import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { MouseButton } from '@opentui/core';
import type { MouseEvent } from '@opentui/core';
import type { FlatRelationItem, QueryMode } from '../lib/types';
import { logError, logInfo, logWarn, writeUiSnapshot } from '../lib/logger';
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
  onOpenLocation: (item: FlatRelationItem) => void;
};

const NODE_COL_WIDTH = 24;
const EDGE_COL_WIDTH = 3;
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

  const fetchOneLevel = async (direction: Direction, nodeId: string) => {
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
          // Keep selection stable; expansion should not jump focus unexpectedly.
          selectedId: prev.selectedId,
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
      await ensureRootSideReady(direction);
      return;
    }

    const children = side.childrenByParent[selectedId] ?? [];
    if (children.length > 0 || (side.loadedByNode[selectedId] ?? false)) {
      return;
    }

    if (!(side.loadedByNode[selectedId] ?? false)) {
      await fetchOneLevel(direction, selectedId);
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
    if (event?.ctrl || event?.meta || (event as { alt?: boolean })?.alt) return;

    const key = event?.name ?? '';
    const seq = event?.sequence ?? '';
    const sig = `${key}:${seq}`;
    const now = Date.now();
    if (lastKeyRef.current.sig === sig && now - lastKeyRef.current.at < 75) return;
    lastKeyRef.current = { sig, at: now };

    if ((key === 'j' && seq === 'j') || key === 'down') moveVertical(1);
    else if ((key === 'k' && seq === 'k') || key === 'up') moveVertical(-1);
    else if ((key === 'h' && seq === 'h') || key === 'left') void stepHorizontal('left');
    else if ((key === 'l' && seq === 'l') || key === 'right') void stepHorizontal('right');
    else if (key === 'c' && seq === 'c') collapseOrBack();
    else if (key === 'i' && seq === 'i') void openRelations('incoming');
    else if (key === 'u' && seq === 'u') void openRelations('outgoing');
    else if (key === 'z' && seq === 'z') collapseCurrentOnly();
    else if (key === 'x' && seq === 'x') removeCurrentNode();
    else if (key === 'X' && seq === 'X') isolateCurrentAmongSiblings();
    else if ((key === 'o' && seq === 'o') || key === 'return') openSelected();
    else if ((key === 'w' && seq === 'w') || (key === 'W' && seq === 'W')) panCanvas(0, -6);
    else if ((key === 'a' && seq === 'a') || (key === 'A' && seq === 'A')) panCanvas(-10, 0);
    else if ((key === 's' && seq === 's') || (key === 'S' && seq === 'S')) panCanvas(0, 6);
    else if ((key === 'd' && seq === 'd') || (key === 'D' && seq === 'D')) panCanvas(10, 0);
    else if (key === '?' && seq === '?') setShowHelp((prev) => !prev);
    else if (key === 'q' && seq === 'q') {
      logInfo('app', 'both window quit requested');
      setTimeout(() => process.exit(0), 30);
    }
    else if (seq === '\t') {
      setGraph((prev) => ({
        ...prev,
        activeDirection: prev.activeDirection === 'incoming' ? 'outgoing' : 'incoming',
      }));
    }
  });

  const getEdgeLineChar = (kind: EdgeKind): string => {
    if (kind === 'interface_registration') return '║';
    if (kind === 'sw_thread_comm') return 'THR';
    if (kind === 'hw_interrupt') return 'IRQ';
    if (kind === 'ring_signal' || kind === 'hw_ring') return 'RNG';
    if (kind === 'event') return 'SIG';
    if (kind === 'custom') return 'IND';
    return '│';
  };

  const getRightJunction = (kind: EdgeKind): string => {
    if (kind === 'interface_registration') return '╣';
    return '┤';
  };

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
  const incomingCount = Object.keys(graph.incoming.depthByNode).filter((id) => id !== graph.rootId).length;
  const outgoingCount = Object.keys(graph.outgoing.depthByNode).filter((id) => id !== graph.rootId).length;

  const canvasLines = useMemo(() => {
    const lines: string[] = [];
    for (let rowIdx = 0; rowIdx < totalRows; rowIdx += 1) {
      let line = '';
      for (let segIdx = 0; segIdx < totalSegments; segIdx += 1) {
        const isNodeSegment = segIdx % 2 === 0;
        if (isNodeSegment) {
          const nodeCol = Math.floor(segIdx / 2);
          const node = nodeCells.get(`${rowIdx}:${nodeCol}`);
          if (!node) {
            line += ' '.repeat(NODE_COL_WIDTH);
            continue;
          }

          const nodeData = graph.nodes[node.id];
          const selected = graph.selectedId === node.id;
          const hovered = !selected && hoveredNodeId === node.id;
          const label = node.id === graph.rootId ? rootName : nodeData?.label ?? '';
          const selectMark = selected ? '* ' : hovered ? '› ' : '  ';
          line += fitWidth(`${selectMark}${label}`, NODE_COL_WIDTH);
          continue;
        }

        const edgeCol = Math.floor(segIdx / 2);
        const edgeChar = edgeCells.get(edgeKey(rowIdx, edgeCol)) ?? ' ';
        line += fitWidth(` ${edgeChar} `, EDGE_COL_WIDTH);
      }
      lines.push(line);
    }
    return lines;
  }, [edgeCells, graph.nodes, graph.rootId, graph.selectedId, hoveredNodeId, nodeCells, rootName, totalRows, totalSegments]);

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
      <box width="100%" paddingX={1} paddingY={1} flexDirection="column" backgroundColor="#1b1f2a">
        <text fg="#7dd3fc" attributes={1}>Q-Relation Graph Canvas</text>
        <text fg="#a5b4fc" truncate>
          root: {rootName}  •  selected: {selectedNode?.label ?? rootName}  •  active: {graph.activeDirection}
        </text>
        <text fg="#94a3b8">
          left=callees | right=callers | in={incomingCount} out={outgoingCount} | wheel=scroll | shift+wheel=horizontal | click=select | double-click=open | middle-drag=pan
        </text>
        <box flexDirection="row" width="100%">
          <text fg="#f8fafc">* selected</text>
          <text fg="#64748b">  |  </text>
          <text fg="#e2e8f0">› hovered</text>
          <text fg="#64748b">  |  </text>
          <text fg="#a7f3d0">│/║/THR/IRQ/RNG/SIG/IND edges</text>
        </box>
      </box>
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
        verticalScrollbarOptions={{ arrowOptions: { foregroundColor: '#4a4a4a', backgroundColor: '#1a1a1a' } }}
        horizontalScrollbarOptions={{ arrowOptions: { foregroundColor: '#4a4a4a', backgroundColor: '#1a1a1a' } }}
      >
        <box width={canvasWidth} height={canvasHeight} flexDirection="column" paddingX={CANVAS_PADDING_X} paddingY={CANVAS_PADDING_Y} zIndex={2} backgroundColor="#0f1420">
          {canvasLines.map((line, idx) => (
            <text
              key={`graph-line:${idx}`}
              fg={line.includes('* ') ? '#f8fafc' : line.includes('› ') ? '#e2e8f0' : '#cbd5e1'}
              attributes={line.includes('* ') || line.includes('› ') ? 1 : 0}
              zIndex={3}
            >
              {line}
            </text>
          ))}
        </box>
      </scrollbox>

      <box width="100%" paddingX={1} paddingY={1} backgroundColor="#1b1f2a">
        <text fg="#93c5fd">h/j/k/l navigate | i/u open rel | z collapse | x remove | X isolate siblings | c back | o open | wheel scroll | shift+wheel horizontal | click select | dbl-click open | middle-drag pan | q close</text>
      </box>
      {showHelp ? (
        <box width="100%" paddingX={1} flexDirection="column">
          <text fg="#c8c8c8">Help</text>
          <text fg="#7f8c8d">h/l move left/right in graph columns (left=callees, right=callers)</text>
          <text fg="#7f8c8d">j/k move across sibling nodes</text>
          <text fg="#7f8c8d">i open callers (incoming) | u open callees (outgoing)</text>
          <text fg="#7f8c8d">edge types: │ api call | ║ registration | THR thread | IRQ interrupt | RNG ring/DMA | SIG signal/event | IND custom</text>
          <text fg="#7f8c8d">z collapse current | x remove current | X isolate current</text>
          <text fg="#7f8c8d">w/a/s/d pan canvas | o open source | c back | q close</text>
        </box>
      ) : null}
      {sideLoading ? (
        <box width="100%" paddingX={1}>
          <text fg="#d19a66">Loading...</text>
        </box>
      ) : null}
      {sideError ? (
        <box width="100%" paddingX={1}>
          <text fg="#e06c75" truncate>
            {sideError}
          </text>
        </box>
      ) : null}
    </box>
  );
}
