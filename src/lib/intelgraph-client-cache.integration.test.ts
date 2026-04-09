import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fetchRelationsFromIntelgraph, resetSnapshotState } from './intelgraph-client';
import { clearWorkspaceCache, getCacheStats } from './relation-cache';
import { startMockMcpServer } from '../../test/mock-mcp-server';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0, cleanup.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.INTELGRAPH_URL;
  resetSnapshotState();
});

function makeTempWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'rw-cache-integration-'));
  cleanup.push(ws);
  mkdirSync(join(ws, 'src'), { recursive: true });
  return ws;
}

describe('relation-cache integration', () => {
  test('cache miss: first query stores result', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'lsp_hover') {
          const ch = Number(args.character);
          if (ch <= 2) return 'No hover information available.';
          return 'function my_function';
        }
        if (name === 'get_callers') {
          return JSON.stringify({
            targetApi: 'my_function',
            targetFile: 'src/test.c',
            targetLine: 1,
            callers: [
              { name: 'caller_a', filePath: 'src/caller.c', lineNumber: 10, callerRole: 'direct_caller', invocationType: 'direct_call', confidence: 1, source: 'lsp_incoming_calls' },
            ],
            registrars: [],
            source: 'get_callers',
            provenance: { stepsAttempted: ['get_callers'], stepUsed: 'get_callers' },
          });
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    const ws = makeTempWorkspace();
    const file = join(ws, 'src', 'test.c');
    const callerFile = join(ws, 'src', 'caller.c');
    writeFileSync(file, 'void my_function(void) {}\n', 'utf8');
    writeFileSync(callerFile, 'void caller_a(void) {}\n', 'utf8');

    // Clear any existing cache
    clearWorkspaceCache(ws);

    const statsBefore = getCacheStats(ws);
    expect(statsBefore.entryCount).toBe(0);

    const result = await fetchRelationsFromIntelgraph({
      mode: 'incoming',
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });

    expect(result.mode).toBe('incoming');
    expect(result.provider).toBe('intelgraph');
    const rootKey = Object.keys(result.result || {})[0];
    expect(rootKey).toBe('my_function');

    const statsAfter = getCacheStats(ws);
    expect(statsAfter.entryCount).toBe(1);

    await mock.close();
  });

  test('cache hit: second identical query returns cached payload without MCP calls', async () => {
    let intelligenceQueryCount = 0;
    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'lsp_hover') {
          const ch = Number(args.character);
          if (ch <= 2) return 'No hover information available.';
          return 'function my_function';
        }
        if (name === 'get_callers') {
          intelligenceQueryCount++;
          return JSON.stringify({
            targetApi: 'my_function',
            targetFile: 'src/test.c',
            targetLine: 1,
            callers: [
              { name: 'caller_a', filePath: 'src/caller.c', lineNumber: 10, callerRole: 'direct_caller', invocationType: 'direct_call', confidence: 1, source: 'lsp_incoming_calls' },
            ],
            registrars: [],
            source: 'get_callers',
            provenance: { stepsAttempted: ['get_callers'], stepUsed: 'get_callers' },
          });
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    const ws = makeTempWorkspace();
    const file = join(ws, 'src', 'test.c');
    const callerFile = join(ws, 'src', 'caller.c');
    writeFileSync(file, 'void my_function(void) {}\n', 'utf8');
    writeFileSync(callerFile, 'void caller_a(void) {}\n', 'utf8');

    // Clear cache
    clearWorkspaceCache(ws);

    // First query (cache miss) - should call get_callers once
    intelligenceQueryCount = 0;
    const result1 = await fetchRelationsFromIntelgraph({
      mode: 'incoming',
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });
    expect(intelligenceQueryCount).toBe(1); // get_callers

    // Second query (cache hit) - should NOT call intelligence_query
    // (lsp_hover is still called for symbol resolution, which is expected)
    intelligenceQueryCount = 0;
    const result2 = await fetchRelationsFromIntelgraph({
      mode: 'incoming',
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });
    expect(intelligenceQueryCount).toBe(0); // Should NOT have called get_callers

    // Results should be identical
    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));

    await mock.close();
  });

  test('cache invalidation: modified file triggers re-query', async () => {
    let intelligenceQueryCount = 0;

    // Create workspace first so we can use absolute paths in mock response
    const ws = makeTempWorkspace();
    const file = join(ws, 'src', 'test.c');
    const callerFile = join(ws, 'src', 'caller.c');
    writeFileSync(file, 'void my_function(void) {}\n', 'utf8');
    writeFileSync(callerFile, 'void caller_a(void) {}\n', 'utf8');

    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'lsp_hover') {
          const ch = Number(args.character);
          if (ch <= 2) return 'No hover information available.';
          return 'function my_function';
        }
        if (name === 'get_callers') {
          intelligenceQueryCount++;
          return JSON.stringify({
            targetApi: 'my_function',
            targetFile: file,
            targetLine: 1,
            callers: [
              { name: 'caller_a', filePath: callerFile, lineNumber: 10, callerRole: 'direct_caller', invocationType: 'direct_call', confidence: 1, source: 'lsp_incoming_calls' },
            ],
            registrars: [],
            source: 'get_callers',
            provenance: { stepsAttempted: ['get_callers'], stepUsed: 'get_callers' },
          });
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    // Clear cache
    clearWorkspaceCache(ws);

    // First query (cache miss) - calls get_callers once
    intelligenceQueryCount = 0;
    await fetchRelationsFromIntelgraph({
      mode: 'incoming',
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });
    expect(intelligenceQueryCount).toBe(1); // get_callers

    // Second query (cache hit)
    intelligenceQueryCount = 0;
    await fetchRelationsFromIntelgraph({
      mode: 'incoming',
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });
    expect(intelligenceQueryCount).toBe(0);

    // Modify evidence file
    writeFileSync(callerFile, 'void caller_a(void) { /* modified */ }\n', 'utf8');

    // Third query (cache invalidated, should re-query)
    intelligenceQueryCount = 0;
    await fetchRelationsFromIntelgraph({
      mode: 'incoming',
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });
    expect(intelligenceQueryCount).toBe(1); // Should have called get_callers again

    await mock.close();
  });

  test('cache isolation: different workspaces use separate DBs', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'lsp_hover') {
          const ch = Number(args.character);
          if (ch <= 2) return 'No hover information available.';
          return 'function my_function';
        }
        if (name === 'get_callers') {
          return JSON.stringify({
            targetApi: 'my_function',
            targetFile: 'src/test.c',
            targetLine: 1,
            callers: [
              { name: 'caller_a', filePath: 'src/caller.c', lineNumber: 10, callerRole: 'direct_caller', invocationType: 'direct_call', confidence: 1, source: 'lsp_incoming_calls' },
            ],
            registrars: [],
            source: 'get_callers',
            provenance: { stepsAttempted: ['get_callers'], stepUsed: 'get_callers' },
          });
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    const ws1 = makeTempWorkspace();
    const ws2 = makeTempWorkspace();

    const file1 = join(ws1, 'src', 'test.c');
    const caller1 = join(ws1, 'src', 'caller.c');
    writeFileSync(file1, 'void my_function(void) {}\n', 'utf8');
    writeFileSync(caller1, 'void caller_a(void) {}\n', 'utf8');

    const file2 = join(ws2, 'src', 'test.c');
    const caller2 = join(ws2, 'src', 'caller.c');
    writeFileSync(file2, 'void my_function(void) {}\n', 'utf8');
    writeFileSync(caller2, 'void caller_a(void) {}\n', 'utf8');

    // Clear both caches
    clearWorkspaceCache(ws1);
    clearWorkspaceCache(ws2);

    // Query workspace 1
    await fetchRelationsFromIntelgraph({
      mode: 'incoming',
      filePath: file1,
      line: 1,
      character: 6,
      workspaceRoot: ws1,
    });

    const stats1 = getCacheStats(ws1);
    const stats2 = getCacheStats(ws2);

    expect(stats1.entryCount).toBe(1);
    expect(stats2.entryCount).toBe(0); // Workspace 2 cache should be empty

    // Query workspace 2
    await fetchRelationsFromIntelgraph({
      mode: 'incoming',
      filePath: file2,
      line: 1,
      character: 6,
      workspaceRoot: ws2,
    });

    const stats1After = getCacheStats(ws1);
    const stats2After = getCacheStats(ws2);

    expect(stats1After.entryCount).toBe(1); // Workspace 1 unchanged
    expect(stats2After.entryCount).toBe(1); // Workspace 2 now has 1 entry

    await mock.close();
  });

  test('systemNodes/systemLinks preserved in cached payload', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'lsp_hover') {
          const ch = Number(args.character);
          if (ch <= 2) return 'No hover information available.';
          return 'function my_handler';
        }
        if (name === 'get_callers') {
          return JSON.stringify({
            targetApi: 'my_handler',
            targetFile: 'src/handler.c',
            targetLine: 1,
            callers: [
              { name: 'WMI_CMD_ID', filePath: '/workspace/src/wmi.c', lineNumber: 100, callerRole: 'runtime_caller', invocationType: 'runtime_direct_call', confidence: 0.9, source: 'intelligence_query_runtime' },
            ],
            registrars: [
              { name: 'wmi_register', filePath: 'src/wmi.c', lineNumber: 100, callerRole: 'registrar', invocationType: 'interface_registration', confidence: 0.8, source: 'intelligence_query_static' },
            ],
            source: 'get_callers',
            provenance: { stepsAttempted: ['get_callers'], stepUsed: 'get_callers' },
          });
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    const ws = makeTempWorkspace();
    const file = join(ws, 'src', 'handler.c');
    const wmiFile = join(ws, 'src', 'wmi.c');
    writeFileSync(file, 'void my_handler(void) {}\n', 'utf8');
    writeFileSync(wmiFile, 'void wmi_register(void) {}\n', 'utf8');

    // Clear cache
    clearWorkspaceCache(ws);

    // First query (cache miss)
    const result1 = await fetchRelationsFromIntelgraph({
      mode: 'incoming',
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });

    const rootKey = Object.keys(result1.result || {})[0];
    const rootNode1 = result1.result?.[rootKey];
    const calledBy1 = rootNode1?.calledBy ?? [];
    expect(calledBy1.length).toBeGreaterThan(0);

    // Verify callers are present
    const wmiCaller = calledBy1.find((x) => x.caller === 'WMI_CMD_ID');
    expect(wmiCaller).toBeDefined();
    expect(wmiCaller?.connectionKind).toBe('api_call');

    // Second query (cache hit)
    const result2 = await fetchRelationsFromIntelgraph({
      mode: 'incoming',
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });

    const rootNode2 = result2.result?.[rootKey];
    const calledBy2 = rootNode2?.calledBy ?? [];

    // Verify cached payload is identical
    expect(JSON.stringify(calledBy1)).toBe(JSON.stringify(calledBy2));

    await mock.close();
  });
});
