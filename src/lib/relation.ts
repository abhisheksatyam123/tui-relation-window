import type {
  FlatRelationItem,
  RelationPayload,
  RelationResult,
  RelationRootNode,
} from './types';
import { buildSystemStructureFromPayload, type SystemStructureGraph } from './system-structure';

export function normalizeRelationPayload(payload?: RelationPayload | null): {
  mode: 'incoming' | 'outgoing' | 'both';
  provider: string;
  rootName: string;
  rootFilePath?: string;
  rootLineNumber?: number;
  items: FlatRelationItem[];
  incomingItems: FlatRelationItem[];
  outgoingItems: FlatRelationItem[];
  systemStructure: SystemStructureGraph;
} {
  const mode = payload?.mode ?? 'incoming';
  const provider = payload?.provider ?? 'unknown';
  const result: RelationResult = payload?.result ?? {};
  const systemStructure = buildSystemStructureFromPayload(payload);

  const [rootName, rootNode] = firstRoot(result);
  if (!rootName || !rootNode) {
    return {
      mode,
      provider,
      rootName: '<none>',
      items: [],
      incomingItems: [],
      outgoingItems: [],
      systemStructure,
    };
  }

  const incomingItems = flattenIncoming(rootNode);
  const outgoingItems = flattenOutgoing(rootNode);
  const items = mode === 'outgoing' ? outgoingItems : incomingItems;

  return {
    mode,
    provider,
    rootName,
    rootFilePath: rootNode.filePath,
    rootLineNumber: rootNode.lineNumber,
    items,
    incomingItems,
    outgoingItems,
    systemStructure,
  };
}

function flattenIncoming(rootNode: RelationRootNode): FlatRelationItem[] {
  const items: FlatRelationItem[] = [];
  const calledBy = Array.isArray(rootNode.calledBy) ? rootNode.calledBy : [];
  for (const caller of calledBy) {
    items.push({
      id: `${caller.caller}:${caller.filePath}:${caller.lineNumber}`,
      label: caller.caller,
      filePath: caller.filePath,
      lineNumber: caller.lineNumber,
      relationType: 'incoming',
      symbolKind: caller.symbolKind,
      connectionKind: caller.connectionKind,
    });
  }
  return items;
}

function flattenOutgoing(rootNode: RelationRootNode): FlatRelationItem[] {
  const items: FlatRelationItem[] = [];
  const calls = Array.isArray(rootNode.calls) ? rootNode.calls : [];
  for (const callee of calls) {
    items.push({
      id: `${callee.callee}:${callee.filePath}:${callee.lineNumber}`,
      label: callee.callee,
      filePath: callee.filePath,
      lineNumber: callee.lineNumber,
      relationType: 'outgoing',
      symbolKind: callee.symbolKind,
      connectionKind: callee.connectionKind,
      viaRegistrationApi: callee.viaRegistrationApi,
    });
  }
  return items;
}

function firstRoot(result: RelationResult): [string | null, RelationRootNode | null] {
  const keys = Object.keys(result);
  if (keys.length === 0) {
    return [null, null];
  }

  const key = keys[0];
  return [key, result[key] ?? null];
}
