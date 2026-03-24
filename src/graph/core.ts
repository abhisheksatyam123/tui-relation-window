import type { FlatRelationItem, SystemConnectionKind } from '../lib/types';

export type Direction = 'incoming' | 'outgoing';
export type EdgeKind = SystemConnectionKind;

export type NodeInstance = {
  id: string;
  label: string;
  filePath: string;
  lineNumber: number;
  symbolKind?: number;
  edgeKindFromParent?: EdgeKind;
};

export type DirectionGraph = {
  childrenByParent: Record<string, string[]>;
  parentByNode: Record<string, string | undefined>;
  depthByNode: Record<string, number>;
  loadedByNode: Record<string, boolean>;
  expandedByNode: Record<string, boolean>;
  loadingNodeId: string | null;
  error: string | null;
};

export type GraphState = {
  nodes: Record<string, NodeInstance>;
  rootId: string;
  selectedId: string;
  activeDirection: Direction;
  incoming: DirectionGraph;
  outgoing: DirectionGraph;
};

function newDirectionGraph(rootId: string): DirectionGraph {
  return {
    childrenByParent: { [rootId]: [] },
    parentByNode: { [rootId]: undefined },
    depthByNode: { [rootId]: 0 },
    loadedByNode: { [rootId]: false },
    expandedByNode: { [rootId]: false },
    loadingNodeId: null,
    error: null,
  };
}

export function makeInitialGraph(
  rootName: string,
  rootFilePath: string | undefined,
  rootLineNumber: number | undefined,
): GraphState {
  const rootId = 'root';
  return {
    nodes: {
      [rootId]: {
        id: rootId,
        label: rootName,
        filePath: rootFilePath ?? '',
        lineNumber: rootLineNumber ?? 1,
      },
    },
    rootId,
    selectedId: rootId,
    activeDirection: 'incoming',
    incoming: newDirectionGraph(rootId),
    outgoing: newDirectionGraph(rootId),
  };
}

export function addChildrenForDirection(
  base: GraphState,
  direction: Direction,
  parentId: string,
  items: FlatRelationItem[],
): GraphState {
  const side = direction === 'incoming' ? base.incoming : base.outgoing;
  const nextNodes = { ...base.nodes };
  const nextChildrenByParent = { ...side.childrenByParent };
  const nextParentByNode = { ...side.parentByNode };
  const nextDepthByNode = { ...side.depthByNode };
  const nextLoadedByNode = { ...side.loadedByNode };
  const nextExpandedByNode = { ...side.expandedByNode };

  let effectiveParentId = parentId;
  if (parentId !== base.rootId && nextDepthByNode[parentId] === undefined) {
    const original = base.nodes[parentId];
    const anchorId = `${direction}:anchor:${parentId}`;
    if (!nextNodes[anchorId]) {
      nextNodes[anchorId] = {
        id: anchorId,
        label: original?.label ?? '',
        filePath: original?.filePath ?? '',
        lineNumber: original?.lineNumber ?? 1,
        symbolKind: original?.symbolKind,
      };
    }
    nextParentByNode[anchorId] = base.rootId;
    nextDepthByNode[anchorId] = 1;
    if (!nextChildrenByParent[anchorId]) {
      nextChildrenByParent[anchorId] = [];
    }
    const rootChildren = nextChildrenByParent[base.rootId] ?? [];
    if (!rootChildren.includes(anchorId)) {
      nextChildrenByParent[base.rootId] = [...rootChildren, anchorId];
    }
    if (nextLoadedByNode[anchorId] === undefined) {
      nextLoadedByNode[anchorId] = false;
    }
    if (nextExpandedByNode[anchorId] === undefined) {
      nextExpandedByNode[anchorId] = false;
    }
    nextLoadedByNode[parentId] = true;
    nextExpandedByNode[parentId] = true;
    effectiveParentId = anchorId;
  }

  const parentDepth = nextDepthByNode[effectiveParentId] ?? 0;
  const existingIds = nextChildrenByParent[effectiveParentId] ?? [];
  const keyFor = (label: string, filePath: string, lineNumber: number) => `${label}|${filePath}|${lineNumber}`;
  const existingByKey = new Map<string, string>();
  for (const id of existingIds) {
    const n = nextNodes[id];
    if (!n) continue;
    existingByKey.set(keyFor(n.label, n.filePath, n.lineNumber), id);
  }
  const appendedIds: string[] = [];

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const nodeKey = keyFor(item.label, item.filePath, item.lineNumber);
    const existingId = existingByKey.get(nodeKey);
    const nodeId = existingId ?? `${direction}:${effectiveParentId}:${existingIds.length + appendedIds.length}:${item.id}`;
    nextNodes[nodeId] = {
      id: nodeId,
      label: item.label,
      filePath: item.filePath,
      lineNumber: item.lineNumber,
      symbolKind: item.symbolKind,
      edgeKindFromParent: item.connectionKind ?? 'api_call',
    };
    appendedIds.push(nodeId);
    nextParentByNode[nodeId] = effectiveParentId;
    nextDepthByNode[nodeId] = parentDepth + 1;
    if (nextLoadedByNode[nodeId] === undefined) nextLoadedByNode[nodeId] = false;
    if (nextExpandedByNode[nodeId] === undefined) nextExpandedByNode[nodeId] = false;
    if (!nextChildrenByParent[nodeId]) nextChildrenByParent[nodeId] = [];
  }

  const mergedIds = [...existingIds];
  for (const id of appendedIds) {
    if (!mergedIds.includes(id)) mergedIds.push(id);
  }
  nextChildrenByParent[effectiveParentId] = mergedIds;
  nextLoadedByNode[effectiveParentId] = true;
  nextExpandedByNode[effectiveParentId] = true;

  const nextSide: DirectionGraph = {
    ...side,
    childrenByParent: nextChildrenByParent,
    parentByNode: nextParentByNode,
    depthByNode: nextDepthByNode,
    loadedByNode: nextLoadedByNode,
    expandedByNode: nextExpandedByNode,
    error: null,
  };

  return {
    ...base,
    nodes: nextNodes,
    incoming: direction === 'incoming' ? nextSide : base.incoming,
    outgoing: direction === 'outgoing' ? nextSide : base.outgoing,
  };
}

export function sideForNode(graph: GraphState, nodeId: string): Direction | 'root' {
  if (nodeId === graph.rootId) return 'root';
  if (graph.incoming.depthByNode[nodeId] !== undefined) return 'incoming';
  if (graph.outgoing.depthByNode[nodeId] !== undefined) return 'outgoing';
  return 'root';
}

export function collectSubtreeIds(side: DirectionGraph, startId: string): string[] {
  const out: string[] = [];
  const visit = (id: string) => {
    out.push(id);
    const children = side.childrenByParent[id] ?? [];
    for (const child of children) visit(child);
  };
  visit(startId);
  return out;
}

export function removeSubtreesFromSide(
  prev: GraphState,
  direction: Direction,
  removeRootIds: string[],
): { next: GraphState; removed: string[] } {
  const side = direction === 'incoming' ? prev.incoming : prev.outgoing;
  const removeSet = new Set<string>();
  for (const rid of removeRootIds) {
    for (const id of collectSubtreeIds(side, rid)) removeSet.add(id);
  }
  if (removeSet.size === 0) return { next: prev, removed: [] };

  const nextNodes = { ...prev.nodes };
  const nextChildrenByParent = { ...side.childrenByParent };
  const nextParentByNode = { ...side.parentByNode };
  const nextDepthByNode = { ...side.depthByNode };
  const nextLoadedByNode = { ...side.loadedByNode };
  const nextExpandedByNode = { ...side.expandedByNode };

  for (const id of removeSet) {
    delete nextNodes[id];
    delete nextChildrenByParent[id];
    delete nextParentByNode[id];
    delete nextDepthByNode[id];
    delete nextLoadedByNode[id];
    delete nextExpandedByNode[id];
  }

  for (const parentId of Object.keys(nextChildrenByParent)) {
    const children = nextChildrenByParent[parentId] ?? [];
    nextChildrenByParent[parentId] = children.filter((id) => !removeSet.has(id));
  }

  const nextSide: DirectionGraph = {
    ...side,
    childrenByParent: nextChildrenByParent,
    parentByNode: nextParentByNode,
    depthByNode: nextDepthByNode,
    loadedByNode: nextLoadedByNode,
    expandedByNode: nextExpandedByNode,
  };

  const nextGraph: GraphState = {
    ...prev,
    nodes: nextNodes,
    incoming: direction === 'incoming' ? nextSide : prev.incoming,
    outgoing: direction === 'outgoing' ? nextSide : prev.outgoing,
  };

  return { next: nextGraph, removed: Array.from(removeSet) };
}
