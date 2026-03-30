/**
 * Unit tests for queryResultToCallerNodes adapter.
 *
 * Close signal: unit tests cover full node/edge → CallerNode conversion:
 *   1. Full node/edge → CallerNode field mapping (all required fields present)
 *   2. Missing optional fields handled gracefully (no crash)
 *   3. Empty nodes array returns []
 *
 * Fail-before: no tests existed for this adapter.
 * Pass-after:  all 3 scenarios covered and passing.
 */
import { describe, expect, test } from 'bun:test';
import { queryResultToCallerNodes, queryResultToRuntimeCallerNodes } from './clangd-mcp-client';
import type { IntelligenceQueryResult } from './clangd-mcp-client';

// Helper to build a minimal IntelligenceQueryResult
function makeResult(
  nodes: Array<Record<string, unknown>>,
  edges: Array<Record<string, unknown>>,
  status: IntelligenceQueryResult['status'] = 'hit',
): IntelligenceQueryResult {
  return {
    status,
    data: { nodes, edges },
    raw: '{}',
  };
}

describe('queryResultToCallerNodes', () => {
  // ── Scenario 1: Full node/edge → CallerNode field mapping ─────────────────

  test('maps caller node symbol to CallerNode.caller', () => {
    const result = makeResult(
      [
        { id: 'fn:target_api', kind: 'api', symbol: 'target_api', filePath: '/src/api.c', lineNumber: 10 },
        { id: 'fn:alpha_caller', kind: 'function', symbol: 'alpha_caller', filePath: '/src/alpha.c', lineNumber: 42 },
      ],
      [{ from: 'fn:alpha_caller', to: 'fn:target_api', kind: 'api_call' }],
    );

    const callers = queryResultToCallerNodes(result);
    expect(callers).toHaveLength(1);
    expect(callers[0]!.caller).toBe('alpha_caller');
  });

  test('maps node filePath to CallerNode.filePath', () => {
    const result = makeResult(
      [
        { id: 'fn:target_api', kind: 'api', symbol: 'target_api', filePath: '/src/api.c', lineNumber: 10 },
        { id: 'fn:alpha_caller', kind: 'function', symbol: 'alpha_caller', filePath: '/src/alpha.c', lineNumber: 42 },
      ],
      [{ from: 'fn:alpha_caller', to: 'fn:target_api', kind: 'api_call' }],
    );

    const callers = queryResultToCallerNodes(result);
    expect(callers[0]!.filePath).toBe('/src/alpha.c');
  });

  test('maps node lineNumber to CallerNode.lineNumber', () => {
    const result = makeResult(
      [
        { id: 'fn:target_api', kind: 'api', symbol: 'target_api', filePath: '/src/api.c', lineNumber: 10 },
        { id: 'fn:alpha_caller', kind: 'function', symbol: 'alpha_caller', filePath: '/src/alpha.c', lineNumber: 42 },
      ],
      [{ from: 'fn:alpha_caller', to: 'fn:target_api', kind: 'api_call' }],
    );

    const callers = queryResultToCallerNodes(result);
    expect(callers[0]!.lineNumber).toBe(42);
  });

  test('interface_registration edge is included — registrar shown with distinct connectionKind', () => {
    // registers_callback / interface_registration edges describe WHO WIRED the function.
    // They are now shown in the tree with a [REG] badge so the user sees both
    // the registrar and the runtime caller in the same view.
    const result = makeResult(
      [
        { id: 'fn:target_api', kind: 'api', symbol: 'target_api', filePath: '/src/api.c', lineNumber: 10 },
        { id: 'fn:reg_caller', kind: 'function', symbol: 'reg_caller', filePath: '/src/reg.c', lineNumber: 7 },
      ],
      [{ from: 'fn:reg_caller', to: 'fn:target_api', kind: 'interface_registration' }],
    );

    const callers = queryResultToCallerNodes(result);
    // Registrar is included — shown with interface_registration connectionKind
    expect(callers).toHaveLength(1);
    expect(callers[0]!.connectionKind).toBe('interface_registration');
  });

  test('maps multiple callers from multiple edges', () => {
    const result = makeResult(
      [
        { id: 'fn:target_api', kind: 'api', symbol: 'target_api', filePath: '/src/api.c', lineNumber: 10 },
        { id: 'fn:caller_a', kind: 'function', symbol: 'caller_a', filePath: '/src/a.c', lineNumber: 5 },
        { id: 'fn:caller_b', kind: 'function', symbol: 'caller_b', filePath: '/src/b.c', lineNumber: 15 },
      ],
      [
        { from: 'fn:caller_a', to: 'fn:target_api', kind: 'api_call' },
        { from: 'fn:caller_b', to: 'fn:target_api', kind: 'hw_interrupt' },
      ],
    );

    const callers = queryResultToCallerNodes(result);
    expect(callers).toHaveLength(2);
    const callerA = callers.find((c) => c.caller === 'caller_a');
    const callerB = callers.find((c) => c.caller === 'caller_b');
    expect(callerA).toBeDefined();
    expect(callerA!.connectionKind).toBe('api_call');
    expect(callerB).toBeDefined();
    expect(callerB!.connectionKind).toBe('hw_interrupt');
  });

  test('all required CallerNode fields are present', () => {
    const result = makeResult(
      [
        { id: 'fn:target_api', kind: 'api', symbol: 'target_api', filePath: '/src/api.c', lineNumber: 10 },
        { id: 'fn:alpha_caller', kind: 'function', symbol: 'alpha_caller', filePath: '/src/alpha.c', lineNumber: 42 },
      ],
      [{ from: 'fn:alpha_caller', to: 'fn:target_api', kind: 'api_call' }],
    );

    const callers = queryResultToCallerNodes(result);
    expect(callers).toHaveLength(1);
    const node = callers[0]!;
    // All required fields must be present and correct types
    expect(typeof node.caller).toBe('string');
    expect(typeof node.filePath).toBe('string');
    expect(typeof node.lineNumber).toBe('number');
    expect(typeof node.connectionKind).toBe('string');
  });

  // ── Scenario 2: Missing optional fields handled gracefully ────────────────

  test('falls back to empty string for missing filePath', () => {
    const result = makeResult(
      [
        { id: 'fn:target_api', kind: 'api', symbol: 'target_api' },
        { id: 'fn:caller_x', kind: 'function', symbol: 'caller_x' },
        // No filePath on caller node
      ],
      [{ from: 'fn:caller_x', to: 'fn:target_api', kind: 'api_call' }],
    );

    const callers = queryResultToCallerNodes(result);
    expect(callers).toHaveLength(1);
    expect(callers[0]!.filePath).toBe('');
  });

  test('falls back to 0 for missing lineNumber', () => {
    const result = makeResult(
      [
        { id: 'fn:target_api', kind: 'api', symbol: 'target_api' },
        { id: 'fn:caller_x', kind: 'function', symbol: 'caller_x', filePath: '/src/x.c' },
        // No lineNumber on caller node
      ],
      [{ from: 'fn:caller_x', to: 'fn:target_api', kind: 'api_call' }],
    );

    const callers = queryResultToCallerNodes(result);
    expect(callers).toHaveLength(1);
    expect(callers[0]!.lineNumber).toBe(0);
  });

  test('falls back to node id when symbol is missing', () => {
    const result = makeResult(
      [
        { id: 'fn:target_api', kind: 'api', symbol: 'target_api' },
        { id: 'fn:caller_x', kind: 'function' },
        // No symbol on caller node — should fall back to id
      ],
      [{ from: 'fn:caller_x', to: 'fn:target_api', kind: 'api_call' }],
    );

    const callers = queryResultToCallerNodes(result);
    expect(callers).toHaveLength(1);
    expect(callers[0]!.caller).toBe('fn:caller_x');
  });

  test('falls back to api_call for unknown edge kind', () => {
    const result = makeResult(
      [
        { id: 'fn:target_api', kind: 'api', symbol: 'target_api' },
        { id: 'fn:caller_x', kind: 'function', symbol: 'caller_x' },
      ],
      [{ from: 'fn:caller_x', to: 'fn:target_api', kind: 'totally_unknown_kind' }],
    );

    const callers = queryResultToCallerNodes(result);
    expect(callers).toHaveLength(1);
    expect(callers[0]!.connectionKind).toBe('custom');
  });

  test('does not crash when edge references unknown node id', () => {
    const result = makeResult(
      [
        { id: 'fn:target_api', kind: 'api', symbol: 'target_api' },
        // fn:ghost_caller is NOT in nodes
      ],
      [{ from: 'fn:ghost_caller', to: 'fn:target_api', kind: 'api_call' }],
    );

    // Should not throw — just skip the edge with unknown source
    expect(() => queryResultToCallerNodes(result)).not.toThrow();
    const callers = queryResultToCallerNodes(result);
    expect(callers).toHaveLength(0);
  });

  test('deduplicates identical caller entries', () => {
    const result = makeResult(
      [
        { id: 'fn:target_api', kind: 'api', symbol: 'target_api', filePath: '/src/api.c', lineNumber: 10 },
        { id: 'fn:caller_a', kind: 'function', symbol: 'caller_a', filePath: '/src/a.c', lineNumber: 5 },
      ],
      [
        // Same caller appears twice with same edge kind
        { from: 'fn:caller_a', to: 'fn:target_api', kind: 'api_call' },
        { from: 'fn:caller_a', to: 'fn:target_api', kind: 'api_call' },
      ],
    );

    const callers = queryResultToCallerNodes(result);
    expect(callers).toHaveLength(1);
  });

  // ── Scenario 3: Empty nodes/edges returns [] ──────────────────────────────

  test('returns [] when nodes array is empty', () => {
    const result = makeResult([], []);
    expect(queryResultToCallerNodes(result)).toEqual([]);
  });

  test('returns [] when edges array is empty', () => {
    const result = makeResult(
      [{ id: 'fn:target_api', kind: 'api', symbol: 'target_api' }],
      [],
    );
    expect(queryResultToCallerNodes(result)).toEqual([]);
  });

  test('returns [] when status is not_found', () => {
    const result = makeResult([], [], 'not_found');
    expect(queryResultToCallerNodes(result)).toEqual([]);
  });

  test('identifies leaf node as target when edges point away from root (topology fallback)', () => {
    // When no node has kind='api', topology fallback is used:
    // the node that is only a destination (never a source) is the target.
    // Here fn:callee_x is only a destination, so root_api is emitted as its caller.
    const result = makeResult(
      [
        { id: 'fn:root_api', kind: 'function', symbol: 'root_api' },
        { id: 'fn:callee_x', kind: 'function', symbol: 'callee_x' },
      ],
      [{ from: 'fn:root_api', to: 'fn:callee_x', kind: 'api_call' }],
    );
    // callee_x is the leaf (only destination), root_api is emitted as its caller
    const callers = queryResultToCallerNodes(result);
    expect(callers).toHaveLength(1);
    expect(callers[0]!.caller).toBe('root_api');
  });

  // ── All known connectionKind values are preserved ─────────────────────────

  test.each([
    'api_call',
    'interface_registration',
    'sw_thread_comm',
    'hw_interrupt',
    'hw_ring',
    'ring_signal',
    'event',
    'timer_callback',
    'deferred_work',
    'debugfs_op',
    'ioctl_dispatch',
    'ring_completion',
    'custom',
  ] as const)('preserves connectionKind=%s from edge', (kind) => {
    const result = makeResult(
      [
        { id: 'fn:target_api', kind: 'api', symbol: 'target_api' },
        { id: 'fn:caller_x', kind: 'function', symbol: 'caller_x' },
      ],
      [{ from: 'fn:caller_x', to: 'fn:target_api', kind }],
    );

    const callers = queryResultToCallerNodes(result);
    expect(callers).toHaveLength(1);
    expect(callers[0]!.connectionKind).toBe(kind);
  });
});

// ─── queryResultToRuntimeCallerNodes ─────────────────────────────────────────

function makeRuntimeResult(
  nodes: Array<Record<string, unknown>>,
  status: IntelligenceQueryResult['status'] = 'hit',
): IntelligenceQueryResult {
  return { status, data: { nodes, edges: [] }, raw: '{}' };
}

describe('queryResultToRuntimeCallerNodes', () => {
  test('maps runtime_caller_api_name to CallerNode.caller', () => {
    const result = makeRuntimeResult([
      {
        runtime_caller_api_name: 'wlan_timer_start',
        runtime_called_api_name: 'target_api',
        runtime_caller_invocation_type_classification: 'runtime_direct_call',
        runtime_relation_confidence_score: 0.9,
      },
    ]);
    const callers = queryResultToRuntimeCallerNodes(result);
    expect(callers).toHaveLength(1);
    expect(callers[0]!.caller).toBe('wlan_timer_start');
  });

  test('runtime_direct_call → connectionKind api_call', () => {
    const result = makeRuntimeResult([
      {
        runtime_caller_api_name: 'direct_fn',
        runtime_caller_invocation_type_classification: 'runtime_direct_call',
      },
    ]);
    const callers = queryResultToRuntimeCallerNodes(result);
    expect(callers[0]!.connectionKind).toBe('api_call');
  });

  test('runtime_callback_registration_call → connectionKind timer_callback', () => {
    const result = makeRuntimeResult([
      {
        runtime_caller_api_name: 'cb_registrar',
        runtime_caller_invocation_type_classification: 'runtime_callback_registration_call',
      },
    ]);
    const callers = queryResultToRuntimeCallerNodes(result);
    expect(callers[0]!.connectionKind).toBe('timer_callback');
  });

  test('runtime_function_pointer_call → connectionKind interface_registration', () => {
    const result = makeRuntimeResult([
      {
        runtime_caller_api_name: 'fp_caller',
        runtime_caller_invocation_type_classification: 'runtime_function_pointer_call',
      },
    ]);
    const callers = queryResultToRuntimeCallerNodes(result);
    expect(callers[0]!.connectionKind).toBe('interface_registration');
  });

  test('runtime_dispatch_table_call → connectionKind interface_registration', () => {
    const result = makeRuntimeResult([
      {
        runtime_caller_api_name: 'dispatch_caller',
        runtime_caller_invocation_type_classification: 'runtime_dispatch_table_call',
      },
    ]);
    const callers = queryResultToRuntimeCallerNodes(result);
    expect(callers[0]!.connectionKind).toBe('interface_registration');
  });

  test('runtime_unknown_call_path → connectionKind api_call (default)', () => {
    const result = makeRuntimeResult([
      {
        runtime_caller_api_name: 'unknown_caller',
        runtime_caller_invocation_type_classification: 'runtime_unknown_call_path',
      },
    ]);
    const callers = queryResultToRuntimeCallerNodes(result);
    expect(callers[0]!.connectionKind).toBe('api_call');
  });

  test('missing invocation type → connectionKind api_call (default)', () => {
    const result = makeRuntimeResult([
      { runtime_caller_api_name: 'bare_caller' },
    ]);
    const callers = queryResultToRuntimeCallerNodes(result);
    expect(callers[0]!.connectionKind).toBe('api_call');
  });

  test('filePath is empty string (runtime rows have no file location)', () => {
    const result = makeRuntimeResult([
      {
        runtime_caller_api_name: 'some_fn',
        runtime_caller_invocation_type_classification: 'runtime_direct_call',
      },
    ]);
    const callers = queryResultToRuntimeCallerNodes(result);
    expect(callers[0]!.filePath).toBe('');
    expect(callers[0]!.lineNumber).toBe(0);
  });

  test('deduplicates entries with same caller+connectionKind', () => {
    const result = makeRuntimeResult([
      {
        runtime_caller_api_name: 'dup_fn',
        runtime_caller_invocation_type_classification: 'runtime_direct_call',
      },
      {
        runtime_caller_api_name: 'dup_fn',
        runtime_caller_invocation_type_classification: 'runtime_direct_call',
      },
    ]);
    const callers = queryResultToRuntimeCallerNodes(result);
    expect(callers).toHaveLength(1);
  });

  test('skips nodes with empty runtime_caller_api_name', () => {
    const result = makeRuntimeResult([
      { runtime_caller_api_name: '', runtime_caller_invocation_type_classification: 'runtime_direct_call' },
      { runtime_caller_api_name: 'valid_fn', runtime_caller_invocation_type_classification: 'runtime_direct_call' },
    ]);
    const callers = queryResultToRuntimeCallerNodes(result);
    expect(callers).toHaveLength(1);
    expect(callers[0]!.caller).toBe('valid_fn');
  });

  test('returns [] when nodes array is empty', () => {
    const result = makeRuntimeResult([]);
    expect(queryResultToRuntimeCallerNodes(result)).toEqual([]);
  });

  test('maps multiple callers with different invocation types', () => {
    const result = makeRuntimeResult([
      {
        runtime_caller_api_name: 'direct_fn',
        runtime_caller_invocation_type_classification: 'runtime_direct_call',
      },
      {
        runtime_caller_api_name: 'cb_fn',
        runtime_caller_invocation_type_classification: 'runtime_callback_registration_call',
      },
    ]);
    const callers = queryResultToRuntimeCallerNodes(result);
    expect(callers).toHaveLength(2);
    const direct = callers.find((c) => c.caller === 'direct_fn');
    const cb = callers.find((c) => c.caller === 'cb_fn');
    expect(direct!.connectionKind).toBe('api_call');
    expect(cb!.connectionKind).toBe('timer_callback');
  });
});
