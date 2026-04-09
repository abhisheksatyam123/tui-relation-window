import type {
  FlatRelationItem,
  RelationPayload,
  RelationResult,
  RelationRootNode,
} from './types';
import { buildSystemStructureFromPayload, type SystemStructureGraph } from './system-structure';

/**
 * Merges extra FlatRelationItem[] into base, deduplicating by label|filePath|lineNumber|relationType.
 * Used to combine custom relations with normalized payload items.
 */
export function mergeFlatItems(base: FlatRelationItem[], extra: FlatRelationItem[]): FlatRelationItem[] {
  if (extra.length === 0) return base;
  const seen = new Set(base.map((item) => `${item.label}|${item.filePath}|${item.lineNumber}|${item.relationType}`));
  const out = [...base];
  for (const item of extra) {
    const key = `${item.label}|${item.filePath}|${item.lineNumber}|${item.relationType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Normalizes a RelationPayload from the backend into a flat structure for rendering.
 * 
 * Runtime-only contract (TD-001):
 * - Backend is responsible for filtering registration nodes from incoming callers
 * - Frontend is a transparent pass-through layer that preserves all nodes and connectionKind
 * - Frontend does NOT add filtering logic based on connectionKind
 * - For incoming/both modes, backend should return only runtime callers (no interface_registration)
 */
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

/**
 * Flattens incoming callers from rootNode.calledBy into FlatRelationItem array.
 * 
 * Passes through ALL callers including registrars (interface_registration).
 * The TUI renders them with distinct [REG] badges.
 * Preserves connectionKind and viaRegistrationApi exactly as provided by backend.
 */
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
      viaRegistrationApi: caller.viaRegistrationApi,
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
