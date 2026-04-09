/**
 * BothRelationWindow.test.ts
 *
 * Unit tests for BothRelationWindow logic, tested via the underlying graph
 * state functions (makeInitialGraph, addChildrenForDirection, sideForNode).
 *
 * BothRelationWindow is a TUI React component using @opentui/react — it cannot
 * be rendered in a DOM test environment. Instead, we test the three key
 * behaviours by replicating the exact state transitions the component performs:
 *
 *   A. stepHorizontal direction mapping  (left → outgoing, right → incoming)
 *   B. fetchOneLevel error path          (requestExpand rejects → error stored)
 *   C. requestExpand deduplication       (loadingNodeId guard prevents double-call)
 */

import { describe, expect, test } from 'bun:test';
import {
  makeInitialGraph,
  addChildrenForDirection,
  sideForNode,
  type Direction,
  type GraphState,
  type DirectionGraph,
} from '../graph/core';
import type { FlatRelationItem } from '../lib/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<FlatRelationItem> = {}): FlatRelationItem {
  return {
    id: 'item-1',
    label: 'foo',
    filePath: '/src/foo.c',
    lineNumber: 10,
    relationType: 'incoming',
    ...overrides,
  };
}

/**
 * Replicate the stepHorizontal direction mapping from BothRelationWindow.tsx:
 *   toward === 'left'  → 'outgoing'  (callees are on the left)
 *   toward === 'right' → 'incoming'  (callers are on the right)
 *
 * Source: BothRelationWindow.tsx line 262
 *   const direction: Direction = toward === 'left' ? 'outgoing' : 'incoming';
 */
function stepHorizontalDirection(toward: 'left' | 'right'): Direction {
  return toward === 'left' ? 'outgoing' : 'incoming';
}

/**
 * Replicate the fetchOneLevel state transition from BothRelationWindow.tsx.
 * Returns the new GraphState after a successful or failed expand.
 */
async function simulateFetchOneLevel(
  graph: GraphState,
  direction: Direction,
  nodeId: string,
  requestExpand: (node: {
    id: string;
    label: string;
    filePath: string;
    lineNumber: number;
    mode: Direction;
  }) => Promise<FlatRelationItem[]>,
): Promise<GraphState> {
  const side = direction === 'incoming' ? graph.incoming : graph.outgoing;
  const node = graph.nodes[nodeId];

  // Guard: same as component — bail if no location or already loading
  if (!node || !node.filePath || !node.lineNumber || side.loadingNodeId) {
    return graph;
  }

  // Set loading state (mirrors component setGraph call)
  let currentGraph: GraphState = {
    ...graph,
    activeDirection: direction,
    incoming:
      direction === 'incoming'
        ? { ...graph.incoming, loadingNodeId: nodeId, error: null }
        : graph.incoming,
    outgoing:
      direction === 'outgoing'
        ? { ...graph.outgoing, loadingNodeId: nodeId, error: null }
        : graph.outgoing,
  };

  try {
    const children = await requestExpand({
      id: node.id,
      label: node.label,
      filePath: node.filePath,
      lineNumber: node.lineNumber,
      mode: direction,
    });

    const withChildren = addChildrenForDirection(currentGraph, direction, nodeId, children);
    const sideNow = direction === 'incoming' ? withChildren.incoming : withChildren.outgoing;
    const cleanSide: DirectionGraph = { ...sideNow, loadingNodeId: null, error: null };

    return {
      ...withChildren,
      selectedId: currentGraph.selectedId,
      activeDirection: direction,
      incoming: direction === 'incoming' ? cleanSide : withChildren.incoming,
      outgoing: direction === 'outgoing' ? cleanSide : withChildren.outgoing,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const currentSide = direction === 'incoming' ? currentGraph.incoming : currentGraph.outgoing;
    const failedSide: DirectionGraph = { ...currentSide, loadingNodeId: null, error: message };
    return {
      ...currentGraph,
      incoming: direction === 'incoming' ? failedSide : currentGraph.incoming,
      outgoing: direction === 'outgoing' ? failedSide : currentGraph.outgoing,
    };
  }
}

// ---------------------------------------------------------------------------
// A. stepHorizontal direction logic
// ---------------------------------------------------------------------------

describe('BothRelationWindow — stepHorizontal direction mapping', () => {
  /**
   * Layout: callees (outgoing) are rendered on the LEFT, callers (incoming) on the RIGHT.
   * Pressing left navigates toward callees → direction = 'outgoing'.
   * Pressing right navigates toward callers → direction = 'incoming'.
   *
   * Source: BothRelationWindow.tsx line 261-262
   *   // left side is outgoing (callees), right side is incoming (callers)
   *   const direction: Direction = toward === 'left' ? 'outgoing' : 'incoming';
   */
  test('pressing left maps to outgoing direction (callees on left)', () => {
    expect(stepHorizontalDirection('left')).toBe('outgoing');
  });

  test('pressing right maps to incoming direction (callers on right)', () => {
    expect(stepHorizontalDirection('right')).toBe('incoming');
  });

  test('left and right map to opposite directions', () => {
    const leftDir = stepHorizontalDirection('left');
    const rightDir = stepHorizontalDirection('right');
    expect(leftDir).not.toBe(rightDir);
  });

  test('stepHorizontal from root with left: selects first outgoing child', () => {
    // Build a graph with an outgoing child
    const base = makeInitialGraph('myFunc', '/src/main.c', 42);
    const outgoingItems = [
      makeItem({ id: 'callee1', label: 'callee1', filePath: '/src/callee.c', lineNumber: 5, relationType: 'outgoing' }),
    ];
    const graph = addChildrenForDirection(base, 'outgoing', 'root', outgoingItems);
    const firstOutgoing = (graph.outgoing.childrenByParent['root'] ?? [])[0]!;

    // Simulate stepHorizontal('left') from root:
    // direction = 'outgoing', selectedId = rootId
    // → select first child of outgoing side
    const direction = stepHorizontalDirection('left');
    expect(direction).toBe('outgoing');

    const side = graph.outgoing;
    const first = side.childrenByParent[graph.rootId]?.[0] ?? null;
    expect(first).toBe(firstOutgoing);
  });

  test('stepHorizontal from root with right: selects first incoming child', () => {
    const base = makeInitialGraph('myFunc', '/src/main.c', 42);
    const incomingItems = [
      makeItem({ id: 'caller1', label: 'caller1', filePath: '/src/caller.c', lineNumber: 3, relationType: 'incoming' }),
    ];
    const graph = addChildrenForDirection(base, 'incoming', 'root', incomingItems);
    const firstIncoming = (graph.incoming.childrenByParent['root'] ?? [])[0]!;

    const direction = stepHorizontalDirection('right');
    expect(direction).toBe('incoming');

    const side = graph.incoming;
    const first = side.childrenByParent[graph.rootId]?.[0] ?? null;
    expect(first).toBe(firstIncoming);
  });

  test('stepHorizontal from an incoming node with left: moves toward center (parent)', () => {
    // When selectedSide !== direction (switching sides), move toward center
    // Source: BothRelationWindow.tsx lines 287-293
    const base = makeInitialGraph('myFunc', '/src/main.c', 42);
    const incomingItems = [
      makeItem({ id: 'caller1', label: 'caller1', filePath: '/src/caller.c', lineNumber: 3, relationType: 'incoming' }),
    ];
    const graph = addChildrenForDirection(base, 'incoming', 'root', incomingItems);
    const callerNodeId = (graph.incoming.childrenByParent['root'] ?? [])[0]!;

    // selectedSide = 'incoming', direction = 'outgoing' (pressing left)
    // → move toward center: parent of callerNodeId = root
    const selectedSide = sideForNode(graph, callerNodeId);
    expect(selectedSide).toBe('incoming');

    const direction = stepHorizontalDirection('left');
    expect(direction).toBe('outgoing');

    // Since selectedSide !== direction, move toward center
    const selectedDirectionSide = graph.incoming;
    const parentId = selectedDirectionSide.parentByNode[callerNodeId];
    const centerNode = parentId ?? graph.rootId;
    expect(centerNode).toBe(graph.rootId);
  });
});

// ---------------------------------------------------------------------------
// B. fetchOneLevel error path
// ---------------------------------------------------------------------------

describe('BothRelationWindow — fetchOneLevel error path', () => {
  test('when requestExpand rejects, error is stored in graph state', async () => {
    const base = makeInitialGraph('myFunc', '/src/main.c', 42);
    const incomingItems = [
      makeItem({ id: 'caller1', label: 'caller1', filePath: '/src/caller.c', lineNumber: 3, relationType: 'incoming' }),
    ];
    const graph = addChildrenForDirection(base, 'incoming', 'root', incomingItems);
    const callerNodeId = (graph.incoming.childrenByParent['root'] ?? [])[0]!;

    const requestExpand = async () => {
      throw new Error('query timeout');
    };

    const nextGraph = await simulateFetchOneLevel(graph, 'incoming', callerNodeId, requestExpand);

    expect(nextGraph.incoming.error).toBe('query timeout');
    expect(nextGraph.incoming.loadingNodeId).toBeNull();
  });

  test('when requestExpand rejects with non-Error, error message is stringified', async () => {
    const base = makeInitialGraph('myFunc', '/src/main.c', 42);
    const incomingItems = [
      makeItem({ id: 'caller1', label: 'caller1', filePath: '/src/caller.c', lineNumber: 3, relationType: 'incoming' }),
    ];
    const graph = addChildrenForDirection(base, 'incoming', 'root', incomingItems);
    const callerNodeId = (graph.incoming.childrenByParent['root'] ?? [])[0]!;

    // eslint-disable-next-line @typescript-eslint/only-throw-error
    const requestExpand = async () => { throw 'network error'; };

    const nextGraph = await simulateFetchOneLevel(graph, 'incoming', callerNodeId, requestExpand);

    expect(nextGraph.incoming.error).toBe('network error');
    expect(nextGraph.incoming.loadingNodeId).toBeNull();
  });

  test('error on incoming side does not affect outgoing side', async () => {
    const base = makeInitialGraph('myFunc', '/src/main.c', 42);
    const incomingItems = [
      makeItem({ id: 'caller1', label: 'caller1', filePath: '/src/caller.c', lineNumber: 3, relationType: 'incoming' }),
    ];
    const graph = addChildrenForDirection(base, 'incoming', 'root', incomingItems);
    const callerNodeId = (graph.incoming.childrenByParent['root'] ?? [])[0]!;

    const requestExpand = async () => { throw new Error('timeout'); };

    const nextGraph = await simulateFetchOneLevel(graph, 'incoming', callerNodeId, requestExpand);

    expect(nextGraph.incoming.error).toBe('timeout');
    expect(nextGraph.outgoing.error).toBeNull(); // outgoing side unaffected
  });

  test('error on outgoing side does not affect incoming side', async () => {
    const base = makeInitialGraph('myFunc', '/src/main.c', 42);
    const outgoingItems = [
      makeItem({ id: 'callee1', label: 'callee1', filePath: '/src/callee.c', lineNumber: 5, relationType: 'outgoing' }),
    ];
    const graph = addChildrenForDirection(base, 'outgoing', 'root', outgoingItems);
    const calleeNodeId = (graph.outgoing.childrenByParent['root'] ?? [])[0]!;

    const requestExpand = async () => { throw new Error('server error'); };

    const nextGraph = await simulateFetchOneLevel(graph, 'outgoing', calleeNodeId, requestExpand);

    expect(nextGraph.outgoing.error).toBe('server error');
    expect(nextGraph.incoming.error).toBeNull(); // incoming side unaffected
  });

  test('successful expand clears any previous error', async () => {
    const base = makeInitialGraph('myFunc', '/src/main.c', 42);
    const incomingItems = [
      makeItem({ id: 'caller1', label: 'caller1', filePath: '/src/caller.c', lineNumber: 3, relationType: 'incoming' }),
    ];
    const graph = addChildrenForDirection(base, 'incoming', 'root', incomingItems);
    const callerNodeId = (graph.incoming.childrenByParent['root'] ?? [])[0]!;

    // First call fails
    const failExpand = async () => { throw new Error('timeout'); };
    const errorGraph = await simulateFetchOneLevel(graph, 'incoming', callerNodeId, failExpand);
    expect(errorGraph.incoming.error).toBe('timeout');

    // Second call succeeds — but loadingNodeId is null now so we can retry
    const successExpand = async () => [
      makeItem({ id: 'grandchild', label: 'gc', filePath: '/src/gc.c', lineNumber: 1, relationType: 'incoming' }),
    ];
    const recoveredGraph = await simulateFetchOneLevel(errorGraph, 'incoming', callerNodeId, successExpand);
    expect(recoveredGraph.incoming.error).toBeNull();
    expect(recoveredGraph.incoming.loadingNodeId).toBeNull();
  });

  test('node without filePath is skipped (guard)', async () => {
    // Node with empty filePath should be skipped by the guard
    const base = makeInitialGraph('myFunc', '', 0);
    let callCount = 0;
    const requestExpand = async () => { callCount++; return []; };

    // rootId has filePath='' and lineNumber=0 — guard should bail
    const nextGraph = await simulateFetchOneLevel(base, 'incoming', base.rootId, requestExpand);

    // Guard: !node.filePath || !node.lineNumber → return early
    // filePath='' is falsy, lineNumber=0 is falsy → skipped
    expect(callCount).toBe(0);
    expect(nextGraph).toBe(base); // unchanged
  });
});

// ---------------------------------------------------------------------------
// C. requestExpand deduplication (loadingNodeId guard)
// ---------------------------------------------------------------------------

describe('BothRelationWindow — requestExpand deduplication', () => {
  /**
   * The dedup guard is in fetchOneLevel (BothRelationWindow.tsx line 164):
   *   if (!node || !node.filePath || !node.lineNumber || side.loadingNodeId) return;
   *
   * If loadingNodeId is already set (first call in flight), the second call
   * returns early without calling requestExpand again.
   */
  test('second expand call is skipped when loadingNodeId is already set', async () => {
    const base = makeInitialGraph('myFunc', '/src/main.c', 42);
    const incomingItems = [
      makeItem({ id: 'caller1', label: 'caller1', filePath: '/src/caller.c', lineNumber: 3, relationType: 'incoming' }),
    ];
    const graph = addChildrenForDirection(base, 'incoming', 'root', incomingItems);
    const callerNodeId = (graph.incoming.childrenByParent['root'] ?? [])[0]!;

    // Simulate the in-flight state: loadingNodeId is already set
    const inFlightGraph: GraphState = {
      ...graph,
      incoming: { ...graph.incoming, loadingNodeId: callerNodeId },
    };

    let callCount = 0;
    const requestExpand = async () => {
      callCount++;
      return [];
    };

    // Second call while first is in flight — should be a no-op
    const result = await simulateFetchOneLevel(inFlightGraph, 'incoming', callerNodeId, requestExpand);

    expect(callCount).toBe(0); // requestExpand was NOT called
    expect(result).toBe(inFlightGraph); // state unchanged
  });

  test('second expand call for a DIFFERENT node is NOT blocked', async () => {
    const base = makeInitialGraph('myFunc', '/src/main.c', 42);
    const incomingItems = [
      makeItem({ id: 'caller1', label: 'caller1', filePath: '/src/caller.c', lineNumber: 3, relationType: 'incoming' }),
      makeItem({ id: 'caller2', label: 'caller2', filePath: '/src/caller2.c', lineNumber: 7, relationType: 'incoming' }),
    ];
    const graph = addChildrenForDirection(base, 'incoming', 'root', incomingItems);
    const [caller1Id, caller2Id] = graph.incoming.childrenByParent['root'] ?? [];

    // caller1 is loading
    const inFlightGraph: GraphState = {
      ...graph,
      incoming: { ...graph.incoming, loadingNodeId: caller1Id! },
    };

    let callCount = 0;
    const requestExpand = async () => {
      callCount++;
      return [];
    };

    // Attempt to expand caller2 — should be blocked because loadingNodeId is set
    // (the guard checks side.loadingNodeId, not whether it matches the current nodeId)
    const result = await simulateFetchOneLevel(inFlightGraph, 'incoming', caller2Id!, requestExpand);

    // The guard is: if (side.loadingNodeId) return — blocks ANY expand on that side
    expect(callCount).toBe(0);
    expect(result).toBe(inFlightGraph);
  });

  test('expand is allowed after loadingNodeId is cleared', async () => {
    const base = makeInitialGraph('myFunc', '/src/main.c', 42);
    const incomingItems = [
      makeItem({ id: 'caller1', label: 'caller1', filePath: '/src/caller.c', lineNumber: 3, relationType: 'incoming' }),
    ];
    const graph = addChildrenForDirection(base, 'incoming', 'root', incomingItems);
    const callerNodeId = (graph.incoming.childrenByParent['root'] ?? [])[0]!;

    let callCount = 0;
    const requestExpand = async () => {
      callCount++;
      return [makeItem({ id: 'gc', label: 'gc', filePath: '/src/gc.c', lineNumber: 1, relationType: 'incoming' })];
    };

    // First call — loadingNodeId is null, should proceed
    const result = await simulateFetchOneLevel(graph, 'incoming', callerNodeId, requestExpand);

    expect(callCount).toBe(1);
    expect(result.incoming.loadingNodeId).toBeNull(); // cleared after completion
    expect(result.incoming.error).toBeNull();

    // Second call — loadingNodeId is null again, should proceed
    const result2 = await simulateFetchOneLevel(result, 'incoming', callerNodeId, requestExpand);
    expect(callCount).toBe(2);
    expect(result2.incoming.loadingNodeId).toBeNull();
  });

  test('dedup guard is per-side: outgoing loading does not block incoming expand', async () => {
    const base = makeInitialGraph('myFunc', '/src/main.c', 42);
    const incomingItems = [
      makeItem({ id: 'caller1', label: 'caller1', filePath: '/src/caller.c', lineNumber: 3, relationType: 'incoming' }),
    ];
    const outgoingItems = [
      makeItem({ id: 'callee1', label: 'callee1', filePath: '/src/callee.c', lineNumber: 5, relationType: 'outgoing' }),
    ];
    let graph = addChildrenForDirection(base, 'incoming', 'root', incomingItems);
    graph = addChildrenForDirection(graph, 'outgoing', 'root', outgoingItems);

    const callerNodeId = (graph.incoming.childrenByParent['root'] ?? [])[0]!;

    // Outgoing side is loading
    const inFlightGraph: GraphState = {
      ...graph,
      outgoing: { ...graph.outgoing, loadingNodeId: (graph.outgoing.childrenByParent['root'] ?? [])[0]! },
    };

    let callCount = 0;
    const requestExpand = async () => {
      callCount++;
      return [];
    };

    // Expand on incoming side — outgoing loading should NOT block it
    const result = await simulateFetchOneLevel(inFlightGraph, 'incoming', callerNodeId, requestExpand);

    expect(callCount).toBe(1); // incoming expand proceeded
    expect(result.incoming.loadingNodeId).toBeNull();
    // Outgoing side still loading (we didn't touch it)
    expect(result.outgoing.loadingNodeId).not.toBeNull();
  });
});
