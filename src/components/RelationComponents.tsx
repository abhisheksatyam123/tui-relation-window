/**
 * RelationComponents.tsx
 *
 * All reusable TUI components for the q-relation-tui interface.
 *
 * Component hierarchy:
 *
 *   <RelationWindow>                   ← orchestrator (state + keyboard)
 *     <RelationHeader />               ← top bar: mode badge, root symbol, provider
 *     <scrollbox ref={scrollRef}>      ← native OpenTUI scrollable canvas
 *       <RelationTree />               ← recursive tree root
 *         <RelationNodeRow />          ← single row: indent + connector + icon + label + path
 *           <SymbolBadge />            ← coloured [ƒ] / [M] / [ℂ] badge
 *           <NodeLabel />              ← bold label text (highlighted when selected)
 *           <NodeMeta />               ← dim file path + line number
 *         <RelationEdge />             ← ◀── / ──▶ connector line between parent and child
 *     <RelationFooter />               ← bottom bar: status, spinner, keybindings
 *
 * Styling conventions:
 *   - Selected row: backgroundColor="#1a3a5c" (deep blue), fg="white", bold
 *   - Root node:    backgroundColor="#1e2a1e" (dark green tint), fg="#a8d8a8"
 *   - Normal row:   no background, fg="#c8c8c8"
 *   - Dim text:     fg="#606060"
 *   - Error text:   fg="#e06c75"
 *   - Accent:       fg="#61afef" (blue), "#c678dd" (purple), "#e5c07b" (yellow)
 *
 * Symbol kind badges (LSP numeric codes → Unicode + colour):
 *   1  File        [📄] white
 *   5  Class       [ℂ]  #61afef  (blue)
 *   6  Method      [M]  #c678dd  (purple)
 *   9  Constructor [⊕]  #e5c07b  (yellow)
 *   10 Enum        [E]  #e5c07b  (yellow)
 *   12 Function    [ƒ]  #56b6c2  (cyan)
 *   13 Variable    [𝓥]  #98c379  (green)
 *   23 Struct      [S]  #e5c07b  (yellow)
 *   25 TypeParam   [T]  #c678dd  (purple)
 *   default        [?]  #606060  (dim)
 */

import React from 'react';
import type { RelationMode, SystemConnectionKind } from '../lib/types';

// ─────────────────────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────────────────────

export type TreeNode = {
  id: string;
  label: string;
  filePath?: string;
  lineNumber?: number;
  symbolKind?: number;
  connectionKind?: SystemConnectionKind;
  /** For interface_registration nodes: the registration API that wired this callback */
  viaRegistrationApi?: string;
  parentId?: string;
  childrenIds: string[];
  loaded: boolean;
  expanded: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Colour palette (all as string literals for OpenTUI fg/bg props)
// ─────────────────────────────────────────────────────────────────────────────

const COLORS = {
  // Backgrounds
  bgSelected:    '#1a3a5c',   // deep blue — selected API label only
  bgRoot:        '#1e2a1e',   // dark green — root node
  bgLoading:     '#2a2a1e',   // dark amber — loading row
  bgError:       '#2a1e1e',   // dark red — error row

  // Foregrounds
  fgDefault:     '#c8c8c8',   // light grey — normal text
  fgSelected:    '#ffffff',   // white — selected text
  fgDim:         '#606060',   // dim grey — meta / path text
  fgDimSelected: '#a0c8f0',   // light blue — meta text when selected
  fgRoot:        '#a8d8a8',   // light green — root label
  fgError:       '#e06c75',   // red — error messages
  fgWarning:     '#e5c07b',   // amber — warning messages
  fgLoading:     '#e5c07b',   // amber — loading indicator

  // Symbol kind colours
  fgFunction:    '#56b6c2',   // cyan
  fgMethod:      '#c678dd',   // purple
  fgClass:       '#61afef',   // blue
  fgStruct:      '#e5c07b',   // yellow
  fgVariable:    '#98c379',   // green
  fgEnum:        '#e5c07b',   // yellow
  fgConstructor: '#e5c07b',   // yellow
  fgTypeParam:   '#c678dd',   // purple
  fgFile:        '#abb2bf',   // grey-white
  fgUnknown:     '#606060',   // dim

  // Edge / connector colours
  fgEdgeIncoming: '#56b6c2',  // cyan arrow ◀──
  fgEdgeOutgoing: '#e5c07b',  // amber arrow ──▶
  fgConnector:    '#3a3a3a',  // dark grey tree lines

  // Header / footer
  fgHeader:      '#ffffff',
  bgHeader:      '#21252b',
  fgFooter:      '#abb2bf',
  bgFooter:      '#21252b',
  fgModeIn:      '#98c379',   // green badge for INCOMING
  fgModeOut:     '#e5c07b',   // amber badge for OUTGOING
  fgProvider:    '#606060',
  fgKeyHint:     '#61afef',   // blue key names
  fgKeyDesc:     '#606060',   // dim descriptions
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Symbol kind → badge character + colour
// ─────────────────────────────────────────────────────────────────────────────

type BadgeInfo = { char: string; color: string };

export function getSymbolBadge(symbolKind?: number): BadgeInfo {
  switch (symbolKind) {
    case 1:  return { char: '󰈙', color: COLORS.fgFile };        // File
    case 2:  return { char: '󰆧', color: COLORS.fgClass };       // Module
    case 3:  return { char: '󰅪', color: COLORS.fgClass };       // Namespace
    case 5:  return { char: 'ℂ', color: COLORS.fgClass };       // Class
    case 6:  return { char: 'M', color: COLORS.fgMethod };      // Method
    case 7:  return { char: '󰜢', color: COLORS.fgVariable };    // Property
    case 8:  return { char: '󰜢', color: COLORS.fgVariable };    // Field
    case 9:  return { char: '⊕', color: COLORS.fgConstructor }; // Constructor
    case 10: return { char: 'E', color: COLORS.fgEnum };        // Enum
    case 11: return { char: 'I', color: COLORS.fgClass };       // Interface
    case 12: return { char: 'ƒ', color: COLORS.fgFunction };    // Function
    case 13: return { char: '𝓥', color: COLORS.fgVariable };    // Variable
    case 14: return { char: 'C', color: COLORS.fgEnum };        // Constant
    case 22: return { char: '󰕘', color: COLORS.fgEnum };        // EnumMember
    case 23: return { char: 'S', color: COLORS.fgStruct };      // Struct
    case 25: return { char: 'T', color: COLORS.fgTypeParam };   // TypeParameter
    default: return { char: '?', color: COLORS.fgUnknown };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Spinner frames
// ─────────────────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function spinnerFrame(tick: number): string {
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length] ?? '⠋';
}

// ─────────────────────────────────────────────────────────────────────────────
// Text helpers (kept minimal — only what the layout engine can't do)
// ─────────────────────────────────────────────────────────────────────────────

export function truncateMiddle(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  const keep = Math.max(4, Math.floor((maxLen - 3) / 2));
  return `${value.slice(0, keep)}...${value.slice(value.length - keep)}`;
}

export function truncateRight(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, Math.max(1, maxLen - 3))}...`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SymbolBadge — coloured [X] badge for a symbol kind
// ─────────────────────────────────────────────────────────────────────────────

type SymbolBadgeProps = {
  symbolKind?: number;
  selected?: boolean;
};

export function SymbolBadge({ symbolKind, selected }: SymbolBadgeProps) {
  const badge = getSymbolBadge(symbolKind);
  return (
    <text
      fg={selected ? badge.color : badge.color}
      attributes={selected ? 1 : 0}
      width={4}
      flexShrink={0}
    >
      {`[${badge.char}]`}
    </text>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// NodeLabel — bold symbol name, highlighted when selected
// ─────────────────────────────────────────────────────────────────────────────

type NodeLabelProps = {
  label: string;
  selected: boolean;
  isRoot?: boolean;
};

export function NodeLabel({ label, selected, isRoot }: NodeLabelProps) {
  let fg: string;
  if (isRoot) {
    fg = selected ? COLORS.fgSelected : COLORS.fgRoot;
  } else {
    fg = selected ? COLORS.fgSelected : COLORS.fgDefault;
  }

  return (
    <box
      backgroundColor={selected ? COLORS.bgSelected : undefined}
      flexShrink={1}
    >
      <text
        fg={fg}
        attributes={selected || isRoot ? 1 : 0}
        flexShrink={1}
        truncate
      >
        {label}
      </text>
    </box>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// NodeMeta — dim file path + line number
// ─────────────────────────────────────────────────────────────────────────────

type NodeMetaProps = {
  filePath?: string;
  lineNumber?: number;
  selected: boolean;
};

export function NodeMeta({ filePath, lineNumber, selected }: NodeMetaProps) {
  if (!filePath) return null;

  // Show only the last two path segments to keep it compact
  const parts = filePath.replace(/\\/g, '/').split('/');
  const shortPath = parts.length > 2
    ? `…/${parts.slice(-2).join('/')}`
    : filePath;

  const meta = lineNumber ? `${shortPath}:${lineNumber}` : shortPath;

  return (
    <text
      fg={selected ? COLORS.fgDimSelected : COLORS.fgDim}
      marginLeft={2}
      flexShrink={1}
      truncate
    >
      {meta}
    </text>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RelationEdge — the ◀── / ──▶ connector line between parent and child
// ─────────────────────────────────────────────────────────────────────────────

type RelationEdgeProps = {
  mode: RelationMode;
  depth: number;
  isLast: boolean;
  connectionKind?: SystemConnectionKind;
  viaRegistrationApi?: string;
};

export function RelationEdge({ mode, depth, isLast, connectionKind, viaRegistrationApi }: RelationEdgeProps) {
  const indent = '  '.repeat(depth);
  const branch = isLast ? '└' : '├';
  const line   = '─'.repeat(3);
  const arrow  = mode === 'incoming' ? `${branch}${line}◀ ` : `${branch}${line}▶ `;
  const label  = mode === 'incoming' ? 'caller' : 'callee';

  // Add bracket label for indirect edge types
  let edgeLabel = '';
  let edgeLabelColor: string = COLORS.fgDim;
  
  if (connectionKind === 'interface_registration') {
    edgeLabel = '[REG]';
    edgeLabelColor = '#e06c75'; // red — registrar, not a runtime caller
  } else if (connectionKind === 'sw_thread_comm') {
    edgeLabel = '[THR]';
    edgeLabelColor = '#56b6c2'; // cyan
  } else if (connectionKind === 'hw_interrupt') {
    edgeLabel = '[IRQ]';
    edgeLabelColor = '#e5c07b'; // amber
  } else if (connectionKind === 'ring_signal' || connectionKind === 'hw_ring') {
    edgeLabel = '[RNG]';
    edgeLabelColor = '#c678dd'; // purple
  } else if (connectionKind === 'event') {
    edgeLabel = '[SIG]';
    edgeLabelColor = '#98c379'; // green
  } else if (connectionKind === 'timer_callback') {
    edgeLabel = '[TMR]';
    edgeLabelColor = '#e5c07b'; // amber
  } else if (connectionKind === 'custom') {
    edgeLabel = '[IND]';
    edgeLabelColor = '#7f8c8d'; // dim
  }

  // For registrars, show the registration API as context
  const viaLabel = connectionKind === 'interface_registration' && viaRegistrationApi
    ? ` via:${viaRegistrationApi}`
    : '';

  return (
    <box flexDirection="row" width="100%" marginLeft={depth * 4}>
      <text fg={COLORS.fgConnector}>{indent}</text>
      <text fg={mode === 'incoming' ? COLORS.fgEdgeIncoming : COLORS.fgEdgeOutgoing}>
        {arrow}
      </text>
      <text fg={COLORS.fgDim}>{label}</text>
      {edgeLabel && (
        <text fg={edgeLabelColor} marginLeft={1}>
          {edgeLabel}
        </text>
      )}
      {viaLabel && (
        <text fg={COLORS.fgDim} marginLeft={1}>
          {viaLabel}
        </text>
      )}
    </box>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RelationNodeRow — a single row in the tree
//
//  [indent][connector?] [badge] label  path:line
//
// The `id` prop is passed to the inner <box> so that
// scrollRef.current.scrollChildIntoView(selectedId) can locate it.
// ─────────────────────────────────────────────────────────────────────────────

type RelationNodeRowProps = {
  node: TreeNode;
  selected: boolean;
  isRoot: boolean;
  depth: number;
  mode: RelationMode;
  loadingNodeId: string | null;
};

export function RelationNodeRow({
  node,
  selected,
  isRoot,
  depth,
  mode,
  loadingNodeId,
}: RelationNodeRowProps) {
  const isLoading = loadingNodeId === node.id;

  // Keep row background transparent; only selected API label is highlighted.
  const bg: string | undefined = undefined;

  // Expand/collapse indicator
  let expandIndicator = '  ';
  if (node.loaded && node.childrenIds.length > 0) {
    expandIndicator = node.expanded ? '▾ ' : '▸ ';
  } else if (!node.loaded && node.filePath) {
    expandIndicator = '▸ ';
  }

  return (
    <box
      id={node.id}
      flexDirection="row"
      width="100%"
      backgroundColor={bg}
      paddingLeft={depth * 4}
      paddingY={0}
      alignItems="center"
    >
      {/* Selection marker */}
      <text
        fg={selected ? COLORS.fgModeIn : COLORS.fgDim}
        width={2}
        flexShrink={0}
      >
        {selected ? '* ' : '  '}
      </text>

      {/* Expand/collapse chevron */}
      <text
        fg={selected ? COLORS.fgSelected : COLORS.fgDim}
        width={2}
        flexShrink={0}
      >
        {expandIndicator}
      </text>

      {/* Symbol kind badge */}
      <SymbolBadge symbolKind={node.symbolKind} selected={selected} />

      {/* Spacer */}
      <text width={1} flexShrink={0}>{' '}</text>

      {/* Label */}
      <NodeLabel label={node.label} selected={selected} isRoot={isRoot} />

      {/* File path + line */}
      <NodeMeta
        filePath={node.filePath}
        lineNumber={node.lineNumber}
        selected={selected}
      />

      {/* Loading spinner (shown inline when this node is being expanded) */}
      {isLoading && (
        <text fg={COLORS.fgLoading} marginLeft={1} flexShrink={0}>
          {' loading…'}
        </text>
      )}
    </box>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RelationTree — recursive tree renderer
//
// Renders the root node row, then for each child (if expanded):
//   1. A RelationEdge connector line
//   2. A recursive RelationTree for the child
// ─────────────────────────────────────────────────────────────────────────────

type RelationTreeProps = {
  nodeId: string;
  nodes: Record<string, TreeNode>;
  selectedId: string;
  mode: RelationMode;
  depth: number;
  loadingNodeId: string | null;
};

export function RelationTree({
  nodeId,
  nodes,
  selectedId,
  mode,
  depth,
  loadingNodeId,
}: RelationTreeProps) {
  const node = nodes[nodeId];
  if (!node) return null;

  const isRoot = depth === 0;
  const selected = node.id === selectedId;

  return (
    <box flexDirection="column" width="100%">
      {/* The node row itself */}
      <RelationNodeRow
        node={node}
        selected={selected}
        isRoot={isRoot}
        depth={depth}
        mode={mode}
        loadingNodeId={loadingNodeId}
      />

      {/* Children (only when expanded) */}
      {node.expanded && node.childrenIds.map((childId, idx) => {
        const isLast = idx === node.childrenIds.length - 1;
        const childNode = nodes[childId];
        return (
          <box key={childId} flexDirection="column" width="100%">
            {/* Edge connector */}
            <RelationEdge
              mode={mode}
              depth={depth + 1}
              isLast={isLast}
              connectionKind={childNode?.connectionKind}
              viaRegistrationApi={childNode?.viaRegistrationApi}
            />
            {/* Recursive child */}
            <RelationTree
              nodeId={childId}
              nodes={nodes}
              selectedId={selectedId}
              mode={mode}
              depth={depth + 1}
              loadingNodeId={loadingNodeId}
            />
          </box>
        );
      })}
    </box>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RelationHeader — top context bar
//
//  ┌─────────────────────────────────────────────────────────────────────────┐
//  │  ◀ INCOMING  │  main()  │  clangd-mcp                                  │
//  └─────────────────────────────────────────────────────────────────────────┘
// ─────────────────────────────────────────────────────────────────────────────

type RelationHeaderProps = {
  mode: RelationMode;
  rootName: string;
  provider: string;
  selectedLabel: string;
};

export function RelationHeader({
  mode,
  rootName,
  provider,
  selectedLabel,
}: RelationHeaderProps) {
  const modeLabel = mode === 'incoming' ? '◀ INCOMING' : 'OUTGOING ▶';
  const modeFg    = mode === 'incoming' ? COLORS.fgModeIn : COLORS.fgModeOut;

  return (
    <box
      flexDirection="row"
      width="100%"
      backgroundColor={COLORS.bgHeader}
      paddingX={1}
      alignItems="center"
      height={1}
    >
      {/* Mode badge */}
      <text fg={modeFg} attributes={1}>
        {modeLabel}
      </text>

      {/* Separator */}
      <text fg={COLORS.fgDim}>{' │ '}</text>

      {/* Root symbol */}
      <text fg={COLORS.fgRoot} attributes={1} flexShrink={1} truncate>
        {rootName}
      </text>

      {/* Separator */}
      <text fg={COLORS.fgDim}>{' │ '}</text>

      {/* Currently selected symbol */}
      <text fg={COLORS.fgSelected} flexShrink={1} truncate>
        {selectedLabel}
      </text>

      {/* Push provider to the right */}
      <box flexGrow={1} />

      {/* Provider */}
      <text fg={COLORS.fgProvider}>{provider}</text>
    </box>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RelationFooter — bottom status + keybinding bar
//
//  ┌─────────────────────────────────────────────────────────────────────────┐
//  │  ⠋ loading…  │  j/k move  l expand  h parent  Enter open  r refresh  ? help  q quit  │
//  └─────────────────────────────────────────────────────────────────────────┘
// ─────────────────────────────────────────────────────────────────────────────

type RelationFooterProps = {
  loadingNodeId: string | null;
  lastError: string | null;
  showHelp: boolean;
  animTick: number;
  workspaceRoot?: string;
};

// Key hint pairs: [key, description]
const KEY_HINTS_SHORT: Array<[string, string]> = [
  ['j/k', 'move'],
  ['l', 'expand'],
  ['h', 'parent'],
  ['Enter', 'open'],
  ['L', 'logs'],
  ['W', 'struct writes'],
  ['r', 'refresh'],
  ['?', 'help'],
  ['q', 'quit'],
];

const KEY_HINTS_FULL: Array<[string, string]> = [
  ['j/k ↑↓', 'move'],
  ['l →', 'expand'],
  ['h ←', 'collapse/parent'],
  ['Enter/o', 'open in editor'],
  ['L', 'show API logs'],
  ['W', 'show struct writes'],
  ['r', 'refresh'],
  ['Shift+W/A/S/D', 'pan'],
  ['?', 'hide help'],
  ['q/Esc', 'quit'],
  // Edge badges: [REG]=registrar  [IRQ]=hw_interrupt  [THR]=thread  [RNG]=ring  [SIG]=event  [TMR]=timer
];

function KeyHints({ hints }: { hints: Array<[string, string]> }) {
  return (
    <box flexDirection="row" alignItems="center">
      {hints.map(([key, desc], i) => (
        <box key={key} flexDirection="row" alignItems="center">
          {i > 0 && <text fg={COLORS.fgDim}>{'  '}</text>}
          <text fg={COLORS.fgKeyHint} attributes={1}>{key}</text>
          <text fg={COLORS.fgKeyDesc}>{` ${desc}`}</text>
        </box>
      ))}
    </box>
  );
}

export function RelationFooter({
  loadingNodeId,
  lastError,
  showHelp,
  animTick,
  workspaceRoot,
}: RelationFooterProps) {
  const hints = showHelp ? KEY_HINTS_FULL : KEY_HINTS_SHORT;
  const hasWorkspaceWarning = !workspaceRoot;

  return (
    <box
      flexDirection="column"
      width="100%"
      backgroundColor={COLORS.bgFooter}
    >
      {/* Status line */}
      <box
        flexDirection="row"
        width="100%"
        paddingX={1}
        height={1}
        alignItems="center"
      >
        {loadingNodeId ? (
          <>
            <text fg={COLORS.fgLoading}>{spinnerFrame(animTick)}</text>
            <text fg={COLORS.fgLoading}>{' Fetching relations…'}</text>
          </>
        ) : lastError ? (
          <>
            <text fg={COLORS.fgError} attributes={1}>{'✖ '}</text>
            <text fg={COLORS.fgError} truncate>{lastError}</text>
          </>
        ) : hasWorkspaceWarning ? (
          <>
            <text fg={COLORS.fgWarning} attributes={1}>{'⚠ '}</text>
            <text fg={COLORS.fgWarning}>{'No WORKSPACE_ROOT configured — logs and struct queries disabled'}</text>
          </>
        ) : (
          <text fg={COLORS.fgDim}>{'Ready'}</text>
        )}
      </box>

      {/* Keybinding hints line */}
      <box
        flexDirection="row"
        width="100%"
        paddingX={1}
        height={1}
        alignItems="center"
      >
        <KeyHints hints={hints} />
      </box>
    </box>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EmptyState — shown when there are no relations to display
// ─────────────────────────────────────────────────────────────────────────────

type EmptyStateProps = {
  mode: RelationMode;
  rootName: string;
};

export function EmptyState({ mode, rootName }: EmptyStateProps) {
  const msg = rootName === '<none>'
    ? 'No data. Press r to refresh.'
    : mode === 'incoming'
      ? `No callers found for ${rootName}`
      : `No callees found for ${rootName}`;

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      alignItems="center"
      justifyContent="center"
    >
      <text fg={COLORS.fgDim} attributes={0}>{msg}</text>
      <text fg={COLORS.fgDim} marginTop={1}>{'Press r to refresh or ? for help'}</text>
    </box>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Divider — a single horizontal rule
// ─────────────────────────────────────────────────────────────────────────────

export function Divider() {
  return (
    <box
      width="100%"
      height={1}
      backgroundColor={COLORS.bgHeader}
    />
  );
}
