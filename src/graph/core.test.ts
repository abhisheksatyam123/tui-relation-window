import { describe, expect, test } from 'bun:test';
import {
  makeInitialGraph,
  addChildrenForDirection,
  sideForNode,
  collectSubtreeIds,
  removeSubtreesFromSide,
} from './core';
import type { FlatRelationItem } from '../lib/types';

// ─── helpers ────────────────────────────────────────────────────────────────

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

// ─── makeInitialGraph ────────────────────────────────────────────────────────

describe('makeInitialGraph', () => {
  test('creates root node with correct fields', () => {
    const state = makeInitialGraph('myFunc', '/src/main.c', 42);
    expect(state.rootId).toBe('root');
    expect(state.nodes['root']).toEqual({
      id: 'root',
      label: 'myFunc',
      filePath: '/src/main.c',
      lineNumber: 42,
    });
  });

  test('selectedId defaults to rootId', () => {
    const state = makeInitialGraph('fn', '/a.c', 1);
    expect(state.selectedId).toBe(state.rootId);
  });

  test('activeDirection defaults to incoming', () => {
    const state = makeInitialGraph('fn', '/a.c', 1);
    expect(state.activeDirection).toBe('incoming');
  });

  test('both direction graphs are initialised with root', () => {
    const state = makeInitialGraph('fn', '/a.c', 1);
    for (const side of [state.incoming, state.outgoing]) {
      expect(side.childrenByParent['root']).toEqual([]);
      expect(side.parentByNode['root']).toBeUndefined();
      expect(side.depthByNode['root']).toBe(0);
      expect(side.loadedByNode['root']).toBe(false);
      expect(side.expandedByNode['root']).toBe(false);
      expect(side.loadingNodeId).toBeNull();
      expect(side.error).toBeNull();
    }
  });

  test('uses empty string for missing filePath', () => {
    const state = makeInitialGraph('fn', undefined, undefined);
    expect(state.nodes['root']?.filePath).toBe('');
    expect(state.nodes['root']?.lineNumber).toBe(1);
  });
});

// ─── addChildrenForDirection ─────────────────────────────────────────────────

describe('addChildrenForDirection', () => {
  test('adds children under root on incoming side', () => {
    const base = makeInitialGraph('root', '/r.c', 1);
    const items: FlatRelationItem[] = [
      makeItem({ id: 'a', label: 'callerA', filePath: '/a.c', lineNumber: 5, relationType: 'incoming' }),
      makeItem({ id: 'b', label: 'callerB', filePath: '/b.c', lineNumber: 7, relationType: 'incoming' }),
    ];
    const next = addChildrenForDirection(base, 'incoming', 'root', items);

    const children = next.incoming.childrenByParent['root'] ?? [];
    expect(children).toHaveLength(2);

    // Each child node should exist in nodes map
    for (const childId of children) {
      expect(next.nodes[childId]).toBeDefined();
    }
  });

  test('sets correct depth for direct children of root', () => {
    const base = makeInitialGraph('root', '/r.c', 1);
    const items = [makeItem({ id: 'x', label: 'x', filePath: '/x.c', lineNumber: 1, relationType: 'incoming' })];
    const next = addChildrenForDirection(base, 'incoming', 'root', items);

    const childId = (next.incoming.childrenByParent['root'] ?? [])[0]!;
    expect(next.incoming.depthByNode[childId]).toBe(1);
  });

  test('marks parent as loaded and expanded after adding children', () => {
    const base = makeInitialGraph('root', '/r.c', 1);
    const items = [makeItem({ id: 'x', label: 'x', filePath: '/x.c', lineNumber: 1, relationType: 'incoming' })];
    const next = addChildrenForDirection(base, 'incoming', 'root', items);

    expect(next.incoming.loadedByNode['root']).toBe(true);
    expect(next.incoming.expandedByNode['root']).toBe(true);
  });

  test('does not duplicate nodes with same label/filePath/lineNumber', () => {
    const base = makeInitialGraph('root', '/r.c', 1);
    const item = makeItem({ id: 'a', label: 'callerA', filePath: '/a.c', lineNumber: 5, relationType: 'incoming' });
    const s1 = addChildrenForDirection(base, 'incoming', 'root', [item]);
    const s2 = addChildrenForDirection(s1, 'incoming', 'root', [item]);

    const children = s2.incoming.childrenByParent['root'] ?? [];
    expect(children).toHaveLength(1);
  });

  test('handles empty items array — marks parent loaded/expanded', () => {
    const base = makeInitialGraph('root', '/r.c', 1);
    const next = addChildrenForDirection(base, 'incoming', 'root', []);

    expect(next.incoming.childrenByParent['root']).toEqual([]);
    expect(next.incoming.loadedByNode['root']).toBe(true);
    expect(next.incoming.expandedByNode['root']).toBe(true);
  });

  test('adds children on outgoing side independently of incoming', () => {
    const base = makeInitialGraph('root', '/r.c', 1);
    const items = [makeItem({ id: 'c', label: 'callee', filePath: '/c.c', lineNumber: 3, relationType: 'outgoing' })];
    const next = addChildrenForDirection(base, 'outgoing', 'root', items);

    expect((next.outgoing.childrenByParent['root'] ?? []).length).toBe(1);
    expect((next.incoming.childrenByParent['root'] ?? []).length).toBe(0);
  });

  test('stores edgeKindFromParent on child node', () => {
    const base = makeInitialGraph('root', '/r.c', 1);
    const item = makeItem({ id: 'e', label: 'ev', filePath: '/e.c', lineNumber: 1, connectionKind: 'event', relationType: 'incoming' });
    const next = addChildrenForDirection(base, 'incoming', 'root', [item]);

    const childId = (next.incoming.childrenByParent['root'] ?? [])[0]!;
    expect(next.nodes[childId]?.edgeKindFromParent).toBe('event');
  });

  test('defaults edgeKindFromParent to api_call when connectionKind is absent', () => {
    const base = makeInitialGraph('root', '/r.c', 1);
    const item = makeItem({ id: 'n', label: 'n', filePath: '/n.c', lineNumber: 1, relationType: 'incoming' });
    const next = addChildrenForDirection(base, 'incoming', 'root', [item]);

    const childId = (next.incoming.childrenByParent['root'] ?? [])[0]!;
    expect(next.nodes[childId]?.edgeKindFromParent).toBe('api_call');
  });

  test('creates anchor node when parentId is not root and not in direction graph', () => {
    // Simulate a node that exists in nodes but not in the direction graph
    const base = makeInitialGraph('root', '/r.c', 1);
    // Add a child to outgoing first so the node exists in nodes
    const items1 = [makeItem({ id: 'child1', label: 'child1', filePath: '/c1.c', lineNumber: 1, relationType: 'outgoing' })];
    const s1 = addChildrenForDirection(base, 'outgoing', 'root', items1);
    const childId = (s1.outgoing.childrenByParent['root'] ?? [])[0]!;

    // Now try to add children to that childId on the INCOMING side (not in incoming graph)
    const items2 = [makeItem({ id: 'grandchild', label: 'gc', filePath: '/gc.c', lineNumber: 2, relationType: 'incoming' })];
    const s2 = addChildrenForDirection(s1, 'incoming', childId, items2);

    // An anchor node should have been created
    const anchorId = `incoming:anchor:${childId}`;
    expect(s2.nodes[anchorId]).toBeDefined();
    expect(s2.incoming.depthByNode[anchorId]).toBe(1);
    expect((s2.incoming.childrenByParent['root'] ?? []).includes(anchorId)).toBe(true);
  });
});

// ─── sideForNode ─────────────────────────────────────────────────────────────

describe('sideForNode', () => {
  test('returns "root" for the root node', () => {
    const state = makeInitialGraph('fn', '/f.c', 1);
    expect(sideForNode(state, 'root')).toBe('root');
  });

  test('returns "incoming" for a node in the incoming graph', () => {
    const base = makeInitialGraph('fn', '/f.c', 1);
    const items = [makeItem({ id: 'i', label: 'caller', filePath: '/i.c', lineNumber: 1, relationType: 'incoming' })];
    const state = addChildrenForDirection(base, 'incoming', 'root', items);
    const childId = (state.incoming.childrenByParent['root'] ?? [])[0]!;

    expect(sideForNode(state, childId)).toBe('incoming');
  });

  test('returns "outgoing" for a node in the outgoing graph', () => {
    const base = makeInitialGraph('fn', '/f.c', 1);
    const items = [makeItem({ id: 'o', label: 'callee', filePath: '/o.c', lineNumber: 1, relationType: 'outgoing' })];
    const state = addChildrenForDirection(base, 'outgoing', 'root', items);
    const childId = (state.outgoing.childrenByParent['root'] ?? [])[0]!;

    expect(sideForNode(state, childId)).toBe('outgoing');
  });

  test('returns "root" for an unknown nodeId', () => {
    const state = makeInitialGraph('fn', '/f.c', 1);
    // "root" is the fallback for unknown nodes per implementation
    expect(sideForNode(state, 'nonexistent-id')).toBe('root');
  });
});

// ─── collectSubtreeIds ───────────────────────────────────────────────────────

describe('collectSubtreeIds', () => {
  test('returns just the node itself for a leaf', () => {
    const base = makeInitialGraph('fn', '/f.c', 1);
    const items = [makeItem({ id: 'leaf', label: 'leaf', filePath: '/l.c', lineNumber: 1, relationType: 'incoming' })];
    const state = addChildrenForDirection(base, 'incoming', 'root', items);
    const leafId = (state.incoming.childrenByParent['root'] ?? [])[0]!;

    const ids = collectSubtreeIds(state.incoming, leafId);
    expect(ids).toEqual([leafId]);
  });

  test('returns root and all descendants for a subtree', () => {
    const base = makeInitialGraph('fn', '/f.c', 1);
    // Add two children under root
    const items = [
      makeItem({ id: 'c1', label: 'c1', filePath: '/c1.c', lineNumber: 1, relationType: 'incoming' }),
      makeItem({ id: 'c2', label: 'c2', filePath: '/c2.c', lineNumber: 2, relationType: 'incoming' }),
    ];
    const s1 = addChildrenForDirection(base, 'incoming', 'root', items);
    const [child1Id, child2Id] = s1.incoming.childrenByParent['root'] ?? [];

    // Add grandchild under child1
    const grandItems = [makeItem({ id: 'gc', label: 'gc', filePath: '/gc.c', lineNumber: 3, relationType: 'incoming' })];
    const s2 = addChildrenForDirection(s1, 'incoming', child1Id!, grandItems);
    const grandchildId = (s2.incoming.childrenByParent[child1Id!] ?? [])[0]!;

    const ids = collectSubtreeIds(s2.incoming, 'root');
    expect(ids).toContain('root');
    expect(ids).toContain(child1Id);
    expect(ids).toContain(child2Id);
    expect(ids).toContain(grandchildId);
    expect(ids).toHaveLength(4);
  });

  test('handles deep trees without stack overflow', () => {
    let state = makeInitialGraph('fn', '/f.c', 1);
    let parentId = 'root';
    const depth = 50;

    for (let i = 0; i < depth; i++) {
      const item = makeItem({ id: `n${i}`, label: `n${i}`, filePath: `/n${i}.c`, lineNumber: i + 1, relationType: 'incoming' });
      state = addChildrenForDirection(state, 'incoming', parentId, [item]);
      parentId = (state.incoming.childrenByParent[parentId] ?? []).at(-1)!;
    }

    const ids = collectSubtreeIds(state.incoming, 'root');
    // root + depth nodes
    expect(ids.length).toBe(depth + 1);
  });
});

// ─── removeSubtreesFromSide ──────────────────────────────────────────────────

describe('removeSubtreesFromSide', () => {
  test('removes a single node and its descendants from the given side', () => {
    const base = makeInitialGraph('fn', '/f.c', 1);
    const items = [
      makeItem({ id: 'c1', label: 'c1', filePath: '/c1.c', lineNumber: 1, relationType: 'incoming' }),
    ];
    const s1 = addChildrenForDirection(base, 'incoming', 'root', items);
    const childId = (s1.incoming.childrenByParent['root'] ?? [])[0]!;

    const { next, removed } = removeSubtreesFromSide(s1, 'incoming', [childId]);

    expect(removed).toContain(childId);
    expect(next.nodes[childId]).toBeUndefined();
    expect(next.incoming.depthByNode[childId]).toBeUndefined();
    expect(next.incoming.childrenByParent['root']).not.toContain(childId);
  });

  test('removes entire subtree recursively', () => {
    const base = makeInitialGraph('fn', '/f.c', 1);
    const items = [makeItem({ id: 'c1', label: 'c1', filePath: '/c1.c', lineNumber: 1, relationType: 'incoming' })];
    const s1 = addChildrenForDirection(base, 'incoming', 'root', items);
    const childId = (s1.incoming.childrenByParent['root'] ?? [])[0]!;

    const grandItems = [makeItem({ id: 'gc', label: 'gc', filePath: '/gc.c', lineNumber: 2, relationType: 'incoming' })];
    const s2 = addChildrenForDirection(s1, 'incoming', childId, grandItems);
    const grandchildId = (s2.incoming.childrenByParent[childId] ?? [])[0]!;

    const { next, removed } = removeSubtreesFromSide(s2, 'incoming', [childId]);

    expect(removed).toContain(childId);
    expect(removed).toContain(grandchildId);
    expect(next.nodes[childId]).toBeUndefined();
    expect(next.nodes[grandchildId]).toBeUndefined();
  });

  test('leaves nodes on the other side intact', () => {
    const base = makeInitialGraph('fn', '/f.c', 1);
    const inItems = [makeItem({ id: 'in1', label: 'in1', filePath: '/in1.c', lineNumber: 1, relationType: 'incoming' })];
    const outItems = [makeItem({ id: 'out1', label: 'out1', filePath: '/out1.c', lineNumber: 2, relationType: 'outgoing' })];
    const s1 = addChildrenForDirection(base, 'incoming', 'root', inItems);
    const s2 = addChildrenForDirection(s1, 'outgoing', 'root', outItems);

    const inChildId = (s2.incoming.childrenByParent['root'] ?? [])[0]!;
    const outChildId = (s2.outgoing.childrenByParent['root'] ?? [])[0]!;

    const { next } = removeSubtreesFromSide(s2, 'incoming', [inChildId]);

    // incoming child removed
    expect(next.nodes[inChildId]).toBeUndefined();
    // outgoing child untouched
    expect(next.nodes[outChildId]).toBeDefined();
    expect(next.outgoing.childrenByParent['root']).toContain(outChildId);
  });

  test('returns empty removed array when removeRootIds is empty', () => {
    const base = makeInitialGraph('fn', '/f.c', 1);
    const { next, removed } = removeSubtreesFromSide(base, 'incoming', []);
    expect(removed).toEqual([]);
    expect(next).toBe(base); // same reference — no mutation
  });

  test('root node is preserved after removing all children', () => {
    const base = makeInitialGraph('fn', '/f.c', 1);
    const items = [makeItem({ id: 'c', label: 'c', filePath: '/c.c', lineNumber: 1, relationType: 'incoming' })];
    const s1 = addChildrenForDirection(base, 'incoming', 'root', items);
    const childId = (s1.incoming.childrenByParent['root'] ?? [])[0]!;

    const { next } = removeSubtreesFromSide(s1, 'incoming', [childId]);

    expect(next.nodes['root']).toBeDefined();
    expect(next.rootId).toBe('root');
  });

  test('removes multiple subtrees in one call', () => {
    const base = makeInitialGraph('fn', '/f.c', 1);
    const items = [
      makeItem({ id: 'c1', label: 'c1', filePath: '/c1.c', lineNumber: 1, relationType: 'incoming' }),
      makeItem({ id: 'c2', label: 'c2', filePath: '/c2.c', lineNumber: 2, relationType: 'incoming' }),
    ];
    const s1 = addChildrenForDirection(base, 'incoming', 'root', items);
    const [c1Id, c2Id] = s1.incoming.childrenByParent['root'] ?? [];

    const { next, removed } = removeSubtreesFromSide(s1, 'incoming', [c1Id!, c2Id!]);

    expect(removed).toContain(c1Id);
    expect(removed).toContain(c2Id);
    expect(next.incoming.childrenByParent['root']).toEqual([]);
  });
});
