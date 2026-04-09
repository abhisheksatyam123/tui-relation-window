/**
 * RelationWindow.tsx
 *
 * Root orchestrator component for the q-relation-tui interface.
 *
 * Responsibilities:
 *   - Owns the tree node state (nodes, rootId, selectedId, loading, error)
 *   - Handles keyboard navigation via useKeyboard
 *   - Drives auto-scroll via scrollRef.current.scrollChildIntoView(selectedId)
 *   - Delegates all rendering to components in RelationComponents.tsx
 *
 * What was removed vs the old implementation:
 *   - walkTree()          → replaced by <RelationTree /> recursive component
 *   - renderNodeBox()     → replaced by <RelationNodeRow /> with proper <box>/<text>
 *   - panX / panY state   → replaced by native <scrollbox> scrollBy / scrollChildIntoView
 *   - manual viewport     → replaced by useTerminalDimensions + Yoga layout engine
 *   - animTick interval   → kept only for the spinner in <RelationFooter />
 *   - padToWidth/clipRow  → deleted; layout engine handles all sizing
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { ScrollBoxRenderable } from '@opentui/core';
import type { FlatRelationItem, QueryMode, RelationMode } from '../lib/types';
import type { LogRow, StructWriterRow } from '../lib/intelligence-query-adapters';
import { sendBridgeMessage } from '../lib/bridge';
import { logError, logInfo, logWarn } from '../lib/logger';
import { BothRelationWindow } from './BothRelationWindow';
import { LogPanel } from './LogPanel';
import { StructPanel } from './StructPanel';
import {
  RelationHeader,
  RelationFooter,
  RelationTree,
  EmptyState,
  Divider,
  type TreeNode,
} from './RelationComponents';

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

type Props = {
  mode: 'incoming' | 'outgoing' | 'both';
  provider: string;
  rootName: string;
  rootFilePath?: string;
  rootLineNumber?: number;
  items: FlatRelationItem[];
  incomingItems: FlatRelationItem[];
  outgoingItems: FlatRelationItem[];
  requestExpand: (node: {
    id: string;
    label: string;
    filePath: string;
    lineNumber: number;
    mode: QueryMode;
  }) => Promise<FlatRelationItem[]>;
  requestHover?: (node: {
    id: string;
    label: string;
    filePath: string;
    lineNumber: number;
  }) => Promise<string>;
  requestLogs?: (apiName: string) => Promise<LogRow[]>;
  requestStructWrites?: (apiName: string) => Promise<StructWriterRow[]>;
  workspaceRoot?: string;
  onOpenLocation: (item: FlatRelationItem) => void;
  onRefresh: () => void;
};

// ─────────────────────────────────────────────────────────────────────────────
// RelationWindow
// ─────────────────────────────────────────────────────────────────────────────

export function RelationWindow({
  mode,
  provider,
  rootName,
  rootFilePath,
  rootLineNumber,
  items,
  incomingItems,
  outgoingItems,
  requestExpand,
  requestHover,
  requestLogs,
  requestStructWrites,
  workspaceRoot,
  onOpenLocation,
  onRefresh,
}: Props) {
  if (mode === 'both') {
    return (
      <BothRelationWindow
        rootName={rootName}
        rootFilePath={rootFilePath}
        rootLineNumber={rootLineNumber}
        incomingItems={incomingItems}
        outgoingItems={outgoingItems}
        requestExpand={requestExpand}
        requestHover={requestHover}
        requestLogs={requestLogs}
        requestStructWrites={requestStructWrites}
        onOpenLocation={onOpenLocation}
      />
    );
  }
  // ── Tree state ──────────────────────────────────────────────────────────────
  const [nodes, setNodes] = useState<Record<string, TreeNode>>({});
  const [rootId, setRootId] = useState('root');
  const [selectedId, setSelectedId] = useState('root');
  const [loadingNodeId, setLoadingNodeId] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [animTick, setAnimTick] = useState(0);
  const [logPanel, setLogPanel] = useState<{
    apiName: string;
    rows: LogRow[];
    loading: boolean;
    error: string | null;
  } | null>(null);
  const [structPanel, setStructPanel] = useState<{
    apiName: string;
    rows: StructWriterRow[];
    loading: boolean;
    error: string | null;
  } | null>(null);

  // ── Refs ────────────────────────────────────────────────────────────────────
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const lastActionAtRef = useRef(0);
  const lastExpandAtRef = useRef(0);
  const lastKeySigRef = useRef<{ sig: string; at: number }>({ sig: '', at: 0 });

  // ── Terminal dimensions (for future use / responsive layout) ────────────────
  useTerminalDimensions(); // triggers re-render on resize

  // ── Build tree from incoming items ─────────────────────────────────────────
  useEffect(() => {
    const rid = `root:${rootName}`;
    const nextNodes: Record<string, TreeNode> = {
      [rid]: {
        id: rid,
        label: rootName,
        filePath: rootFilePath,
        lineNumber: rootLineNumber,
        childrenIds: [],
        loaded: items.length > 0,
        expanded: true,
      },
    };

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const id = `${rid}|${item.id}|${i}`;
      nextNodes[id] = {
        id,
        label: item.label,
        filePath: item.filePath,
        lineNumber: item.lineNumber,
        symbolKind: item.symbolKind,
        connectionKind: item.connectionKind,
        viaRegistrationApi: item.viaRegistrationApi,
        parentId: rid,
        childrenIds: [],
        loaded: false,
        expanded: false,
      };
      nextNodes[rid].childrenIds.push(id);
    }

    setNodes(nextNodes);
    setRootId(rid);
    setSelectedId(nextNodes[rid].childrenIds[0] ?? rid);
    setLoadingNodeId(null);
    setLastError(null);
    logInfo('app', 'tree rebuilt', {
      mode,
      rootName,
      rootChildren: nextNodes[rid].childrenIds.length,
    });
  }, [rootName, rootFilePath, rootLineNumber, items]);

  // ── Animation tick (spinner only) ──────────────────────────────────────────
  useEffect(() => {
    const timer = setInterval(() => {
      setAnimTick((v) => (v + 1) % 10000);
    }, 120);
    return () => clearInterval(timer);
  }, []);

  // ── Auto-scroll: keep selected node in view ─────────────────────────────────
  useEffect(() => {
    if (scrollRef.current && selectedId) {
      scrollRef.current.scrollChildIntoView(selectedId);
    }
  }, [selectedId]);

  // ── Derived values ──────────────────────────────────────────────────────────
  const selectedNode = nodes[selectedId];
  const hasItems = nodes[rootId]?.childrenIds.length > 0;

  // ── Navigation helpers ──────────────────────────────────────────────────────

  /**
   * Build a flat ordered list of all *visible* node IDs in the tree.
   * "Visible" means the node itself is always included; its children are
   * included only when the node is expanded.
   */
  const buildVisibleOrder = useCallback(
    (startId: string): string[] => {
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
    },
    [nodes],
  );

  const moveSibling = useCallback(
    (delta: number) => {
      const order = buildVisibleOrder(rootId);
      const idx = order.indexOf(selectedId);
      if (idx === -1) {
        logWarn('app', 'moveSibling ignored: selected node not visible', { selectedId, delta });
        return;
      }
      const next = idx + delta;
      if (next >= 0 && next < order.length) {
        logInfo('app', 'selection moved', { from: selectedId, to: order[next], delta });
        setSelectedId(order[next]);
      }
    },
    [buildVisibleOrder, rootId, selectedId],
  );

  const moveParent = useCallback(() => {
    const current = nodes[selectedId];
    if (!current) {
      logWarn('app', 'moveParent ignored: no selected node', { selectedId });
      return;
    }

    // If the node is expanded, collapse it first
    if (current.expanded && current.childrenIds.length > 0) {
      logInfo('app', 'node collapsed', { nodeId: current.id, children: current.childrenIds.length });
      setNodes((prev) => ({
        ...prev,
        [current.id]: { ...prev[current.id], expanded: false },
      }));
      return;
    }

    // Otherwise jump to parent
    if (current.parentId) {
      logInfo('app', 'moved to parent', { from: current.id, to: current.parentId });
      setSelectedId(current.parentId);
    }
  }, [nodes, selectedId]);

  const expandSelected = useCallback(async () => {
    if (loadingNodeId) {
      return;
    }
    const node = nodes[selectedId];
    if (!node) {
      logWarn('app', 'expand ignored: no selected node', { selectedId });
      return;
    }
    if (!node.filePath || !node.lineNumber) {
      logWarn('app', 'expand ignored: node has no source location', { nodeId: node.id });
      setLastError('Selected node has no source location.');
      return;
    }

    // Already loaded — just toggle expand and move into first child
    if (node.loaded) {
      if (node.childrenIds.length > 0) {
        logInfo('app', 'expanding loaded node', { nodeId: node.id, children: node.childrenIds.length });
        setNodes((prev) => ({
          ...prev,
          [node.id]: { ...prev[node.id], expanded: true },
        }));
        setSelectedId(node.childrenIds[0]);
      } else {
        logInfo('app', 'loaded node has no children', { nodeId: node.id });
        setLastError('No deeper callers/callees found for this symbol.');
      }
      return;
    }

    // Fetch children from backend via Neovim relay
    logInfo('app', 'expand query started', {
      nodeId: node.id,
      filePath: node.filePath,
      lineNumber: node.lineNumber,
      mode,
    });
    setLoadingNodeId(node.id);
    setLastError(null);

    try {
      const children = await requestExpand({
        id: node.id,
        label: node.label,
        filePath: node.filePath,
        lineNumber: node.lineNumber,
        mode,
      });

      setNodes((prev) => {
        const copy: Record<string, TreeNode> = { ...prev };
        const childIds: string[] = [];

        for (let i = 0; i < children.length; i += 1) {
          const child = children[i];
          const cid = `${node.id}|${child.id}|${i}`;
          copy[cid] = {
            id: cid,
            label: child.label,
            filePath: child.filePath,
            lineNumber: child.lineNumber,
            symbolKind: child.symbolKind,
            connectionKind: child.connectionKind,
            viaRegistrationApi: child.viaRegistrationApi,
            parentId: node.id,
            childrenIds: [],
            loaded: false,
            expanded: false,
          };
          childIds.push(cid);
        }

        copy[node.id] = {
          ...copy[node.id],
          loaded: true,
          expanded: true,
          childrenIds: childIds,
        };

        return copy;
      });

      if (children.length > 0) {
        setSelectedId(`${node.id}|${children[0].id}|0`);
        logInfo('app', 'expand query success', { nodeId: node.id, children: children.length });
      } else {
        setLastError('No deeper callers/callees found for this symbol.');
        logInfo('app', 'expand query returned no children', { nodeId: node.id });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError('app', 'expand query failed', { nodeId: node.id, error: message });
      setLastError(message);
    } finally {
      setLoadingNodeId(null);
    }
  }, [loadingNodeId, nodes, selectedId, mode, requestExpand]);

  const openSelected = useCallback(() => {
    if (selectedNode?.filePath && selectedNode?.lineNumber) {
      logInfo('app', 'opening selected location', {
        nodeId: selectedNode.id,
        filePath: selectedNode.filePath,
        lineNumber: selectedNode.lineNumber,
      });
      onOpenLocation({
        id: selectedNode.id,
        label: selectedNode.label,
        filePath: selectedNode.filePath,
        lineNumber: selectedNode.lineNumber,
        relationType: mode,
      });
      return;
    }
    logWarn('app', 'openSelected ignored: no source location', { selectedId });
    setLastError('Selected node has no source location.');
  }, [selectedId, selectedNode, onOpenLocation, mode]);

  const eventRawText = (event: any): string => {
    if (typeof event?.raw === 'string') return event.raw;
    if (event?.raw && typeof event.raw.toString === 'function') {
      try {
        return event.raw.toString('utf8');
      } catch {
        return '';
      }
    }
    return '';
  };

  const withActionGate = (action: () => void, minIntervalMs = 45) => {
    const now = Date.now();
    if (now - lastActionAtRef.current < minIntervalMs) return;
    lastActionAtRef.current = now;
    action();
  };

  const normalizeKey = (event: any):
    | 'down'
    | 'up'
    | 'left'
    | 'right'
    | 'open'
    | 'help'
    | 'escape'
    | 'logs'
    | 'struct'
    | null => {
    const raw = eventRawText(event);
    const name = typeof event?.name === 'string' ? event.name : '';
    const seq = typeof event?.sequence === 'string' ? event.sequence : '';
    const alt = Boolean(event?.alt || event?.meta);
    const ctrl = Boolean(event?.ctrl);
    if (alt || ctrl) return null;

    // Strict plain-key acceptance to avoid synthetic/noisy triggers.
    if (name === 'j' && seq === 'j' && raw === 'j') return 'down';
    if (name === 'k' && seq === 'k' && raw === 'k') return 'up';
    if (name === 'h' && seq === 'h' && raw === 'h') return 'left';
    if (name === 'l' && seq === 'l' && raw === 'l') return 'right';
    if (name === 'o' && seq === 'o' && raw === 'o') return 'open';
    if (name === '?' && seq === '?' && raw === '?') return 'help';
    if (name === 'L' && seq === 'L' && raw === 'L') return 'logs';
    if (name === 'W' && seq === 'W' && raw === 'W') return 'struct';

    // Arrow keys: accept canonical escape sequences only.
    if ((name === 'down' || seq === '\u001b[B') && raw === '\u001b[B') return 'down';
    if ((name === 'up' || seq === '\u001b[A') && raw === '\u001b[A') return 'up';
    if ((name === 'left' || seq === '\u001b[D') && raw === '\u001b[D') return 'left';
    if ((name === 'right' || seq === '\u001b[C') && raw === '\u001b[C') return 'right';

    // Escape for help-close only.
    if ((name === 'escape' || seq === '\u001b') && raw === '\u001b') return 'escape';

    return null;
  };

  // ── Keyboard handler ────────────────────────────────────────────────────────
  useKeyboard((event) => {
    const key = normalizeKey(event);
    if (!key) return;

    const raw = eventRawText(event);
    const sig = `${key}:${event?.name ?? ''}:${event?.sequence ?? ''}:${raw}`;
    const now = Date.now();
    if (lastKeySigRef.current.sig === sig && now - lastKeySigRef.current.at < 100) {
      return;
    }
    lastKeySigRef.current = { sig, at: now };

    // Help toggle
    if (key === 'help') {
      withActionGate(() => {
        logInfo('app', 'help toggled', { showHelp: !showHelp });
        setShowHelp((prev) => !prev);
      });
      return;
    }

    // Close struct panel, log panel or help on Esc (do not exit the TUI process)
    if (key === 'escape') {
      if (structPanel) {
        logInfo('app', 'struct panel closed via escape');
        setStructPanel(null);
        return;
      }
      if (logPanel) {
        logInfo('app', 'log panel closed via escape');
        setLogPanel(null);
        return;
      }
      if (showHelp) {
        logInfo('app', 'help closed via escape');
        setShowHelp(false);
      }
      return;
    }

    // Open log panel for selected node
    if (key === 'logs') {
      withActionGate(() => {
        const node = nodes[selectedId];
        if (!node) return;
        const apiName = node.label;
        logInfo('app', 'log panel requested', { apiName });
        setLogPanel({ apiName, rows: [], loading: true, error: null });
        if (!requestLogs) {
          setLogPanel({ apiName, rows: [], loading: false, error: 'requestLogs not configured' });
          return;
        }
        void requestLogs(apiName).then((rows) => {
          setLogPanel({ apiName, rows, loading: false, error: null });
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          logError('app', 'log panel fetch failed', { apiName, error: msg });
          setLogPanel({ apiName, rows: [], loading: false, error: msg });
        });
      });
      return;
    }

    // Open struct panel for selected node
    if (key === 'struct') {
      withActionGate(async () => {
        const node = nodes[selectedId];
        if (!node || node.id === rootId) return;
        const apiName = node.label;
        logInfo('app', 'struct panel requested', { apiName });
        setStructPanel({ apiName, rows: [], loading: true, error: null });
        try {
          if (requestStructWrites) {
            const rows = await requestStructWrites(apiName);
            setStructPanel((prev) => prev ? { ...prev, rows, loading: false } : null);
          } else {
            setStructPanel((prev) => prev ? { ...prev, loading: false, error: 'requestStructWrites not configured' } : null);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logError('app', 'struct panel fetch failed', { apiName, error: msg });
          setStructPanel((prev) => prev ? { ...prev, loading: false, error: msg } : null);
        }
      });
      return;
    }

    // Tree navigation
    if (key === 'down') {
      withActionGate(() => moveSibling(1));
    } else if (key === 'up') {
      withActionGate(() => moveSibling(-1));
    } else if (key === 'left') {
      withActionGate(() => moveParent());
    } else if (key === 'right') {
      if (now - lastExpandAtRef.current < 550) {
        return;
      }
      lastExpandAtRef.current = now;
      withActionGate(() => {
        void expandSelected();
      }, 120);
    } else if (key === 'open') {
      withActionGate(() => openSelected());
    }
  });

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      overflow="hidden"
    >
      {/* ── Header ── */}
      <RelationHeader
        mode={mode}
        rootName={rootName}
        provider={provider}
        selectedLabel={selectedNode?.label ?? ''}
      />

      <Divider />

      {/* ── Main scrollable canvas ── */}
      {hasItems ? (
        <scrollbox
          ref={scrollRef}
          flexGrow={1}
          scrollY={true}
          scrollX={true}
          viewportCulling={true}
          verticalScrollbarOptions={{ arrowOptions: { foregroundColor: '#4a4a4a', backgroundColor: '#1a1a1a' } }}
          horizontalScrollbarOptions={{ arrowOptions: { foregroundColor: '#4a4a4a', backgroundColor: '#1a1a1a' } }}
        >
          <RelationTree
            nodeId={rootId}
            nodes={nodes}
            selectedId={selectedId}
            mode={mode}
            depth={0}
            loadingNodeId={loadingNodeId}
          />
        </scrollbox>
      ) : (
        <EmptyState mode={mode} rootName={rootName} />
      )}

      <Divider />

      {/* ── Footer ── */}
      <RelationFooter
        loadingNodeId={loadingNodeId}
        lastError={lastError}
        showHelp={showHelp}
        animTick={animTick}
        workspaceRoot={workspaceRoot}
      />

      {/* ── Log panel overlay ── */}
      {logPanel && (
        <box
          position="absolute"
          top={2}
          left={2}
          width="90%"
          height="80%"
          zIndex={10}
        >
          <LogPanel
            apiName={logPanel.apiName}
            rows={logPanel.rows}
            loading={logPanel.loading}
            error={logPanel.error}
            onClose={() => setLogPanel(null)}
          />
        </box>
      )}

      {/* ── Struct panel overlay ── */}
      {structPanel && (
        <box
          position="absolute"
          top={3}
          left={3}
          width="90%"
          height="80%"
          zIndex={11}
        >
          <StructPanel
            apiName={structPanel.apiName}
            rows={structPanel.rows}
            loading={structPanel.loading}
            error={structPanel.error}
            onClose={() => setStructPanel(null)}
          />
        </box>
      )}
    </box>
  );
}
