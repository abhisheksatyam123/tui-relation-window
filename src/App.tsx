import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readFileSync } from 'node:fs';
import { RelationWindow } from './components/RelationWindow';
import { onBridgeMessage, sendBridgeMessage } from './lib/bridge';
import { normalizeRelationPayload } from './lib/relation';
import { logError, logInfo, logWarn } from './lib/logger';
import type { FlatRelationItem, QueryMode, RelationMode, RelationPayload } from './lib/types';
import type { SystemStructureGraph } from './lib/system-structure';

type RelationState = {
  mode: 'incoming' | 'outgoing' | 'both';
  provider: string;
  rootName: string;
  rootFilePath?: string;
  rootLineNumber?: number;
  items: FlatRelationItem[];
  incomingItems: FlatRelationItem[];
  outgoingItems: FlatRelationItem[];
  systemStructure: SystemStructureGraph;
};

const DEFAULT_PAYLOAD: RelationPayload = {
  mode: 'incoming',
  provider: 'none',
  result: null,
};

const QUERY_TIMEOUT_MS = 30000;
const GLOBAL_CUSTOM_KEY = '__global__';

type CustomByRoot = Record<string, { incoming: FlatRelationItem[]; outgoing: FlatRelationItem[] }>;

function makeRootKey(rootName: string, rootFilePath?: string, rootLineNumber?: number): string {
  return `${rootName}|${rootFilePath ?? ''}|${rootLineNumber ?? 0}`;
}

function mergeFlatItems(base: FlatRelationItem[], extra: FlatRelationItem[]): FlatRelationItem[] {
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

function inferSourcePoint(filePath: string, lineNumber: number, label: string): { lineNumber: number; character: number } {
  try {
    const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
    const idx = Math.max(0, lineNumber - 1);
    const line = lines[idx] ?? '';
    if (!line) return { lineNumber, character: 1 };

    const exact = line.indexOf(label);
    if (exact >= 0) return { lineNumber, character: exact + 1 };

    // Fallback: match token-ish prefix of label (handles variants/suffixes).
    const token = label.match(/[A-Za-z_][A-Za-z0-9_]*/)?.[0];
    if (token) {
      const partial = line.indexOf(token);
      if (partial >= 0) return { lineNumber, character: partial + 1 };

      // If label token is not present on the current line, walk upward to find
      // the nearest enclosing function signature that contains the label.
      // This avoids resolving the currently called callee token on callsite lines.
      for (let i = idx - 1; i >= Math.max(0, idx - 240); i -= 1) {
        const prev = lines[i] ?? '';
        if (!prev.includes(token)) continue;
        if (!prev.includes('(')) continue;
        const at = prev.indexOf(token);
        if (at >= 0) {
          return { lineNumber: i + 1, character: at + 1 };
        }
      }
    }

    // Fallback to first identifier-like token on line.
    const firstWord = line.match(/[A-Za-z_][A-Za-z0-9_]*/);
    if (firstWord?.index != null) return { lineNumber, character: firstWord.index + 1 };
  } catch {
    // Ignore inference errors and fall back.
  }

  return { lineNumber, character: 1 };
}

export function App() {
  const [payload, setPayload] = useState<RelationPayload>(DEFAULT_PAYLOAD);
  const [customByRoot, setCustomByRoot] = useState<CustomByRoot>({});
  const lastPayloadHash = useRef<string>('');
  const activeRootKeyRef = useRef<string>(GLOBAL_CUSTOM_KEY);
  const queryWaiters = useRef(new Map<string, {
    resolve: (items: FlatRelationItem[]) => void;
    reject: (error: Error) => void;
  }>());
  const hoverWaiters = useRef(new Map<string, {
    resolve: (text: string) => void;
    reject: (error: Error) => void;
  }>());
  const queryInFlightByNode = useRef(new Map<string, Promise<FlatRelationItem[]>>());

  useEffect(() => {
    const off = onBridgeMessage((message) => {
      if (message.type === 'set_data') {
        let payloadHash = '';
        try {
          payloadHash = JSON.stringify(message.payload);
        } catch {
          payloadHash = `${Date.now()}`;
        }
        if (payloadHash === lastPayloadHash.current) {
          return;
        }
        lastPayloadHash.current = payloadHash;
        logInfo('app', 'set_data received', {
          mode: message.payload.mode,
          provider: message.payload.provider,
          roots: message.payload.result ? Object.keys(message.payload.result).length : 0,
        });
        setPayload(message.payload);
        return;
      }

      if (message.type === 'add_custom_relation') {
        const p = message.payload;
        if (!p || !p.label || !p.filePath || !p.lineNumber) {
          logWarn('app', 'add_custom_relation ignored: invalid payload', { payload: p });
          return;
        }

        const relationType = p.relationType === 'outgoing' ? 'outgoing' : 'incoming';
        const rootKey = activeRootKeyRef.current || GLOBAL_CUSTOM_KEY;
        const item: FlatRelationItem = {
          id: `custom:${relationType}:${p.label}:${p.filePath}:${p.lineNumber}`,
          label: p.label,
          filePath: p.filePath,
          lineNumber: p.lineNumber,
          relationType,
          symbolKind: p.symbolKind,
        };

        setCustomByRoot((prev) => {
          const existing = prev[rootKey] ?? { incoming: [], outgoing: [] };
          const target = relationType === 'incoming' ? existing.incoming : existing.outgoing;
          const exists = target.some((x) =>
            x.label === item.label &&
            x.filePath === item.filePath &&
            x.lineNumber === item.lineNumber &&
            x.relationType === item.relationType,
          );
          if (exists) {
            return prev;
          }
          const nextEntry = relationType === 'incoming'
            ? { incoming: [...existing.incoming, item], outgoing: existing.outgoing }
            : { incoming: existing.incoming, outgoing: [...existing.outgoing, item] };
          return { ...prev, [rootKey]: nextEntry };
        });

        logInfo('app', 'custom relation added', {
          rootKey,
          relationType,
          label: item.label,
          filePath: item.filePath,
          lineNumber: item.lineNumber,
        });
        return;
      }

      if (message.type === 'query_result') {
        const waiter = queryWaiters.current.get(message.payload.requestId);
        if (!waiter) {
          logWarn('app', 'query_result without waiter', { requestId: message.payload.requestId });
          return;
        }
        queryWaiters.current.delete(message.payload.requestId);
        logInfo('app', 'query_result received', { requestId: message.payload.requestId });
        const normalized = normalizeRelationPayload(message.payload.result);
        waiter.resolve(normalized.items);
        return;
      }

      if (message.type === 'query_error') {
        const waiter = queryWaiters.current.get(message.payload.requestId);
        if (!waiter) {
          logWarn('app', 'query_error without waiter', { requestId: message.payload.requestId });
          return;
        }
        queryWaiters.current.delete(message.payload.requestId);
        logWarn('app', 'query_error received', {
          requestId: message.payload.requestId,
          error: message.payload.error,
        });
        waiter.reject(new Error(message.payload.error || 'query failed'));
        return;
      }

      if (message.type === 'hover_result') {
        const waiter = hoverWaiters.current.get(message.payload.requestId);
        if (!waiter) return;
        hoverWaiters.current.delete(message.payload.requestId);
        waiter.resolve(message.payload.hoverText || '');
        return;
      }

      if (message.type === 'hover_error') {
        const waiter = hoverWaiters.current.get(message.payload.requestId);
        if (!waiter) return;
        hoverWaiters.current.delete(message.payload.requestId);
        waiter.reject(new Error(message.payload.error || 'hover failed'));
        return;
      }

      if (message.type === 'refresh') {
        logInfo('app', 'refresh requested by host');
        sendBridgeMessage({ type: 'request_refresh' });
        return;
      }

      if (message.type === 'ping') {
        logInfo('app', 'ping received');
        sendBridgeMessage({ type: 'pong' });
        return;
      }

      if (message.type === 'quit') {
        logInfo('app', 'quit requested by host');
        sendBridgeMessage({ type: 'quit_ack' });
        // Give stderr a tick to flush before exiting
        setTimeout(() => process.exit(0), 50);
      }
    });

    return off;
  }, []);

  const state: RelationState = useMemo(() => normalizeRelationPayload(payload), [payload]);
  useEffect(() => {
    activeRootKeyRef.current = makeRootKey(state.rootName, state.rootFilePath, state.rootLineNumber);
  }, [state.rootFilePath, state.rootLineNumber, state.rootName]);

  const rootKey = useMemo(
    () => makeRootKey(state.rootName, state.rootFilePath, state.rootLineNumber),
    [state.rootFilePath, state.rootLineNumber, state.rootName],
  );
  const mergedIncomingItems = useMemo(() => {
    const scoped = customByRoot[rootKey]?.incoming ?? [];
    const global = customByRoot[GLOBAL_CUSTOM_KEY]?.incoming ?? [];
    return mergeFlatItems(mergeFlatItems(state.incomingItems, global), scoped);
  }, [customByRoot, rootKey, state.incomingItems]);
  const mergedOutgoingItems = useMemo(() => {
    const scoped = customByRoot[rootKey]?.outgoing ?? [];
    const global = customByRoot[GLOBAL_CUSTOM_KEY]?.outgoing ?? [];
    return mergeFlatItems(mergeFlatItems(state.outgoingItems, global), scoped);
  }, [customByRoot, rootKey, state.outgoingItems]);
  const mergedItems = useMemo(() => {
    if (state.mode === 'incoming') return mergedIncomingItems;
    if (state.mode === 'outgoing') return mergedOutgoingItems;
    return state.items;
  }, [mergedIncomingItems, mergedOutgoingItems, state.items, state.mode]);

  const requestExpand = useCallback(
    (node: { id: string; label: string; filePath: string; lineNumber: number; mode: QueryMode }) => {
      const queryKey = `${node.mode}:${node.id}`;
      const existing = queryInFlightByNode.current.get(queryKey);
      if (existing) {
        logInfo('app', 'query_relations deduped (in-flight)', { parentId: node.id, mode: node.mode });
        return existing;
      }

      const promise = new Promise<FlatRelationItem[]>((resolve, reject) => {
        const requestId = crypto.randomUUID();
        const inferred = inferSourcePoint(node.filePath, node.lineNumber, node.label);
        const timer = setTimeout(() => {
          queryWaiters.current.delete(requestId);
          logError('app', 'query timeout', { requestId, parentId: node.id, timeoutMs: QUERY_TIMEOUT_MS });
          reject(new Error(`query timed out after ${QUERY_TIMEOUT_MS}ms`));
        }, QUERY_TIMEOUT_MS);

        logInfo('app', 'query_relations requested', {
          requestId,
          parentId: node.id,
          filePath: node.filePath,
          lineNumber: node.lineNumber,
          inferredLineNumber: inferred.lineNumber,
          inferredCharacter: inferred.character,
          mode: node.mode,
        });

        const wrappedResolve = (items: FlatRelationItem[]) => {
          clearTimeout(timer);
          queryInFlightByNode.current.delete(queryKey);
          resolve(items);
        };
        const wrappedReject = (error: Error) => {
          clearTimeout(timer);
          queryInFlightByNode.current.delete(queryKey);
          reject(error);
        };
        queryWaiters.current.set(requestId, { resolve: wrappedResolve, reject: wrappedReject });

        sendBridgeMessage({
          type: 'query_relations',
          payload: {
            requestId,
            parentId: node.id,
            filePath: node.filePath,
            lineNumber: inferred.lineNumber,
            character: inferred.character,
            mode: node.mode,
          },
        });
      });

      queryInFlightByNode.current.set(queryKey, promise);
      return promise;
    },
    [],
  );

  const requestHover = useCallback((node: { id: string; filePath: string; lineNumber: number; label: string }) => {
    return new Promise<string>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const inferred = inferSourcePoint(node.filePath, node.lineNumber, node.label);
      const timer = setTimeout(() => {
        hoverWaiters.current.delete(requestId);
        reject(new Error(`hover timed out after ${QUERY_TIMEOUT_MS}ms`));
      }, QUERY_TIMEOUT_MS);

      hoverWaiters.current.set(requestId, {
        resolve: (text) => {
          clearTimeout(timer);
          resolve(text);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      sendBridgeMessage({
        type: 'query_hover',
        payload: {
          requestId,
          nodeId: node.id,
          filePath: node.filePath,
          lineNumber: inferred.lineNumber,
          character: inferred.character,
        },
      });
    });
  }, []);

  return (
    <RelationWindow
      mode={state.mode}
      provider={state.provider}
      rootName={state.rootName}
      rootFilePath={state.rootFilePath}
      rootLineNumber={state.rootLineNumber}
      items={mergedItems}
      incomingItems={mergedIncomingItems}
      outgoingItems={mergedOutgoingItems}
      requestExpand={requestExpand}
      requestHover={requestHover}
      onOpenLocation={(item) => {
        logInfo('app', 'open_location requested', {
          label: item.label,
          filePath: item.filePath,
          lineNumber: item.lineNumber,
        });
        sendBridgeMessage({
          type: 'open_location',
          payload: {
            filePath: item.filePath,
            lineNumber: item.lineNumber,
            label: item.label,
          },
        });
      }}
      onRefresh={() => {
        logInfo('app', 'manual refresh requested');
        sendBridgeMessage({ type: 'request_refresh' });
      }}
    />
  );
}
