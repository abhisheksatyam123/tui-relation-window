import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fetchRelationsFromClangdMcp } from './clangd-mcp-client';
import { clearWorkspaceCache, getCacheStats } from './relation-cache';
import { startMockMcpServer } from '../../test/mock-mcp-server';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0, cleanup.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.CLANGD_MCP_URL;
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
        if (name === 'lsp_indirect_callers') {
          return [
            'Callers of my_function  (1 total: 1 registration-call)',
            '',
            'Registration-call registrations (1):',
            '  <- [Function] caller_a  at src/caller.c:10:5',
            '     via: register_handler',
          ].join('\n');
        }
        if (name === 'lsp_incoming_calls') {
          return 'No callers found.';
        }
        if (name === 'lsp_outgoing_calls') {
          return 'No outgoing calls.';
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.CLANGD_MCP_URL = mock.url;

    const ws = makeTempWorkspace();
    const file = join(ws, 'src', 'test.c');
    const callerFile = join(ws, 'src', 'caller.c');
    writeFileSync(file, 'void my_function(void) {}\n', 'utf8');
    writeFileSync(callerFile, 'void caller_a(void) {}\n', 'utf8');

    // Clear any existing cache
    clearWorkspaceCache(ws);

    const statsBefore = getCacheStats(ws);
    expect(statsBefore.entryCount).toBe(0);

    const result = await fetchRelationsFromClangdMcp({
      mode: 'incoming',
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });

    expect(result.mode).toBe('incoming');
    expect(result.provider).toBe('clangd-mcp');
    const rootKey = Object.keys(result.result || {})[0];
    expect(rootKey).toBe('my_function');

    const statsAfter = getCacheStats(ws);
    expect(statsAfter.entryCount).toBe(1);

    await mock.close();
  });

  test('cache hit: second identical query returns cached payload without MCP calls', async () => {
    let indirectCallersCount = 0;
    let incomingCallsCount = 0;
    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'lsp_hover') {
          const ch = Number(args.character);
          if (ch <= 2) return 'No hover information available.';
          return 'function my_function';
        }
        if (name === 'lsp_indirect_callers') {
          indirectCallersCount++;
          return [
            'Callers of my_function  (1 total: 1 registration-call)',
            '',
            'Registration-call registrations (1):',
            '  <- [Function] caller_a  at src/caller.c:10:5',
            '     via: register_handler',
          ].join('\n');
        }
        if (name === 'lsp_incoming_calls') {
          incomingCallsCount++;
          return 'No callers found.';
        }
        if (name === 'lsp_outgoing_calls') {
          return 'No outgoing calls.';
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.CLANGD_MCP_URL = mock.url;

    const ws = makeTempWorkspace();
    const file = join(ws, 'src', 'test.c');
    const callerFile = join(ws, 'src', 'caller.c');
    writeFileSync(file, 'void my_function(void) {}\n', 'utf8');
    writeFileSync(callerFile, 'void caller_a(void) {}\n', 'utf8');

    // Clear cache
    clearWorkspaceCache(ws);

    // First query (cache miss) - should call lsp_indirect_callers and lsp_incoming_calls
    indirectCallersCount = 0;
    incomingCallsCount = 0;
    const result1 = await fetchRelationsFromClangdMcp({
      mode: 'incoming',
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });
    expect(indirectCallersCount).toBe(1);
    expect(incomingCallsCount).toBe(1);

    // Second query (cache hit) - should NOT call lsp_indirect_callers or lsp_incoming_calls
    // (lsp_hover is still called for symbol resolution, which is expected)
    indirectCallersCount = 0;
    incomingCallsCount = 0;
    const result2 = await fetchRelationsFromClangdMcp({
      mode: 'incoming',
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });
    expect(indirectCallersCount).toBe(0); // Should NOT have called lsp_indirect_callers
    expect(incomingCallsCount).toBe(0); // Should NOT have called lsp_incoming_calls

    // Results should be identical
    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));

    await mock.close();
  });

  test('cache invalidation: modified file triggers re-query', async () => {
    let indirectCallersCount = 0;
    let incomingCallsCount = 0;
    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'lsp_hover') {
          const ch = Number(args.character);
          if (ch <= 2) return 'No hover information available.';
          return 'function my_function';
        }
        if (name === 'lsp_indirect_callers') {
          indirectCallersCount++;
          return [
            'Callers of my_function  (1 total: 1 registration-call)',
            '',
            'Registration-call registrations (1):',
            '  <- [Function] caller_a  at src/caller.c:10:5',
            '     via: register_handler',
          ].join('\n');
        }
        if (name === 'lsp_incoming_calls') {
          incomingCallsCount++;
          return 'No callers found.';
        }
        if (name === 'lsp_outgoing_calls') {
          return 'No outgoing calls.';
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.CLANGD_MCP_URL = mock.url;

    const ws = makeTempWorkspace();
    const file = join(ws, 'src', 'test.c');
    const callerFile = join(ws, 'src', 'caller.c');
    writeFileSync(file, 'void my_function(void) {}\n', 'utf8');
    writeFileSync(callerFile, 'void caller_a(void) {}\n', 'utf8');

    // Clear cache
    clearWorkspaceCache(ws);

    // First query (cache miss)
    indirectCallersCount = 0;
    incomingCallsCount = 0;
    await fetchRelationsFromClangdMcp({
      mode: 'incoming',
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });
    expect(indirectCallersCount).toBe(1);
    expect(incomingCallsCount).toBe(1);

    // Second query (cache hit)
    indirectCallersCount = 0;
    incomingCallsCount = 0;
    await fetchRelationsFromClangdMcp({
      mode: 'incoming',
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });
    expect(indirectCallersCount).toBe(0);
    expect(incomingCallsCount).toBe(0);

    // Modify evidence file
    writeFileSync(callerFile, 'void caller_a(void) { /* modified */ }\n', 'utf8');

    // Third query (cache invalidated, should re-query)
    indirectCallersCount = 0;
    incomingCallsCount = 0;
    await fetchRelationsFromClangdMcp({
      mode: 'incoming',
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });
    expect(indirectCallersCount).toBe(1); // Should have called lsp_indirect_callers again
    expect(incomingCallsCount).toBe(1); // Should have called lsp_incoming_calls again

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
        if (name === 'lsp_indirect_callers') {
          return [
            'Callers of my_function  (1 total: 1 registration-call)',
            '',
            'Registration-call registrations (1):',
            '  <- [Function] caller_a  at src/caller.c:10:5',
            '     via: register_handler',
          ].join('\n');
        }
        if (name === 'lsp_incoming_calls') {
          return 'No callers found.';
        }
        if (name === 'lsp_outgoing_calls') {
          return 'No outgoing calls.';
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.CLANGD_MCP_URL = mock.url;

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
    await fetchRelationsFromClangdMcp({
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
    await fetchRelationsFromClangdMcp({
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
        if (name === 'lsp_indirect_callers') {
          const mediatedPaths = [
            {
              pathId: 'path-1',
              endpoint: {
                endpointKind: 'host_interface',
                endpointId: 'WMI_CMD_ID',
                endpointLabel: 'WMI Command',
                origin: 'external(host)',
                filePath: '/workspace/src/wmi.c',
                lineNumber: 100,
              },
              stages: [
                {
                  stageKind: 'dispatch_table',
                  ownerSymbol: 'wmi_dispatch',
                  filePath: '/workspace/src/wmi.c',
                  lineNumber: 100,
                  ids: { eventId: 'WMI_CMD_ID' },
                },
              ],
              confidence: { score: 0.9, reasons: ['explicit-endpoint-id'] },
              evidence: [{ role: 'registration-site', filePath: '/workspace/src/wmi.c', lineNumber: 100 }],
            },
          ];

          return [
            'Callers of my_handler  (1 total)',
            '',
            'Registration-call registrations (1):',
            '  <- [Function] wmi_register  at src/wmi.c:100:5',
            '     via: wmi_unified_register_event_handler',
            '',
            '---mediated-paths-json---',
            JSON.stringify(mediatedPaths, null, 2),
            '---end-mediated-paths-json---',
          ].join('\n');
        }
        if (name === 'lsp_incoming_calls') {
          return 'No callers found.';
        }
        if (name === 'lsp_outgoing_calls') {
          return 'No outgoing calls.';
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.CLANGD_MCP_URL = mock.url;

    const ws = makeTempWorkspace();
    const file = join(ws, 'src', 'handler.c');
    const wmiFile = join(ws, 'src', 'wmi.c');
    writeFileSync(file, 'void my_handler(void) {}\n', 'utf8');
    writeFileSync(wmiFile, 'void wmi_register(void) {}\n', 'utf8');

    // Clear cache
    clearWorkspaceCache(ws);

    // First query (cache miss)
    const result1 = await fetchRelationsFromClangdMcp({
      mode: 'incoming',
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });

    const rootKey = Object.keys(result1.result || {})[0];
    const rootNode1 = result1.result?.[rootKey];
    expect(rootNode1?.systemNodes).toBeDefined();
    expect(rootNode1?.systemLinks).toBeDefined();
    expect(rootNode1?.systemNodes?.length).toBeGreaterThan(0);

    // Second query (cache hit)
    const result2 = await fetchRelationsFromClangdMcp({
      mode: 'incoming',
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });

    const rootNode2 = result2.result?.[rootKey];
    expect(rootNode2?.systemNodes).toBeDefined();
    expect(rootNode2?.systemLinks).toBeDefined();

    // Verify systemNodes/systemLinks are identical
    expect(JSON.stringify(rootNode1?.systemNodes)).toBe(JSON.stringify(rootNode2?.systemNodes));
    expect(JSON.stringify(rootNode1?.systemLinks)).toBe(JSON.stringify(rootNode2?.systemLinks));

    await mock.close();
  });
});
