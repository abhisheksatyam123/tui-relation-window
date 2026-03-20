import type {
  RelationMode,
  RelationPayload,
  RelationResult,
  RelationRootNode,
  SystemConnectionKind,
  SystemNodeKind,
} from './types';

export type SystemStructureNode = {
  id: string;
  name: string;
  kind: SystemNodeKind;
  filePath?: string;
  lineNumber?: number;
  symbolKind?: number;
  metadata?: Record<string, string | number | boolean | null>;
};

export type SystemStructureLink = {
  id: string;
  from: string;
  to: string;
  kind: SystemConnectionKind;
  direction: 'in' | 'out' | 'bi';
  metadata?: Record<string, string | number | boolean | null>;
};

export type SystemStructureGraph = {
  version: 1;
  mode: RelationMode;
  provider: string;
  rootId: string | null;
  nodes: Record<string, SystemStructureNode>;
  links: SystemStructureLink[];
  adjacency: Record<string, string[]>;
};

export type SystemTrace = {
  nodeIds: string[];
  linkIds: string[];
};

export function buildSystemStructureFromPayload(payload?: RelationPayload | null): SystemStructureGraph {
  const mode: RelationMode = payload?.mode ?? 'incoming';
  const provider = payload?.provider ?? 'unknown';
  const result: RelationResult = payload?.result ?? {};
  const [rootName, rootNode] = firstRoot(result);

  const nodes: Record<string, SystemStructureNode> = {};
  const links: SystemStructureLink[] = [];
  const adjacency: Record<string, string[]> = {};
  const linkSet = new Set<string>();

  if (!rootName || !rootNode) {
    return { version: 1, mode, provider, rootId: null, nodes, links, adjacency };
  }

  const rootId = makeNodeId(rootName, rootNode.filePath, rootNode.lineNumber);
  upsertNode(nodes, {
    id: rootId,
    name: rootName,
    kind: 'api',
    filePath: rootNode.filePath,
    lineNumber: rootNode.lineNumber,
    symbolKind: rootNode.symbolKind,
  });

  // Core API call graph (current relation window data source).
  if (mode === 'incoming') {
    const calledBy = Array.isArray(rootNode.calledBy) ? rootNode.calledBy : [];
    for (const item of calledBy) {
      const callerId = makeNodeId(item.caller, item.filePath, item.lineNumber);
      upsertNode(nodes, {
        id: callerId,
        name: item.caller,
        kind: 'api',
        filePath: item.filePath,
        lineNumber: item.lineNumber,
        symbolKind: item.symbolKind,
      });
      addLink({
        linkSet,
        links,
        adjacency,
        from: callerId,
        to: rootId,
        kind: 'api_call',
        direction: 'in',
      });
    }
  } else {
    const calls = Array.isArray(rootNode.calls) ? rootNode.calls : [];
    for (const item of calls) {
      const calleeId = makeNodeId(item.callee, item.filePath, item.lineNumber);
      upsertNode(nodes, {
        id: calleeId,
        name: item.callee,
        kind: 'api',
        filePath: item.filePath,
        lineNumber: item.lineNumber,
        symbolKind: item.symbolKind,
      });
      addLink({
        linkSet,
        links,
        adjacency,
        from: rootId,
        to: calleeId,
        kind: 'api_call',
        direction: 'out',
      });
    }
  }

  // Extended system topology (interrupts, rings, signals, interface-reg, etc.)
  const systemNodes = Array.isArray(rootNode.systemNodes) ? rootNode.systemNodes : [];
  for (const node of systemNodes) {
    upsertNode(nodes, {
      id: node.id,
      name: node.name,
      kind: node.kind,
      filePath: node.filePath,
      lineNumber: node.lineNumber,
      symbolKind: node.symbolKind,
      metadata: node.metadata,
    });
  }

  const systemLinks = Array.isArray(rootNode.systemLinks) ? rootNode.systemLinks : [];
  for (const link of systemLinks) {
    if (!nodes[link.fromId]) {
      upsertNode(nodes, { id: link.fromId, name: link.fromId, kind: 'unknown' });
    }
    if (!nodes[link.toId]) {
      upsertNode(nodes, { id: link.toId, name: link.toId, kind: 'unknown' });
    }
    addLink({
      linkSet,
      links,
      adjacency,
      from: link.fromId,
      to: link.toId,
      kind: link.kind,
      direction: link.direction ?? 'out',
      metadata: link.metadata,
    });
  }

  return { version: 1, mode, provider, rootId, nodes, links, adjacency };
}

export function tracePath(graph: SystemStructureGraph, fromId: string, toId: string): SystemTrace | null {
  if (!graph.nodes[fromId] || !graph.nodes[toId]) return null;
  if (fromId === toId) return { nodeIds: [fromId], linkIds: [] };

  const queue: string[] = [fromId];
  const visited = new Set<string>([fromId]);
  const prevNode = new Map<string, string>();
  const prevLink = new Map<string, string>();

  while (queue.length > 0) {
    const nodeId = queue.shift() as string;
    const incident = graph.adjacency[nodeId] ?? [];
    for (const linkId of incident) {
      const link = graph.links.find((l) => l.id === linkId);
      if (!link) continue;

      const neighbors =
        link.direction === 'bi'
          ? [link.from, link.to]
          : link.direction === 'out'
            ? nodeId === link.from ? [link.to] : []
            : nodeId === link.to ? [link.from] : [];

      for (const next of neighbors) {
        if (visited.has(next)) continue;
        visited.add(next);
        prevNode.set(next, nodeId);
        prevLink.set(next, linkId);
        if (next === toId) {
          return reconstructTrace(fromId, toId, prevNode, prevLink);
        }
        queue.push(next);
      }
    }
  }

  return null;
}

function reconstructTrace(
  fromId: string,
  toId: string,
  prevNode: Map<string, string>,
  prevLink: Map<string, string>,
): SystemTrace {
  const nodeIds: string[] = [];
  const linkIds: string[] = [];
  let current = toId;

  while (current !== fromId) {
    nodeIds.push(current);
    const lid = prevLink.get(current);
    if (lid) linkIds.push(lid);
    current = prevNode.get(current) as string;
  }
  nodeIds.push(fromId);

  nodeIds.reverse();
  linkIds.reverse();
  return { nodeIds, linkIds };
}

function makeNodeId(name: string, filePath?: string, lineNumber?: number): string {
  const file = filePath ?? '<unknown-file>';
  const line = lineNumber ?? 0;
  return `${name}:${file}:${line}`;
}

function makeLinkId(from: string, to: string, kind: SystemConnectionKind): string {
  return `${from}->${to}:${kind}`;
}

function upsertNode(nodes: Record<string, SystemStructureNode>, node: SystemStructureNode) {
  const existing = nodes[node.id];
  if (!existing) {
    nodes[node.id] = node;
    return;
  }

  nodes[node.id] = {
    ...existing,
    ...node,
    metadata: { ...(existing.metadata ?? {}), ...(node.metadata ?? {}) },
  };
}

function addLink(input: {
  linkSet: Set<string>;
  links: SystemStructureLink[];
  adjacency: Record<string, string[]>;
  from: string;
  to: string;
  kind: SystemConnectionKind;
  direction: 'in' | 'out' | 'bi';
  metadata?: Record<string, string | number | boolean | null>;
}) {
  const { linkSet, links, adjacency, from, to, kind, direction, metadata } = input;
  const id = makeLinkId(from, to, kind);
  if (linkSet.has(id)) return;
  linkSet.add(id);

  links.push({ id, from, to, kind, direction, metadata });
  if (!adjacency[from]) adjacency[from] = [];
  if (!adjacency[to]) adjacency[to] = [];
  adjacency[from].push(id);
  adjacency[to].push(id);
}

function firstRoot(result: RelationResult): [string | null, RelationRootNode | null] {
  const keys = Object.keys(result);
  if (keys.length === 0) return [null, null];
  const key = keys[0];
  return [key, result[key] ?? null];
}
