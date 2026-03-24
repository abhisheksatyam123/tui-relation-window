import type { Direction, EdgeKind, GraphState } from './core';

export const ROW_GAP = 2;

export type LayoutNode = {
  id: string;
  side: Direction | 'root';
  depth: number;
  row: number;
  nodeCol: number;
};

export type LayoutEdge = {
  side: Direction;
  fromId: string;
  toId: string;
  edgeCol: number;
  fromRow: number;
  toRow: number;
  kind: EdgeKind;
};

export type GraphLayout = {
  nodes: Record<string, LayoutNode>;
  edges: LayoutEdge[];
  incomingOrder: string[];
  outgoingOrder: string[];
  maxIncomingDepth: number;
  maxOutgoingDepth: number;
  maxRow: number;
};

function maxDepth(side: GraphState['incoming']): number {
  let max = 0;
  for (const id of Object.keys(side.depthByNode)) {
    const d = side.depthByNode[id] ?? 0;
    if (d > max) max = d;
  }
  return max;
}

function layoutDirection(
  graph: GraphState,
  sideName: Direction,
): {
  rows: Record<string, number>;
  rootRow: number;
  edges: Array<{ fromId: string; toId: string }>;
  order: string[];
} {
  const side = sideName === 'incoming' ? graph.incoming : graph.outgoing;
  const rows: Record<string, number> = {};
  const edges: Array<{ fromId: string; toId: string }> = [];
  const order: string[] = [];
  let cursor = 0;

  const assign = (nodeId: string): number => {
    const children = side.childrenByParent[nodeId] ?? [];
    const visibleChildren = side.expandedByNode[nodeId] ? children : [];
    if (visibleChildren.length === 0) {
      const row = cursor;
      cursor += ROW_GAP;
      rows[nodeId] = row;
      if (nodeId !== graph.rootId) order.push(nodeId);
      return row;
    }

    const childRows = visibleChildren.map((childId) => {
      edges.push({ fromId: nodeId, toId: childId });
      return assign(childId);
    });
    const row = Math.round((childRows[0] + childRows[childRows.length - 1]) / 2);
    rows[nodeId] = row;
    if (nodeId !== graph.rootId) order.push(nodeId);
    return row;
  };

  const rootChildren = side.childrenByParent[graph.rootId] ?? [];
  if (rootChildren.length === 0) {
    rows[graph.rootId] = 0;
    return { rows, rootRow: 0, edges, order };
  }
  const rootChildRows = rootChildren.map((childId) => {
    edges.push({ fromId: graph.rootId, toId: childId });
    return assign(childId);
  });
  const rootRow = Math.round((rootChildRows[0] + rootChildRows[rootChildRows.length - 1]) / 2);
  rows[graph.rootId] = rootRow;
  return { rows, rootRow, edges, order };
}

export function buildLayout(graph: GraphState): GraphLayout {
  const inDepth = maxDepth(graph.incoming);
  const outDepth = maxDepth(graph.outgoing);
  const rootCol = outDepth;

  const incoming = layoutDirection(graph, 'incoming');
  const outgoing = layoutDirection(graph, 'outgoing');
  const rootRow = Math.max(incoming.rootRow, outgoing.rootRow);
  const shiftIncoming = rootRow - incoming.rootRow;
  const shiftOutgoing = rootRow - outgoing.rootRow;

  const nodes: Record<string, LayoutNode> = {
    [graph.rootId]: {
      id: graph.rootId,
      side: 'root',
      depth: 0,
      row: rootRow,
      nodeCol: rootCol,
    },
  };

  const addSideNodes = (sideName: Direction, rows: Record<string, number>, shift: number) => {
    const side = sideName === 'incoming' ? graph.incoming : graph.outgoing;
    for (const id of Object.keys(rows)) {
      if (id === graph.rootId) continue;
      const depth = side.depthByNode[id] ?? 1;
      const nodeCol = sideName === 'incoming' ? rootCol + depth : rootCol - depth;
      nodes[id] = { id, side: sideName, depth, row: rows[id] + shift, nodeCol };
    }
  };
  addSideNodes('incoming', incoming.rows, shiftIncoming);
  addSideNodes('outgoing', outgoing.rows, shiftOutgoing);

  const edgeRows: LayoutEdge[] = [];
  const addEdges = (sideName: Direction, edges: Array<{ fromId: string; toId: string }>) => {
    for (const edge of edges) {
      const fromNode = nodes[edge.fromId];
      const toNode = nodes[edge.toId];
      if (!fromNode || !toNode) continue;
      edgeRows.push({
        side: sideName,
        fromId: edge.fromId,
        toId: edge.toId,
        edgeCol: Math.min(fromNode.nodeCol, toNode.nodeCol),
        fromRow: fromNode.row,
        toRow: toNode.row,
        kind: graph.nodes[edge.toId]?.edgeKindFromParent ?? 'api_call',
      });
    }
  };
  addEdges('incoming', incoming.edges);
  addEdges('outgoing', outgoing.edges);

  const maxRow = Math.max(rootRow, ...Object.values(nodes).map((n) => n.row));
  const incomingOrder = incoming.order.slice().sort((a, b) => (nodes[a]?.row ?? 0) - (nodes[b]?.row ?? 0));
  const outgoingOrder = outgoing.order.slice().sort((a, b) => (nodes[a]?.row ?? 0) - (nodes[b]?.row ?? 0));
  return {
    nodes,
    edges: edgeRows,
    incomingOrder,
    outgoingOrder,
    maxIncomingDepth: inDepth,
    maxOutgoingDepth: outDepth,
    maxRow,
  };
}

export function edgeKey(row: number, col: number): string {
  return `${row}:${col}`;
}

export function fitWidth(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length >= width) return text.slice(0, width);
  return `${text}${' '.repeat(width - text.length)}`;
}

export function mergeEdgeChar(current: string | undefined, next: string): string {
  if (!current) return next;
  if (current === next) return current;
  
  // Preserve 3-char labels (IRQ, RNG, THR, SIG, IND) over line-drawing chars
  const isLabel = (s: string) => s.length === 3 && /^[A-Z]{3}$/.test(s);
  if (isLabel(current)) return current;
  if (isLabel(next)) return next;
  
  if (current === '◀' || current === '▶') return current;
  if (next === '◀' || next === '▶') return next;
  if (
    ((current === '│' || current === '║') && (next === '├' || next === '┤' || next === '╠' || next === '╣')) ||
    ((next === '│' || next === '║') && (current === '├' || current === '┤' || current === '╠' || current === '╣'))
  ) return '┼';
  if (current === '┼' || next === '┼') return '┼';
  if (
    current === '├' || current === '┤' || current === '╠' || current === '╣' ||
    next === '├' || next === '┤' || next === '╠' || next === '╣'
  ) return '┼';
  return next;
}
