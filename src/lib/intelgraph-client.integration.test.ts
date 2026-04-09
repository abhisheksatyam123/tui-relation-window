import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  beginSnapshot,
  checkSnapshot,
  commitSnapshot,
  doctorIntelgraph,
  fetchRelationsFromIntelgraph,
  ingestWorkspace,
  intelligenceQuery,
  queryApiLogs,
  queryApiStructReads,
  queryApiStructWrites,
  queryStructWriters,
  resetSnapshotState,
} from './intelgraph-client';
import { startMockMcpServer } from '../../test/mock-mcp-server';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0, cleanup.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.INTELGRAPH_URL;
  resetSnapshotState();
});

describe('clangd-mcp client integration (mock server)', () => {
  test('intelligence_query wrapper symbol is exported', async () => {
    const mod = await import('./intelgraph-client');
    expect('queryIntelligence' in mod).toBe(false);
    expect('intelligenceQuery' in mod).toBe(true);
  });

  test('intelligenceQuery parses who_calls_api QueryResult payload', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name) => {
        if (name === 'intelligence_query') {
          return JSON.stringify({
            status: 'hit',
            data: {
              nodes: [
                { id: 'fn:resolve_check', kind: 'api', symbol: 'resolve_check' },
                { id: 'fn:alpha_caller', kind: 'function', symbol: 'alpha_caller' },
              ],
              edges: [
                { from: 'fn:alpha_caller', to: 'fn:resolve_check', kind: 'api_call' },
              ],
            },
            provenance: { intent: 'who_calls_api', source: 'postgres' },
          });
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    const out = await intelligenceQuery({
      workspaceRoot: '/tmp/ws',
      intent: 'who_calls_api',
      params: { symbol: 'resolve_check', maxDepth: 2, maxNodes: 20 },
    });

    expect(out.status).toBe('hit');
    expect(out.data.nodes.length).toBe(2);
    expect(out.data.edges.length).toBe(1);
    expect(out.provenance?.intent).toBe('who_calls_api');

    await mock.close();
  });

  test('intelligenceQuery parses what_does_api_call QueryResult payload', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name) => {
        if (name === 'intelligence_query') {
          return JSON.stringify({
            status: 'enriched',
            data: {
              nodes: [
                { id: 'fn:resolve_check', kind: 'api', symbol: 'resolve_check' },
                { id: 'fn:x_callee', kind: 'function', symbol: 'x_callee' },
                { id: 'fn:y_callee', kind: 'function', symbol: 'y_callee' },
              ],
              edges: [
                { from: 'fn:resolve_check', to: 'fn:x_callee', kind: 'api_call' },
                { from: 'fn:resolve_check', to: 'fn:y_callee', kind: 'api_call' },
              ],
            },
            provenance: { intent: 'what_does_api_call', source: 'postgres+neo4j' },
          });
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    const out = await intelligenceQuery({
      workspaceRoot: '/tmp/ws',
      intent: 'what_api_calls',
      params: { symbol: 'resolve_check' },
    });

    expect(out.status).toBe('enriched');
    expect(out.data.nodes.length).toBe(3);
    expect(out.data.edges.length).toBe(2);
    expect(out.provenance?.intent).toBe('what_does_api_call');

    await mock.close();
  });

  test('intelligenceQuery wraps tool failure with deterministic prefix', async () => {
    const server = createServer(async (req, res) => {
      const body = await readRequestBody(req);
      const rpc = JSON.parse(body) as { id?: number; method?: string };
      if (rpc.method === 'initialize') {
        res.setHeader('mcp-session-id', 'mock-session');
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: rpc.id ?? 1,
          result: { protocolVersion: '2024-11-05', serverInfo: { name: 'mock-mcp', version: '0.0.1' } },
        });
        return;
      }
      if (rpc.method === 'tools/call') {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: rpc.id ?? 1,
          error: { code: -32000, message: 'synthetic intelligence_query failure' },
        });
        return;
      }
      sendJson(res, 404, { jsonrpc: '2.0', id: rpc.id ?? 1, error: { code: -32601, message: 'Method not found' } });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('Failed to bind custom test server');
    }
    process.env.INTELGRAPH_URL = `http://127.0.0.1:${addr.port}/mcp`;

    await expect(
      intelligenceQuery({
        workspaceRoot: '/tmp/ws',
        intent: 'who_calls_api',
        params: { symbol: 'resolve_check' },
      }),
    ).rejects.toThrow('intelligence_query failed:');

    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  test('beginSnapshot parses snapshotId/status/createdAt on success', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name) => {
        if (name === 'intelligence_snapshot') {
          return ['snapshotId: 42', 'status: building', 'createdAt: 2026-03-28T10:20:30Z'].join('\n');
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    const out = await beginSnapshot({
      workspaceRoot: '/tmp/ws',
      compileDbHash: 'abc123',
      parserVersion: 'v1',
    });

    expect(out.snapshotId).toBe(42);
    expect(out.status).toBe('building');
    expect(out.createdAt).toBe('2026-03-28T10:20:30Z');

    await mock.close();
  });

  test('beginSnapshot wraps malformed payload errors', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name) => {
        if (name === 'intelligence_snapshot') {
          return 'status: building\ncreatedAt: 2026-03-28T10:20:30Z';
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    await expect(
      beginSnapshot({
        workspaceRoot: '/tmp/ws',
        compileDbHash: 'abc123',
      }),
    ).rejects.toThrow('intelligence_snapshot begin failed:');

    await mock.close();
  });

  test('commitSnapshot accepts committed acknowledgement', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name) => {
        if (name === 'intelligence_snapshot') {
          return 'snapshotId: 42\nstatus: ready\ncommitted';
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    await expect(commitSnapshot({ workspaceRoot: '/tmp/ws', snapshotId: 42 })).resolves.toBeUndefined();

    await mock.close();
  });

  test('commitSnapshot wraps failure payloads', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name) => {
        if (name === 'intelligence_snapshot') {
          return 'snapshotId: 42\nstatus: building';
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    await expect(commitSnapshot({ workspaceRoot: '/tmp/ws', snapshotId: 42 })).rejects.toThrow(
      'intelligence_snapshot commit failed for snapshot 42:',
    );

    await mock.close();
  });

  test('checkSnapshot parses supported check responses', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name) => {
        if (name === 'intelligence_snapshot') {
          return 'Snapshot ready: snapshotId=42 workspaceRoot=/tmp/ws status=ready';
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    const out = await checkSnapshot({ workspaceRoot: '/tmp/ws' });
    expect(out.snapshotId).toBe(42);
    expect(out.exists).toBe(true);
    expect(out.status).toBe('ready');
    expect(out.supported).toBe(true);

    await mock.close();
  });

  test('checkSnapshot falls back when check action unsupported by MCP', async () => {
    const server = createServer(async (req, res) => {
      const body = await readRequestBody(req);
      const rpc = JSON.parse(body) as { id?: number; method?: string };
      if (rpc.method === 'initialize') {
        res.setHeader('mcp-session-id', 'mock-session');
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: rpc.id ?? 1,
          result: { protocolVersion: '2024-11-05', serverInfo: { name: 'mock-mcp', version: '0.0.1' } },
        });
        return;
      }
      if (rpc.method === 'tools/call') {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: rpc.id ?? 1,
          error: { code: -32602, message: 'invalid enum value for action: check' },
        });
        return;
      }
      sendJson(res, 404, { jsonrpc: '2.0', id: rpc.id ?? 1, error: { code: -32601, message: 'Method not found' } });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('Failed to bind custom test server');
    }
    process.env.INTELGRAPH_URL = `http://127.0.0.1:${addr.port}/mcp`;

    const out = await checkSnapshot({ workspaceRoot: '/tmp/ws' });
    expect(out.snapshotId).toBe(0);
    expect(out.exists).toBe(false);
    expect(out.supported).toBe(false);
    expect(out.raw).toContain('invalid enum value for action: check');

    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  test('ingestWorkspace parses snapshot and count metadata on success', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name) => {
        if (name === 'intelligence_ingest') {
          return [
            'Snapshot started: id=77',
            'Extracted: symbols=120 types=33 edges=245',
            'Persisted: symbols=118 types=33 edges=241',
            'Snapshot committed: id=77 status=ready',
            'Done in 452ms',
          ].join('\n');
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    const out = await ingestWorkspace({
      workspaceRoot: '/tmp/ws',
      fileLimit: 200,
      syncProjection: true,
    });

    expect(out.snapshotId).toBe(77);
    expect(out.extracted).toEqual({ symbols: 120, types: 33, edges: 245 });
    expect(out.persisted).toEqual({ symbols: 118, types: 33, edges: 241 });
    expect(out.raw).toContain('Snapshot committed: id=77 status=ready');

    await mock.close();
  });

  test('ingestWorkspace wraps backend-reported ingest failure', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name) => {
        if (name === 'intelligence_ingest') {
          return 'intelligence_ingest: failed — snapshot 77 marked failed.\nError: synthetic ingest failure';
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    await expect(
      ingestWorkspace({
        workspaceRoot: '/tmp/ws',
      }),
    ).rejects.toThrow('intelligence_ingest failed:');

    await mock.close();
  });

  // intelligenceQuery normalized status/data/provenance and parse-failure cases are covered
  // by the earlier tests at lines ~37 and ~113 in this file. Removed duplicates.

  test('fetchRelationsFromIntelgraph ingests once when snapshot missing and reuses on next query', async () => {
    let ingestCalls = 0;
    let checkCalls = 0;
    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'intelligence_snapshot') {
          const action = String(args.action || '');
          if (action === 'check') {
            checkCalls += 1;
            if (checkCalls === 1) return 'snapshotId: 101\nstatus: missing\nnot found';
            return 'snapshotId: 101\nstatus: ready';
          }
          return 'snapshotId: 101\nstatus: ready';
        }
        if (name === 'intelligence_ingest') {
          ingestCalls += 1;
          return [
            'Snapshot started: id=101',
            'Extracted: symbols=3 types=2 edges=1',
            'Persisted: symbols=3 types=2 edges=1',
            'Snapshot committed: id=101 status=ready',
          ].join('\n');
        }
        if (name === 'lsp_hover') {
          return 'function resolve_check';
        }
        if (name === 'intelligence_query') {
          return JSON.stringify({
            status: 'hit',
            data: {
              nodes: [
                { id: 'fn:resolve_check', kind: 'api', symbol: 'resolve_check', filePath: '/src/api.c', lineNumber: 1 },
                { id: 'fn:alpha_caller', kind: 'function', symbol: 'alpha_caller', filePath: '/src/alpha.c', lineNumber: 11 },
              ],
              edges: [{ from: 'fn:alpha_caller', to: 'fn:resolve_check', kind: 'api_call' }],
            },
          });
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    const ws = mkdtempSync(join(tmpdir(), 'rw-mcp-snap-init-'));
    cleanup.push(ws);
    mkdirSync(join(ws, 'src'), { recursive: true });
    const file = join(ws, 'src', 'entry.c');
    writeFileSync(file, 'void resolve_check(void) {}\n', 'utf8');

    const q = {
      mode: 'incoming' as const,
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    };

    await fetchRelationsFromIntelgraph(q);
    await fetchRelationsFromIntelgraph(q);

    expect(ingestCalls).toBe(1);
    expect(checkCalls).toBe(1);

    await mock.close();
  });

  test('fetchRelationsFromIntelgraph surfaces deterministic initialization errors', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'intelligence_snapshot' && String(args.action || '') === 'check') {
          return 'snapshotId: 55\nstatus: missing\nnot found';
        }
        if (name === 'intelligence_ingest') {
          return 'intelligence_ingest: failed — snapshot 55 marked failed.\nError: synthetic init failure';
        }
        if (name === 'lsp_hover') {
          return 'function resolve_check';
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    const ws = mkdtempSync(join(tmpdir(), 'rw-mcp-snap-init-err-'));
    cleanup.push(ws);
    mkdirSync(join(ws, 'src'), { recursive: true });
    const file = join(ws, 'src', 'entry.c');
    writeFileSync(file, 'void resolve_check(void) {}\n', 'utf8');

    await expect(
      fetchRelationsFromIntelgraph({
        mode: 'incoming',
        filePath: file,
        line: 1,
        character: 6,
        workspaceRoot: ws,
      }),
    ).rejects.toThrow('snapshot initialization failed:');

    await mock.close();
  });

  test('incoming uses get_callers and includes registrar context when provided', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'lsp_hover') {
          const ch = Number(args.character);
          if (ch <= 2) return 'No hover information available.';
          return 'function wlan_bpf_filter_offload_handler';
        }
        if (name === 'get_callers') {
          return JSON.stringify({
            targetApi: 'wlan_bpf_filter_offload_handler',
            targetFile: 'wlan_proc/wlan/protocol/src/offloads/src/l2/bpf/bpf_offload.c',
            targetLine: 83,
            callers: [],
            registrars: [
              {
                name: 'wlan_bpf_enable_data_path',
                filePath: 'wlan_proc/wlan/protocol/src/offloads/src/l2/bpf/bpf_offload_int.c',
                lineNumber: 1095,
                callerRole: 'registrar',
                invocationType: 'interface_registration',
                confidence: 0.9,
                source: 'intelligence_query_static',
              },
              {
                name: 'wlan_bpf_offload_test_route_uc_active',
                filePath: 'wlan_proc/wlan/protocol/src/offloads/src/l2/bpf/bpf_offload_unit_test.c',
                lineNumber: 202,
                callerRole: 'registrar',
                invocationType: 'interface_registration',
                confidence: 0.9,
                source: 'intelligence_query_static',
              },
            ],
            source: 'intelligence_query_static',
            provenance: { stepsAttempted: ['intelligence_query_static'], stepUsed: 'intelligence_query_static' },
          });
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    const ws = mkdtempSync(join(tmpdir(), 'rw-mcp-reg-'));
    cleanup.push(ws);
    mkdirSync(join(ws, 'src'), { recursive: true });

    const file = join(ws, 'src', 'bpf_offload.c');
    writeFileSync(file, 'void wlan_bpf_filter_offload_handler(void) {}\n', 'utf8');

    const incoming = await fetchRelationsFromIntelgraph({
      mode: 'incoming' as const,
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });

    const root = Object.keys(incoming.result || {})[0];
    const calledBy = incoming.result?.[root]?.calledBy ?? [];

    // Both registrars are shown — the TUI renders them with [REG] badges.
    // The user sees both the registrar (who wired it) and can expand to find the runtime caller.
    expect(calledBy.length).toBe(2);
    const reg1 = calledBy.find((x) => x.caller === 'wlan_bpf_enable_data_path');
    expect(reg1).toBeDefined();
    expect(reg1?.connectionKind).toBe('interface_registration');
    const reg2 = calledBy.find((x) => x.caller === 'wlan_bpf_offload_test_route_uc_active');
    expect(reg2).toBeDefined();
    expect(reg2?.connectionKind).toBe('interface_registration');

    await mock.close();
  });

  test('incoming returns empty when get_callers returns no callers', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'lsp_hover') {
          const ch = Number(args.character);
          if (ch <= 2) return 'No hover information available.';
          return 'function wlan_bpf_filter_offload_handler';
        }
        if (name === 'get_callers') {
          return JSON.stringify({
            targetApi: 'wlan_bpf_filter_offload_handler',
            targetFile: '/src/bpf_offload.c',
            targetLine: 1,
            callers: [],
            registrars: [],
            source: 'none',
            provenance: { stepsAttempted: ['lsp_runtime_flow', 'intelligence_query_runtime', 'intelligence_query_static', 'lsp_indirect_callers', 'lsp_incoming_calls'], stepUsed: 'none' },
          });
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    const ws = mkdtempSync(join(tmpdir(), 'rw-mcp-fallback-'));
    cleanup.push(ws);
    mkdirSync(join(ws, 'src'), { recursive: true });

    const file = join(ws, 'src', 'bpf_offload.c');
    writeFileSync(file, 'void wlan_bpf_filter_offload_handler(void) {}\n', 'utf8');

    const incoming = await fetchRelationsFromIntelgraph({
      mode: 'incoming' as const,
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });

    const root = Object.keys(incoming.result || {})[0];
    const calledBy = incoming.result?.[root]?.calledBy ?? [];
    
    expect(calledBy.length).toBe(0);

    await mock.close();
  });

  test('incoming ignores placeholder runtime_flow caller and falls back to concrete incoming caller', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'lsp_hover') {
          const ch = Number(args.character);
          if (ch <= 2) return 'No hover information available.';
          return 'function resolve_check';
        }
        if (name === 'lsp_runtime_flow') {
          return JSON.stringify({
            targetApi: 'resolve_check',
            runtimeFlows: [
              {
                targetApi: 'resolve_check',
                runtimeTrigger: 'dispatch',
                dispatchChain: ['unknown'],
                immediateInvoker: '(unknown-registrar)',
              },
            ],
          });
        }
        if (name === 'intelligence_snapshot') {
          const action = String((args as Record<string, unknown>).action ?? '');
          if (action === 'check') {
            return 'exists: false\nlatestSnapshotId: 0';
          }
          if (action === 'begin') {
            return 'snapshotId: 7\nstatus: building';
          }
          if (action === 'commit') {
            return 'snapshotId: 7\nstatus: ready\ncommitted';
          }
          return 'exists: false\nlatestSnapshotId: 0';
        }
        if (name === 'intelligence_ingest') {
          return 'snapshotId: 7\nrows: 1';
        }
        if (name === 'get_callers') {
          return JSON.stringify({
            targetApi: 'resolve_check',
            targetFile: '/src/arpns.c',
            targetLine: 1,
            callers: [
              {
                name: 'offldmgr_enhanced_data_handler',
                filePath: 'wlan_proc/wlan/protocol/src/offloads/src/offload_mgr_ext.c',
                lineNumber: 500,
                callerRole: 'runtime_caller',
                invocationType: 'runtime_dispatch_table_call',
                confidence: 0.9,
                source: 'intelligence_query_runtime',
              },
            ],
            registrars: [],
            source: 'intelligence_query_runtime',
            provenance: { stepsAttempted: ['intelligence_query_runtime'], stepUsed: 'intelligence_query_runtime' },
          });
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    const ws = mkdtempSync(join(tmpdir(), 'rw-mcp-placeholder-runtimeflow-'));
    cleanup.push(ws);
    mkdirSync(join(ws, 'src'), { recursive: true });

    const file = join(ws, 'src', 'arpns.c');
    writeFileSync(file, 'void resolve_check(void) {}\n', 'utf8');

    const incoming = await fetchRelationsFromIntelgraph({
      mode: 'incoming' as const,
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });

    const root = Object.keys(incoming.result || {})[0];
    const calledBy = incoming.result?.[root]?.calledBy ?? [];

    expect(calledBy.some((x) => x.caller === '(unknown-registrar)')).toBe(false);
    // Key regression guard: placeholder from runtime_flow must not be treated as final caller.
    // If deeper stages return data, they can populate calledBy; but placeholder itself is forbidden.
    expect(calledBy.every((x) => x.caller !== '(unknown-registrar)')).toBe(true);

    await mock.close();
  });

  // Parameterized test covering 3 near-identical runtime_caller+registrar scenarios:
  // - runtime_dispatch_table_call → interface_registration (indirect fn-ptr dispatch)
  // - runtime_direct_call → api_call (direct call)
  // Both scenarios: runtime caller + registrar both shown; registrar has interface_registration kind.
  test.each([
    {
      label: 'runtime_dispatch_table_call → interface_registration for runtime caller',
      invocationType: 'runtime_dispatch_table_call',
      expectedRuntimeKind: 'interface_registration' as const,
    },
    {
      label: 'runtime_direct_call → api_call for runtime caller',
      invocationType: 'runtime_direct_call',
      expectedRuntimeKind: 'api_call' as const,
    },
  ])('incoming runtime_caller+registrar: $label', async ({ invocationType, expectedRuntimeKind }) => {
    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'lsp_hover') {
          const ch = Number(args.character);
          if (ch <= 2) return 'No hover information available.';
          return 'function wlan_bpf_filter_offload_handler';
        }
        if (name === 'get_callers') {
          return JSON.stringify({
            targetApi: 'wlan_bpf_filter_offload_handler',
            targetFile: '/src/bpf_offload.c',
            targetLine: 83,
            callers: [
              {
                name: '_offldmgr_enhanced_data_handler',
                filePath: '/src/offload_mgr_ext.c',
                lineNumber: 500,
                callerRole: 'runtime_caller',
                invocationType,
                confidence: 0.95,
                source: 'intelligence_query_runtime',
              },
            ],
            registrars: [
              {
                name: 'wlan_bpf_enable_data_path',
                filePath: '/src/bpf_offload_int.c',
                lineNumber: 1095,
                callerRole: 'registrar',
                invocationType: 'interface_registration',
                confidence: 0.8,
                source: 'intelligence_query_static',
              },
            ],
            source: 'intelligence_query_runtime',
            provenance: { stepsAttempted: ['intelligence_query_runtime'], stepUsed: 'intelligence_query_runtime' },
          });
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    const ws = mkdtempSync(join(tmpdir(), 'rw-mcp-rt-reg-'));
    cleanup.push(ws);
    mkdirSync(join(ws, 'src'), { recursive: true });

    const file = join(ws, 'src', 'bpf_offload.c');
    writeFileSync(file, 'void wlan_bpf_filter_offload_handler(void) {}\n', 'utf8');

    const incoming = await fetchRelationsFromIntelgraph({
      mode: 'incoming' as const,
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });

    const root = Object.keys(incoming.result || {})[0];
    const calledBy = incoming.result?.[root]?.calledBy ?? [];

    // Both runtime caller AND registrar are shown — TUI renders them with distinct badges.
    expect(calledBy.length).toBe(2);

    // Runtime caller: _offldmgr_enhanced_data_handler (leading underscore canonicalized)
    const runtimeCaller = calledBy.find((x) => x.caller === 'offldmgr_enhanced_data_handler');
    expect(runtimeCaller).toBeDefined();
    expect(runtimeCaller?.connectionKind).toBe(expectedRuntimeKind);

    // Registrar IS shown — always with interface_registration connectionKind
    const registrar = calledBy.find((x) => x.caller === 'wlan_bpf_enable_data_path');
    expect(registrar).toBeDefined();
    expect(registrar?.connectionKind).toBe('interface_registration');

    await mock.close();
  });

  test('doctor + incoming/outgoing queries return compatible payloads', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'lsp_hover') {
          const ch = Number(args.character);
          if (ch <= 2) return 'No hover information available.';
          return 'function resolve_check';
        }
        if (name === 'get_callers') {
          return JSON.stringify({
            targetApi: 'resolve_check',
            targetFile: '/src/api.c',
            targetLine: 2,
            callers: [
              {
                name: 'alpha_caller',
                filePath: '/src/alpha.c',
                lineNumber: 11,
                callerRole: 'direct_caller',
                invocationType: 'direct_call',
                confidence: 1,
                source: 'lsp_incoming_calls',
              },
            ],
            registrars: [
              {
                name: 'setup_handlers',
                filePath: '/src/registrar.c',
                lineNumber: 3,
                callerRole: 'registrar',
                invocationType: 'interface_registration',
                confidence: 0.8,
                source: 'intelligence_query_static',
              },
            ],
            source: 'get_callers',
            provenance: { stepsAttempted: ['get_callers'], stepUsed: 'get_callers' },
          });
        }
        if (name === 'intelligence_query') {
          return JSON.stringify({
            status: 'hit',
            data: {
              nodes: [
                { id: 'fn:resolve_check', kind: 'api', symbol: 'resolve_check', filePath: '/src/api.c', lineNumber: 2 },
                { id: 'fn:x_callee', kind: 'function', symbol: 'x_callee', filePath: '/src/x.c', lineNumber: 31 },
                { id: 'fn:y_callee', kind: 'function', symbol: 'y_callee', filePath: '/src/y.c', lineNumber: 44 },
              ],
              edges: [
                { from: 'fn:resolve_check', to: 'fn:x_callee', kind: 'api_call' },
                { from: 'fn:resolve_check', to: 'fn:y_callee', kind: 'api_call' },
              ],
            },
          });
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    const ws = mkdtempSync(join(tmpdir(), 'rw-mcp-'));
    cleanup.push(ws);
    mkdirSync(join(ws, 'src'), { recursive: true });

    const file = join(ws, 'src', 'demo.cpp');
    writeFileSync(
      file,
      [
        '#include <stdio.h>',
        'int resolve_check() { return 0; }',
        'int main() {',
        '  resolve_check();',
        '  return 0;',
        '}',
      ].join('\n'),
      'utf8'
    );

    const query = {
      mode: 'incoming' as const,
      filePath: file,
      line: 4,
      character: 1,
      workspaceRoot: ws,
    };

    const diag = await doctorIntelgraph(query);
    expect(diag.connected).toBe(true);
    expect(diag.mcpUrl).toContain('/mcp');
    expect(diag.hoverFirstLine.length).toBeGreaterThan(0);

    const incoming = await fetchRelationsFromIntelgraph(query);
    expect(incoming.mode).toBe('incoming');
    expect(incoming.provider).toBe('intelgraph');
    const inRoot = Object.keys(incoming.result || {})[0];
    expect(inRoot).toBeString();

    const calledBy = incoming.result?.[inRoot]?.calledBy ?? [];
    expect(calledBy.length).toBeGreaterThan(0);

    // Direct caller → api_call (should appear)
    const directCaller = calledBy.find((x) => x.caller === 'alpha_caller');
    expect(directCaller).toBeDefined();
    expect(directCaller?.connectionKind).toBe('api_call');

    // Registrar → interface_registration (IS shown with [REG] badge in TUI)
    const regCaller = calledBy.find((x) => x.caller === 'setup_handlers');
    expect(regCaller).toBeDefined();
    expect(regCaller?.connectionKind).toBe('interface_registration');

    const outgoing = await fetchRelationsFromIntelgraph({ ...query, mode: 'outgoing' });
    expect(outgoing.mode).toBe('outgoing');
    const outRoot = Object.keys(outgoing.result || {})[0];
    expect((outgoing.result?.[outRoot]?.calls?.length ?? 0)).toBeGreaterThan(0);

    await mock.close();
  });

  test('intelligence_query returns diverse connection kinds for event-source callers', async () => {
    // With intelligence_query, the backend returns structured nodes/edges with semantic connection kinds.
    // This test verifies that fetchRelationsFromIntelgraph correctly maps all connection kinds.
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
            targetFile: '/src/handler.c',
            targetLine: 1,
            callers: [
              { name: 'WMI_MY_CMDID', filePath: '/src/wmi.c', lineNumber: 42, callerRole: 'runtime_caller', invocationType: 'runtime_direct_call', confidence: 0.9, source: 'intelligence_query_runtime' },
              { name: 'A_INUM_TQM_STATUS_HI', filePath: '/src/ring.c', lineNumber: 10, callerRole: 'runtime_caller', invocationType: 'runtime_direct_call', confidence: 0.9, source: 'intelligence_query_runtime' },
              { name: 'WLAN_THREAD_SIG_MY_EVENT', filePath: '/src/sig.c', lineNumber: 7, callerRole: 'runtime_caller', invocationType: 'runtime_direct_call', confidence: 0.9, source: 'intelligence_query_runtime' },
            ],
            registrars: [
              { name: 'wmi_dispatch_table', filePath: '/src/wmi.c', lineNumber: 42, callerRole: 'registrar', invocationType: 'interface_registration', confidence: 0.8, source: 'intelligence_query_static' },
              { name: 'setup_handlers', filePath: '/src/offload.c', lineNumber: 10, callerRole: 'registrar', invocationType: 'interface_registration', confidence: 0.8, source: 'intelligence_query_static' },
              { name: 'ring_setup', filePath: '/src/ring.c', lineNumber: 10, callerRole: 'registrar', invocationType: 'interface_registration', confidence: 0.8, source: 'intelligence_query_static' },
              { name: 'htc_init', filePath: '/src/htc.c', lineNumber: 5, callerRole: 'registrar', invocationType: 'interface_registration', confidence: 0.8, source: 'intelligence_query_static' },
            ],
            source: 'get_callers',
            provenance: { stepsAttempted: ['get_callers'], stepUsed: 'get_callers' },
          });
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    const ws = mkdtempSync(join(tmpdir(), 'rw-mcp-all-'));
    cleanup.push(ws);
    mkdirSync(join(ws, 'src'), { recursive: true });
    const file = join(ws, 'src', 'handler.c');
    writeFileSync(file, 'void my_handler(void) {}\n', 'utf8');

    const result = await fetchRelationsFromIntelgraph({
      mode: 'incoming' as const,
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });

    const calledBy = result.result?.[Object.keys(result.result ?? {})[0]]?.calledBy ?? [];

    // All connection kinds are shown — runtime callers AND registrars

    // With get_callers mapping, runtime/direct callers surface as api_call
    const wmiEvent = calledBy.find((x) => x.caller === 'WMI_MY_CMDID');
    expect(wmiEvent?.connectionKind).toBe('api_call');

    // HW interrupt source appears as runtime caller in unified payload
    const ringInterrupt = calledBy.find((x) => x.caller === 'A_INUM_TQM_STATUS_HI');
    expect(ringInterrupt?.connectionKind).toBe('api_call');

    // Signal source appears as runtime caller in unified payload
    const sigReal = calledBy.find((x) => x.caller === 'WLAN_THREAD_SIG_MY_EVENT');
    expect(sigReal?.connectionKind).toBe('api_call');

    // Registration nodes ARE shown with interface_registration connectionKind ([REG] badge in TUI)
    const wmiReg = calledBy.find((x) => x.caller === 'wmi_dispatch_table');
    expect(wmiReg).toBeDefined();
    expect(wmiReg?.connectionKind).toBe('interface_registration');
    const setupReg = calledBy.find((x) => x.caller === 'setup_handlers');
    expect(setupReg).toBeDefined();
    expect(setupReg?.connectionKind).toBe('interface_registration');
    // ring_setup and htc_init are also registrars — shown with [REG] badge
    const ringSetup = calledBy.find((x) => x.caller === 'ring_setup');
    expect(ringSetup).toBeDefined();
    expect(ringSetup?.connectionKind).toBe('interface_registration');
    const htcInit = calledBy.find((x) => x.caller === 'htc_init');
    expect(htcInit).toBeDefined();
    expect(htcInit?.connectionKind).toBe('interface_registration');

    await mock.close();
  });

  test('intelligence_query returns WMI and IRQ callers with correct connection kinds', async () => {
    // With intelligence_query, the backend returns structured nodes/edges for WMI and IRQ callers.
    // This test verifies that fetchRelationsFromIntelgraph correctly maps event and hw_interrupt kinds.
    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'lsp_hover') {
          const ch = Number(args.character);
          if (ch <= 2) return 'No hover information available.';
          return 'function wls_fw_scan_result_handler';
        }
        if (name === 'get_callers') {
          return JSON.stringify({
            targetApi: 'wls_fw_scan_result_handler',
            targetFile: '/workspace/src/wls_fw.c',
            targetLine: 1,
            callers: [
              { name: 'WMI_LPI_RESULT_EVENTID', filePath: '/workspace/src/wls_fw.c', lineNumber: 2935, callerRole: 'runtime_caller', invocationType: 'runtime_direct_call', confidence: 0.9, source: 'intelligence_query_runtime' },
              { name: 'A_INUM_TQM_STATUS_HI', filePath: '/workspace/src/tqm_thread.c', lineNumber: 310, callerRole: 'runtime_caller', invocationType: 'runtime_direct_call', confidence: 0.9, source: 'intelligence_query_runtime' },
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

    const ws = mkdtempSync(join(tmpdir(), 'rw-mcp-g8-'));
    cleanup.push(ws);
    mkdirSync(join(ws, 'src'), { recursive: true });
    const file = join(ws, 'src', 'wls_fw.c');
    writeFileSync(file, 'int wls_fw_scan_result_handler(void) { return 0; }\n', 'utf8');

    const result = await fetchRelationsFromIntelgraph({
      mode: 'incoming' as const,
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });

    const rootKey = Object.keys(result.result ?? {})[0];
    const rootNode = result.result?.[rootKey];
    const calledBy = rootNode?.calledBy ?? [];

    // Unified get_callers runtime caller mapping
    const wmiCaller = calledBy.find((x) => x.caller === 'WMI_LPI_RESULT_EVENTID');
    expect(wmiCaller).toBeDefined();
    expect(wmiCaller?.connectionKind).toBe('api_call');

    // Unified get_callers runtime caller mapping
    const irqCaller = calledBy.find((x) => x.caller === 'A_INUM_TQM_STATUS_HI');
    expect(irqCaller).toBeDefined();
    expect(irqCaller?.connectionKind).toBe('api_call');

    await mock.close();
  });

  // ── Gap A: queryApiLogs / queryApiStructWrites / queryApiStructReads / queryStructWriters ──

  test('queryApiLogs returns parsed intelligence_query result for find_api_logs intent', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'intelligence_query') {
          expect(args.intent).toBe('find_api_logs');
          expect(args.apiName).toBe('wlan_send_packet');
          return JSON.stringify({
            status: 'hit',
            data: {
              nodes: [
                { api_name: 'wlan_send_packet', level: 'INFO', template: 'Sending packet len=%d', subsystem: 'wlan', file_path: '/src/wlan.c', line: 42, confidence: 0.9 },
              ],
              edges: [],
            },
            provenance: { intent: 'find_api_logs', source: 'postgres' },
          });
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    const out = await queryApiLogs({ workspaceRoot: '/tmp/ws', apiName: 'wlan_send_packet' });

    expect(out.status).toBe('hit');
    expect(out.data.nodes).toHaveLength(1);
    expect(out.data.nodes[0]?.['api_name']).toBe('wlan_send_packet');
    expect(out.provenance?.intent).toBe('find_api_logs');

    await mock.close();
  });

  test('queryApiLogs uses find_api_logs_by_level intent when logLevel provided', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'intelligence_query') {
          expect(args.intent).toBe('find_api_logs_by_level');
          expect(args.logLevel).toBe('ERROR');
          return JSON.stringify({
            status: 'hit',
            data: { nodes: [], edges: [] },
          });
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    const out = await queryApiLogs({ workspaceRoot: '/tmp/ws', apiName: 'wlan_send_packet', logLevel: 'ERROR' });
    expect(out.status).toBe('hit');

    await mock.close();
  });

  test('queryApiLogs wraps tool failure with deterministic prefix', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name) => {
        if (name === 'intelligence_query') return 'not-valid-json';
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    await expect(
      queryApiLogs({ workspaceRoot: '/tmp/ws', apiName: 'wlan_send_packet' }),
    ).rejects.toThrow('intelligence_query failed:');

    await mock.close();
  });

  test('queryApiStructWrites returns parsed result for find_api_struct_writes intent', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'intelligence_query') {
          expect(args.intent).toBe('find_api_struct_writes');
          expect(args.apiName).toBe('wlan_init');
          return JSON.stringify({
            status: 'hit',
            data: {
              nodes: [
                { writer: 'wlan_init', target: 'wlan_config_t', edge_kind: 'writes_field', confidence: 0.95, derivation: 'static' },
              ],
              edges: [],
            },
            provenance: { intent: 'find_api_struct_writes', source: 'postgres' },
          });
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    const out = await queryApiStructWrites({ workspaceRoot: '/tmp/ws', apiName: 'wlan_init' });

    expect(out.status).toBe('hit');
    expect(out.data.nodes).toHaveLength(1);
    expect(out.data.nodes[0]?.['writer']).toBe('wlan_init');
    expect(out.data.nodes[0]?.['target']).toBe('wlan_config_t');

    await mock.close();
  });

  test('queryApiStructWrites wraps parse failure with deterministic prefix', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name) => {
        if (name === 'intelligence_query') return 'not-valid-json';
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    await expect(
      queryApiStructWrites({ workspaceRoot: '/tmp/ws', apiName: 'wlan_init' }),
    ).rejects.toThrow('intelligence_query failed:');

    await mock.close();
  });

  test('queryApiStructReads returns parsed result for find_api_struct_reads intent', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'intelligence_query') {
          expect(args.intent).toBe('find_api_struct_reads');
          expect(args.apiName).toBe('wlan_process');
          return JSON.stringify({
            status: 'enriched',
            data: {
              nodes: [
                { reader: 'wlan_process', target: 'wlan_state_t', edge_kind: 'reads_field', confidence: 0.88, derivation: 'static' },
                { reader: 'wlan_process', target: 'wlan_config_t', edge_kind: 'reads_field', confidence: 0.75, derivation: 'static' },
              ],
              edges: [],
            },
            provenance: { intent: 'find_api_struct_reads', source: 'postgres' },
          });
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    const out = await queryApiStructReads({ workspaceRoot: '/tmp/ws', apiName: 'wlan_process' });

    expect(out.status).toBe('enriched');
    expect(out.data.nodes).toHaveLength(2);
    expect(out.data.nodes[0]?.['reader']).toBe('wlan_process');
    expect(out.data.nodes[1]?.['target']).toBe('wlan_config_t');

    await mock.close();
  });

  test('queryApiStructReads wraps parse failure with deterministic prefix', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name) => {
        if (name === 'intelligence_query') return 'not-valid-json';
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    await expect(
      queryApiStructReads({ workspaceRoot: '/tmp/ws', apiName: 'wlan_process' }),
    ).rejects.toThrow('intelligence_query failed:');

    await mock.close();
  });

  test('queryStructWriters returns parsed result for find_struct_writers intent', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'intelligence_query') {
          expect(args.intent).toBe('find_struct_writers');
          expect(args.structName).toBe('wlan_config_t');
          return JSON.stringify({
            status: 'hit',
            data: {
              nodes: [
                { writer: 'wlan_init', target: 'wlan_config_t', edge_kind: 'writes_field', confidence: 0.95, derivation: 'static' },
                { writer: 'wlan_reset', target: 'wlan_config_t', edge_kind: 'writes_field', confidence: 0.80, derivation: 'static' },
              ],
              edges: [],
            },
            provenance: { intent: 'find_struct_writers', source: 'postgres' },
          });
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    const out = await queryStructWriters({ workspaceRoot: '/tmp/ws', structName: 'wlan_config_t' });

    expect(out.status).toBe('hit');
    expect(out.data.nodes).toHaveLength(2);
    expect(out.data.nodes[0]?.['writer']).toBe('wlan_init');
    expect(out.data.nodes[1]?.['writer']).toBe('wlan_reset');

    await mock.close();
  });

  test('queryStructWriters wraps parse failure with deterministic prefix', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name) => {
        if (name === 'intelligence_query') return 'not-valid-json';
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    await expect(
      queryStructWriters({ workspaceRoot: '/tmp/ws', structName: 'wlan_config_t' }),
    ).rejects.toThrow('intelligence_query failed:');

    await mock.close();
  });

  // ── Gap B: 3 invocationType variants through full fetchRelationsFromIntelgraph pipeline ──

  test('incoming: runtime_callback_registration_call maps to timer_callback connectionKind', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'lsp_hover') {
          const ch = Number(args.character);
          if (ch <= 2) return 'No hover information available.';
          return 'function my_timer_callback';
        }
        if (name === 'get_callers') {
          return JSON.stringify({
            targetApi: 'my_timer_callback',
            targetFile: '/src/timer.c',
            targetLine: 1,
            callers: [
              {
                name: 'timer_arm_fn',
                filePath: '/src/timer_mgr.c',
                lineNumber: 55,
                callerRole: 'runtime_caller',
                invocationType: 'runtime_callback_registration_call',
                confidence: 0.9,
                source: 'intelligence_query_runtime',
              },
            ],
            registrars: [],
            source: 'intelligence_query_runtime',
            provenance: { stepsAttempted: ['intelligence_query_runtime'], stepUsed: 'intelligence_query_runtime' },
          });
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    const ws = mkdtempSync(join(tmpdir(), 'rw-mcp-cb-reg-'));
    cleanup.push(ws);
    mkdirSync(join(ws, 'src'), { recursive: true });
    const file = join(ws, 'src', 'timer.c');
    writeFileSync(file, 'void my_timer_callback(void) {}\n', 'utf8');

    const result = await fetchRelationsFromIntelgraph({
      mode: 'incoming' as const,
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });

    const calledBy = result.result?.[Object.keys(result.result ?? {})[0]]?.calledBy ?? [];
    const caller = calledBy.find((x) => x.caller === 'timer_arm_fn');
    expect(caller).toBeDefined();
    // runtime_callback_registration_call → timer_callback
    expect(caller?.connectionKind).toBe('timer_callback');

    await mock.close();
  });

  test('incoming: runtime_function_pointer_call maps to interface_registration connectionKind', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'lsp_hover') {
          const ch = Number(args.character);
          if (ch <= 2) return 'No hover information available.';
          return 'function my_fp_handler';
        }
        if (name === 'get_callers') {
          return JSON.stringify({
            targetApi: 'my_fp_handler',
            targetFile: '/src/handler.c',
            targetLine: 1,
            callers: [
              {
                name: 'dispatch_via_fp',
                filePath: '/src/dispatch.c',
                lineNumber: 77,
                callerRole: 'runtime_caller',
                invocationType: 'runtime_function_pointer_call',
                confidence: 0.85,
                source: 'intelligence_query_runtime',
              },
            ],
            registrars: [],
            source: 'intelligence_query_runtime',
            provenance: { stepsAttempted: ['intelligence_query_runtime'], stepUsed: 'intelligence_query_runtime' },
          });
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    const ws = mkdtempSync(join(tmpdir(), 'rw-mcp-fp-call-'));
    cleanup.push(ws);
    mkdirSync(join(ws, 'src'), { recursive: true });
    const file = join(ws, 'src', 'handler.c');
    writeFileSync(file, 'void my_fp_handler(void) {}\n', 'utf8');

    const result = await fetchRelationsFromIntelgraph({
      mode: 'incoming' as const,
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });

    const calledBy = result.result?.[Object.keys(result.result ?? {})[0]]?.calledBy ?? [];
    const caller = calledBy.find((x) => x.caller === 'dispatch_via_fp');
    expect(caller).toBeDefined();
    // runtime_function_pointer_call → interface_registration
    expect(caller?.connectionKind).toBe('interface_registration');

    await mock.close();
  });

  test('incoming: runtime_unknown_call_path maps to api_call connectionKind (default)', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'lsp_hover') {
          const ch = Number(args.character);
          if (ch <= 2) return 'No hover information available.';
          return 'function my_unknown_path_target';
        }
        if (name === 'get_callers') {
          return JSON.stringify({
            targetApi: 'my_unknown_path_target',
            targetFile: '/src/target.c',
            targetLine: 1,
            callers: [
              {
                name: 'unknown_path_caller',
                filePath: '/src/caller.c',
                lineNumber: 33,
                callerRole: 'runtime_caller',
                invocationType: 'runtime_unknown_call_path',
                confidence: 0.5,
                source: 'intelligence_query_runtime',
              },
            ],
            registrars: [],
            source: 'intelligence_query_runtime',
            provenance: { stepsAttempted: ['intelligence_query_runtime'], stepUsed: 'intelligence_query_runtime' },
          });
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.INTELGRAPH_URL = mock.url;

    const ws = mkdtempSync(join(tmpdir(), 'rw-mcp-unknown-path-'));
    cleanup.push(ws);
    mkdirSync(join(ws, 'src'), { recursive: true });
    const file = join(ws, 'src', 'target.c');
    writeFileSync(file, 'void my_unknown_path_target(void) {}\n', 'utf8');

    const result = await fetchRelationsFromIntelgraph({
      mode: 'incoming' as const,
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });

    const calledBy = result.result?.[Object.keys(result.result ?? {})[0]]?.calledBy ?? [];
    const caller = calledBy.find((x) => x.caller === 'unknown_path_caller');
    expect(caller).toBeDefined();
    // runtime_unknown_call_path → api_call (default fallback)
    expect(caller?.connectionKind).toBe('api_call');

    await mock.close();
  });

  // ── Gap C: HTTP connection failure ──

  test('fetchRelationsFromIntelgraph returns graceful error when MCP server is unreachable', async () => {
    // Start a mock server, get its URL, then stop it before calling fetchRelationsFromIntelgraph
    const mock = await startMockMcpServer({
      onToolCall: () => 'should not be called',
    });
    const deadUrl = mock.url;
    await mock.close(); // Stop the server — port is now closed

    process.env.INTELGRAPH_URL = deadUrl;

    const ws = mkdtempSync(join(tmpdir(), 'rw-mcp-conn-fail-'));
    cleanup.push(ws);
    mkdirSync(join(ws, 'src'), { recursive: true });
    const file = join(ws, 'src', 'entry.c');
    writeFileSync(file, 'void my_fn(void) {}\n', 'utf8');

    // Should reject with a network/connection error, not crash the process
    let caughtError: unknown;
    try {
      await fetchRelationsFromIntelgraph({
        mode: 'incoming' as const,
        filePath: file,
        line: 1,
        character: 6,
        workspaceRoot: ws,
      });
    } catch (e) {
      caughtError = e;
    }
    expect(caughtError).toBeInstanceOf(Error);
  });
});

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => resolve(body));
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}
