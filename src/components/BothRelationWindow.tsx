import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { MouseButton } from '@opentui/core';
import type { MouseEvent } from '@opentui/core';
import type { FlatRelationItem, QueryMode } from '../lib/types';
import { logError, logInfo, logWarn, writeUiSnapshot } from '../lib/logger';
import { sendBridgeMessage } from '../lib/bridge';
import {
  addChildrenForDirection,
  makeInitialGraph,
  removeSubtreesFromSide,
  sideForNode,
  type Direction,
  type DirectionGraph,
  type GraphState,
  type EdgeKind,
} from '../graph/core';
import { buildLayout, edgeKey, fitWidth, mergeEdgeChar, type LayoutNode } from '../graph/layout';
import { LogPanel } from './LogPanel';
import { StructPanel } from './StructPanel';
import type { LogRow, StructWriterRow } from '../lib/intelligence-query-adapters';
import { spinnerFrame } from './RelationComponents';

type Props = {
  rootName: string;
  rootFilePath?: string;
  rootLineNumber?: number;
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
  onOpenLocation: (item: FlatRelationItem) => void;
};

const NODE_COL_WIDTH = 36;  // wide enough for most WLAN symbol names
const EDGE_COL_WIDTH = 5;   // edge glyph + spacing
const CANVAS_PADDING_X = 4;
const CANVAS_PADDING_Y = 3;
const ROOT_ROW_OFFSET = 12;
const DOUBLE_CLICK_MS = 320;

export function BothRelationWindow({
  rootName,
  rootFilePath,
  rootLineNumber,
  incomingItems,
  outgoingItems,
  requestExpand,
  requestHover,
  requestLogs,
  requestStructWrites,
  onOpenLocation,
}: Props) {
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const initialIncomingRef = useRef<FlatRelationItem[]>(incomingItems);
  const initialOutgoingRef = useRef<FlatRelationItem[]>(outgoingItems);
  const [graph, setGraph] = useState<GraphState>(() =>
    makeInitialGraph(rootName, rootFilePath, rootLineNumber),
  );
  const [showHelp, setShowHelp] = useState(false);
  const [hoveredEdge, setHoveredEdge] = useState<{ key: string; glyph: string } | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [animTick, setAnimTick] = useState(0);
  // Search mode — press / to activate, type to filter, n/N to cycle, Esc to exit
  const [searchMode, setSearchMode] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [searchMatchIdx, setSearchMatchIdx] = useState(0);
  // Log and struct panels
  type PanelState<T> = { apiName: string; rows: T[]; loading: boolean; error: string | null } | null;
  const [logPanel, setLogPanel] = useState<PanelState<LogRow>>(null);
  const [structPanel, setStructPanel] = useState<PanelState<StructWriterRow>>(null);
  // Hover text feature temporarily disabled.
  const lastKeyRef = useRef<{ sig: string; at: number }>({ sig: '', at: 0 });
  const lastUiSnapshotRef = useRef('');
  const dragStateRef = useRef<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false });
  const middleScrollRef = useRef<{ x: number; y: number } | null>(null);
  const pressStateRef = useRef<{
    button: number;
    startX: number;
    startY: number;
    dragged: boolean;
    nodeId: string | null;
  } | null>(null);
  const lastClickRef = useRef<{ nodeId: string | null; at: number }>({ nodeId: null, at: 0 });

  // Spinner animation tick
  useEffect(() => {
    const interval = setInterval(() => setAnimTick((t) => t + 1), 120);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    initialIncomingRef.current = incomingItems;
    initialOutgoingRef.current = outgoingItems;
  }, [incomingItems, outgoingItems]);

  // Keep root children in sync with incoming/outgoing props (backend refreshes
  // and user-added custom relations) without resetting the whole graph.
  useEffect(() => {
    setGraph((prev) => addChildrenForDirection(prev, 'incoming', prev.rootId, incomingItems));
  }, [incomingItems]);

  useEffect(() => {
    setGraph((prev) => addChildrenForDirection(prev, 'outgoing', prev.rootId, outgoingItems));
  }, [outgoingItems]);

  useEffect(() => {
    setGraph(makeInitialGraph(rootName, rootFilePath, rootLineNumber));
  }, [rootName, rootFilePath, rootLineNumber]);

  const layout = useMemo(() => buildLayout(graph), [graph]);

  const nodeColCount = layout.maxIncomingDepth + 1 + layout.maxOutgoingDepth;
  const edgeColCount = Math.max(0, nodeColCount - 1);
  const totalSegments = nodeColCount + edgeColCount;
  const totalRows = Math.max(1, layout.maxRow + 1 + ROOT_ROW_OFFSET) + CANVAS_PADDING_Y * 2;

  const canvasWidth = CANVAS_PADDING_X * 2 + nodeColCount * NODE_COL_WIDTH + edgeColCount * EDGE_COL_WIDTH;
  const canvasHeight = Math.max(40, totalRows + 8);

  useEffect(() => {
    const t = setTimeout(() => {
      const selected = layout.nodes[graph.selectedId];
      if (!selected) {
        return;
      }
      const selectedRow = selected.row + ROOT_ROW_OFFSET + CANVAS_PADDING_Y;
      const selectedX = CANVAS_PADDING_X + selected.nodeCol * (NODE_COL_WIDTH + EDGE_COL_WIDTH);
      scrollRef.current?.scrollTo({
        x: Math.max(0, selectedX - 45),
        y: Math.max(0, selectedRow - 10),
      });
    }, 10);
    return () => clearTimeout(t);
  }, [graph.selectedId, layout]);

  const moveVertical = (delta: number) => {
    const selectedId = graph.selectedId;
    const selectedSide = sideForNode(graph, selectedId);
    const direction = selectedSide === 'root' ? graph.activeDirection : selectedSide;
    const side = direction === 'incoming' ? graph.incoming : graph.outgoing;

    let siblings: string[] = [];
    if (selectedSide === 'root') {
      siblings = side.childrenByParent[graph.rootId] ?? [];
      if (siblings.length === 0) {
        return;
      }
      const nextIndex = delta > 0 ? 0 : siblings.length - 1;
      setGraph((prev) => ({ ...prev, selectedId: siblings[nextIndex] ?? prev.selectedId, activeDirection: direction }));
      return;
    }

    const parentId = side.parentByNode[selectedId];
    if (!parentId) {
      return;
    }
    siblings = side.childrenByParent[parentId] ?? [];
    if (siblings.length === 0) {
      return;
    }

    const currentIndex = siblings.indexOf(selectedId);
    const start = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = Math.max(0, Math.min(siblings.length - 1, start + delta));
    const nextId = siblings[nextIndex];
    if (!nextId) return;
    setGraph((prev) => ({ ...prev, selectedId: nextId, activeDirection: direction }));
  };

  const fetchOneLevel = async (direction: Direction, nodeId: string, autoSelect = false) => {
    const side = direction === 'incoming' ? graph.incoming : graph.outgoing;
    const node = graph.nodes[nodeId];
    if (!node || !node.filePath || !node.lineNumber || side.loadingNodeId) return;

    setGraph((prev) => {
      const currentSide = direction === 'incoming' ? prev.incoming : prev.outgoing;
      const nextSide: DirectionGraph = { ...currentSide, loadingNodeId: nodeId, error: null };
      return {
        ...prev,
        activeDirection: direction,
        incoming: direction === 'incoming' ? nextSide : prev.incoming,
        outgoing: direction === 'outgoing' ? nextSide : prev.outgoing,
      };
    });

    try {
      const children = await requestExpand({
        id: node.id,
        label: node.label,
        filePath: node.filePath,
        lineNumber: node.lineNumber,
        mode: direction,
      });

      setGraph((prev) => {
        const withChildren = addChildrenForDirection(prev, direction, nodeId, children);
        const sideNow = direction === 'incoming' ? withChildren.incoming : withChildren.outgoing;
        const ids = sideNow.childrenByParent[nodeId] ?? [];
        const cleanSide: DirectionGraph = { ...sideNow, loadingNodeId: null, error: null };
        logInfo('app', 'both graph expanded', { direction, node: node.label, children: ids.length });
        return {
          ...withChildren,
          // Auto-select first child when triggered by i/o (openRelations), otherwise keep selection stable
          selectedId: autoSelect && ids.length > 0 ? (ids[0] ?? prev.selectedId) : prev.selectedId,
          activeDirection: direction,
          incoming: direction === 'incoming' ? cleanSide : withChildren.incoming,
          outgoing: direction === 'outgoing' ? cleanSide : withChildren.outgoing,
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGraph((prev) => {
        const currentSide = direction === 'incoming' ? prev.incoming : prev.outgoing;
        const failedSide: DirectionGraph = { ...currentSide, loadingNodeId: null, error: message };
        return {
          ...prev,
          incoming: direction === 'incoming' ? failedSide : prev.incoming,
          outgoing: direction === 'outgoing' ? failedSide : prev.outgoing,
        };
      });
      logError('app', 'both graph expand failed', { direction, node: node.label, error: message });
    }
  };

  const ensureRootSideReady = async (direction: Direction): Promise<string | null> => {
    const side = direction === 'incoming' ? graph.incoming : graph.outgoing;
    const first = side.childrenByParent[graph.rootId]?.[0];
    if (first) {
      return first;
    }

    const seed = direction === 'incoming' ? initialIncomingRef.current : initialOutgoingRef.current;
    if (seed.length > 0) {
      let firstSeed: string | null = null;
      setGraph((prev) => {
        const withSeed = addChildrenForDirection(prev, direction, prev.rootId, seed);
        const seededSide = direction === 'incoming' ? withSeed.incoming : withSeed.outgoing;
        firstSeed = seededSide.childrenByParent[prev.rootId]?.[0] ?? null;
        return withSeed;
      });
      logInfo('app', 'both graph seeded root from initial payload', { direction, count: seed.length });
      return firstSeed;
    }

    await fetchOneLevel(direction, graph.rootId);
    return null;
  };

  const openRelations = async (direction: Direction) => {
    const selectedId = graph.selectedId;
    const side = direction === 'incoming' ? graph.incoming : graph.outgoing;
    setGraph((prev) => ({ ...prev, activeDirection: direction }));

    if (selectedId === graph.rootId) {
      const firstChild = await ensureRootSideReady(direction);
      // Auto-select first root child when available
      if (firstChild) {
        setGraph((prev) => ({ ...prev, selectedId: firstChild, activeDirection: direction }));
      }
      return;
    }

    const children = side.childrenByParent[selectedId] ?? [];
    if (children.length > 0 || (side.loadedByNode[selectedId] ?? false)) {
      // Already loaded — step into first child immediately
      if (children.length > 0) {
        setGraph((prev) => ({ ...prev, selectedId: children[0] ?? prev.selectedId, activeDirection: direction }));
      }
      return;
    }

    if (!(side.loadedByNode[selectedId] ?? false)) {
      await fetchOneLevel(direction, selectedId, /* autoSelect= */ true);
    }
  };

  const stepHorizontal = async (toward: 'left' | 'right') => {
    // left side is outgoing (callees), right side is incoming (callers)
    const direction: Direction = toward === 'left' ? 'outgoing' : 'incoming';
    const selectedId = graph.selectedId;
    const selectedSide = sideForNode(graph, selectedId);

    setGraph((prev) => ({ ...prev, activeDirection: direction }));

    if (selectedId === graph.rootId) {
      const side = direction === 'incoming' ? graph.incoming : graph.outgoing;
      const first = side.childrenByParent[graph.rootId]?.[0] ?? null;
      if (first) {
        setGraph((prev) => ({ ...prev, selectedId: first, activeDirection: direction }));
      }
      return;
    }

    if (selectedSide === direction) {
      // move one column farther in the same side
      const side = direction === 'incoming' ? graph.incoming : graph.outgoing;
      const children = side.childrenByParent[selectedId] ?? [];
      if (children.length > 0) {
        setGraph((prev) => ({ ...prev, selectedId: children[0], activeDirection: direction }));
      }
      return;
    }

    if (selectedSide !== 'root') {
      // move one column toward center when switching side directions
      const selectedDirectionSide = selectedSide === 'incoming' ? graph.incoming : graph.outgoing;
      const parentId = selectedDirectionSide.parentByNode[selectedId];
      const centerNode = parentId ?? graph.rootId;
      setGraph((prev) => ({ ...prev, selectedId: centerNode, activeDirection: direction }));
    }
  };

  const collapseOrBack = () => {
    if (graph.selectedId === graph.rootId) return;

    const selectedSide = sideForNode(graph, graph.selectedId);
    if (selectedSide === 'root') return;

    const side = selectedSide === 'incoming' ? graph.incoming : graph.outgoing;
    const children = side.childrenByParent[graph.selectedId] ?? [];
    if (side.expandedByNode[graph.selectedId] && children.length > 0) {
      const nextSide: DirectionGraph = {
        ...side,
        expandedByNode: { ...side.expandedByNode, [graph.selectedId]: false },
      };
      setGraph((prev) => ({
        ...prev,
        incoming: selectedSide === 'incoming' ? nextSide : prev.incoming,
        outgoing: selectedSide === 'outgoing' ? nextSide : prev.outgoing,
      }));
      return;
    }

    const parentId = side.parentByNode[graph.selectedId];
    if (parentId) {
      setGraph((prev) => ({ ...prev, selectedId: parentId, activeDirection: selectedSide }));
    }
  };

  const collapseCurrentOnly = () => {
    const selectedId = graph.selectedId;
    if (selectedId === graph.rootId) {
      return;
    }

    const selectedSide = sideForNode(graph, selectedId);
    if (selectedSide === 'root') {
      return;
    }

    const side = selectedSide === 'incoming' ? graph.incoming : graph.outgoing;
    const children = side.childrenByParent[selectedId] ?? [];
    if (children.length === 0) {
      return;
    }

    const nextSide: DirectionGraph = {
      ...side,
      expandedByNode: { ...side.expandedByNode, [selectedId]: false },
    };
    setGraph((prev) => ({
      ...prev,
      incoming: selectedSide === 'incoming' ? nextSide : prev.incoming,
      outgoing: selectedSide === 'outgoing' ? nextSide : prev.outgoing,
    }));
  };

  const removeCurrentNode = () => {
    const selectedId = graph.selectedId;
    if (selectedId === graph.rootId) {
      return;
    }

    const selectedSide = sideForNode(graph, selectedId);
    if (selectedSide === 'root') {
      return;
    }

    const side = selectedSide === 'incoming' ? graph.incoming : graph.outgoing;
    const parentId = side.parentByNode[selectedId] ?? graph.rootId;

    setGraph((prev) => {
      const { next } = removeSubtreesFromSide(prev, selectedSide, [selectedId]);
      return {
        ...next,
        selectedId: parentId,
        activeDirection: selectedSide,
      };
    });
  };

  const isolateCurrentAmongSiblings = () => {
    const selectedId = graph.selectedId;
    if (selectedId === graph.rootId) {
      return;
    }

    const selectedSide = sideForNode(graph, selectedId);
    if (selectedSide === 'root') {
      return;
    }

    const side = selectedSide === 'incoming' ? graph.incoming : graph.outgoing;
    const parentId = side.parentByNode[selectedId];
    if (!parentId) {
      return;
    }
    const siblings = side.childrenByParent[parentId] ?? [];
    const toRemove = siblings.filter((id) => id !== selectedId);
    if (toRemove.length === 0) {
      return;
    }

    setGraph((prev) => {
      const { next } = removeSubtreesFromSide(prev, selectedSide, toRemove);
      return {
        ...next,
        selectedId,
        activeDirection: selectedSide,
      };
    });
  };

  const openSelected = () => {
    const node = graph.nodes[graph.selectedId];
    if (!node || !node.filePath || !node.lineNumber) {
      logWarn('app', 'both graph open ignored: no source location', { nodeId: graph.selectedId });
      return;
    }

    onOpenLocation({
      id: node.id,
      label: node.label,
      filePath: node.filePath,
      lineNumber: node.lineNumber,
      relationType: sideForNode(graph, graph.selectedId) === 'outgoing' ? 'outgoing' : 'incoming',
      symbolKind: node.symbolKind,
    });
  };

  const panCanvas = (dx: number, dy: number) => {
    scrollRef.current?.scrollBy({ x: dx, y: dy }, 'step');
  };

  const nodeAtMouse = (event: MouseEvent): LayoutNode | null => {
    const scrollTop = scrollRef.current?.scrollTop ?? 0;
    const scrollLeft = scrollRef.current?.scrollLeft ?? 0;

    // Mouse coordinates are terminal absolute; subtract scrollbox origin first.
    const viewport = (scrollRef.current as unknown as { viewport?: { x?: number; y?: number } })?.viewport;
    const localY = event.y - (viewport?.y ?? 0);
    const localX = event.x - (viewport?.x ?? 0);
    const row = Math.max(0, Math.floor(localY + scrollTop - CANVAS_PADDING_Y));
    const xInCanvas = localX + scrollLeft - CANVAS_PADDING_X;
    if (xInCanvas < 0) return null;

    const segmentWidth = NODE_COL_WIDTH + EDGE_COL_WIDTH;
    const approxCol = Math.floor(xInCanvas / segmentWidth);
    if (approxCol < 0) return null;
    const within = xInCanvas - approxCol * segmentWidth;
    if (within < 0 || within >= NODE_COL_WIDTH) {
      return null;
    }

    return nodeCells.get(`${row}:${approxCol}`) ?? null;
  };

  const edgeAtMouse = (event: MouseEvent): { key: string; glyph: string } | null => {
    const scrollTop = scrollRef.current?.scrollTop ?? 0;
    const scrollLeft = scrollRef.current?.scrollLeft ?? 0;
    const viewport = (scrollRef.current as unknown as { viewport?: { x?: number; y?: number } })?.viewport;
    const localY = event.y - (viewport?.y ?? 0);
    const localX = event.x - (viewport?.x ?? 0);
    const row = Math.max(0, Math.floor(localY + scrollTop - CANVAS_PADDING_Y));
    const xInCanvas = localX + scrollLeft - CANVAS_PADDING_X;
    if (xInCanvas < 0) return null;

    const segmentWidth = NODE_COL_WIDTH + EDGE_COL_WIDTH;
    const approxSegment = Math.floor(xInCanvas / segmentWidth);
    const within = xInCanvas - approxSegment * segmentWidth;
    // Edge zone is right after the node text area.
    if (within < NODE_COL_WIDTH || within >= NODE_COL_WIDTH + EDGE_COL_WIDTH) {
      return null;
    }

    const edgeCol = approxSegment;
    const key = edgeKey(row, edgeCol);
    const glyph = edgeCells.get(key);
    if (!glyph || glyph.trim().length === 0) return null;
    return { key, glyph };
  };


  const handleMouseDown = (event: MouseEvent) => {
    if (event.button === MouseButton.LEFT || event.button === MouseButton.MIDDLE) {
      const hit = nodeAtMouse(event);
      pressStateRef.current = {
        button: event.button,
        startX: event.x,
        startY: event.y,
        dragged: false,
        nodeId: hit?.id ?? null,
      };
      dragStateRef.current = { x: event.x, y: event.y, active: true };
      event.preventDefault();
    }
  };

  const handleMouseDrag = (event: MouseEvent) => {
    if (!dragStateRef.current.active) return;
    const dx = event.x - dragStateRef.current.x;
    const dy = event.y - dragStateRef.current.y;
    dragStateRef.current = { x: event.x, y: event.y, active: true };
    if (Math.abs(dx) + Math.abs(dy) > 0) {
      if (pressStateRef.current) pressStateRef.current.dragged = true;
    }
    // Drag direction follows map movement with light acceleration for smoother long pans.
    const distance = Math.hypot(dx, dy);
    const accel = Math.min(3.2, 1 + distance / 6);
    panCanvas(-dx * accel, -dy * accel * 0.9);
    event.preventDefault();
  };

  const handleMiddleMoveScroll = (event: MouseEvent) => {
    // ThinkPad TrackPoint style: hold middle button and move mouse.
    // Use movement vector directly (no direction remap) to keep natural behavior:
    // - move left/right => horizontal scroll
    // - move up/down => vertical scroll
    const press = pressStateRef.current;
    if (!press || press.button !== MouseButton.MIDDLE) return;

    const dx = event.x - dragStateRef.current.x;
    const dy = event.y - dragStateRef.current.y;
    if (dx === 0 && dy === 0) return;

    dragStateRef.current = { x: event.x, y: event.y, active: true };
    panCanvas(-dx * 1.6, -dy * 1.1);
    event.preventDefault();
  };

  const handleMouseUp = (event: MouseEvent) => {
    const press = pressStateRef.current;
    pressStateRef.current = null;
    dragStateRef.current.active = false;
    middleScrollRef.current = null;

    if (!press || press.button !== MouseButton.LEFT || press.dragged) return;

    const hit = nodeAtMouse(event);
    if (!hit) return;

    setGraph((prev) => ({
      ...prev,
      selectedId: hit.id,
      activeDirection: sideForNode(prev, hit.id) === 'outgoing' ? 'outgoing' : 'incoming',
    }));

    const now = Date.now();
    if (lastClickRef.current.nodeId === hit.id && now - lastClickRef.current.at <= DOUBLE_CLICK_MS) {
      // Open exact node without depending on async selected-state update.
      const node = graph.nodes[hit.id];
      if (node?.filePath && node?.lineNumber) {
        onOpenLocation({
          id: node.id,
          label: node.label,
          filePath: node.filePath,
          lineNumber: node.lineNumber,
          relationType: sideForNode(graph, hit.id) === 'outgoing' ? 'outgoing' : 'incoming',
          symbolKind: node.symbolKind,
        });
      }
    }
    lastClickRef.current = { nodeId: hit.id, at: now };
  };

  const handleMouseMove = (event: MouseEvent) => {
    handleMiddleMoveScroll(event);

    if (pressStateRef.current?.button === MouseButton.MIDDLE) {
      logInfo('ui', 'mouse-middle-move', {
        x: event.x,
        y: event.y,
        dragActive: dragStateRef.current.active,
      });
    }

    const node = nodeAtMouse(event);
    setHoveredNodeId(node?.id ?? null);

    if (node) {
      setHoveredEdge(null);
      return;
    }
    const edge = edgeAtMouse(event);
    setHoveredEdge(edge);
  };

  const handleMouseScroll = (event: MouseEvent) => {
    const direction = event.scroll?.direction;
    if (!direction) return;

    logInfo('ui', 'mouse-scroll', {
      button: event.button,
      direction,
      x: event.x,
      y: event.y,
      shift: event.modifiers?.shift,
      alt: event.modifiers?.alt,
      ctrl: event.modifiers?.ctrl,
    });

    if (event.button === MouseButton.MIDDLE) {
      const prev = middleScrollRef.current;
      middleScrollRef.current = { x: event.x, y: event.y };
      if (prev) {
        const dx = event.x - prev.x;
        const dy = event.y - prev.y;
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 0) {
          panCanvas(dx > 0 ? 10 : -10, 0);
          return;
        }
      }
    }

    // Hold Shift for horizontal scroll even on vertical wheel.
    const horizontal = event.modifiers.shift || direction === 'left' || direction === 'right';
    if (horizontal) {
      if (direction === 'up' || direction === 'left') panCanvas(-8, 0);
      else panCanvas(8, 0);
      return;
    }

    if (direction === 'up') panCanvas(0, -3);
    else if (direction === 'down') panCanvas(0, 3);
  };

  useKeyboard((event) => {
    const key  = event?.name ?? '';
    const seq  = event?.sequence ?? '';
    const ctrl = event?.ctrl ?? false;
    const meta = (event as { meta?: boolean })?.meta ?? false;
    const alt  = (event as { alt?: boolean })?.alt ?? false;

    const sig = `${key}:${seq}:${ctrl}`;
    const now = Date.now();
    if (lastKeyRef.current.sig === sig && now - lastKeyRef.current.at < 75) return;
    lastKeyRef.current = { sig, at: now };

    // ── SEARCH MODE ────────────────────────────────────────────────────────
    if (searchMode) {
      if (key === 'escape') {
        setSearchMode(false);
        setSearchText('');
        setSearchMatchIdx(0);
        return;
      }
      if (key === 'return') {
        // Jump to current match and exit search
        const matches = searchMatches;
        const hit = matches[searchMatchIdx];
        if (hit) {
          const side = sideForNode(graph, hit) === 'outgoing' ? 'outgoing' : 'incoming';
          setGraph((prev) => ({ ...prev, selectedId: hit, activeDirection: side }));
        }
        setSearchMode(false);
        setSearchText('');
        return;
      }
      if (key === 'backspace') {
        setSearchText((t) => t.slice(0, -1));
        setSearchMatchIdx(0);
        return;
      }
      // n / N cycle through matches while in search
      if (seq === 'n') {
        setSearchMatchIdx((i) => (searchMatches.length > 0 ? (i + 1) % searchMatches.length : 0));
        return;
      }
      if (seq === 'N') {
        setSearchMatchIdx((i) => (searchMatches.length > 0 ? (i - 1 + searchMatches.length) % searchMatches.length : 0));
        return;
      }
      // Any printable char — append to search text
      if (seq.length === 1 && seq >= ' ') {
        setSearchText((t) => t + seq);
        setSearchMatchIdx(0);
        return;
      }
      return;
    }

    // ── PANEL ESCAPE ────────────────────────────────────────────────────────
    if (key === 'escape') {
      if (structPanel) { setStructPanel(null); return; }
      if (logPanel)    { setLogPanel(null);    return; }
      if (showHelp)    { setShowHelp(false);   return; }
      return;
    }

    // Block navigation keys when a panel is open
    if (logPanel || structPanel) return;

    if (meta || alt) return;

    // ── CTRL CHORDS ─────────────────────────────────────────────────────────
    if (ctrl) {
      // Ctrl+D — jump 5 siblings down (half-page)
      if (key === 'd') { for (let i = 0; i < 5; i++) moveVertical(1); return; }
      // Ctrl+U — jump 5 siblings up (half-page)
      if (key === 'u') { for (let i = 0; i < 5; i++) moveVertical(-1); return; }
      return;
    }

    // ── NORMAL NAVIGATION ───────────────────────────────────────────────────
    if ((key === 'j' && seq === 'j') || key === 'down')  moveVertical(1);
    else if ((key === 'k' && seq === 'k') || key === 'up') moveVertical(-1);
    else if ((key === 'h' && seq === 'h') || key === 'left')  void stepHorizontal('left');
    else if ((key === 'l' && seq === 'l') || key === 'right') void stepHorizontal('right');
    else if (key === 'c' && seq === 'c') collapseOrBack();
    else if (key === 'i' && seq === 'i') void openRelations('incoming');
    else if (key === 'o' && seq === 'o') void openRelations('outgoing');
    else if (key === 'z' && seq === 'z') collapseCurrentOnly();
    else if (key === 'x' && seq === 'x') removeCurrentNode();
    else if (key === 'X' && seq === 'X') isolateCurrentAmongSiblings();
    else if ((key === 'e' && seq === 'e') || key === 'return') openSelected();

    // ── SEARCH ──────────────────────────────────────────────────────────────
    else if (key === '/' && seq === '/') {
      setSearchMode(true);
      setSearchText('');
      setSearchMatchIdx(0);
    }
    // n/N cycle matches outside search mode (after a previous search)
    else if (key === 'n' && seq === 'n' && searchText) {
      const nextIdx = (searchMatchIdx + 1) % Math.max(1, searchMatches.length);
      setSearchMatchIdx(nextIdx);
      const hit = searchMatches[nextIdx];
      if (hit) {
        const side = sideForNode(graph, hit) === 'outgoing' ? 'outgoing' : 'incoming';
        setGraph((prev) => ({ ...prev, selectedId: hit, activeDirection: side }));
      }
    }
    else if (key === 'N' && seq === 'N' && searchText) {
      const prevIdx = (searchMatchIdx - 1 + Math.max(1, searchMatches.length)) % Math.max(1, searchMatches.length);
      setSearchMatchIdx(prevIdx);
      const hit = searchMatches[prevIdx];
      if (hit) {
        const side = sideForNode(graph, hit) === 'outgoing' ? 'outgoing' : 'incoming';
        setGraph((prev) => ({ ...prev, selectedId: hit, activeDirection: side }));
      }
    }

    // ── PANELS ──────────────────────────────────────────────────────────────
    else if (key === 'L' && seq === 'L') {
      const node = graph.nodes[graph.selectedId];
      const apiName = node?.label ?? rootName;
      if (requestLogs) {
        setLogPanel({ apiName, rows: [], loading: true, error: null });
        requestLogs(apiName).then((rows) => {
          setLogPanel({ apiName, rows, loading: false, error: null });
        }).catch((err: unknown) => {
          setLogPanel({ apiName, rows: [], loading: false, error: String(err) });
        });
      }
    }
    else if (key === 'S' && seq === 'S') {
      const node = graph.nodes[graph.selectedId];
      const apiName = node?.label ?? rootName;
      if (requestStructWrites) {
        setStructPanel({ apiName, rows: [], loading: true, error: null });
        requestStructWrites(apiName).then((rows) => {
          setStructPanel({ apiName, rows, loading: false, error: null });
        }).catch((err: unknown) => {
          setStructPanel({ apiName, rows: [], loading: false, error: String(err) });
        });
      }
    }

    // ── CANVAS PAN ───────────────────────────────────────────────────────────
    else if (key === 'w' && seq === 'w') panCanvas(0, -6);
    else if (key === 'a' && seq === 'a') panCanvas(-10, 0);
    else if (key === 's' && seq === 's') panCanvas(0, 6);
    else if (key === 'd' && seq === 'd') panCanvas(10, 0);

    // ── MISC ─────────────────────────────────────────────────────────────────
    else if (key === '?' && seq === '?') setShowHelp((prev) => !prev);
    else if (key === 'q' && seq === 'q') {
      logInfo('app', 'both window quit requested');
      sendBridgeMessage({ type: 'quit_ack' });
      setTimeout(() => process.exit(0), 50);
    }
    else if (seq === '\t') {
      setGraph((prev) => ({
        ...prev,
        activeDirection: prev.activeDirection === 'incoming' ? 'outgoing' : 'incoming',
      }));
    }
  });

  const getEdgeLineChar = (kind: EdgeKind): string => {
    // Use the same glyphs as edgeGlyphInfo so the edge cells map matches the colors
    return edgeGlyphInfo(kind).line;
  };

  const getRightJunction = (kind: EdgeKind): string => {
    return edgeGlyphInfo(kind).junction;
  };

  // ── Search matches: all node IDs whose label contains searchText ──────────
  const searchMatches = useMemo((): string[] => {
    if (!searchText.trim()) return [];
    const lower = searchText.toLowerCase();
    // Scan both sides flat, preserve order: incoming order first, then outgoing
    const allIds = [
      ...layout.incomingOrder,
      ...layout.outgoingOrder,
      graph.rootId,
    ];
    return allIds.filter((id) => {
      const node = graph.nodes[id];
      return node?.label.toLowerCase().includes(lower);
    });
  }, [searchText, layout.incomingOrder, layout.outgoingOrder, graph.nodes, graph.rootId]);

  // Auto-select the first match when searchText changes
  // (done separately so searchMatchIdx stays correct)

  // ── Expanded vs total node counts ─────────────────────────────────────────
  const incomingExpandedCount = useMemo(() =>
    Object.keys(graph.incoming.expandedByNode).filter(
      (id) => id !== graph.rootId && (graph.incoming.expandedByNode[id] || graph.incoming.loadedByNode[id])
    ).length,
  [graph.incoming]);
  const outgoingExpandedCount = useMemo(() =>
    Object.keys(graph.outgoing.expandedByNode).filter(
      (id) => id !== graph.rootId && (graph.outgoing.expandedByNode[id] || graph.outgoing.loadedByNode[id])
    ).length,
  [graph.outgoing]);
  const incomingTotalCount = useMemo(() =>
    Object.keys(graph.incoming.depthByNode).filter((id) => id !== graph.rootId).length,
  [graph.incoming]);
  const outgoingTotalCount = useMemo(() =>
    Object.keys(graph.outgoing.depthByNode).filter((id) => id !== graph.rootId).length,
  [graph.outgoing]);

  const edgeCells = useMemo(() => {
    const map = new Map<string, string>();

    for (const edge of layout.edges) {
      const from = layout.nodes[edge.fromId];
      const to = layout.nodes[edge.toId];
      if (!from || !to) continue;

      const edgeRowFrom = from.row + ROOT_ROW_OFFSET + CANVAS_PADDING_Y;
      const edgeRowTo = to.row + ROOT_ROW_OFFSET + CANVAS_PADDING_Y;
      const edgeCol = edge.edgeCol;
      const edgeLineChar = getEdgeLineChar(edge.kind);
      const rightJunction = getRightJunction(edge.kind);

      const start = Math.min(edgeRowFrom, edgeRowTo);
      const end = Math.max(edgeRowFrom, edgeRowTo);

      // For 3-char label edges (THR, IRQ, RNG, SIG, IND), write the label at midpoint
      // and use plain │ for the rest of the line
      const isLabelEdge = edgeLineChar.length === 3;
      const midpoint = Math.round((start + end) / 2);

      for (let row = start + 1; row < end; row += 1) {
        const key = edgeKey(row, edgeCol);
        if (isLabelEdge && row === midpoint) {
          map.set(key, mergeEdgeChar(map.get(key), edgeLineChar));
        } else {
          map.set(key, mergeEdgeChar(map.get(key), isLabelEdge ? '│' : edgeLineChar));
        }
      }

      // Arrow direction is always caller -> callee.
      // With callers rendered on the right and callees on the left,
      // every relation flows right-to-left on the canvas.
      const fromIsLeft = from.nodeCol <= to.nodeCol;
      const leftNode = fromIsLeft ? from : to;
      const rightNode = fromIsLeft ? to : from;
      const leftRow = leftNode.row + ROOT_ROW_OFFSET + CANVAS_PADDING_Y;
      const rightRow = rightNode.row + ROOT_ROW_OFFSET + CANVAS_PADDING_Y;

      const rightKey = edgeKey(rightRow, edgeCol);
      map.set(rightKey, mergeEdgeChar(map.get(rightKey), rightJunction));

      const leftKey = edgeKey(leftRow, edgeCol);
      map.set(leftKey, mergeEdgeChar(map.get(leftKey), '◀'));
    }

    return map;
  }, [layout]);

  const nodeCells = useMemo(() => {
    const map = new Map<string, LayoutNode>();
    for (const node of Object.values(layout.nodes)) {
      map.set(`${node.row + ROOT_ROW_OFFSET + CANVAS_PADDING_Y}:${node.nodeCol}`, node);
    }
    return map;
  }, [layout]);

  const sideLoading = graph.activeDirection === 'incoming' ? graph.incoming.loadingNodeId : graph.outgoing.loadingNodeId;
  const sideError = graph.activeDirection === 'incoming' ? graph.incoming.error : graph.outgoing.error;
  const selectedNode = graph.nodes[graph.selectedId];
  const hoveredNode = hoveredNodeId ? graph.nodes[hoveredNodeId] : null;

  // ── Unified One Dark Pro palette ────────────────────────────────────────────
  // All colors reference this palette so the canvas is consistent with
  // RelationComponents.tsx and the rest of the TUI.
  const C = {
    // Backgrounds
    bgDeep:    '#1b1f27',  // canvas background
    bgPanel:   '#21252b',  // header / footer / bars
    bgSel:     '#2c313a',  // selected node highlight row
    bgRoot:    '#1e2a1e',  // root node tint

    // Text
    fgBright:  '#ffffff',  // selected label
    fgDefault: '#abb2bf',  // normal node label
    fgDim:     '#5c6370',  // meta / file:line / separators
    fgRoot:    '#a8d8a8',  // root node label (green tint)
    fgLoading: '#e5c07b',  // amber spinner
    fgError:   '#e06c75',  // red error
    fgOk:      '#98c379',  // green ready

    // Accents (One Dark Pro)
    blue:      '#61afef',  // navigation keys, title
    green:     '#98c379',  // callers / incoming badge
    yellow:    '#e5c07b',  // callees / outgoing badge / timers
    purple:    '#c678dd',  // registrations
    cyan:      '#56b6c2',  // functions, rings
    red:       '#e06c75',  // errors, quit

    // Edge / glyph accent colors
    edgeCall:   '#4b5263',  // direct call — subtle (most common)
    edgeReg:    '#c678dd',  // registration — purple
    edgeThread: '#61afef',  // thread comm — blue
    edgeIrq:    '#e5c07b',  // interrupt — amber
    edgeRing:   '#56b6c2',  // ring/DMA — cyan
    edgeEvent:  '#98c379',  // signal/event — green
    edgeTimer:  '#d19a66',  // timer — orange

    // Canvas structural
    sep:       '#3a3f4b',  // separator lines between sections
  } as const;

  // ── Node-kind symbol + color ─────────────────────────────────────────────
  function nodeKindGlyph(node: { label: string; symbolKind?: number; edgeKindFromParent?: EdgeKind }): { glyph: string; color: string } {
    // Edge-kind overrides (for indirect caller nodes the connection type is most informative)
    const ek = node.edgeKindFromParent;
    if (ek === 'hw_interrupt')                        return { glyph: '⚡', color: C.edgeIrq    };
    if (ek === 'timer_callback')                      return { glyph: '⏱', color: C.edgeTimer   };
    if (ek === 'sw_thread_comm')                      return { glyph: '⟳', color: C.edgeThread  };
    if (ek === 'hw_ring' || ek === 'ring_signal')     return { glyph: '⬡', color: C.edgeRing    };
    if (ek === 'event')                               return { glyph: '◈', color: C.edgeEvent   };
    if (ek === 'interface_registration')              return { glyph: '⊕', color: C.edgeReg     };

    // LSP symbol kind
    switch (node.symbolKind) {
      case 1:  return { glyph: '󰈙', color: C.fgDim    };  // File
      case 5:  return { glyph: 'ℂ', color: C.blue     };  // Class
      case 6:  return { glyph: 'M', color: C.purple   };  // Method
      case 9:  return { glyph: '⊕', color: C.yellow   };  // Constructor
      case 10: return { glyph: 'E', color: C.yellow   };  // Enum
      case 11: return { glyph: 'I', color: C.blue     };  // Interface
      case 12: return { glyph: 'ƒ', color: C.cyan     };  // Function
      case 13: return { glyph: '𝓥', color: C.green    };  // Variable
      case 23: return { glyph: 'S', color: C.yellow   };  // Struct
      default: return { glyph: 'ƒ', color: C.cyan     };  // default: function
    }
  }

  // Edge glyph + color per EdgeKind — all colors from C palette
  function edgeGlyphInfo(kind: EdgeKind): { line: string; junction: string; arrow: string; color: string } {
    switch (kind) {
      case 'interface_registration': return { line: '║', junction: '╣', arrow: '◀', color: C.edgeReg    };
      case 'sw_thread_comm':        return { line: '┄', junction: '┤', arrow: '◀', color: C.edgeThread  };
      case 'hw_interrupt':          return { line: '╎', junction: '┤', arrow: '◀', color: C.edgeIrq    };
      case 'hw_ring':
      case 'ring_signal':           return { line: '┉', junction: '┤', arrow: '◀', color: C.edgeRing   };
      case 'event':                 return { line: '╌', junction: '┤', arrow: '◀', color: C.edgeEvent   };
      case 'timer_callback':        return { line: '┈', junction: '┤', arrow: '◀', color: C.edgeTimer   };
      case 'deferred_work':         return { line: '╌', junction: '┤', arrow: '◀', color: C.fgDim       };
      default:                      return { line: '│', junction: '┤', arrow: '◀', color: C.edgeCall    };
    }
  }

  // ── Structured canvas rows ─────────────────────────────────────────────────
  // Each row is an array of segments; each segment is {text, fg, bold}.
  // This replaces the flat string approach so each cell can have its own color.
  type CanvasSegment = { text: string; fg: string; bold?: boolean };
  type CanvasRow = CanvasSegment[];

  const canvasRows = useMemo((): CanvasRow[] => {
    const rows: CanvasRow[] = [];

    for (let rowIdx = 0; rowIdx < totalRows; rowIdx += 1) {
      const row: CanvasRow = [];

      for (let segIdx = 0; segIdx < totalSegments; segIdx += 1) {
        const isNodeSegment = segIdx % 2 === 0;

        if (isNodeSegment) {
          const nodeCol = Math.floor(segIdx / 2);
          const layoutNode = nodeCells.get(`${rowIdx}:${nodeCol}`);
          if (!layoutNode) {
            row.push({ text: ' '.repeat(NODE_COL_WIDTH), fg: C.bgDeep });
            continue;
          }

          const nodeData = graph.nodes[layoutNode.id];
          const isRoot = layoutNode.id === graph.rootId;
          const selected = graph.selectedId === layoutNode.id;
          const hovered  = !selected && hoveredNodeId === layoutNode.id;
          const rawLabel  = isRoot ? rootName : (nodeData?.label ?? '');
          const { glyph, color: glyphColor } = nodeKindGlyph(nodeData ?? { label: rawLabel });

          // Selection / hover marker (2 chars)
          const marker   = selected ? '▶ ' : hovered ? '› ' : '  ';
          const markerFg = selected ? C.green : hovered ? C.fgDim : C.bgDeep;

          // Glyph badge (4 chars: "[X] ")
          const glyphText = `[${glyph}] `;

          // Label — fill remaining width
          const usedFixed = 2 + 4; // marker(2) + glyph(4)
          const labelWidth = NODE_COL_WIDTH - usedFixed;
          const rawLabelText = rawLabel.length <= labelWidth
            ? rawLabel.padEnd(labelWidth)
            : `${rawLabel.slice(0, labelWidth - 1)}…`;

          // Search highlight: node whose label matches current search text
          const isSearchMatch = searchText.trim() !== '' && rawLabel.toLowerCase().includes(searchText.toLowerCase());
          const isCurrentSearchHit = isSearchMatch && searchMatches[searchMatchIdx] === layoutNode.id;

          // Label colors: search matches get amber highlight; current hit gets bright
          const labelFg = isCurrentSearchHit
            ? C.yellow
            : isSearchMatch
              ? C.edgeTimer
              : selected ? C.fgBright : isRoot ? C.fgRoot : C.fgDefault;
          const labelBold = selected || isRoot || isCurrentSearchHit;

          // Loaded-empty indicator: node was fetched but has no relations
          const nodeDir = sideForNode(graph, layoutNode.id);
          const nodeSide = nodeDir === 'incoming' ? graph.incoming : nodeDir === 'outgoing' ? graph.outgoing : null;
          const isLoadedEmpty = !isRoot && nodeSide !== null
            && (nodeSide.loadedByNode[layoutNode.id] ?? false)
            && (nodeSide.childrenByParent[layoutNode.id]?.length ?? 0) === 0;
          // Marker: ▶ selected | › hovered | ○ loaded-empty leaf | · search match | ▸ unexpanded | (space) normal
          const markerChar = selected ? '▶ ' : hovered ? '› ' : isLoadedEmpty ? '○ ' : isSearchMatch ? '· ' : '  ';
          const markerFgFinal = selected ? C.green
            : hovered ? C.fgDim
            : isLoadedEmpty ? C.fgDim
            : isSearchMatch ? C.yellow
            : C.bgDeep;

          row.push({ text: markerChar, fg: markerFgFinal });
          row.push({ text: glyphText, fg: selected ? C.fgBright : isCurrentSearchHit ? C.yellow : glyphColor, bold: selected || isCurrentSearchHit });
          row.push({ text: rawLabelText, fg: labelFg, bold: labelBold });

          // file:line suffix
          const fileInfo = nodeData?.filePath && nodeData?.lineNumber
            ? `  ${nodeData.filePath.split('/').pop() ?? ''}:${nodeData.lineNumber}`
            : '';
          if (fileInfo) {
            const maxFileWidth = 18;
            const trimmed = fileInfo.length <= maxFileWidth
              ? fileInfo.padEnd(maxFileWidth)
              : `  ${fileInfo.slice(2, 2 + maxFileWidth - 2)}`;
            row.push({ text: trimmed, fg: selected ? C.blue : C.fgDim });
          }

          // viaRegistrationApi: show "⊳api_name" for registration nodes
          const via = (nodeData as { viaRegistrationApi?: string } | undefined)?.viaRegistrationApi;
          if (via && !isRoot) {
            const viaText = `  ⊳${via.length > 14 ? `${via.slice(0, 13)}…` : via}`;
            row.push({ text: viaText, fg: selected ? C.edgeReg : C.purple });
          }
          continue;
        }

        // ── Edge segment ────────────────────────────────────────────────────
        const edgeCol = Math.floor(segIdx / 2);
        const rawChar = edgeCells.get(edgeKey(rowIdx, edgeCol)) ?? ' ';

        // Look up the edge kind to pick the right color
        // Find any edge that passes through this cell to determine its kind
        const matchingEdge = layout.edges.find((e) => {
          if (e.edgeCol !== edgeCol) return false;
          const fr = e.fromRow + ROOT_ROW_OFFSET + CANVAS_PADDING_Y;
          const tr = e.toRow + ROOT_ROW_OFFSET + CANVAS_PADDING_Y;
          const lo = Math.min(fr, tr);
          const hi = Math.max(fr, tr);
          return rowIdx >= lo && rowIdx <= hi;
        });
        const eInfo = matchingEdge ? edgeGlyphInfo(matchingEdge.kind) : { line: '│', junction: '┤', arrow: '◀', color: C.edgeCall };
        const edgeFg = rawChar.trim() ? eInfo.color : C.bgDeep;

        // Pad edge cell to EDGE_COL_WIDTH
        const padded = ` ${rawChar} `.padEnd(EDGE_COL_WIDTH);
        row.push({ text: padded, fg: edgeFg });
      }

      rows.push(row);
    }
    return rows;
  }, [edgeCells, graph.nodes, graph.rootId, graph.selectedId, graph.incoming, graph.outgoing, hoveredNodeId, layout.edges, nodeCells, rootName, searchMatches, searchMatchIdx, searchText, totalRows, totalSegments]);

  // Keep a flat text snapshot for the UI snapshot logger (unchanged behavior)
  const canvasLines = useMemo(() =>
    canvasRows.map((row) => row.map((s) => s.text).join('')),
  [canvasRows]);

  const uiSnapshot = useMemo(() => {
    const lines: string[] = [];
    lines.push(`root=${rootName}`);
    lines.push(`selected=${graph.selectedId}`);
    lines.push(`active=${graph.activeDirection}`);
    lines.push(`segments=${totalSegments}, rows=${totalRows}`);
    lines.push('-'.repeat(Math.min(180, canvasWidth)));
    lines.push(...canvasLines);
    return lines.join('\n');
  }, [canvasLines, canvasWidth, graph.activeDirection, graph.selectedId, rootName, totalRows, totalSegments]);

  useEffect(() => {
    if (uiSnapshot === lastUiSnapshotRef.current) {
      return;
    }
    lastUiSnapshotRef.current = uiSnapshot;
    writeUiSnapshot('both-relation-window', uiSnapshot);
  }, [uiSnapshot]);

  return (
    <box width="100%" height="100%" flexDirection="column" overflow="hidden" zIndex={1}>

      {/* ── TOP HEADER ─────────────────────────────────────────────────────── */}
      <box width="100%" flexDirection="column" backgroundColor={C.bgPanel}>

        {/* Title bar */}
        <box flexDirection="row" width="100%" paddingX={2} height={1} alignItems="center" backgroundColor={C.bgPanel}>
          <text fg={C.blue} attributes={1}>{'⬡ Q-Relation'}</text>
          <text fg={C.sep}>{'  '}</text>
          <text fg={C.cyan} attributes={1} flexShrink={1} truncate>{rootName}</text>
          {rootFilePath && (
            <>
              <text fg={C.sep}>{'  '}</text>
              <text fg={C.fgDim} flexShrink={1} truncate>
                {rootFilePath.split('/').slice(-2).join('/')}
                {rootLineNumber ? `:${rootLineNumber}` : ''}
              </text>
            </>
          )}
          <box flexGrow={1} />
          <text fg={graph.activeDirection === 'incoming' ? C.green : C.yellow} attributes={1}>
            {graph.activeDirection === 'incoming' ? '◀ CALLERS' : 'CALLEES ▶'}
          </text>
          <text fg={C.sep}>{'  '}</text>
          {/* Show expanded/total counts */}
          <text fg={C.green}>{`in:${incomingExpandedCount}`}</text>
          <text fg={C.fgDim}>{`/${incomingTotalCount}  `}</text>
          <text fg={C.yellow}>{`out:${outgoingExpandedCount}`}</text>
          <text fg={C.fgDim}>{`/${outgoingTotalCount}`}</text>
        </box>

        {/* Rich status bar — breadcrumb + depth + edge kind + via + file */}
        <box flexDirection="row" width="100%" paddingX={2} height={1} alignItems="center" backgroundColor={C.bgDeep}>
          {/* Breadcrumb: build path root → … → parent → selected */}
          {(() => {
            const selId = graph.selectedId;
            const selNode = graph.nodes[selId];
            const selDir = sideForNode(graph, selId);
            const selSide = selDir === 'incoming' ? graph.incoming : selDir === 'outgoing' ? graph.outgoing : null;
            const depth = selSide?.depthByNode[selId] ?? 0;

            // Build parent chain (max 2 hops for brevity)
            const parentId = selSide?.parentByNode[selId];
            const parentNode = parentId ? graph.nodes[parentId] : null;
            const gpId = parentId && parentNode && parentId !== graph.rootId ? selSide?.parentByNode[parentId] : null;
            const gpNode = gpId ? graph.nodes[gpId] : null;

            const edgeKindText = selNode?.edgeKindFromParent
              ? selNode.edgeKindFromParent.replace(/_/g, ' ')
              : null;
            const viaText = (selNode as { viaRegistrationApi?: string } | undefined)?.viaRegistrationApi;

            return (
              <>
                {/* Depth badge */}
                {depth > 0 && (
                  <text fg={C.fgDim}>{`d${depth} `}</text>
                )}
                {/* Grandparent */}
                {gpNode && gpId !== graph.rootId && (
                  <>
                    <text fg={C.fgDim} truncate>{gpNode.label.slice(0, 12)}{gpNode.label.length > 12 ? '…' : ''}</text>
                    <text fg={C.sep}>{' › '}</text>
                  </>
                )}
                {/* Parent */}
                {parentNode && parentId !== graph.rootId && (
                  <>
                    <text fg={C.fgDim} truncate>{parentNode.label.slice(0, 16)}{parentNode.label.length > 16 ? '…' : ''}</text>
                    <text fg={C.sep}>{' › '}</text>
                  </>
                )}
                {/* Selected */}
                <text fg={C.fgBright} attributes={1} flexShrink={1} truncate>
                  {selNode?.label ?? rootName}
                </text>
                {/* Edge kind */}
                {edgeKindText && (
                  <text fg={C.fgDim}>{`  [${edgeKindText}]`}</text>
                )}
                {/* via registration */}
                {viaText && (
                  <text fg={C.purple}>{`  ⊳${viaText}`}</text>
                )}
                {/* file:line */}
                {selNode?.filePath && (
                  <text fg={C.blue} flexShrink={1} truncate>
                    {`  ${selNode.filePath.split('/').slice(-2).join('/')}:${selNode.lineNumber ?? ''}`}
                  </text>
                )}
              </>
            );
          })()}
          <box flexGrow={1} />
          {sideLoading ? (
            <text fg={C.fgLoading}>{`${spinnerFrame(animTick)} fetching…`}</text>
          ) : sideError ? (
            <text fg={C.fgError} truncate>{`✖ ${sideError}`}</text>
          ) : searchMode ? (
            <text fg={C.yellow} attributes={1}>{`/ ${searchText}▌  ${searchMatches.length > 0 ? `${searchMatchIdx + 1}/${searchMatches.length} matches` : 'no match'}`}</text>
          ) : searchText ? (
            <text fg={C.fgDim}>{`/${searchText}  ${searchMatches.length} match${searchMatches.length !== 1 ? 'es' : ''}  n/N cycle  Esc clear`}</text>
          ) : (
            <text fg={C.fgOk}>{'✓ ready'}</text>
          )}
        </box>

        {/* Edge + glyph legend */}
        <box flexDirection="row" width="100%" paddingX={2} height={1} alignItems="center" backgroundColor={C.bgDeep}>
          <text fg={C.fgDim}>{'edges: '}</text>
          <text fg={C.edgeCall}>{'│'}</text><text fg={C.fgDim}>{'call  '}</text>
          <text fg={C.edgeReg}>{'║'}</text><text fg={C.fgDim}>{'reg  '}</text>
          <text fg={C.edgeThread}>{'┄'}</text><text fg={C.fgDim}>{'thread  '}</text>
          <text fg={C.edgeIrq}>{'╎'}</text><text fg={C.fgDim}>{'IRQ  '}</text>
          <text fg={C.edgeRing}>{'┉'}</text><text fg={C.fgDim}>{'ring  '}</text>
          <text fg={C.edgeEvent}>{'╌'}</text><text fg={C.fgDim}>{'event  '}</text>
          <text fg={C.edgeTimer}>{'┈'}</text><text fg={C.fgDim}>{'timer'}</text>
          <box flexGrow={1} />
          <text fg={C.fgDim}>{'left=callees  right=callers'}</text>
        </box>
      </box>

      <box width="100%" height={1} backgroundColor={C.sep} />

      {/* ── CANVAS ──────────────────────────────────────────────────────────── */}
      <scrollbox
        ref={scrollRef}
        flexGrow={1}
        scrollY={true}
        scrollX={true}
        viewportCulling={false}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseDrag={handleMouseDrag}
        onMouseUp={handleMouseUp}
        onMouseDragEnd={handleMouseUp}
        onMouseScroll={handleMouseScroll}
        zIndex={1}
        verticalScrollbarOptions={{ arrowOptions: { foregroundColor: C.sep, backgroundColor: C.bgDeep } }}
        horizontalScrollbarOptions={{ arrowOptions: { foregroundColor: C.sep, backgroundColor: C.bgDeep } }}
      >
        <box width={canvasWidth} height={canvasHeight} flexDirection="column" paddingX={CANVAS_PADDING_X} paddingY={CANVAS_PADDING_Y} zIndex={2} backgroundColor={C.bgDeep}>
          {canvasRows.map((row, rowIdx) => (
            <box key={`graph-row:${rowIdx}`} flexDirection="row" width="100%" height={1} zIndex={3}>
              {row.map((seg, segIdx) => (
                <text key={`seg:${rowIdx}:${segIdx}`} fg={seg.fg} attributes={seg.bold ? 1 : 0}>{seg.text}</text>
              ))}
            </box>
          ))}
        </box>
      </scrollbox>

      <box width="100%" height={1} backgroundColor={C.sep} />

      {/* ── FOOTER ──────────────────────────────────────────────────────────── */}
      <box width="100%" flexDirection="column" backgroundColor={C.bgPanel}>
        <box flexDirection="row" width="100%" paddingX={2} height={1} alignItems="center">
          <text fg={C.blue} attributes={1}>{'h/l'}</text><text fg={C.fgDim}>{'  '}</text>
          <text fg={C.blue} attributes={1}>{'j/k'}</text><text fg={C.fgDim}>{'  '}</text>
          <text fg={C.fgDim} attributes={1}>{'^D/U'}</text><text fg={C.fgDim}>{'jump5  '}</text>
          <text fg={C.green} attributes={1}>{'i'}</text><text fg={C.fgDim}>{'callers  '}</text>
          <text fg={C.yellow} attributes={1}>{'o'}</text><text fg={C.fgDim}>{'callees  '}</text>
          <text fg={C.fgDefault} attributes={1}>{'e'}</text><text fg={C.fgDim}>{'open  '}</text>
          <text fg={C.yellow} attributes={1}>{'/'}</text><text fg={C.fgDim}>{'search  '}</text>
          <text fg={C.purple} attributes={1}>{'L'}</text><text fg={C.fgDim}>{'logs  '}</text>
          <text fg={C.yellow} attributes={1}>{'S'}</text><text fg={C.fgDim}>{'struct  '}</text>
          <box flexGrow={1} />
          <text fg={C.fgDim} attributes={1}>{'?'}</text><text fg={C.fgDim}>{'help  '}</text>
          <text fg={C.red} attributes={1}>{'q'}</text><text fg={C.fgDim}>{'quit'}</text>
        </box>
        {showHelp && (
          <box flexDirection="column" width="100%" paddingX={2} paddingY={1} backgroundColor={C.bgDeep}>
            <box flexDirection="row" width="100%">
              <text fg={C.blue} attributes={1} width={26}>{'Navigation:'}</text>
              <text fg={C.fgDefault}>{'h/l cols  j/k rows  i callers  o callees  e open  Tab toggle side'}</text>
            </box>
            <box flexDirection="row" width="100%">
              <text fg={C.blue} attributes={1} width={26}>{'Panels:'}</text>
              <text fg={C.purple}>{'L logs  '}</text>
              <text fg={C.yellow}>{'S struct writes  '}</text>
              <text fg={C.fgDim}>{'Esc close panel'}</text>
            </box>
            <box flexDirection="row" width="100%">
              <text fg={C.blue} attributes={1} width={26}>{'Search:'}</text>
              <text fg={C.yellow}>{'/  '}</text>
              <text fg={C.fgDefault}>{'type to search  '}</text>
              <text fg={C.yellow}>{'n/N  '}</text>
              <text fg={C.fgDefault}>{'cycle matches  '}</text>
              <text fg={C.fgDim}>{'↵ jump  Esc clear'}</text>
            </box>
            <box flexDirection="row" width="100%">
              <text fg={C.blue} attributes={1} width={26}>{'Graph ops:'}</text>
              <text fg={C.fgDefault}>{'c back  z collapse  x remove  X isolate  Ctrl+D/U jump5  w/a/s/d pan'}</text>
            </box>
            <box flexDirection="row" width="100%">
              <text fg={C.blue} attributes={1} width={26}>{'Canvas markers:'}</text>
              <text fg={C.green}>{'▶ selected  '}</text>
              <text fg={C.fgDim}>{'› hovered  '}</text>
              <text fg={C.fgDim}>{'○ loaded(no results)  '}</text>
              <text fg={C.yellow}>{'· search match'}</text>
            </box>
            <box flexDirection="row" width="100%">
              <text fg={C.blue} attributes={1} width={26}>{'Edge types:'}</text>
              <text fg={C.edgeCall}>{'│call  '}</text>
              <text fg={C.edgeReg}>{'║reg  '}</text>
              <text fg={C.edgeThread}>{'┄thd  '}</text>
              <text fg={C.edgeIrq}>{'╎IRQ  '}</text>
              <text fg={C.edgeRing}>{'┉ring  '}</text>
              <text fg={C.edgeEvent}>{'╌evt  '}</text>
              <text fg={C.edgeTimer}>{'┈tmr'}</text>
            </box>
            <box flexDirection="row" width="100%">
              <text fg={C.blue} attributes={1} width={26}>{'Node glyphs:'}</text>
              <text fg={C.cyan}>{'[ƒ]fn  '}</text>
              <text fg={C.blue}>{'[ℂ]cls  '}</text>
              <text fg={C.yellow}>{'[S]struct  '}</text>
              <text fg={C.edgeIrq}>{'[⚡]IRQ  '}</text>
              <text fg={C.edgeTimer}>{'[⏱]tmr  '}</text>
              <text fg={C.edgeThread}>{'[⟳]thd  '}</text>
              <text fg={C.edgeRing}>{'[⬡]ring  '}</text>
              <text fg={C.edgeReg}>{'[⊕]reg ⊳via'}</text>
            </box>
            <box flexDirection="row" width="100%">
              <text fg={C.fgDim}>{'Mouse: click=select  dbl-click=open  drag=pan  wheel=scroll  shift+wheel=horiz'}</text>
            </box>
          </box>
        )}
      </box>

      {logPanel && (
        <box position="absolute" top={4} left={2} width="92%" height="75%" zIndex={20}>
          <LogPanel apiName={logPanel.apiName} rows={logPanel.rows} loading={logPanel.loading} error={logPanel.error} onClose={() => setLogPanel(null)} />
        </box>
      )}
      {structPanel && (
        <box position="absolute" top={4} left={2} width="92%" height="75%" zIndex={21}>
          <StructPanel apiName={structPanel.apiName} rows={structPanel.rows} loading={structPanel.loading} error={structPanel.error} onClose={() => setStructPanel(null)} />
        </box>
      )}
    </box>
  );
}
