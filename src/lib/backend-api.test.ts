/**
 * Unit tests for createBackendApi.
 *
 * Strategy: pass an explicit `deps` object with stub implementations of every
 * underlying client function. This isolates the facade from the real MCP
 * transport so the tests run in milliseconds and need no daemon.
 */
import { describe, expect, test } from 'bun:test';
import { createBackendApi, type BackendApiDeps } from './backend-api';
import type { IntelligenceQueryResult } from './intelgraph-client';
import type { BackendRelationPayload } from './backend-types';

const WORKSPACE_ROOT = '/tmp/fake-workspace';
const MCP_URL = 'http://localhost:9999/mcp';

/**
 * Build an empty IntelligenceQueryResult shaped however the caller wants.
 * Avoids repeating the same boilerplate across tests.
 */
function makeQueryResult(nodes: Array<Record<string, unknown>>): IntelligenceQueryResult {
  return {
    status: 'hit',
    data: { nodes, edges: [] },
    raw: JSON.stringify({ nodes }),
  };
}

/**
 * Build a BackendRelationPayload for a single root with the given callers
 * (incoming) or callees (outgoing).
 */
function makeRelationPayload(
  mode: 'incoming' | 'outgoing',
  rootName: string,
  items: Array<{ name: string; filePath: string; lineNumber: number }>,
): BackendRelationPayload {
  return {
    mode,
    provider: 'test',
    result: {
      [rootName]: {
        symbolKind: 12,
        filePath: items[0]?.filePath,
        lineNumber: items[0]?.lineNumber,
        ...(mode === 'incoming'
          ? {
              calledBy: items.map((i) => ({
                caller: i.name,
                filePath: i.filePath,
                lineNumber: i.lineNumber,
              })),
            }
          : {
              calls: items.map((i) => ({
                callee: i.name,
                filePath: i.filePath,
                lineNumber: i.lineNumber,
              })),
            }),
      },
    },
  };
}

/**
 * Build a fully stubbed deps object. Each test overrides only what it cares
 * about; everything else throws if accidentally called, which makes test
 * intent obvious.
 */
function makeDeps(overrides: Partial<BackendApiDeps>): BackendApiDeps {
  const notImplemented = (name: string) => () => {
    throw new Error(`unexpected call to ${name}`);
  };
  return {
    ensureSnapshotInitialized: overrides.ensureSnapshotInitialized ?? (notImplemented('ensureSnapshotInitialized') as never),
    fetchRelations: overrides.fetchRelations ?? (notImplemented('fetchRelations') as never),
    intelligenceQuery: overrides.intelligenceQuery ?? (notImplemented('intelligenceQuery') as never),
    queryApiLogs: overrides.queryApiLogs ?? (notImplemented('queryApiLogs') as never),
    queryApiStructWrites: overrides.queryApiStructWrites ?? (notImplemented('queryApiStructWrites') as never),
    queryApiStructReads: overrides.queryApiStructReads ?? (notImplemented('queryApiStructReads') as never),
    queryModuleImports: overrides.queryModuleImports ?? (notImplemented('queryModuleImports') as never),
    queryModuleDependents: overrides.queryModuleDependents ?? (notImplemented('queryModuleDependents') as never),
    queryModuleSymbols: overrides.queryModuleSymbols ?? (notImplemented('queryModuleSymbols') as never),
    queryClassInheritance: overrides.queryClassInheritance ?? (notImplemented('queryClassInheritance') as never),
    queryClassSubtypes: overrides.queryClassSubtypes ?? (notImplemented('queryClassSubtypes') as never),
    queryInterfaceImplementors: overrides.queryInterfaceImplementors ?? (notImplemented('queryInterfaceImplementors') as never),
  };
}

describe('createBackendApi', () => {
  test('throws when workspaceRoot is missing', () => {
    expect(() => createBackendApi({ workspaceRoot: '' })).toThrow(/workspaceRoot/);
  });

  test('ensureSnapshot forwards workspaceRoot and mcpUrl', async () => {
    const captured: { args?: { workspaceRoot: string; mcpUrl?: string } } = {};
    const api = createBackendApi(
      { workspaceRoot: WORKSPACE_ROOT, mcpUrl: MCP_URL },
      makeDeps({
        ensureSnapshotInitialized: async (args) => {
          captured.args = args;
          return 42;
        },
      }),
    );

    const id = await api.ensureSnapshot();
    expect(id).toBe(42);
    expect(captured.args).toEqual({ workspaceRoot: WORKSPACE_ROOT, mcpUrl: MCP_URL });
  });

  test('getCallersAt flattens incoming payload into items', async () => {
    let capturedQuery: unknown = null;
    const api = createBackendApi(
      { workspaceRoot: WORKSPACE_ROOT, mcpUrl: MCP_URL },
      makeDeps({
        fetchRelations: async (q) => {
          capturedQuery = q;
          return makeRelationPayload('incoming', 'processOrder', [
            { name: 'caller_a', filePath: '/src/a.ts', lineNumber: 10 },
            { name: 'caller_b', filePath: '/src/b.ts', lineNumber: 20 },
          ]);
        },
      }),
    );

    const result = await api.getCallersAt({
      filePath: '/src/order.ts',
      lineNumber: 5,
      character: 3,
    });

    expect(capturedQuery).toEqual({
      mode: 'incoming',
      filePath: '/src/order.ts',
      line: 5,
      character: 3,
      workspaceRoot: WORKSPACE_ROOT,
      mcpUrl: MCP_URL,
    });
    expect(result.provider).toBe('test');
    expect(result.items).toHaveLength(2);
    expect((result.items[0] as { caller: string }).caller).toBe('caller_a');
  });

  test('getCallersAt defaults character to 1 when omitted', async () => {
    const captured: { query?: { character: number } } = {};
    const api = createBackendApi(
      { workspaceRoot: WORKSPACE_ROOT },
      makeDeps({
        fetchRelations: async (q) => {
          captured.query = { character: q.character };
          return makeRelationPayload('incoming', 'foo', []);
        },
      }),
    );

    await api.getCallersAt({ filePath: '/src/x.ts', lineNumber: 1 });
    expect(captured.query?.character).toBe(1);
  });

  test('getCalleesAt flattens outgoing payload into items', async () => {
    const api = createBackendApi(
      { workspaceRoot: WORKSPACE_ROOT },
      makeDeps({
        fetchRelations: async () =>
          makeRelationPayload('outgoing', 'processOrder', [
            { name: 'cache.set', filePath: '/src/cache.ts', lineNumber: 7 },
          ]),
      }),
    );

    const result = await api.getCalleesAt({ filePath: '/src/o.ts', lineNumber: 1 });
    expect(result.items).toHaveLength(1);
    expect((result.items[0] as { callee: string }).callee).toBe('cache.set');
  });

  test('getApiLogs adapts the query result into LogRow[]', async () => {
    const api = createBackendApi(
      { workspaceRoot: WORKSPACE_ROOT },
      makeDeps({
        queryApiLogs: async (args) => {
          expect(args.apiName).toBe('processOrder');
          expect(args.logLevel).toBe('ERROR');
          return makeQueryResult([
            {
              level: 'ERROR',
              template: 'failed to persist',
              subsystem: 'orders',
              file_path: '/src/order.ts',
              line: 42,
              confidence: 0.91,
            },
          ]);
        },
      }),
    );

    const rows = await api.getApiLogs({ apiName: 'processOrder', level: 'ERROR' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      level: 'ERROR',
      template: 'failed to persist',
      subsystem: 'orders',
      filePath: '/src/order.ts',
      line: 42,
      confidence: 0.91,
    });
  });

  test('getApiStructWrites adapts result into StructWriterRow[]', async () => {
    const api = createBackendApi(
      { workspaceRoot: WORKSPACE_ROOT },
      makeDeps({
        queryApiStructWrites: async () =>
          makeQueryResult([
            { writer: 'processOrder', target: 'Order', edge_kind: 'writes_field', confidence: 0.8, derivation: 'static' },
          ]),
      }),
    );

    const rows = await api.getApiStructWrites({ apiName: 'processOrder' });
    expect(rows).toHaveLength(1);
    expect(rows[0].writer).toBe('processOrder');
    expect(rows[0].target).toBe('Order');
    expect(rows[0].edgeKind).toBe('writes_field');
  });

  test('getApiStructReads adapts result into StructReaderRow[]', async () => {
    const api = createBackendApi(
      { workspaceRoot: WORKSPACE_ROOT },
      makeDeps({
        queryApiStructReads: async () =>
          makeQueryResult([
            { reader: 'processOrder', target: 'Order', edge_kind: 'reads_field', confidence: 0.7, derivation: 'static' },
          ]),
      }),
    );

    const rows = await api.getApiStructReads({ apiName: 'processOrder' });
    expect(rows).toHaveLength(1);
    expect(rows[0].reader).toBe('processOrder');
    expect(rows[0].edgeKind).toBe('reads_field');
  });

  test('getModuleImports adapts result into ModuleRow[]', async () => {
    const api = createBackendApi(
      { workspaceRoot: WORKSPACE_ROOT },
      makeDeps({
        queryModuleImports: async (args) => {
          expect(args.moduleName).toBe('module:src/order.ts');
          return makeQueryResult([
            { canonical_name: 'module:src/cache.ts', file_path: 'src/cache.ts' },
            { canonical_name: 'module:src/logger.ts', file_path: 'src/logger.ts' },
          ]);
        },
      }),
    );

    const rows = await api.getModuleImports({ moduleName: 'module:src/order.ts' });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ name: 'module:src/cache.ts', filePath: 'src/cache.ts' });
  });

  test('getClassInheritance adapts result into ClassRow[]', async () => {
    const api = createBackendApi(
      { workspaceRoot: WORKSPACE_ROOT },
      makeDeps({
        queryClassInheritance: async () =>
          makeQueryResult([{ canonical_name: 'BaseEntity', file_path: 'src/base.ts', line: 12, kind: 'class' }]),
      }),
    );

    const rows = await api.getClassInheritance({ className: 'Order' });
    expect(rows).toEqual([
      { name: 'BaseEntity', filePath: 'src/base.ts', lineNumber: 12, kind: 'class' },
    ]);
  });

  test('getInterfaceImplementors forwards interfaceName to the underlying client', async () => {
    const captured: { interfaceName?: string } = {};
    const api = createBackendApi(
      { workspaceRoot: WORKSPACE_ROOT },
      makeDeps({
        queryInterfaceImplementors: async (args) => {
          captured.interfaceName = args.interfaceName;
          return makeQueryResult([{ canonical_name: 'OrderRepository' }]);
        },
      }),
    );

    const rows = await api.getInterfaceImplementors({ interfaceName: 'Repository' });
    expect(captured.interfaceName).toBe('Repository');
    expect(rows[0].name).toBe('OrderRepository');
  });

  test('query escape hatch forwards intent and params verbatim', async () => {
    let captured: unknown = null;
    const api = createBackendApi(
      { workspaceRoot: WORKSPACE_ROOT, mcpUrl: MCP_URL },
      makeDeps({
        intelligenceQuery: async (args) => {
          captured = args;
          return makeQueryResult([]);
        },
      }),
    );

    await api.query({
      intent: 'find_module_symbols',
      params: { symbol: 'module:src/foo.ts', maxNodes: 50 },
    });

    expect(captured).toEqual({
      workspaceRoot: WORKSPACE_ROOT,
      mcpUrl: MCP_URL,
      intent: 'find_module_symbols',
      params: { symbol: 'module:src/foo.ts', maxNodes: 50 },
    });
  });

  test('uses default deps when none are provided (no throw at construction)', () => {
    // Just smoke-test that construction with default deps works. We don't
    // actually call any methods because they would hit the real transport.
    const api = createBackendApi({ workspaceRoot: WORKSPACE_ROOT });
    expect(typeof api.getCallersAt).toBe('function');
    expect(typeof api.getApiLogs).toBe('function');
    expect(typeof api.query).toBe('function');
  });
});
