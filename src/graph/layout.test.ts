import { describe, test, expect } from 'bun:test';
import { buildLayout, edgeKey, fitWidth, mergeEdgeChar, ROW_GAP } from './layout';
import { makeInitialGraph, addChildrenForDirection } from './core';
import type { GraphState } from './core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(id: string, label: string) {
  return {
    id,
    label,
    filePath: `${label}.cpp`,
    lineNumber: 1,
    relationType: 'incoming' as const,
    connectionKind: 'api_call' as const,
  };
}

// ---------------------------------------------------------------------------
// edgeKey
// ---------------------------------------------------------------------------

describe('edgeKey', () => {
  test('returns deterministic string key', () => {
    expect(edgeKey(3, 5)).toBe('3:5');
  });

  test('different row/col pairs produce different keys', () => {
    expect(edgeKey(1, 2)).not.toBe(edgeKey(2, 1));
    expect(edgeKey(0, 0)).not.toBe(edgeKey(0, 1));
    expect(edgeKey(0, 0)).not.toBe(edgeKey(1, 0));
  });

  test('same pair always produces same key', () => {
    expect(edgeKey(7, 9)).toBe(edgeKey(7, 9));
  });

  test('handles zero values', () => {
    expect(edgeKey(0, 0)).toBe('0:0');
  });
});

// ---------------------------------------------------------------------------
// fitWidth
// ---------------------------------------------------------------------------

describe('fitWidth', () => {
  test('pads text shorter than maxWidth with spaces', () => {
    expect(fitWidth('hi', 5)).toBe('hi   ');
  });

  test('preserves text exactly equal to maxWidth', () => {
    expect(fitWidth('hello', 5)).toBe('hello');
  });

  test('truncates text longer than maxWidth', () => {
    expect(fitWidth('hello world', 5)).toBe('hello');
  });

  test('handles empty string — pads with spaces', () => {
    expect(fitWidth('', 3)).toBe('   ');
  });

  test('handles maxWidth=0 — returns empty string', () => {
    expect(fitWidth('anything', 0)).toBe('');
  });

  test('handles maxWidth=1', () => {
    expect(fitWidth('abc', 1)).toBe('a');
    expect(fitWidth('', 1)).toBe(' ');
  });
});

// ---------------------------------------------------------------------------
// mergeEdgeChar
// ---------------------------------------------------------------------------

describe('mergeEdgeChar', () => {
  test('returns next when current is undefined', () => {
    expect(mergeEdgeChar(undefined, '│')).toBe('│');
  });

  test('returns current when current === next', () => {
    expect(mergeEdgeChar('│', '│')).toBe('│');
    expect(mergeEdgeChar('┼', '┼')).toBe('┼');
  });

  test('3-char uppercase label wins over line-drawing char', () => {
    expect(mergeEdgeChar('IRQ', '│')).toBe('IRQ');
    expect(mergeEdgeChar('│', 'IRQ')).toBe('IRQ');
    expect(mergeEdgeChar('RNG', '┤')).toBe('RNG');
    expect(mergeEdgeChar('┤', 'RNG')).toBe('RNG');
  });

  test('arrow chars (◀ ▶) win over non-arrow chars', () => {
    expect(mergeEdgeChar('◀', '│')).toBe('◀');
    expect(mergeEdgeChar('│', '◀')).toBe('◀');
    expect(mergeEdgeChar('▶', '┤')).toBe('▶');
    expect(mergeEdgeChar('┤', '▶')).toBe('▶');
  });

  test('vertical + branch char merges to ┼', () => {
    expect(mergeEdgeChar('│', '├')).toBe('┼');
    expect(mergeEdgeChar('├', '│')).toBe('┼');
    expect(mergeEdgeChar('║', '┤')).toBe('┼');
    expect(mergeEdgeChar('┤', '║')).toBe('┼');
    expect(mergeEdgeChar('│', '╠')).toBe('┼');
    expect(mergeEdgeChar('╣', '│')).toBe('┼');
  });

  test('┼ always wins', () => {
    expect(mergeEdgeChar('┼', '│')).toBe('┼');
    expect(mergeEdgeChar('│', '┼')).toBe('┼');
    expect(mergeEdgeChar('┼', '├')).toBe('┼');
  });

  test('branch chars merge to ┼', () => {
    expect(mergeEdgeChar('├', '┤')).toBe('┼');
    expect(mergeEdgeChar('╠', '╣')).toBe('┼');
    expect(mergeEdgeChar('├', '╣')).toBe('┼');
  });

  test('fallback returns next', () => {
    // Two different non-special chars — falls through to return next
    expect(mergeEdgeChar('─', '═')).toBe('═');
  });
});

// ---------------------------------------------------------------------------
// buildLayout
// ---------------------------------------------------------------------------

describe('buildLayout — empty graph (no children)', () => {
  test('root node is present at row 0', () => {
    const graph = makeInitialGraph('root', 'root.cpp', 1);
    const layout = buildLayout(graph);
    expect(layout.nodes['root']).toBeDefined();
    expect(layout.nodes['root'].row).toBe(0);
    expect(layout.nodes['root'].side).toBe('root');
  });

  test('no edges in empty graph', () => {
    const graph = makeInitialGraph('root', 'root.cpp', 1);
    const layout = buildLayout(graph);
    expect(layout.edges).toHaveLength(0);
  });

  test('maxRow is 0 for empty graph', () => {
    const graph = makeInitialGraph('root', 'root.cpp', 1);
    const layout = buildLayout(graph);
    expect(layout.maxRow).toBe(0);
  });

  test('maxIncomingDepth and maxOutgoingDepth are 0', () => {
    const graph = makeInitialGraph('root', 'root.cpp', 1);
    const layout = buildLayout(graph);
    expect(layout.maxIncomingDepth).toBe(0);
    expect(layout.maxOutgoingDepth).toBe(0);
  });
});

describe('buildLayout — single incoming child', () => {
  function makeGraphWithOneIncoming(): GraphState {
    const base = makeInitialGraph('root', 'root.cpp', 1);
    return addChildrenForDirection(base, 'incoming', 'root', [makeItem('a', 'A')]);
  }

  test('root node is present', () => {
    const layout = buildLayout(makeGraphWithOneIncoming());
    expect(layout.nodes['root']).toBeDefined();
  });

  test('incoming child is to the right of root (higher nodeCol)', () => {
    const layout = buildLayout(makeGraphWithOneIncoming());
    const rootCol = layout.nodes['root'].nodeCol;
    const childId = Object.keys(layout.nodes).find((id) => id !== 'root')!;
    const childCol = layout.nodes[childId].nodeCol;
    // incoming nodes are placed at rootCol + depth (right side)
    expect(childCol).toBeGreaterThan(rootCol);
  });

  test('incoming child has side=incoming', () => {
    const layout = buildLayout(makeGraphWithOneIncoming());
    const childId = Object.keys(layout.nodes).find((id) => id !== 'root')!;
    expect(layout.nodes[childId].side).toBe('incoming');
  });

  test('one edge is produced', () => {
    const layout = buildLayout(makeGraphWithOneIncoming());
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0].side).toBe('incoming');
  });

  test('maxIncomingDepth is 1', () => {
    const layout = buildLayout(makeGraphWithOneIncoming());
    expect(layout.maxIncomingDepth).toBe(1);
  });
});

describe('buildLayout — single outgoing child', () => {
  function makeGraphWithOneOutgoing(): GraphState {
    const base = makeInitialGraph('root', 'root.cpp', 1);
    return addChildrenForDirection(base, 'outgoing', 'root', [makeItem('b', 'B')]);
  }

  test('outgoing child is to the left of root (lower nodeCol)', () => {
    const layout = buildLayout(makeGraphWithOneOutgoing());
    const rootCol = layout.nodes['root'].nodeCol;
    const childId = Object.keys(layout.nodes).find((id) => id !== 'root')!;
    const childCol = layout.nodes[childId].nodeCol;
    // outgoing nodes are placed at rootCol - depth (left side)
    expect(childCol).toBeLessThan(rootCol);
  });

  test('outgoing child has side=outgoing', () => {
    const layout = buildLayout(makeGraphWithOneOutgoing());
    const childId = Object.keys(layout.nodes).find((id) => id !== 'root')!;
    expect(layout.nodes[childId].side).toBe('outgoing');
  });

  test('one edge is produced with side=outgoing', () => {
    const layout = buildLayout(makeGraphWithOneOutgoing());
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0].side).toBe('outgoing');
  });

  test('maxOutgoingDepth is 1', () => {
    const layout = buildLayout(makeGraphWithOneOutgoing());
    expect(layout.maxOutgoingDepth).toBe(1);
  });
});

describe('buildLayout — root column placement', () => {
  test('root nodeCol equals maxOutgoingDepth (no outgoing → col 0)', () => {
    const graph = makeInitialGraph('root', 'root.cpp', 1);
    const layout = buildLayout(graph);
    // rootCol = outDepth = 0 when no outgoing nodes
    expect(layout.nodes['root'].nodeCol).toBe(0);
  });

  test('root nodeCol equals maxOutgoingDepth when outgoing nodes exist', () => {
    const base = makeInitialGraph('root', 'root.cpp', 1);
    const graph = addChildrenForDirection(base, 'outgoing', 'root', [makeItem('c', 'C')]);
    const layout = buildLayout(graph);
    // outDepth = 1, so rootCol = 1
    expect(layout.nodes['root'].nodeCol).toBe(layout.maxOutgoingDepth);
  });
});

describe('buildLayout — multiple children row spacing', () => {
  test('multiple incoming children are spaced ROW_GAP apart', () => {
    const base = makeInitialGraph('root', 'root.cpp', 1);
    const graph = addChildrenForDirection(base, 'incoming', 'root', [
      makeItem('x', 'X'),
      makeItem('y', 'Y'),
    ]);
    const layout = buildLayout(graph);
    const childIds = Object.keys(layout.nodes).filter((id) => id !== 'root');
    expect(childIds).toHaveLength(2);
    const rows = childIds.map((id) => layout.nodes[id].row).sort((a, b) => a - b);
    expect(rows[1] - rows[0]).toBe(ROW_GAP);
  });

  test('maxRow reflects the last child row', () => {
    const base = makeInitialGraph('root', 'root.cpp', 1);
    const graph = addChildrenForDirection(base, 'incoming', 'root', [
      makeItem('p', 'P'),
      makeItem('q', 'Q'),
      makeItem('r', 'R'),
    ]);
    const layout = buildLayout(graph);
    const allRows = Object.values(layout.nodes).map((n) => n.row);
    expect(layout.maxRow).toBe(Math.max(...allRows));
  });
});

describe('buildLayout — incomingOrder / outgoingOrder', () => {
  test('incomingOrder contains incoming node ids sorted by row', () => {
    const base = makeInitialGraph('root', 'root.cpp', 1);
    const graph = addChildrenForDirection(base, 'incoming', 'root', [
      makeItem('a1', 'A1'),
      makeItem('a2', 'A2'),
    ]);
    const layout = buildLayout(graph);
    const rows = layout.incomingOrder.map((id) => layout.nodes[id]?.row ?? -1);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]).toBeGreaterThanOrEqual(rows[i - 1]);
    }
  });

  test('outgoingOrder contains outgoing node ids sorted by row', () => {
    const base = makeInitialGraph('root', 'root.cpp', 1);
    const graph = addChildrenForDirection(base, 'outgoing', 'root', [
      makeItem('b1', 'B1'),
      makeItem('b2', 'B2'),
    ]);
    const layout = buildLayout(graph);
    const rows = layout.outgoingOrder.map((id) => layout.nodes[id]?.row ?? -1);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]).toBeGreaterThanOrEqual(rows[i - 1]);
    }
  });
});

describe('buildLayout — edge properties', () => {
  test('edge fromRow and toRow match node rows', () => {
    const base = makeInitialGraph('root', 'root.cpp', 1);
    const graph = addChildrenForDirection(base, 'incoming', 'root', [makeItem('e1', 'E1')]);
    const layout = buildLayout(graph);
    const edge = layout.edges[0];
    expect(edge.fromRow).toBe(layout.nodes[edge.fromId]?.row);
    expect(edge.toRow).toBe(layout.nodes[edge.toId]?.row);
  });

  test('edge edgeCol is min of fromNode.nodeCol and toNode.nodeCol', () => {
    const base = makeInitialGraph('root', 'root.cpp', 1);
    const graph = addChildrenForDirection(base, 'incoming', 'root', [makeItem('e2', 'E2')]);
    const layout = buildLayout(graph);
    const edge = layout.edges[0];
    const fromCol = layout.nodes[edge.fromId]?.nodeCol ?? 0;
    const toCol = layout.nodes[edge.toId]?.nodeCol ?? 0;
    expect(edge.edgeCol).toBe(Math.min(fromCol, toCol));
  });

  test('edge kind defaults to api_call', () => {
    const base = makeInitialGraph('root', 'root.cpp', 1);
    const graph = addChildrenForDirection(base, 'outgoing', 'root', [makeItem('e3', 'E3')]);
    const layout = buildLayout(graph);
    expect(layout.edges[0].kind).toBe('api_call');
  });
});
