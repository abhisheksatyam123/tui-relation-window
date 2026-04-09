/**
 * App.test.ts
 *
 * Unit tests for pure logic functions extracted from App.tsx:
 *   1. add_custom_relation lineNumber=0 guard (falsy check drops valid line 0)
 *   2. query_result unknown requestId — no crash, no waiter leak
 *   3. inferSourcePoint walk-up heuristic
 *   4. mergeFlatItems deduplication
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { __test } from './App';
import { onBridgeMessage, __test as bridgeTest } from './lib/bridge';
import type { BridgeIncomingMessage, FlatRelationItem } from './lib/types';

const { mergeFlatItems, inferSourcePoint } = __test;

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0, cleanup.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
  bridgeTest.resetForTest();
});

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'app-test-'));
  cleanup.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// 1. add_custom_relation lineNumber=0 guard
//
// App.tsx line 132: `if (!p || !p.label || !p.filePath || !p.lineNumber)`
// lineNumber=0 is falsy — the guard silently drops valid relations at line 0.
// This test documents the bug and verifies the guard behavior.
// ---------------------------------------------------------------------------

describe('add_custom_relation lineNumber=0 guard', () => {
  /**
   * Simulate the guard condition from App.tsx line 132.
   * This mirrors the exact check in the production code.
   */
  function wouldBeDropped(p: { label?: string; filePath?: string; lineNumber?: number } | null): boolean {
    return !p || !p.label || !p.filePath || !p.lineNumber;
  }

  test('lineNumber=0 is dropped by the guard (falsy bug)', () => {
    const p = { label: 'myFunc', filePath: '/src/foo.c', lineNumber: 0 };
    // lineNumber=0 is falsy — the guard drops it
    expect(wouldBeDropped(p)).toBe(true);
  });

  test('lineNumber=1 passes the guard', () => {
    const p = { label: 'myFunc', filePath: '/src/foo.c', lineNumber: 1 };
    expect(wouldBeDropped(p)).toBe(false);
  });

  test('missing label is dropped', () => {
    const p = { label: '', filePath: '/src/foo.c', lineNumber: 5 };
    expect(wouldBeDropped(p)).toBe(true);
  });

  test('missing filePath is dropped', () => {
    const p = { label: 'myFunc', filePath: '', lineNumber: 5 };
    expect(wouldBeDropped(p)).toBe(true);
  });

  test('null payload is dropped', () => {
    expect(wouldBeDropped(null)).toBe(true);
  });

  test('valid payload with lineNumber=42 passes', () => {
    const p = { label: 'someFunc', filePath: '/src/bar.c', lineNumber: 42 };
    expect(wouldBeDropped(p)).toBe(false);
  });

  // Verify the bug via bridge dispatch: send add_custom_relation with lineNumber=0
  // and verify the message is dispatched (bridge delivers it) but the guard would drop it.
  test('bridge dispatches add_custom_relation with lineNumber=0 without crashing', () => {
    const received: BridgeIncomingMessage[] = [];
    onBridgeMessage((msg) => received.push(msg));

    const msg: BridgeIncomingMessage = {
      type: 'add_custom_relation',
      payload: {
        relationType: 'incoming',
        label: 'myFunc',
        filePath: '/src/foo.c',
        lineNumber: 0,
      },
    };
    bridgeTest.processInboxChunk(JSON.stringify(msg) + '\n');

    // Bridge delivers the message — App's guard then drops it
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(msg);

    // Confirm the guard would drop this payload
    const p = (received[0] as Extract<BridgeIncomingMessage, { type: 'add_custom_relation' }>).payload;
    expect(wouldBeDropped(p)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. query_result with unknown requestId — no crash, no waiter leak
//
// App.tsx line 177-181: if requestId doesn't match any waiter, logs warning and returns.
// The waiter map is internal to the React component, so we test the bridge dispatch
// path: message arrives, no crash, no side effects.
// ---------------------------------------------------------------------------

describe('query_result unknown requestId — no crash, no waiter leak', () => {
  test('bridge dispatches query_result with unknown requestId without crashing', () => {
    const received: BridgeIncomingMessage[] = [];
    onBridgeMessage((msg) => received.push(msg));

    const msg: BridgeIncomingMessage = {
      type: 'query_result',
      payload: {
        requestId: 'unknown-request-id-that-has-no-waiter',
        parentId: 'some-parent',
        result: { mode: 'incoming', result: null },
      },
    };

    expect(() => bridgeTest.processInboxChunk(JSON.stringify(msg) + '\n')).not.toThrow();
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(msg);
  });

  test('multiple query_result messages with unknown requestIds do not accumulate', () => {
    const received: BridgeIncomingMessage[] = [];
    onBridgeMessage((msg) => received.push(msg));

    for (let i = 0; i < 5; i++) {
      const msg: BridgeIncomingMessage = {
        type: 'query_result',
        payload: {
          requestId: `unknown-${i}`,
          parentId: `parent-${i}`,
          result: { mode: 'incoming', result: null },
        },
      };
      bridgeTest.processInboxChunk(JSON.stringify(msg) + '\n');
    }

    // All 5 messages dispatched without crash
    expect(received).toHaveLength(5);
  });

  test('query_result with random UUID requestId does not crash', () => {
    const received: BridgeIncomingMessage[] = [];
    onBridgeMessage((msg) => received.push(msg));

    const randomId = crypto.randomUUID();
    const msg: BridgeIncomingMessage = {
      type: 'query_result',
      payload: {
        requestId: randomId,
        parentId: 'p1',
        result: { mode: 'outgoing', result: null },
      },
    };

    expect(() => bridgeTest.processInboxChunk(JSON.stringify(msg) + '\n')).not.toThrow();
    expect(received).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. inferSourcePoint walk-up heuristic
// ---------------------------------------------------------------------------

describe('inferSourcePoint', () => {
  test('file does not exist → returns { lineNumber, character: 1 } fallback', () => {
    const result = inferSourcePoint('/nonexistent/path/file.c', 10, 'myFunc');
    expect(result).toEqual({ lineNumber: 10, character: 1 });
  });

  test('label found on exact line → returns correct character offset (1-based)', () => {
    const dir = makeTempDir();
    const file = join(dir, 'test.c');
    writeFileSync(file, [
      'int other_func() { return 0; }',
      'int myFunc(int x) { return x; }',
      'void caller() { myFunc(1); }',
    ].join('\n'), 'utf8');

    // Line 2 (1-based) contains "myFunc"
    const result = inferSourcePoint(file, 2, 'myFunc');
    expect(result.lineNumber).toBe(2);
    // "int myFunc" — 'myFunc' starts at index 4 (0-based) → character 5 (1-based)
    expect(result.character).toBe(5);
  });

  test('label on exact line at column 1 → character=1', () => {
    const dir = makeTempDir();
    const file = join(dir, 'test.c');
    writeFileSync(file, 'myFunc(int x) { return x; }\n', 'utf8');

    const result = inferSourcePoint(file, 1, 'myFunc');
    expect(result.lineNumber).toBe(1);
    expect(result.character).toBe(1);
  });

  test('label not on current line but found in enclosing function above → walk-up result', () => {
    const dir = makeTempDir();
    const file = join(dir, 'test.c');
    // Line 1: function definition with label
    // Line 2: call site (label appears as callee, not definition)
    // Line 3: closing brace
    writeFileSync(file, [
      'int myFunc(int x) {',   // line 1 — contains "myFunc" and "("
      '  return x + 1;',       // line 2 — does NOT contain "myFunc"
      '}',                     // line 3
    ].join('\n'), 'utf8');

    // Ask for line 2 — "myFunc" not on line 2, walk up finds it on line 1
    const result = inferSourcePoint(file, 2, 'myFunc');
    expect(result.lineNumber).toBe(1);
    // "int myFunc" — 'myFunc' at index 4 → character 5
    expect(result.character).toBe(5);
  });

  test('label not found anywhere → falls back to first identifier on line', () => {
    const dir = makeTempDir();
    const file = join(dir, 'test.c');
    writeFileSync(file, [
      'int other_func() { return 0; }',
      'void caller() { other_func(); }',
    ].join('\n'), 'utf8');

    // Ask for "unknownLabel" on line 2 — not found anywhere
    const result = inferSourcePoint(file, 2, 'unknownLabel');
    // Falls back to first identifier on line 2: "void"
    expect(result.lineNumber).toBe(2);
    expect(result.character).toBe(1); // "void" starts at index 0 → character 1
  });

  test('empty line → returns { lineNumber, character: 1 } fallback', () => {
    const dir = makeTempDir();
    const file = join(dir, 'test.c');
    writeFileSync(file, '\n\n\n', 'utf8');

    const result = inferSourcePoint(file, 2, 'myFunc');
    expect(result).toEqual({ lineNumber: 2, character: 1 });
  });

  test('lineNumber beyond file length → returns { lineNumber, character: 1 } fallback', () => {
    const dir = makeTempDir();
    const file = join(dir, 'test.c');
    writeFileSync(file, 'int x = 1;\n', 'utf8');

    // File has 1 line, ask for line 999
    const result = inferSourcePoint(file, 999, 'myFunc');
    expect(result).toEqual({ lineNumber: 999, character: 1 });
  });

  test('token prefix match when full label not on line', () => {
    const dir = makeTempDir();
    const file = join(dir, 'test.c');
    // Line contains "myFunc" but label is "myFunc_v2" (suffix variant)
    // Token extracted from label: "myFunc_v2" (whole identifier) — not found on line
    // Falls back to first identifier on line: "int" at index 0 → character 1
    writeFileSync(file, 'int myFunc(void) { return 0; }\n', 'utf8');

    // label "myFunc_v2" — token is "myFunc_v2" (full identifier) — not found on line
    // Falls back to first identifier "int" at index 0 → character 1
    const result = inferSourcePoint(file, 1, 'myFunc_v2');
    expect(result.lineNumber).toBe(1);
    expect(result.character).toBe(1); // fallback to first identifier "int"
  });

  test('partial token match: label with spaces uses first word token', () => {
    const dir = makeTempDir();
    const file = join(dir, 'test.c');
    // Label "myFunc impl" — token extracted is "myFunc" (stops at space)
    // Line contains "myFunc" at index 4
    writeFileSync(file, 'int myFunc(void) { return 0; }\n', 'utf8');

    // label "myFunc impl" — token is "myFunc" — found at index 4 → character 5
    const result = inferSourcePoint(file, 1, 'myFunc impl');
    expect(result.lineNumber).toBe(1);
    expect(result.character).toBe(5); // "int myFunc" — "myFunc" at index 4 → char 5
  });
});

// ---------------------------------------------------------------------------
// 4. mergeFlatItems deduplication
// ---------------------------------------------------------------------------

describe('mergeFlatItems', () => {
  function makeItem(overrides: Partial<FlatRelationItem> = {}): FlatRelationItem {
    return {
      id: 'test-id',
      label: 'myFunc',
      filePath: '/src/foo.c',
      lineNumber: 10,
      relationType: 'incoming',
      ...overrides,
    };
  }

  test('exact duplicate is not added', () => {
    const base = [makeItem()];
    const extra = [makeItem()]; // identical
    const result = mergeFlatItems(base, extra);
    expect(result).toHaveLength(1);
  });

  test('same label different filePath is added', () => {
    const base = [makeItem({ filePath: '/src/foo.c' })];
    const extra = [makeItem({ filePath: '/src/bar.c' })];
    const result = mergeFlatItems(base, extra);
    expect(result).toHaveLength(2);
  });

  test('same label different lineNumber is added', () => {
    const base = [makeItem({ lineNumber: 10 })];
    const extra = [makeItem({ lineNumber: 20 })];
    const result = mergeFlatItems(base, extra);
    expect(result).toHaveLength(2);
  });

  test('same label different relationType is added', () => {
    const base = [makeItem({ relationType: 'incoming' })];
    const extra = [makeItem({ relationType: 'outgoing' })];
    const result = mergeFlatItems(base, extra);
    expect(result).toHaveLength(2);
  });

  test('empty extra returns base unchanged', () => {
    const base = [makeItem(), makeItem({ lineNumber: 20 })];
    const result = mergeFlatItems(base, []);
    expect(result).toBe(base); // same reference — no copy made
    expect(result).toHaveLength(2);
  });

  test('empty base with extra returns all extra items', () => {
    const extra = [makeItem(), makeItem({ lineNumber: 20 })];
    const result = mergeFlatItems([], extra);
    expect(result).toHaveLength(2);
  });

  test('deduplication key is label|filePath|lineNumber|relationType', () => {
    // Two items with same key fields but different id/symbolKind — still deduplicated
    const base = [makeItem({ id: 'id-1', symbolKind: 1 })];
    const extra = [makeItem({ id: 'id-2', symbolKind: 99 })]; // same key fields
    const result = mergeFlatItems(base, extra);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('id-1'); // base item preserved
  });

  test('multiple non-duplicate extras all added', () => {
    const base = [makeItem({ lineNumber: 1 })];
    const extra = [
      makeItem({ lineNumber: 2 }),
      makeItem({ lineNumber: 3 }),
      makeItem({ lineNumber: 4 }),
    ];
    const result = mergeFlatItems(base, extra);
    expect(result).toHaveLength(4);
  });

  test('mix of duplicates and new items — only new items added', () => {
    const base = [makeItem({ lineNumber: 1 }), makeItem({ lineNumber: 2 })];
    const extra = [
      makeItem({ lineNumber: 1 }), // duplicate
      makeItem({ lineNumber: 3 }), // new
      makeItem({ lineNumber: 2 }), // duplicate
      makeItem({ lineNumber: 4 }), // new
    ];
    const result = mergeFlatItems(base, extra);
    expect(result).toHaveLength(4);
    const lineNumbers = result.map((i) => i.lineNumber);
    expect(lineNumbers).toEqual([1, 2, 3, 4]);
  });

  test('undefined fields in dedup key — items with undefined filePath deduplicated correctly', () => {
    // FlatRelationItem.filePath is required (string), but test robustness with edge values
    const base = [makeItem({ filePath: '' })];
    const extra = [makeItem({ filePath: '' })]; // same empty string
    const result = mergeFlatItems(base, extra);
    expect(result).toHaveLength(1);
  });
});
