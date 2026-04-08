/**
 * tui-relation-window/html-viewer/graph-to-html.ts
 *
 * Self-contained HTML viewer for intelgraph GraphJson documents.
 * Takes a GraphJson (the node-link graph emitted by the intelgraph
 * `intelligence_graph` MCP tool or by `snapshot-stats --graph-json`)
 * and renders it as a single self-contained HTML document with a
 * d3-force layout.
 *
 * Pipe the output of graphJsonToHtml() into a `.html` file and open
 * it in a browser — no build step, no dev server, no file:// CORS
 * issues. d3 is loaded from a pinned CDN URL.
 *
 * SEPARATION OF CONCERNS:
 * - Backend (extraction, schema, query intents, MCP tools) lives
 *   in /home/abhi/qprojects/clangd-mcp (intelgraph repo).
 * - All frontend / UI code (this file, the inlined HTML/CSS/JS,
 *   the tests) lives here in tui-relation-window.
 * - The contract between them is the GraphJson shape declared
 *   below — it must stay in sync with intelgraph's
 *   src/intelligence/db/sqlite/graph-export.ts.
 *
 * The VIEWER_PURE_JS constant exposes pure helpers (BFS,
 * shortestPath, resolveSymbol, hashHue, dirOf, buildVSCodeUrl) that
 * are inlined into the rendered HTML AND are unit-testable in
 * isolation via `new Function(VIEWER_PURE_JS)`. See
 * graph-to-html.test.ts.
 */

/**
 * GraphJson — node-link graph shape produced by intelgraph's
 * `loadGraphJsonFromDb`. This must stay in sync with the backend's
 * declaration in
 *   /home/abhi/qprojects/clangd-mcp/src/intelligence/db/sqlite/graph-export.ts
 *
 * The viewer is purely a renderer of this shape; if the backend
 * adds new fields, this type can be extended optionally without
 * breaking the consumer.
 */
export interface GraphJson {
  workspace: string
  snapshot_id: number
  nodes: Array<{
    id: string
    kind: string
    file_path: string | null
    line: number | null
    end_line: number | null
    line_count: number | null
    exported: boolean
    doc: string | null
    owning_class: string | null
  }>
  edges: Array<{
    src: string
    dst: string
    kind: string
    resolution_kind: string | null
    metadata: Record<string, unknown> | null
  }>
  /** Total node count BEFORE filters. Used for the "X of Y" badge. */
  total_nodes: number
  /** Total edge count BEFORE filters. */
  total_edges: number
}

/**
 * VIEWER_PURE_JS — pure-logic functions used by the inlined HTML
 * viewer, factored out so they can be unit-tested in vitest without
 * a JSDOM/d3 sandbox.
 *
 * Every function here takes its inputs as parameters (no closure
 * over outer-scope `successors` / `nodeById` / etc.). The HTML
 * template inlines this string verbatim and the call sites pass
 * the closure variables in as args.
 *
 * Exported so the test suite can `new Function(...)` this string
 * and call into the functions with concrete inputs.
 */
export const VIEWER_PURE_JS = `
// Map a file path to its parent directory.
function dirOf(filePath) {
  if (!filePath) return "";
  const slash = filePath.lastIndexOf("/");
  return slash >= 0 ? filePath.substring(0, slash) : "";
}

// FNV-1a-style string → 0..359 hue. Used to color nodes by
// directory in a stable way across runs.
function hashHue(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h % 360;
}

// k-hop BFS in the requested direction. Pure: takes adjacency as
// args so it's callable from anywhere with concrete Maps.
//   direction: "in" | "out" | "both"
//   succ: Map<id, Set<id>> of forward edges
//   pred: Map<id, Set<id>> of backward edges
function neighborhood(rootId, hops, direction, succ, pred) {
  const walkOut = direction === "out" || direction === "both";
  const walkIn = direction === "in" || direction === "both";
  const seen = new Set([rootId]);
  let frontier = [rootId];
  for (let i = 0; i < hops; i++) {
    const next = [];
    for (const id of frontier) {
      if (walkOut) {
        const out = succ.get(id);
        if (out) for (const t of out) if (!seen.has(t)) { seen.add(t); next.push(t); }
      }
      if (walkIn) {
        const inn = pred.get(id);
        if (inn) for (const t of inn) if (!seen.has(t)) { seen.add(t); next.push(t); }
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return seen;
}

// Directed BFS from src to dst over the supplied successors map.
// Returns the ordered node-id sequence (length >= 2) on success or
// null if no path exists. nodeIds is the set of valid ids used to
// reject queries that don't resolve to a known node.
function shortestPath(srcId, dstId, succ, nodeIds) {
  if (!nodeIds.has(srcId) || !nodeIds.has(dstId)) return null;
  if (srcId === dstId) return [srcId];
  const prev = new Map();
  prev.set(srcId, null);
  const queue = [srcId];
  while (queue.length > 0) {
    const cur = queue.shift();
    const out = succ.get(cur);
    if (!out) continue;
    for (const next of out) {
      if (prev.has(next)) continue;
      prev.set(next, cur);
      if (next === dstId) {
        const trail = [next];
        let walk = cur;
        while (walk !== null && walk !== undefined) {
          trail.push(walk);
          walk = prev.get(walk) ?? null;
        }
        return trail.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

// Resolve a forgiving symbol query to a node id. Strategies in
// order: exact match → suffix-after-# match → substring match.
// nodeIds is an iterable of all known canonical names. Returns
// null if nothing matches.
function resolveSymbol(query, nodeIds) {
  if (!query) return null;
  // Pass 1: exact (Set has O(1), so we materialize once if iterable
  // wasn't already a Set)
  const idSet = nodeIds instanceof Set ? nodeIds : new Set(nodeIds);
  if (idSet.has(query)) return query;
  // Pass 2: suffix-after-#
  for (const id of idSet) {
    if (id.endsWith("#" + query)) return id;
  }
  // Pass 3: substring
  for (const id of idSet) {
    if (id.includes(query)) return id;
  }
  return null;
}

// Build a vscode://file URL for the focused node's source
// location. Pure: takes filePath, workspaceRoot, and an optional
// 1-based line, returns the URL string. Returns null when there
// is no usable filePath.
//
//   - Absolute filePath: used verbatim (any leading workspace root
//     in the path is left intact since the user explicitly knows
//     the absolute location).
//   - Relative filePath: resolved against workspaceRoot, with the
//     workspace's trailing slash (if any) trimmed first.
//   - line: appended as ":N" when it's a positive integer; omitted
//     otherwise so VS Code opens at the file's first line.
//
// VS Code Insiders is reachable via the same vscode:// scheme; the
// user's default mac/win/linux URL handler picks the right binary.
function buildVSCodeUrl(filePath, workspaceRoot, line) {
  if (!filePath) return null;
  let root = workspaceRoot || "";
  if (root.endsWith("/")) {
    root = root.substring(0, root.length - 1);
  }
  const abs = filePath.startsWith("/")
    ? filePath
    : (root ? root + "/" + filePath : filePath);
  const lineSuffix =
    typeof line === "number" && line > 0 && Number.isFinite(line)
      ? ":" + line
      : "";
  return "vscode://file" + abs + lineSuffix;
}
`

/**
 * Render a GraphJson as a single self-contained HTML document with
 * a d3-force layout. Pipe the output into a `.html` file and open
 * it in a browser — no build step, no dev server, no file:// CORS
 * issues. d3 is loaded from a pinned CDN URL.
 *
 * Interactivity:
 *   - drag nodes
 *   - zoom + pan
 *   - hover for symbol tooltip
 *   - click a node to highlight its 1-hop neighborhood
 *   - toggle edge kinds via the legend
 *   - search by canonical name
 */
export function graphJsonToHtml(graph: GraphJson): string {
  // Inline the graph data as a JSON literal. JSON is a strict
  // subset of JS, so this is a safe `<script>` body — but we still
  // escape `</` to defend against script-tag injection from rogue
  // canonical names.
  const dataLiteral = JSON.stringify(graph).replace(/<\//g, "<\\/")
  const title = `intelgraph — ${escapeHtml(graph.workspace)}`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  :root {
    --bg: #0f1117;
    --panel: #181b24;
    --border: #2a2f3d;
    --text: #d8def0;
    --muted: #8a93a6;
    --accent: #6ab1ff;
    --link: #3a4456;
    --link-active: #ffd86b;
  }
  html, body {
    margin: 0; padding: 0; height: 100%;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    font-size: 13px;
    overflow: hidden;
  }
  #app { display: flex; height: 100vh; }
  #sidebar {
    width: 280px;
    border-right: 1px solid var(--border);
    background: var(--panel);
    padding: 12px;
    overflow-y: auto;
    flex-shrink: 0;
  }
  #sidebar h1 {
    font-size: 14px;
    margin: 0 0 4px 0;
    font-weight: 600;
    color: var(--accent);
  }
  #sidebar .workspace { font-size: 11px; color: var(--muted); word-break: break-all; margin-bottom: 12px; }
  #sidebar h2 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    margin: 14px 0 6px 0;
    font-weight: 600;
  }
  #sidebar .stat { display: flex; justify-content: space-between; padding: 2px 0; font-variant-numeric: tabular-nums; }
  #sidebar .stat .label { color: var(--muted); }
  #sidebar input[type="search"] {
    width: 100%; box-sizing: border-box;
    background: var(--bg); color: var(--text);
    border: 1px solid var(--border); border-radius: 4px;
    padding: 6px 8px; font-size: 12px;
    margin-bottom: 4px;
  }
  #search-count {
    font-size: 10px; color: var(--muted);
    margin-bottom: 8px; min-height: 12px;
    font-variant-numeric: tabular-nums;
  }
  #sidebar .legend-item, #sidebar .edge-toggle {
    display: flex; align-items: center; gap: 8px;
    padding: 3px 0; cursor: pointer;
    user-select: none;
  }
  #sidebar .swatch {
    width: 12px; height: 12px; border-radius: 2px; flex-shrink: 0;
  }
  #sidebar .swatch.line {
    height: 3px;
  }
  #sidebar .legend-item .count, #sidebar .edge-toggle .count {
    margin-left: auto; color: var(--muted); font-variant-numeric: tabular-nums;
  }
  #sidebar .disabled { opacity: 0.35; }
  #info {
    margin-top: 12px;
    padding: 8px; border: 1px solid var(--border); border-radius: 4px;
    font-size: 11px; min-height: 60px;
    background: var(--bg);
    word-break: break-all;
  }
  #info .empty { color: var(--muted); font-style: italic; }
  #info .row { margin: 2px 0; }
  #info .key { color: var(--muted); }
  #info .section {
    margin-top: 8px; padding-top: 6px;
    border-top: 1px solid var(--border);
  }
  #info .section-title {
    font-size: 10px; text-transform: uppercase;
    letter-spacing: 0.05em; color: var(--muted);
    margin-bottom: 4px; font-weight: 600;
  }
  #info .neighbor-row {
    display: flex; gap: 4px; align-items: baseline;
    padding: 1px 0; cursor: pointer; user-select: none;
  }
  #info .neighbor-row:hover { color: var(--accent); }
  #info .neighbor-row .kind {
    color: var(--muted); font-size: 9px;
    width: 28px; flex-shrink: 0;
  }
  #info .neighbor-row .name {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    flex: 1; min-width: 0;
  }
  #info .open-link {
    display: inline-block;
    margin-top: 6px;
    padding: 3px 8px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--accent);
    font-size: 11px;
    text-decoration: none;
    cursor: pointer;
  }
  #info .open-link:hover {
    border-color: var(--accent);
    background: var(--panel);
  }
  #canvas-wrap { flex: 1; position: relative; }
  svg { width: 100%; height: 100%; display: block; }
  .node { stroke: #000; stroke-width: 0.5; cursor: pointer; }
  .node.dim { opacity: 0.12; }
  .node.hit { stroke: #fff; stroke-width: 1.5; }
  .node.focused { stroke: var(--link-active); stroke-width: 2; }
  .node.search-hit {
    stroke: #82aaff; stroke-width: 2;
  }
  .link { stroke-opacity: 0.45; fill: none; }
  .link.dim { stroke-opacity: 0.04; }
  .link.hit { stroke: var(--link-active); stroke-opacity: 0.85; }
  .arrowhead { fill-opacity: 0.5; }
  .arrowhead.hit { fill: var(--link-active); fill-opacity: 0.85; }
  .link.cycle { stroke: #ff5b6b; stroke-opacity: 0.85; stroke-width: 1.6; }
  .node.cycle { stroke: #ff5b6b; stroke-width: 1.5; }
  .link.path-on { stroke: #c792ea; stroke-opacity: 0.95; stroke-width: 2.4; }
  .node.path-on { stroke: #c792ea; stroke-width: 2.5; }
  /* Phase 3: data-structure edges */
  .link.field_of_type { stroke-dasharray: 4 2; }
  .link.writes_field  { stroke-dasharray: 6 3; }
  .link.aggregates    { stroke-width: 1.6; stroke-opacity: 0.7; }
  #path-status {
    margin-top: 6px; font-size: 11px; color: var(--muted);
    min-height: 14px;
  }
  #path-status.ok { color: #9bd17f; }
  #path-status.fail { color: #ff5b6b; }
  #sidebar input[type="range"] {
    width: 100%; box-sizing: border-box;
    accent-color: var(--accent);
  }
  #sidebar .slider-row {
    display: flex; justify-content: space-between;
    font-size: 11px; color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  #sidebar .dir-row {
    display: flex; gap: 12px;
    font-size: 11px; color: var(--muted);
    margin: 6px 0 8px 0;
  }
  #sidebar .dir-row label {
    cursor: pointer; user-select: none;
    display: flex; gap: 4px; align-items: center;
  }
  #sidebar .dir-row input[type="radio"] {
    accent-color: var(--accent);
  }
  #sidebar button.preset {
    width: 100%; box-sizing: border-box;
    background: var(--bg); color: var(--text);
    border: 1px solid var(--border); border-radius: 4px;
    padding: 6px 8px; font-size: 12px; cursor: pointer;
    text-align: left;
    margin-bottom: 4px;
  }
  #sidebar button.preset:hover {
    border-color: var(--accent); color: var(--accent);
  }
  #sidebar .hub-row {
    display: flex; gap: 6px; align-items: baseline;
    font-size: 11px; padding: 2px 0;
    cursor: pointer; user-select: none;
  }
  #sidebar .hub-row:hover { color: var(--accent); }
  #sidebar .hub-row .deg {
    color: var(--muted); font-variant-numeric: tabular-nums;
    width: 28px; text-align: right; flex-shrink: 0;
  }
  #sidebar .hub-row .name {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    flex: 1; min-width: 0;
  }
  .label {
    font-size: 9px;
    fill: var(--text);
    pointer-events: none;
    text-shadow: 0 0 2px var(--bg), 0 0 2px var(--bg);
  }
  #toolbar {
    position: absolute; top: 8px; right: 8px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 6px 8px;
    font-size: 11px;
    color: var(--muted);
  }
  #toolbar kbd {
    background: var(--bg); border: 1px solid var(--border);
    border-radius: 2px; padding: 1px 4px; font-family: inherit;
  }
  #help-overlay {
    position: absolute; inset: 0;
    background: rgba(15, 17, 23, 0.92);
    display: none;
    align-items: center; justify-content: center;
    z-index: 100;
  }
  #help-overlay.open { display: flex; }
  #help-card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 20px 24px;
    max-width: 540px;
    max-height: 80vh;
    overflow-y: auto;
    color: var(--text);
    font-size: 12px;
    line-height: 1.5;
  }
  #help-card h2 {
    font-size: 14px; margin: 0 0 12px 0;
    color: var(--accent); font-weight: 600;
  }
  #help-card h3 {
    font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.05em; color: var(--muted);
    margin: 14px 0 6px 0; font-weight: 600;
  }
  #help-card .item {
    display: flex; gap: 10px;
    margin: 4px 0;
  }
  #help-card .item kbd {
    background: var(--bg); border: 1px solid var(--border);
    border-radius: 2px; padding: 1px 6px; font-family: inherit;
    font-size: 11px; flex-shrink: 0; min-width: 40px;
    text-align: center;
  }
  #help-card .item .desc { color: var(--text); flex: 1; }
  #help-card .close-hint {
    margin-top: 14px; padding-top: 10px;
    border-top: 1px solid var(--border);
    color: var(--muted); font-size: 11px;
  }
  #help-button {
    position: absolute; bottom: 8px; left: 8px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 11px;
    color: var(--muted);
    cursor: pointer;
    user-select: none;
  }
  #help-button:hover { color: var(--accent); border-color: var(--accent); }
  #fit-button {
    position: absolute; bottom: 8px; left: 70px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 11px;
    color: var(--muted);
    cursor: pointer;
    user-select: none;
    font-family: inherit;
  }
  #fit-button:hover { color: var(--accent); border-color: var(--accent); }
  #badge {
    position: absolute; bottom: 8px; right: 8px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 11px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
</style>
</head>
<body>
<div id="app">
  <aside id="sidebar">
    <h1>intelgraph</h1>
    <div class="workspace">${escapeHtml(graph.workspace)}</div>

    <h2>Stats</h2>
    <div class="stat"><span class="label">nodes</span><span id="stat-nodes">0</span></div>
    <div class="stat"><span class="label">edges</span><span id="stat-edges">0</span></div>
    <div class="stat"><span class="label">visible</span><span id="stat-visible">0</span></div>

    <h2>Search</h2>
    <input id="search" type="search" placeholder="canonical name…" />
    <div id="search-count"></div>

    <h2>Focus depth</h2>
    <input id="hop-slider" type="range" min="1" max="4" value="1" step="1" />
    <div class="slider-row">
      <span>1 hop</span>
      <span id="hop-value">1</span>
      <span>4 hops</span>
    </div>
    <div class="dir-row">
      <label><input type="radio" name="dir" value="both" checked> both</label>
      <label><input type="radio" name="dir" value="out"> out</label>
      <label><input type="radio" name="dir" value="in"> in</label>
    </div>
    <button class="preset" id="center-on-focused">Center on focused (live)</button>
    <button class="preset" id="clear-center">Show full graph</button>

    <h2>Cycles</h2>
    <div class="legend-item" id="cycle-toggle">
      <div class="swatch" style="background:#ff5b6b"></div>
      <div>highlight 2-cycles</div>
      <div class="count" id="cycle-count">0</div>
    </div>

    <h2>Tint by directory</h2>
    <div class="legend-item" id="tint-toggle">
      <div class="swatch" style="background:linear-gradient(90deg,#6ab1ff,#9bd17f,#ffb86b,#c792ea)"></div>
      <div>color stroke by parent dir</div>
      <div class="count" id="tint-count">0</div>
    </div>

    <h2>Quick views</h2>
    <button class="preset" id="preset-modules">Module dependency view</button>
    <button class="preset" id="preset-data">Data structure view</button>
    <button class="preset" id="preset-reset">Reset all filters</button>

    <h2>Find path</h2>
    <input id="path-from" type="search" placeholder="from (canonical name)" />
    <input id="path-to" type="search" placeholder="to (canonical name)" />
    <button class="preset" id="path-find">Find shortest path</button>
    <div id="path-status"></div>

    <h2>Top imported modules</h2>
    <div id="top-imported"></div>

    <h2>Top called functions</h2>
    <div id="top-called"></div>

    <h2>Symbol kinds</h2>
    <div id="kind-legend"></div>

    <h2>Edge kinds</h2>
    <div id="edge-legend"></div>

    <h2>Selection</h2>
    <div id="info"><span class="empty">click a node</span></div>
  </aside>
  <div id="canvas-wrap">
    <svg id="canvas"></svg>
    <div id="toolbar">scroll = zoom · drag = pan · click = focus · <kbd>f</kbd> = fit · <kbd>esc</kbd> = clear · <kbd>?</kbd> = help</div>
    <div id="badge"><span id="badge-text">0 nodes / 0 edges</span></div>
    <button id="fit-button">fit view</button>
    <div id="help-button">? help</div>
    <div id="help-overlay">
      <div id="help-card">
        <h2>intelgraph viewer · keyboard &amp; features</h2>

        <h3>Canvas</h3>
        <div class="item"><kbd>scroll</kbd><div class="desc">zoom in / out</div></div>
        <div class="item"><kbd>drag</kbd><div class="desc">pan canvas, or drag a node to reposition it</div></div>
        <div class="item"><kbd>click</kbd><div class="desc">focus a node — highlights its k-hop neighborhood</div></div>
        <div class="item"><kbd>f</kbd><div class="desc">fit view — zoom + center to show all visible nodes</div></div>
        <div class="item"><kbd>esc</kbd><div class="desc">clear focus + close help</div></div>
        <div class="item"><kbd>?</kbd><div class="desc">toggle this help overlay</div></div>

        <h3>Sidebar — exploration</h3>
        <div class="item"><kbd>search</kbd><div class="desc">find a symbol by canonical name (substring matches)</div></div>
        <div class="item"><kbd>hops</kbd><div class="desc">slider sets focus depth (1–4) and live-center radius</div></div>
        <div class="item"><kbd>dir</kbd><div class="desc">in / out / both — direction of the BFS walk</div></div>
        <div class="item"><kbd>center</kbd><div class="desc">"Center on focused" hard-filters the graph to the neighborhood</div></div>
        <div class="item"><kbd>neighbors</kbd><div class="desc">click a row in the Selection panel's Outgoing/Incoming lists to jump focus</div></div>

        <h3>Sidebar — overlays</h3>
        <div class="item"><kbd>cycles</kbd><div class="desc">highlight 2-cycles in red (imports / calls / references_type)</div></div>
        <div class="item"><kbd>tint</kbd><div class="desc">color node strokes by parent directory</div></div>
        <div class="item"><kbd>kinds</kbd><div class="desc">click any kind in the legends to toggle visibility</div></div>

        <h3>Sidebar — paths</h3>
        <div class="item"><kbd>find</kbd><div class="desc">"Find path" runs directed BFS between two symbols, highlights the trail</div></div>
        <div class="item"><kbd>presets</kbd><div class="desc">"Module dependency view" → module-only + imports-only. "Data structure view" → struct/class/interface/enum + field/variant nodes connected by contains/field_of_type/aggregates.</div></div>

        <h3>Persistence</h3>
        <div class="item"><kbd>url</kbd><div class="desc">focus, depth, direction, toggles, and filters all live in the URL hash — share or bookmark to round-trip the view</div></div>

        <div class="close-hint">click outside or press <kbd>esc</kbd> / <kbd>?</kbd> to close</div>
      </div>
    </div>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script>
<script>
${VIEWER_PURE_JS}
const data = ${dataLiteral};
const KIND_COLORS = {
  module:       "#6ab1ff",
  function:     "#9bd17f",
  method:       "#7fc6c0",
  class:        "#ffb86b",
  struct:       "#ff8a65",
  interface:    "#c792ea",
  enum:         "#e5c07b",
  typedef:      "#82aaff",
  namespace:    "#f78c6c",
  global_var:   "#a3a8b8",
  // Phase 3d: structural data hierarchy
  field:        "#b48ead",
  enum_variant: "#d5a0c0",
};
const EDGE_COLORS = {
  imports:         "#6ab1ff",
  contains:        "#5a6378",
  calls:           "#9bd17f",
  references_type: "#c792ea",
  implements:      "#e5c07b",
  extends:         "#ff8a65",
  // Phase 3a/3b: data-structure edges
  reads_field:     "#7fc6c0",
  writes_field:    "#ff8a65",
  field_of_type:   "#b48ead",
  aggregates:      "#9b6fb0",
};
function colorFor(kind, table, fallback) {
  return table[kind] || fallback;
}

const svg = d3.select("#canvas");
const wrap = document.getElementById("canvas-wrap");
const width  = () => wrap.clientWidth;
const height = () => wrap.clientHeight;

// Per-edge-kind arrowhead markers, so directed edges can show
// direction without us hand-rolling triangle paths. d3 auto-orients
// markerUnits=strokeWidth so the arrow scales with the link.
const defs = svg.append("defs");
const ARROW_KINDS = Object.keys(EDGE_COLORS).concat(["__default", "__hit"]);
for (const k of ARROW_KINDS) {
  const fill =
    k === "__hit" ? "#ffd86b" :
    k === "__default" ? "#5a6378" :
    EDGE_COLORS[k];
  defs.append("marker")
    .attr("id", "arrow-" + k)
    .attr("class", "arrowhead")
    .attr("viewBox", "0 -5 10 10")
    .attr("refX", 12)
    .attr("refY", 0)
    .attr("markerWidth", 6)
    .attr("markerHeight", 6)
    .attr("orient", "auto")
    .attr("markerUnits", "strokeWidth")
    .append("path")
    .attr("d", "M0,-5L10,0L0,5")
    .attr("fill", fill);
}

const root = svg.append("g");
const linkLayer  = root.append("g").attr("class", "links");
const nodeLayer  = root.append("g").attr("class", "nodes");
const labelLayer = root.append("g").attr("class", "labels");

const zoom = d3.zoom().scaleExtent([0.1, 8]).on("zoom", (ev) => {
  root.attr("transform", ev.transform);
  // hide labels when zoomed out
  labelLayer.style("display", ev.transform.k > 1.6 ? "block" : "none");
});
svg.call(zoom);

// Index nodes by id and build d3 link objects
const nodeById = new Map(data.nodes.map((n) => [n.id, n]));
const links = data.edges
  .filter((e) => nodeById.has(e.src) && nodeById.has(e.dst))
  .map((e) => ({ source: e.src, target: e.dst, kind: e.kind }));

// Build directed in/out adjacency for multi-hop expansion + degree
// counts. successors[id] = Set of nodes this id points TO via any
// edge; predecessors[id] = Set of nodes that point AT this id.
const successors = new Map();
const predecessors = new Map();
// Edge-kind-tagged adjacency for the info panel's caller/callee
// listing. outEdgesByKind[id][kind] = Array of dst ids;
// inEdgesByKind[id][kind] = Array of src ids.
const outEdgesByKind = new Map();
const inEdgesByKind = new Map();
for (const n of data.nodes) {
  successors.set(n.id, new Set());
  predecessors.set(n.id, new Set());
  outEdgesByKind.set(n.id, {});
  inEdgesByKind.set(n.id, {});
}
for (const l of links) {
  successors.get(l.source).add(l.target);
  predecessors.get(l.target).add(l.source);
  const outBuckets = outEdgesByKind.get(l.source);
  if (outBuckets) {
    if (!outBuckets[l.kind]) outBuckets[l.kind] = [];
    outBuckets[l.kind].push(l.target);
  }
  const inBuckets = inEdgesByKind.get(l.target);
  if (inBuckets) {
    if (!inBuckets[l.kind]) inBuckets[l.kind] = [];
    inBuckets[l.kind].push(l.source);
  }
}
// Walk direction for neighborhood expansion. Mirrors the server-side
// centerDirection contract:
//   "both" → undirected (successors ∪ predecessors), "everything related"
//   "out"  → forward only (successors), "what X reaches"
//   "in"   → backward only (predecessors), "what reaches X"
let walkDirection = "both";

// Closure-bound wrapper around the parametric neighborhood() from
// VIEWER_PURE_JS. Call sites use this so they don't have to pass
// the adjacency maps every time.
function nbhd(rootId, hops, direction) {
  return neighborhood(
    rootId,
    hops,
    direction || walkDirection,
    successors,
    predecessors,
  );
}

document.getElementById("stat-nodes").textContent = data.nodes.length;
document.getElementById("stat-edges").textContent = links.length;

// Detect 2-cycles by edge_kind: any pair (a,b) where a→b AND b→a via
// the same kind. Reported as a Set of "kind|a|b" strings (a < b
// lexicographically, so each cycle appears once). We detect across
// every edge_kind so the user sees imports cycles, calls cycles, and
// references_type cycles uniformly. Used to color the offending nodes
// and edges in red.
const cycleNodes = new Set();
const cycleEdgeKeys = new Set();
{
  const keyOf = (kind, s, t) => kind + "|" + s + "|" + t;
  const have = new Set();
  for (const l of links) have.add(keyOf(l.kind, l.source, l.target));
  for (const l of links) {
    if (have.has(keyOf(l.kind, l.target, l.source))) {
      // Mark both directions as cycle edges
      cycleEdgeKeys.add(keyOf(l.kind, l.source, l.target));
      cycleEdgeKeys.add(keyOf(l.kind, l.target, l.source));
      cycleNodes.add(l.source);
      cycleNodes.add(l.target);
    }
  }
}
document.getElementById("cycle-count").textContent = cycleNodes.size;

// Active filters
const activeKinds = new Set(data.nodes.map((n) => n.kind));
const activeEdgeKinds = new Set(links.map((l) => l.kind));
let cyclesOn = false;
let tintOn = false;
// Set of node ids that match the current search query, used to
// paint the .search-hit class on every matching node (not just the
// first one we focus on).
const searchMatches = new Set();

// Directory tint: hash each node's parent directory to a stable hue
// in the HSL wheel. Used as the stroke color when "tint by directory"
// is on, so the kind color (fill) and subsystem cue (stroke) are
// readable simultaneously. Computed once at init. (dirOf and hashHue
// come from the VIEWER_PURE_JS block above.)
const dirHueByNode = new Map();
const distinctDirs = new Set();
for (const n of data.nodes) {
  const d = dirOf(n.file_path);
  if (d) {
    distinctDirs.add(d);
    dirHueByNode.set(n.id, "hsl(" + hashHue(d) + ",55%,55%)");
  }
}
document.getElementById("tint-count").textContent = distinctDirs.size;

const sim = d3.forceSimulation(data.nodes)
  .force("link", d3.forceLink(links).id((d) => d.id).distance(40).strength(0.5))
  .force("charge", d3.forceManyBody().strength(-90))
  .force("center", d3.forceCenter(width() / 2, height() / 2))
  .force("collide", d3.forceCollide().radius(7));

let linkSel = linkLayer.selectAll("line");
let nodeSel = nodeLayer.selectAll("circle");
let labelSel = labelLayer.selectAll("text");

function shortName(id) {
  const hash = id.indexOf("#");
  if (hash >= 0) return id.substring(hash + 1);
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.substring(slash + 1) : id;
}

function radiusFor(d) {
  if (d.kind === "module") return 6;
  if (d.kind === "class" || d.kind === "struct" || d.kind === "interface") return 5;
  return 3.5;
}

// Live center filter: when set, render() drops nodes outside this
// set in addition to the kind filter. Populated by the "Center on
// focused" button from the focused node's k-hop neighborhood,
// where k is the current hop slider value. Cleared by "Show full
// graph" or by entering a fresh search query.
let centerSet = null;

function render() {
  const visibleNodes = data.nodes.filter((n) => {
    if (!activeKinds.has(n.kind)) return false;
    if (centerSet && !centerSet.has(n.id)) return false;
    return true;
  });
  const visibleNodeIds = new Set(visibleNodes.map((n) => n.id));
  const visibleLinks = links.filter(
    (l) =>
      activeEdgeKinds.has(l.kind) &&
      visibleNodeIds.has(typeof l.source === "object" ? l.source.id : l.source) &&
      visibleNodeIds.has(typeof l.target === "object" ? l.target.id : l.target),
  );

  document.getElementById("stat-visible").textContent =
    visibleNodes.length + " / " + visibleLinks.length;
  if (typeof updateBadge === "function") {
    updateBadge(visibleNodes.length, visibleLinks.length);
  }

  linkSel = linkLayer
    .selectAll("line")
    .data(visibleLinks, (d) => (typeof d.source === "object" ? d.source.id : d.source) + "→" + (typeof d.target === "object" ? d.target.id : d.target) + ":" + d.kind)
    .join("line")
    .attr("class", (d) => {
      const s = typeof d.source === "object" ? d.source.id : d.source;
      const t = typeof d.target === "object" ? d.target.id : d.target;
      const isCycle = cyclesOn && cycleEdgeKeys.has(d.kind + "|" + s + "|" + t);
      const isPath = pathEdgeKeys.has(d.kind + "|" + s + "|" + t);
      // The d.kind class enables per-edge-kind CSS rules
      // (.link.field_of_type, .link.writes_field, .link.aggregates, …).
      let cls = "link " + d.kind;
      if (isCycle) cls += " cycle";
      if (isPath) cls += " path-on";
      return cls;
    })
    .attr("stroke", (d) => colorFor(d.kind, EDGE_COLORS, "#5a6378"))
    .attr("stroke-width", (d) => (d.kind === "calls" ? 1.2 : 0.8))
    .attr("marker-end", (d) =>
      EDGE_COLORS[d.kind] ? "url(#arrow-" + d.kind + ")" : "url(#arrow-__default)");

  nodeSel = nodeLayer
    .selectAll("circle")
    .data(visibleNodes, (d) => d.id)
    .join("circle")
    .attr("class", (d) => {
      let cls = "node";
      if (cyclesOn && cycleNodes.has(d.id)) cls += " cycle";
      if (pathNodes.has(d.id)) cls += " path-on";
      if (searchMatches.has(d.id)) cls += " search-hit";
      return cls;
    })
    .attr("r", radiusFor)
    .attr("fill", (d) => colorFor(d.kind, KIND_COLORS, "#a3a8b8"))
    .attr("stroke", (d) => {
      // .cycle class wins (set in CSS), then directory tint, then default.
      if (cyclesOn && cycleNodes.has(d.id)) return null;
      if (tintOn) return dirHueByNode.get(d.id) || "#000";
      return null;
    })
    .attr("stroke-width", (d) => (tintOn && dirHueByNode.has(d.id) ? 1.5 : 0.5))
    .on("click", onClick)
    .on("mouseover", onHover)
    .call(
      d3.drag()
        .on("start", (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag",  (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
        .on("end",   (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }),
    );

  labelSel = labelLayer
    .selectAll("text")
    .data(visibleNodes, (d) => d.id)
    .join("text")
    .attr("class", "label")
    .attr("dx", 7)
    .attr("dy", 3)
    .text((d) => shortName(d.id));

  sim.nodes(visibleNodes);
  sim.force("link").links(visibleLinks);
  sim.alpha(0.6).restart();
}

sim.on("tick", () => {
  linkSel
    .attr("x1", (d) => d.source.x)
    .attr("y1", (d) => d.source.y)
    .attr("x2", (d) => d.target.x)
    .attr("y2", (d) => d.target.y);
  nodeSel.attr("cx", (d) => d.x).attr("cy", (d) => d.y);
  labelSel.attr("x", (d) => d.x).attr("y", (d) => d.y);
});

let focused = null;
let hopDepth = 1;
function onClick(ev, d) {
  ev.stopPropagation();
  focused = focused === d.id ? null : d.id;
  applyFocus();
  showInfo(d);
  saveHashState();
}
function onHover(ev, d) {
  if (!focused) showInfo(d);
}
svg.on("click", () => { focused = null; applyFocus(); clearInfo(); saveHashState(); });
window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    // Esc closes the help overlay first if it's open, otherwise
    // clears focus.
    const helpOpen = document.getElementById("help-overlay").classList.contains("open");
    if (helpOpen) {
      document.getElementById("help-overlay").classList.remove("open");
      return;
    }
    focused = null; applyFocus(); clearInfo(); saveHashState();
  }
  if (ev.key === "?" || (ev.shiftKey && ev.key === "/")) {
    // Toggle help (Shift+/ produces ? on US layouts; the explicit
    // check covers other layouts that emit "?" directly).
    document.getElementById("help-overlay").classList.toggle("open");
  }
  if (ev.key === "f" || ev.key === "F") {
    // Skip when the user is typing in a search box
    const tag = (ev.target && ev.target.tagName) || "";
    if (tag !== "INPUT" && tag !== "TEXTAREA") {
      fitView();
    }
  }
});

// Help button click + click-outside-to-close behavior on the
// overlay backdrop.
document.getElementById("help-button").addEventListener("click", (ev) => {
  ev.stopPropagation();
  document.getElementById("help-overlay").classList.toggle("open");
});
document.getElementById("help-overlay").addEventListener("click", (ev) => {
  // Click on the dark backdrop dismisses; click on the inner card
  // does not.
  if (ev.target === ev.currentTarget) {
    ev.currentTarget.classList.remove("open");
  }
});

// Fit-view: compute the bounding box of all currently-rendered
// nodes and apply a zoom transform that centers and scales them
// to fill ~85% of the viewport. Used by the "fit view" button and
// the f keyboard shortcut.
function fitView() {
  // Read positions from the d3 data binding — node.x / node.y are
  // populated by the force tick handler.
  const nodes = nodeSel.data();
  if (nodes.length === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (typeof n.x !== "number" || typeof n.y !== "number") continue;
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x;
    if (n.y > maxY) maxY = n.y;
  }
  if (!isFinite(minX)) return;
  const bboxW = Math.max(1, maxX - minX);
  const bboxH = Math.max(1, maxY - minY);
  const PAD = 40;
  const w = width(), h = height();
  const k = Math.min(
    (w - 2 * PAD) / bboxW,
    (h - 2 * PAD) / bboxH,
    8, // never zoom in past the existing scaleExtent ceiling
  );
  const tx = (w - k * (minX + maxX)) / 2;
  const ty = (h - k * (minY + maxY)) / 2;
  svg.transition()
    .duration(400)
    .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
}
document.getElementById("fit-button").addEventListener("click", fitView);

// ── URL hash state ──────────────────────────────────────────────────────────
// The viewer persists discrete UI state (focused node, hop depth, the
// cycle/tint toggles, and the active kind/edge filters) into the URL
// hash so users can bookmark or share specific views. The continuous
// zoom transform is excluded — it changes too often to be useful in
// the URL bar and would noisily push history entries.
function saveHashState() {
  const params = new URLSearchParams();
  if (focused) params.set("f", focused);
  if (hopDepth !== 1) params.set("h", String(hopDepth));
  if (walkDirection !== "both") params.set("d", walkDirection);
  if (cyclesOn) params.set("c", "1");
  if (tintOn) params.set("t", "1");
  if (centerSet) params.set("cm", "1");
  // Only encode kind filters when they don't match the full set
  const allKinds = new Set(data.nodes.map((n) => n.kind));
  if (activeKinds.size !== allKinds.size) {
    params.set("k", [...activeKinds].sort().join(","));
  }
  const allEdgeKinds = new Set(links.map((l) => l.kind));
  if (activeEdgeKinds.size !== allEdgeKinds.size) {
    params.set("e", [...activeEdgeKinds].sort().join(","));
  }
  const next = params.toString();
  // history.replaceState avoids spamming the back button with every click
  if (next !== (window.location.hash || "").slice(1)) {
    history.replaceState(null, "", next ? "#" + next : window.location.pathname);
  }
}
function loadHashState() {
  const raw = (window.location.hash || "").slice(1);
  if (!raw) return;
  const params = new URLSearchParams(raw);
  const f = params.get("f");
  if (f && nodeById.has(f)) focused = f;
  const h = Number(params.get("h"));
  if (h >= 1 && h <= 4) {
    hopDepth = h;
    document.getElementById("hop-slider").value = String(h);
    document.getElementById("hop-value").textContent = String(h);
  }
  const d = params.get("d");
  if (d === "in" || d === "out" || d === "both") {
    walkDirection = d;
    for (const radio of document.querySelectorAll('input[name="dir"]')) {
      radio.checked = radio.value === d;
    }
  }
  if (params.get("c") === "1") {
    cyclesOn = true;
    document.getElementById("cycle-toggle").classList.remove("disabled");
  }
  if (params.get("t") === "1") {
    tintOn = true;
    document.getElementById("tint-toggle").classList.remove("disabled");
  }
  // Live center filter: if cm=1 is in the hash AND f resolved to a
  // valid node, recompute the centerSet from the focused node's
  // neighborhood at the current hop depth. We can't store the full
  // ID set in the URL — it would explode for big graphs — so we
  // store just the flag and recompute.
  if (params.get("cm") === "1" && focused) {
    centerSet = nbhd(focused, hopDepth);
  }
  const k = params.get("k");
  if (k) {
    activeKinds.clear();
    for (const part of k.split(",")) if (part) activeKinds.add(part);
  }
  const e = params.get("e");
  if (e) {
    activeEdgeKinds.clear();
    for (const part of e.split(",")) if (part) activeEdgeKinds.add(part);
  }
}

// Hop-depth slider — re-applies focus on change so the highlighted
// neighborhood expands/contracts live.
const hopSlider = document.getElementById("hop-slider");
const hopValue = document.getElementById("hop-value");
hopSlider.addEventListener("input", (ev) => {
  hopDepth = Number(ev.target.value);
  hopValue.textContent = String(hopDepth);
  if (focused) applyFocus();
  // If the live center filter is active, recompute it for the
  // new depth so the visible set tracks the slider live.
  if (centerSet && focused) {
    centerSet = nbhd(focused, hopDepth);
    render();
  }
  saveHashState();
});

// Direction radio — switches the BFS walk to forward / backward / both.
// Re-applies focus so the highlighted set updates immediately, and
// rebuilds the live center filter if it's active.
for (const radio of document.querySelectorAll('input[name="dir"]')) {
  radio.addEventListener("change", (ev) => {
    walkDirection = ev.target.value;
    if (focused) applyFocus();
    if (centerSet && focused) {
      centerSet = nbhd(focused, hopDepth);
      render();
    }
    saveHashState();
  });
}

// Cycle-highlight toggle — re-renders so node + link classes pick up
// the cycle marking. The cycle sets are precomputed once at init,
// the toggle just controls whether the .cycle class is applied.
const cycleToggle = document.getElementById("cycle-toggle");
cycleToggle.addEventListener("click", () => {
  cyclesOn = !cyclesOn;
  cycleToggle.classList.toggle("disabled", !cyclesOn);
  render();
  saveHashState();
});
// Start in the disabled visual state so users see the count first
cycleToggle.classList.add("disabled");

// Directory-tint toggle — same shape as the cycle toggle.
const tintToggle = document.getElementById("tint-toggle");
tintToggle.addEventListener("click", () => {
  tintOn = !tintOn;
  tintToggle.classList.toggle("disabled", !tintOn);
  render();
  saveHashState();
});
tintToggle.classList.add("disabled");

function applyFocus() {
  if (!focused) {
    nodeSel.classed("dim", false).classed("hit", false).classed("focused", false);
    linkSel.classed("dim", false).classed("hit", false);
    return;
  }
  const nbrs = nbhd(focused, hopDepth);
  nodeSel
    .classed("dim", (d) => !nbrs.has(d.id))
    .classed("hit", (d) => nbrs.has(d.id) && d.id !== focused)
    .classed("focused", (d) => d.id === focused);
  linkSel
    .classed("dim", (l) => {
      const s = typeof l.source === "object" ? l.source.id : l.source;
      const t = typeof l.target === "object" ? l.target.id : l.target;
      return !(nbrs.has(s) && nbrs.has(t));
    })
    .classed("hit", (l) => {
      const s = typeof l.source === "object" ? l.source.id : l.source;
      const t = typeof l.target === "object" ? l.target.id : l.target;
      return nbrs.has(s) && nbrs.has(t) && (s === focused || t === focused);
    });
}

function showInfo(d) {
  const info = document.getElementById("info");
  const inDeg = (predecessors.get(d.id) || new Set()).size;
  const outDeg = (successors.get(d.id) || new Set()).size;
  const rows = [
    ["id",         d.id],
    ["kind",       d.kind],
    ["file",       d.file_path || "—"],
    ["line",       d.line ?? "—"],
    ["lines",      d.line_count ?? "—"],
    ["in-degree",  inDeg],
    ["out-degree", outDeg],
    ["exported",   d.exported ? "yes" : "no"],
    ["owning",     d.owning_class || "—"],
  ];
  let html = rows
    .map((r) => '<div class="row"><span class="key">' + r[0] + '</span> ' + escapeHtml(String(r[1])) + '</div>')
    .join("");

  // Add an "open in VS Code" link when the node has a usable
  // file_path. The pure URL builder lives in VIEWER_PURE_JS so
  // it can be unit-tested without spinning up the full viewer.
  const vscodeUrl = buildVSCodeUrl(d.file_path, data.workspace, d.line);
  if (vscodeUrl) {
    html +=
      '<a class="open-link" href="' + escapeHtml(vscodeUrl) + '">→ open in VS Code</a>';
  }

  // Render up to 6 callers and 6 callees grouped by edge_kind. Each
  // row is clickable; clicking jumps focus to that neighbor.
  html += renderNeighborSection(
    "Outgoing",
    outEdgesByKind.get(d.id) || {},
  );
  html += renderNeighborSection(
    "Incoming",
    inEdgesByKind.get(d.id) || {},
  );

  info.innerHTML = html;

  // Wire click handlers on the new neighbor rows. We do this after
  // setting innerHTML because event delegation is simpler than
  // re-attaching to the dynamically-built rows.
  for (const row of info.querySelectorAll(".neighbor-row")) {
    row.addEventListener("click", () => {
      const target = row.getAttribute("data-target");
      if (target && nodeById.has(target)) {
        focused = target;
        applyFocus();
        showInfo(nodeById.get(target));
        saveHashState();
      }
    });
  }
}

function renderNeighborSection(title, byKind) {
  const kinds = Object.keys(byKind);
  if (kinds.length === 0) return "";
  // Flatten and cap at 6 entries total, sorted by edge_kind for
  // determinism. Each entry rendered as a clickable row.
  const entries = [];
  for (const kind of kinds.sort()) {
    for (const target of byKind[kind]) {
      entries.push({ kind, target });
      if (entries.length >= 6) break;
    }
    if (entries.length >= 6) break;
  }
  let body = '<div class="section">';
  body += '<div class="section-title">' + escapeHtml(title) + '</div>';
  for (const e of entries) {
    body +=
      '<div class="neighbor-row" data-target="' + escapeHtml(e.target) + '">' +
      '<span class="kind">' + escapeHtml(e.kind.slice(0, 4)) + '</span>' +
      '<span class="name">' + escapeHtml(shortName(e.target)) + '</span>' +
      '</div>';
  }
  body += '</div>';
  return body;
}
function clearInfo() {
  document.getElementById("info").innerHTML = '<span class="empty">click a node</span>';
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Build legends
function buildKindLegend() {
  const counts = {};
  for (const n of data.nodes) counts[n.kind] = (counts[n.kind] || 0) + 1;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const container = document.getElementById("kind-legend");
  container.innerHTML = "";
  for (const [kind, n] of sorted) {
    const div = document.createElement("div");
    div.className = "legend-item";
    div.innerHTML =
      '<div class="swatch" style="background:' + colorFor(kind, KIND_COLORS, "#a3a8b8") + '"></div>' +
      '<div>' + escapeHtml(kind) + '</div>' +
      '<div class="count">' + n + '</div>';
    if (!activeKinds.has(kind)) div.classList.add("disabled");
    div.onclick = () => {
      if (activeKinds.has(kind)) activeKinds.delete(kind);
      else activeKinds.add(kind);
      div.classList.toggle("disabled", !activeKinds.has(kind));
      render();
      saveHashState();
    };
    container.appendChild(div);
  }
}
function buildEdgeLegend() {
  const counts = {};
  for (const l of links) counts[l.kind] = (counts[l.kind] || 0) + 1;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const container = document.getElementById("edge-legend");
  container.innerHTML = "";
  for (const [kind, n] of sorted) {
    const div = document.createElement("div");
    div.className = "edge-toggle";
    div.innerHTML =
      '<div class="swatch line" style="background:' + colorFor(kind, EDGE_COLORS, "#5a6378") + '"></div>' +
      '<div>' + escapeHtml(kind) + '</div>' +
      '<div class="count">' + n + '</div>';
    if (!activeEdgeKinds.has(kind)) div.classList.add("disabled");
    div.onclick = () => {
      if (activeEdgeKinds.has(kind)) activeEdgeKinds.delete(kind);
      else activeEdgeKinds.add(kind);
      div.classList.toggle("disabled", !activeEdgeKinds.has(kind));
      render();
      saveHashState();
    };
    container.appendChild(div);
  }
}
// ── Top-hubs panels ─────────────────────────────────────────────────────────
// Surface the most-imported modules and most-called functions in the
// sidebar so users have one-click entry points into the busiest parts
// of the graph. The data is already inlined as the links array, so we
// compute the rankings client-side at init.
function buildHubPanel(containerId, edgeKind, validNodeKinds) {
  const incoming = new Map();
  for (const l of links) {
    if (l.kind !== edgeKind) continue;
    incoming.set(l.target, (incoming.get(l.target) || 0) + 1);
  }
  const ranked = [];
  for (const [id, count] of incoming) {
    const node = nodeById.get(id);
    if (!node) continue;
    if (validNodeKinds && !validNodeKinds.has(node.kind)) continue;
    ranked.push({ id, count, node });
  }
  ranked.sort((a, b) => b.count - a.count);
  const top = ranked.slice(0, 8);
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  if (top.length === 0) {
    container.innerHTML = '<div class="hub-row" style="cursor:default"><div class="name" style="color:var(--muted);font-style:italic">none</div></div>';
    return;
  }
  for (const hub of top) {
    const row = document.createElement("div");
    row.className = "hub-row";
    row.title = hub.id;
    row.innerHTML =
      '<div class="deg">' + hub.count + '</div>' +
      '<div class="name">' + escapeHtml(shortName(hub.id)) + '</div>';
    row.onclick = () => {
      focused = hub.id;
      applyFocus();
      showInfo(hub.node);
      saveHashState();
    };
    container.appendChild(row);
  }
}

// ── Quick-view presets ──────────────────────────────────────────────────────
// One-click filter combinations for the most useful subgraphs.
function applyModuleDepView() {
  // Module-only nodes, imports-only edges. The canonical "package
  // dependency" view that the snapshot-stats CLI exposes via
  // --filter-edge-kind=imports --filter-symbol-kind=module.
  activeKinds.clear();
  activeKinds.add("module");
  activeEdgeKinds.clear();
  activeEdgeKinds.add("imports");
  buildKindLegend();
  buildEdgeLegend();
  render();
  saveHashState();
}
function applyResetView() {
  activeKinds.clear();
  for (const n of data.nodes) activeKinds.add(n.kind);
  activeEdgeKinds.clear();
  for (const l of links) activeEdgeKinds.add(l.kind);
  focused = null;
  buildKindLegend();
  buildEdgeLegend();
  applyFocus();
  clearInfo();
  render();
  saveHashState();
}
function applyDataStructureView() {
  // Show structs/classes/interfaces/enums + their fields/variants,
  // connected by contains + field_of_type + aggregates edges. The
  // dual of "Module dependency view" — that one shows package shape,
  // this one shows what data each type holds and depends on.
  activeKinds.clear();
  for (const k of ["struct", "class", "interface", "enum", "field", "enum_variant", "typedef"]) {
    activeKinds.add(k);
  }
  activeEdgeKinds.clear();
  for (const k of ["contains", "field_of_type", "aggregates"]) {
    activeEdgeKinds.add(k);
  }
  buildKindLegend();
  buildEdgeLegend();
  render();
  saveHashState();
}
document.getElementById("preset-modules").addEventListener("click", applyModuleDepView);
document.getElementById("preset-data").addEventListener("click", applyDataStructureView);
document.getElementById("preset-reset").addEventListener("click", applyResetView);

// Path-finding wiring: button click + Enter-key in either input.
document.getElementById("path-find").addEventListener("click", findAndShowPath);
for (const id of ["path-from", "path-to"]) {
  document.getElementById(id).addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") findAndShowPath();
  });
}
// Also clear the path when Reset is clicked.
document.getElementById("preset-reset").addEventListener("click", clearPath);

// Live center filter: take the focused node's k-hop neighborhood
// and use it as a hard visibility filter. This is the inline
// counterpart to the CLI / MCP centerOf flag — same effect, but
// reversible at any time and computed against the inlined data.
document.getElementById("center-on-focused").addEventListener("click", () => {
  if (!focused) {
    document.getElementById("info").innerHTML =
      '<span class="empty">click a node first, then center</span>';
    return;
  }
  centerSet = nbhd(focused, hopDepth);
  render();
  saveHashState();
});
document.getElementById("clear-center").addEventListener("click", () => {
  centerSet = null;
  render();
  saveHashState();
});
// Also clear the center filter when "Reset all filters" is clicked.
document.getElementById("preset-reset").addEventListener("click", () => {
  centerSet = null;
});

// ── Live stats badge ────────────────────────────────────────────────────────
// Updates after every render() so users see exactly how their filter
// choices change the visible counts.
//
// When the result was filtered server-side (centerOf, maxNodes, etc.),
// the GraphJson carries the pre-filter totals so we can show
// "<visible> of <total>" instead of just the visible count. This
// makes truncation visible to the user — if they ran
// --max-nodes=300 against a 20K-node workspace, the badge will say
// "300 of 20466 nodes" so they know how much was hidden.
const TOTAL_NODES = data.total_nodes ?? data.nodes.length;
const TOTAL_EDGES = data.total_edges ?? links.length;
function fmtBadgePart(visible, total, label) {
  if (total > visible) return visible + " of " + total + " " + label;
  return visible + " " + label;
}
function updateBadge(visibleNodeCount, visibleEdgeCount) {
  document.getElementById("badge-text").textContent =
    fmtBadgePart(visibleNodeCount, TOTAL_NODES, "nodes") +
    " / " +
    fmtBadgePart(visibleEdgeCount, TOTAL_EDGES, "edges");
}

// ── Path finding ────────────────────────────────────────────────────────────
// Shortest src→dst path over the directed successors map. BFS, returns
// the ordered node-id sequence or null if no path exists. Pure client-
// side computation on the inlined adjacency — no MCP round-trip.
//
// Path state is stored as a Set of node ids and a Set of edge keys
// (kind|s|t) so the render() pass can paint .path-on classes without
// disturbing the existing focused/cycle/dim state. The pure BFS and
// resolveSymbol live in the VIEWER_PURE_JS block above; these are
// closure-bound wrappers that pass the inlined adjacency.
const pathNodes = new Set();
const pathEdgeKeys = new Set();
function findPath(srcId, dstId) {
  return shortestPath(srcId, dstId, successors, nodeById);
}
function findSymbol(query) {
  return resolveSymbol(query, nodeById);
}
function clearPath() {
  pathNodes.clear();
  pathEdgeKeys.clear();
  document.getElementById("path-status").textContent = "";
  document.getElementById("path-status").className = "";
  render();
}
function findAndShowPath() {
  const fromQ = document.getElementById("path-from").value.trim();
  const toQ = document.getElementById("path-to").value.trim();
  const status = document.getElementById("path-status");
  if (!fromQ || !toQ) {
    status.textContent = "enter both endpoints";
    status.className = "fail";
    return;
  }
  const src = findSymbol(fromQ);
  const dst = findSymbol(toQ);
  if (!src || !dst) {
    status.textContent =
      (!src ? "no match for from" : "no match for to") + " — try a longer query";
    status.className = "fail";
    pathNodes.clear();
    pathEdgeKeys.clear();
    render();
    return;
  }
  const trail = findPath(src, dst);
  if (!trail) {
    status.textContent = "no path found (src → dst)";
    status.className = "fail";
    pathNodes.clear();
    pathEdgeKeys.clear();
    render();
    return;
  }
  pathNodes.clear();
  pathEdgeKeys.clear();
  for (const id of trail) pathNodes.add(id);
  for (let i = 0; i < trail.length - 1; i++) {
    const a = trail[i];
    const b = trail[i + 1];
    // Add for any edge_kind — render() walks all visible links and
    // matches by (kind|src|dst). We don't know which kind connects
    // a→b at this point, so encode all kinds present in this edge.
    const kinds = new Set();
    for (const l of links) {
      const ls = typeof l.source === "object" ? l.source.id : l.source;
      const lt = typeof l.target === "object" ? l.target.id : l.target;
      if (ls === a && lt === b) kinds.add(l.kind);
    }
    for (const k of kinds) pathEdgeKeys.add(k + "|" + a + "|" + b);
  }
  status.textContent =
    "path: " + trail.length + " nodes, " + (trail.length - 1) + " hops";
  status.className = "ok";
  render();
}

// Restore any persisted state from the URL hash before building the
// legends and the first render — so the legends pick up the right
// disabled state and the canvas immediately shows the saved view.
loadHashState();

buildKindLegend();
buildEdgeLegend();
buildHubPanel("top-imported", "imports", new Set(["module"]));
buildHubPanel("top-called", "calls", new Set(["function", "method"]));

// Search: as the user types, highlight EVERY matching node (not
// just the first) and show a count. The first match is also
// auto-focused so the camera lands on something useful immediately.
// The .search-hit class is rendered by render() — toggling it
// requires a re-render, but it's cheap because we don't re-layout.
document.getElementById("search").addEventListener("input", (ev) => {
  const q = ev.target.value.trim().toLowerCase();
  searchMatches.clear();
  const countEl = document.getElementById("search-count");
  if (!q) {
    countEl.textContent = "";
    focused = null;
    applyFocus();
    render();
    saveHashState();
    return;
  }
  // Cap matches at 200 so a one-character query against a huge
  // workspace doesn't paint every node yellow.
  let firstMatch = null;
  for (const n of data.nodes) {
    if (n.id.toLowerCase().includes(q)) {
      if (!firstMatch) firstMatch = n;
      if (searchMatches.size < 200) searchMatches.add(n.id);
    }
  }
  const total = (() => {
    let c = 0;
    for (const n of data.nodes) {
      if (n.id.toLowerCase().includes(q)) c++;
    }
    return c;
  })();
  if (total === 0) {
    countEl.textContent = "no matches";
  } else if (total > searchMatches.size) {
    countEl.textContent = "showing " + searchMatches.size + " of " + total + " matches";
  } else {
    countEl.textContent = total + " match" + (total === 1 ? "" : "es");
  }
  if (firstMatch) {
    focused = firstMatch.id;
    applyFocus();
    showInfo(firstMatch);
  }
  render();
  saveHashState();
});

window.addEventListener("resize", () => {
  sim.force("center", d3.forceCenter(width() / 2, height() / 2));
  sim.alpha(0.3).restart();
});

render();
if (focused) {
  applyFocus();
  const node = nodeById.get(focused);
  if (node) showInfo(node);
}
</script>
</body>
</html>
`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

