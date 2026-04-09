/**
 * RelationWindow.test.ts
 *
 * Unit tests for RelationWindow tree logic, tested by replicating the exact
 * state transitions the component performs — without rendering React.
 *
 * RelationWindow uses @opentui/react and cannot be rendered in a DOM test
 * environment. Instead, we extract the four key pure/near-pure behaviours:
 *
 *   1. buildVisibleOrder  — flat DFS list of visible node IDs
 *   2. moveParent         — collapse-then-jump logic
 *   3. expandSelected     — error paths (no location, no children, reject, dedup)
 *   4. Tree rebuild       — items change resets selectedId and clears loadingNodeId
 */

import { describe, expect, test } from 'bun:test';
import type { TreeNode } from './RelationComponents';

// ---------------------------------------------------------------------------
// Helpers — replicate component state types and helpers
// ---------------------------------------------------------------------------

type Nodes = Record<string, TreeNode>;

function makeNode(overrides: Partial<TreeNode> & { id: string }): TreeNode {
  return {
    label: overrides.id,
    childrenIds: [],
    loaded: false,
    expanded: false,
    ...overrides,
  };
}

/**
 * Replicate buildVisibleOrder from RelationWindow.tsx lines 210-225.
 * Pure recursive DFS over nodes; children included only when expanded.
 */
function buildVisibleOrder(nodes: Nodes, startId: string): string[] {
  const result: string[] = [];
  const visit = (id: string) => {
    const n = nodes[id];
    if (!n) return;
    result.push(id);
    if (n.expanded) {
      for (const cid of n.childrenIds) visit(cid);
    }
  };
  visit(startId);
  return result;
}

/**
 * Replicate moveParent from RelationWindow.tsx lines 244-266.
 * Returns { nodes, selectedId } after the transition.
 */
function moveParent(
  nodes: Nodes,
  selectedId: string,
): { nodes: Nodes; selectedId: string } {
  const current = nodes[selectedId];
  if (!current) return { nodes, selectedId };

  // If expanded with children → collapse, don't jump
  if (current.expanded && current.childrenIds.length > 0) {
    return {
      nodes: {
        ...nodes,
        [current.id]: { ...nodes[current.id], expanded: false },
      },
      selectedId,
    };
  }

  // Otherwise jump to parent
  if (current.parentId) {
    return { nodes, selectedId: current.parentId };
  }

  return { nodes, selectedId };
}

/**
 * Replicate expandSelected from RelationWindow.tsx lines 268-365.
 * Returns { nodes, selectedId, loadingNodeId, lastError } after the transition.
 */
async function expandSelected(
  nodes: Nodes,
  selectedId: string,
  loadingNodeId: string | null,
  mode: string,
  requestExpand: (node: {
    id: string;
    label: string;
    filePath: string;
    lineNumber: number;
    mode: string;
  }) => Promise<Array<{ id: string; label: string; filePath?: string; lineNumber?: number }>>,
): Promise<{
  nodes: Nodes;
  selectedId: string;
  loadingNodeId: string | null;
  lastError: string | null;
}> {
  // Dedup guard
  if (loadingNodeId) {
    return { nodes, selectedId, loadingNodeId, lastError: null };
  }

  const node = nodes[selectedId];
  if (!node) {
    return { nodes, selectedId, loadingNodeId: null, lastError: null };
  }

  // No source location guard
  if (!node.filePath || !node.lineNumber) {
    return {
      nodes,
      selectedId,
      loadingNodeId: null,
      lastError: 'Selected node has no source location.',
    };
  }

  // Already loaded
  if (node.loaded) {
    if (node.childrenIds.length > 0) {
      return {
        nodes: {
          ...nodes,
          [node.id]: { ...nodes[node.id], expanded: true },
        },
        selectedId: node.childrenIds[0],
        loadingNodeId: null,
        lastError: null,
      };
    } else {
      return {
        nodes,
        selectedId,
        loadingNodeId: null,
        lastError: 'No deeper callers/callees found for this symbol.',
      };
    }
  }

  // Fetch from backend
  const currentLoadingNodeId = node.id;
  try {
    const children = await requestExpand({
      id: node.id,
      label: node.label,
      filePath: node.filePath,
      lineNumber: node.lineNumber,
      mode,
    });

    const copy: Nodes = { ...nodes };
    const childIds: string[] = [];

    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      const cid = `${node.id}|${child.id}|${i}`;
      copy[cid] = makeNode({
        id: cid,
        label: child.label,
        filePath: child.filePath,
        lineNumber: child.lineNumber,
        parentId: node.id,
        childrenIds: [],
        loaded: false,
        expanded: false,
      });
      childIds.push(cid);
    }

    copy[node.id] = {
      ...copy[node.id],
      loaded: true,
      expanded: true,
      childrenIds: childIds,
    };

    const newSelectedId =
      children.length > 0 ? `${node.id}|${children[0].id}|0` : selectedId;
    const newError =
      children.length === 0 ? 'No deeper callers/callees found for this symbol.' : null;

    return {
      nodes: copy,
      selectedId: newSelectedId,
      loadingNodeId: null,
      lastError: newError,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      nodes,
      selectedId,
      loadingNodeId: null,
      lastError: message,
    };
  }
}

/**
 * Replicate the tree-rebuild useEffect from RelationWindow.tsx lines 139-182.
 * Returns { nodes, rootId, selectedId, loadingNodeId }.
 */
function rebuildTree(
  rootName: string,
  rootFilePath: string | undefined,
  rootLineNumber: number | undefined,
  items: Array<{ id: string; label: string; filePath?: string; lineNumber?: number }>,
): {
  nodes: Nodes;
  rootId: string;
  selectedId: string;
  loadingNodeId: null;
} {
  const rid = `root:${rootName}`;
  const nextNodes: Nodes = {
    [rid]: makeNode({
      id: rid,
      label: rootName,
      filePath: rootFilePath,
      lineNumber: rootLineNumber,
      childrenIds: [],
      loaded: items.length > 0,
      expanded: true,
    }),
  };

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const id = `${rid}|${item.id}|${i}`;
    nextNodes[id] = makeNode({
      id,
      label: item.label,
      filePath: item.filePath,
      lineNumber: item.lineNumber,
      parentId: rid,
      childrenIds: [],
      loaded: false,
      expanded: false,
    });
    nextNodes[rid].childrenIds.push(id);
  }

  const selectedId = nextNodes[rid].childrenIds[0] ?? rid;

  return { nodes: nextNodes, rootId: rid, selectedId, loadingNodeId: null };
}

// ---------------------------------------------------------------------------
// 1. buildVisibleOrder
// ---------------------------------------------------------------------------

describe('RelationWindow — buildVisibleOrder', () => {
  test('root with 3 expanded children: all 4 nodes in DFS order', () => {
    const nodes: Nodes = {
      root: makeNode({ id: 'root', childrenIds: ['a', 'b', 'c'], expanded: true }),
      a: makeNode({ id: 'a', parentId: 'root' }),
      b: makeNode({ id: 'b', parentId: 'root' }),
      c: makeNode({ id: 'c', parentId: 'root' }),
    };
    expect(buildVisibleOrder(nodes, 'root')).toEqual(['root', 'a', 'b', 'c']);
  });

  test('root with 3 children, first child collapsed: first child visible but its children not', () => {
    const nodes: Nodes = {
      root: makeNode({ id: 'root', childrenIds: ['a', 'b', 'c'], expanded: true }),
      a: makeNode({ id: 'a', parentId: 'root', childrenIds: ['a1', 'a2'], expanded: false }),
      a1: makeNode({ id: 'a1', parentId: 'a' }),
      a2: makeNode({ id: 'a2', parentId: 'a' }),
      b: makeNode({ id: 'b', parentId: 'root' }),
      c: makeNode({ id: 'c', parentId: 'root' }),
    };
    // a is collapsed → a1, a2 not visible
    expect(buildVisibleOrder(nodes, 'root')).toEqual(['root', 'a', 'b', 'c']);
  });

  test('root with no children: just root', () => {
    const nodes: Nodes = {
      root: makeNode({ id: 'root', childrenIds: [], expanded: true }),
    };
    expect(buildVisibleOrder(nodes, 'root')).toEqual(['root']);
  });

  test('deeply nested 3 levels: correct DFS order', () => {
    const nodes: Nodes = {
      root: makeNode({ id: 'root', childrenIds: ['a'], expanded: true }),
      a: makeNode({ id: 'a', parentId: 'root', childrenIds: ['b'], expanded: true }),
      b: makeNode({ id: 'b', parentId: 'a', childrenIds: ['c'], expanded: true }),
      c: makeNode({ id: 'c', parentId: 'b' }),
    };
    expect(buildVisibleOrder(nodes, 'root')).toEqual(['root', 'a', 'b', 'c']);
  });

  test('root expanded but children also have children: only expanded subtrees visible', () => {
    const nodes: Nodes = {
      root: makeNode({ id: 'root', childrenIds: ['a', 'b'], expanded: true }),
      a: makeNode({ id: 'a', parentId: 'root', childrenIds: ['a1'], expanded: true }),
      a1: makeNode({ id: 'a1', parentId: 'a' }),
      b: makeNode({ id: 'b', parentId: 'root', childrenIds: ['b1'], expanded: false }),
      b1: makeNode({ id: 'b1', parentId: 'b' }),
    };
    // b is collapsed → b1 not visible
    expect(buildVisibleOrder(nodes, 'root')).toEqual(['root', 'a', 'a1', 'b']);
  });

  test('unknown startId returns empty list', () => {
    const nodes: Nodes = {
      root: makeNode({ id: 'root' }),
    };
    expect(buildVisibleOrder(nodes, 'nonexistent')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. moveParent — collapse-then-jump logic
// ---------------------------------------------------------------------------

describe('RelationWindow — moveParent collapse-then-jump', () => {
  test('expanded node with children: collapses it, does not jump to parent', () => {
    const nodes: Nodes = {
      root: makeNode({ id: 'root', childrenIds: ['a'], expanded: true }),
      a: makeNode({ id: 'a', parentId: 'root', childrenIds: ['a1'], expanded: true }),
      a1: makeNode({ id: 'a1', parentId: 'a' }),
    };
    const result = moveParent(nodes, 'a');
    // selectedId stays at 'a', node 'a' is now collapsed
    expect(result.selectedId).toBe('a');
    expect(result.nodes['a'].expanded).toBe(false);
  });

  test('collapsed node with parent: jumps to parent', () => {
    const nodes: Nodes = {
      root: makeNode({ id: 'root', childrenIds: ['a'], expanded: true }),
      a: makeNode({ id: 'a', parentId: 'root', childrenIds: ['a1'], expanded: false }),
      a1: makeNode({ id: 'a1', parentId: 'a' }),
    };
    const result = moveParent(nodes, 'a');
    expect(result.selectedId).toBe('root');
    expect(result.nodes['a'].expanded).toBe(false); // unchanged
  });

  test('expanded node with NO children: jumps to parent (not collapsed)', () => {
    // expanded=true but childrenIds=[] → the guard `current.childrenIds.length > 0` is false
    const nodes: Nodes = {
      root: makeNode({ id: 'root', childrenIds: ['a'], expanded: true }),
      a: makeNode({ id: 'a', parentId: 'root', childrenIds: [], expanded: true }),
    };
    const result = moveParent(nodes, 'a');
    // No children to collapse → jump to parent
    expect(result.selectedId).toBe('root');
  });

  test('root node with no parent: no change', () => {
    const nodes: Nodes = {
      root: makeNode({ id: 'root', childrenIds: ['a'], expanded: true }),
      a: makeNode({ id: 'a', parentId: 'root' }),
    };
    const result = moveParent(nodes, 'root');
    // root has no parentId → stays at root
    expect(result.selectedId).toBe('root');
  });

  test('nonexistent selectedId: no change', () => {
    const nodes: Nodes = {
      root: makeNode({ id: 'root' }),
    };
    const result = moveParent(nodes, 'nonexistent');
    expect(result.selectedId).toBe('nonexistent');
    expect(result.nodes).toBe(nodes); // unchanged reference
  });

  test('two-step: collapse then jump on second call', () => {
    const nodes: Nodes = {
      root: makeNode({ id: 'root', childrenIds: ['a'], expanded: true }),
      a: makeNode({ id: 'a', parentId: 'root', childrenIds: ['a1'], expanded: true }),
      a1: makeNode({ id: 'a1', parentId: 'a' }),
    };
    // First call: collapse 'a'
    const step1 = moveParent(nodes, 'a');
    expect(step1.selectedId).toBe('a');
    expect(step1.nodes['a'].expanded).toBe(false);

    // Second call: jump to parent
    const step2 = moveParent(step1.nodes, 'a');
    expect(step2.selectedId).toBe('root');
  });
});

// ---------------------------------------------------------------------------
// 3. expandSelected — error paths
// ---------------------------------------------------------------------------

describe('RelationWindow — expandSelected error paths', () => {
  test('node has no filePath: sets error "Selected node has no source location."', async () => {
    const nodes: Nodes = {
      root: makeNode({ id: 'root', childrenIds: ['a'], expanded: true }),
      a: makeNode({ id: 'a', parentId: 'root', filePath: undefined, lineNumber: undefined }),
    };
    const result = await expandSelected(nodes, 'a', null, 'incoming', async () => []);
    expect(result.lastError).toBe('Selected node has no source location.');
    expect(result.loadingNodeId).toBeNull();
  });

  test('node has no lineNumber: sets error "Selected node has no source location."', async () => {
    const nodes: Nodes = {
      root: makeNode({ id: 'root', childrenIds: ['a'], expanded: true }),
      a: makeNode({ id: 'a', parentId: 'root', filePath: '/src/foo.c', lineNumber: undefined }),
    };
    const result = await expandSelected(nodes, 'a', null, 'incoming', async () => []);
    expect(result.lastError).toBe('Selected node has no source location.');
  });

  test('node already loaded with no children: sets error "No deeper callers/callees found"', async () => {
    const nodes: Nodes = {
      root: makeNode({ id: 'root', childrenIds: ['a'], expanded: true }),
      a: makeNode({
        id: 'a',
        parentId: 'root',
        filePath: '/src/foo.c',
        lineNumber: 10,
        loaded: true,
        childrenIds: [],
      }),
    };
    const result = await expandSelected(nodes, 'a', null, 'incoming', async () => []);
    expect(result.lastError).toBe('No deeper callers/callees found for this symbol.');
    expect(result.loadingNodeId).toBeNull();
  });

  test('requestExpand rejects: sets error message, clears loadingNodeId', async () => {
    const nodes: Nodes = {
      root: makeNode({ id: 'root', childrenIds: ['a'], expanded: true }),
      a: makeNode({
        id: 'a',
        parentId: 'root',
        filePath: '/src/foo.c',
        lineNumber: 10,
        loaded: false,
      }),
    };
    const requestExpand = async () => {
      throw new Error('query timeout');
    };
    const result = await expandSelected(nodes, 'a', null, 'incoming', requestExpand);
    expect(result.lastError).toBe('query timeout');
    expect(result.loadingNodeId).toBeNull();
  });

  test('requestExpand rejects with non-Error: error is stringified', async () => {
    const nodes: Nodes = {
      root: makeNode({ id: 'root', childrenIds: ['a'], expanded: true }),
      a: makeNode({
        id: 'a',
        parentId: 'root',
        filePath: '/src/foo.c',
        lineNumber: 10,
        loaded: false,
      }),
    };
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    const requestExpand = async () => { throw 'network error'; };
    const result = await expandSelected(nodes, 'a', null, 'incoming', requestExpand);
    expect(result.lastError).toBe('network error');
    expect(result.loadingNodeId).toBeNull();
  });

  test('loadingNodeId is set: returns early without calling requestExpand', async () => {
    const nodes: Nodes = {
      root: makeNode({ id: 'root', childrenIds: ['a'], expanded: true }),
      a: makeNode({
        id: 'a',
        parentId: 'root',
        filePath: '/src/foo.c',
        lineNumber: 10,
        loaded: false,
      }),
    };
    let callCount = 0;
    const requestExpand = async () => {
      callCount++;
      return [];
    };
    // loadingNodeId already set → dedup guard fires
    const result = await expandSelected(nodes, 'a', 'a', 'incoming', requestExpand);
    expect(callCount).toBe(0);
    expect(result.nodes).toBe(nodes); // unchanged
    expect(result.selectedId).toBe('a');
    expect(result.loadingNodeId).toBe('a'); // preserved
  });

  test('successful expand with children: selects first child, clears error', async () => {
    const nodes: Nodes = {
      root: makeNode({ id: 'root', childrenIds: ['a'], expanded: true }),
      a: makeNode({
        id: 'a',
        parentId: 'root',
        filePath: '/src/foo.c',
        lineNumber: 10,
        loaded: false,
      }),
    };
    const requestExpand = async () => [
      { id: 'child1', label: 'child1', filePath: '/src/child1.c', lineNumber: 5 },
    ];
    const result = await expandSelected(nodes, 'a', null, 'incoming', requestExpand);
    expect(result.lastError).toBeNull();
    expect(result.loadingNodeId).toBeNull();
    expect(result.selectedId).toBe('a|child1|0');
    expect(result.nodes['a'].expanded).toBe(true);
    expect(result.nodes['a'].loaded).toBe(true);
    expect(result.nodes['a|child1|0']).toBeDefined();
  });

  test('successful expand with no children: sets "No deeper callers/callees" error', async () => {
    const nodes: Nodes = {
      root: makeNode({ id: 'root', childrenIds: ['a'], expanded: true }),
      a: makeNode({
        id: 'a',
        parentId: 'root',
        filePath: '/src/foo.c',
        lineNumber: 10,
        loaded: false,
      }),
    };
    const requestExpand = async () => [];
    const result = await expandSelected(nodes, 'a', null, 'incoming', requestExpand);
    expect(result.lastError).toBe('No deeper callers/callees found for this symbol.');
    expect(result.loadingNodeId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Tree rebuild on items change
// ---------------------------------------------------------------------------

describe('RelationWindow — tree rebuild on items change', () => {
  test('items change: tree rebuilt from scratch', () => {
    const items = [
      { id: 'caller1', label: 'caller1', filePath: '/src/caller1.c', lineNumber: 3 },
      { id: 'caller2', label: 'caller2', filePath: '/src/caller2.c', lineNumber: 7 },
    ];
    const { nodes, rootId } = rebuildTree('myFunc', '/src/main.c', 42, items);
    expect(nodes[rootId]).toBeDefined();
    expect(nodes[rootId].childrenIds).toHaveLength(2);
    expect(nodes[rootId].expanded).toBe(true);
  });

  test('selectedId is reset to first child after rebuild', () => {
    const items = [
      { id: 'caller1', label: 'caller1', filePath: '/src/caller1.c', lineNumber: 3 },
      { id: 'caller2', label: 'caller2', filePath: '/src/caller2.c', lineNumber: 7 },
    ];
    const { selectedId, nodes, rootId } = rebuildTree('myFunc', '/src/main.c', 42, items);
    expect(selectedId).toBe(nodes[rootId].childrenIds[0]);
  });

  test('selectedId is reset to root when no children', () => {
    const { selectedId, rootId } = rebuildTree('myFunc', '/src/main.c', 42, []);
    expect(selectedId).toBe(rootId);
  });

  test('loadingNodeId is cleared after rebuild', () => {
    const items = [
      { id: 'caller1', label: 'caller1', filePath: '/src/caller1.c', lineNumber: 3 },
    ];
    const { loadingNodeId } = rebuildTree('myFunc', '/src/main.c', 42, items);
    expect(loadingNodeId).toBeNull();
  });

  test('rebuild with new rootName creates new rootId', () => {
    const items = [{ id: 'c1', label: 'c1', filePath: '/src/c1.c', lineNumber: 1 }];
    const result1 = rebuildTree('funcA', '/src/a.c', 10, items);
    const result2 = rebuildTree('funcB', '/src/b.c', 20, items);
    expect(result1.rootId).toBe('root:funcA');
    expect(result2.rootId).toBe('root:funcB');
    expect(result1.rootId).not.toBe(result2.rootId);
  });

  test('child node IDs are deterministic: rootId|itemId|index', () => {
    const items = [
      { id: 'caller1', label: 'caller1', filePath: '/src/caller1.c', lineNumber: 3 },
    ];
    const { nodes, rootId } = rebuildTree('myFunc', '/src/main.c', 42, items);
    const expectedChildId = `${rootId}|caller1|0`;
    expect(nodes[rootId].childrenIds[0]).toBe(expectedChildId);
    expect(nodes[expectedChildId]).toBeDefined();
    expect(nodes[expectedChildId].parentId).toBe(rootId);
  });

  test('root node loaded flag reflects whether items exist', () => {
    const { nodes: nodesEmpty, rootId: ridEmpty } = rebuildTree('f', '/src/f.c', 1, []);
    expect(nodesEmpty[ridEmpty].loaded).toBe(false);

    const { nodes: nodesWithItems, rootId: ridItems } = rebuildTree('f', '/src/f.c', 1, [
      { id: 'c1', label: 'c1', filePath: '/src/c1.c', lineNumber: 1 },
    ]);
    expect(nodesWithItems[ridItems].loaded).toBe(true);
  });
});
