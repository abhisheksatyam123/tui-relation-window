import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import type { ScrollBoxRenderable } from '@opentui/core';
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
  onOpenLocation: (item: FlatRelationItem) => void;
};

const NODE_COL_WIDTH = 24;
const EDGE_COL_WIDTH = 3;
const CANVAS_PADDING_X = 4;
const CANVAS_PADDING_Y = 3;
const ROOT_ROW_OFFSET = 12;

export function BothRelationWindow({
  rootName,
  rootFilePath,
  rootLineNumber,
  incomingItems,
  outgoingItems,
  requestExpand,
  onOpenLocation,
}: Props) {
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const initialIncomingRef = useRef<FlatRelationItem[]>(incomingItems);
  const initialOutgoingRef = useRef<FlatRelationItem[]>(outgoingItems);
  const [graph, setGraph] = useState<GraphState>(() =>
    makeInitialGraph(rootName, rootFilePath, rootLineNumber),
  );
  const [showHelp, setShowHelp] = useState(false);
  const lastKeyRef = useRef<{ sig: string; at: number }>({ sig: '', at: 0 });
  const lastUiSnapshotRef = useRef('');

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

  const edgeCells = useMemo(() => {
    const map = new Map<string, string>();

    for (const edge of layout.edges) {
      const from = layout.nodes[edge.fromId];
      const to = layout.nodes[edge.toId];
      if (!from || !to) continue;

      const edgeRowFrom = from.row + ROOT_ROW_OFFSET + CANVAS_PADDING_Y;
      const edgeRowTo = to.row + ROOT_ROW_OFFSET + CANVAS_PADDING_Y;
      const edgeCol = edge.edgeCol;
      const edgeLineChar = edge.kind === 'interface_registration' ? '║' : '│';
      const rightJunction = edge.kind === 'interface_registration' ? '╣' : '┤';

      const start = Math.min(edgeRowFrom, edgeRowTo);
      const end = Math.max(edgeRowFrom, edgeRowTo);

      for (let row = start + 1; row < end; row += 1) {
        const key = edgeKey(row, edgeCol);
        map.set(key, mergeEdgeChar(map.get(key), edgeLineChar));
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
          const label = node.id === graph.rootId ? rootName : nodeData?.label ?? '';
          const selectMark = selected ? '* ' : '  ';
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
  }, [edgeCells, graph.nodes, graph.rootId, graph.selectedId, nodeCells, rootName, totalRows, totalSegments]);

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
      <box width="100%" paddingX={1} flexDirection="column">
        <text fg="#98c379" attributes={1}>Relation Canvas</text>
        <text fg="#8abeb7" truncate>
          root: {rootName} | selected: {selectedNode?.label ?? rootName} | active: {graph.activeDirection}
        </text>
        <text fg="#5c6370">
          left=callees | right=callers | arrows: caller to callee | registration edge: ║ | move:h/j/k/l | open:i(callers) u(callees) | z collapse | x remove | X isolate | pan:w/a/s/d | in={incomingCount} out={outgoingCount}
        </text>
      </box>
      <scrollbox
        ref={scrollRef}
        flexGrow={1}
        scrollY={true}
        scrollX={true}
        viewportCulling={false}
        zIndex={1}
        verticalScrollbarOptions={{ arrowOptions: { foregroundColor: '#4a4a4a', backgroundColor: '#1a1a1a' } }}
        horizontalScrollbarOptions={{ arrowOptions: { foregroundColor: '#4a4a4a', backgroundColor: '#1a1a1a' } }}
      >
        <box width={canvasWidth} height={canvasHeight} flexDirection="column" paddingX={CANVAS_PADDING_X} paddingY={CANVAS_PADDING_Y} zIndex={2}>
          {canvasLines.map((line, idx) => (
            <text
              key={`graph-line:${idx}`}
              fg={line.includes('* ') ? '#ffffff' : '#c8c8c8'}
              attributes={line.includes('* ') ? 1 : 0}
              zIndex={3}
            >
              {line}
            </text>
          ))}
        </box>
      </scrollbox>

      <box width="100%" paddingX={1}>
        <text fg="#4f5b66">h/j/k/l navigate | i/u open rel | z collapse | x remove | X isolate siblings | c back | o open | w/a/s/d pan | ? help | q close</text>
      </box>
      {showHelp ? (
        <box width="100%" paddingX={1} flexDirection="column">
          <text fg="#c8c8c8">Help</text>
          <text fg="#7f8c8d">h/l move left/right in graph columns (left=callees, right=callers)</text>
          <text fg="#7f8c8d">j/k move across sibling nodes</text>
          <text fg="#7f8c8d">i open callers (incoming) | u open callees (outgoing)</text>
          <text fg="#7f8c8d">registration links use heavy vertical edge (║) to distinguish from call stack</text>
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
