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
  /* Phase 3r: health badge — clickable rows when count > 0 */
  #sidebar .health-row { padding: 3px 4px; border-radius: 2px; }
  #sidebar .health-row.has-issues { cursor: pointer; }
  #sidebar .health-row.has-issues:hover { background: var(--panel); }
  #sidebar .health-row.has-issues span:last-child { color: #ff8a65; font-weight: 600; }
  #sidebar .health-row.clean span:last-child { color: #7fc6c0; }
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
  #info .field-type-row {
    margin: 4px 0;
    padding: 4px 6px;
    background: rgba(180, 142, 173, 0.08);
    border-left: 2px solid #b48ead;
    border-radius: 2px;
  }
  #info .field-type-row .type-expr {
    font-family: ui-monospace, "SF Mono", Consolas, monospace;
    font-size: 11px; color: var(--text);
    word-break: break-all;
  }
  #info .field-type-row .containment {
    font-size: 10px; color: var(--muted);
    margin: 2px 0;
  }
  /* Phase 3j: function/method data footprint section */
  #info .data-footprint-summary {
    font-size: 11px;
    color: var(--muted);
    margin: 2px 0 6px 0;
  }
  /* Phase 3l-frontend: secondary summary for transitive reach */
  #info .data-footprint-transitive {
    font-style: italic;
    margin-top: -2px;
  }
  #info .data-footprint-reads { color: #7fc6c0; }
  #info .data-footprint-writes { color: #ff8a65; }
  #info .data-footprint-group {
    margin-top: 4px;
  }
  #info .data-footprint-label {
    font-size: 10px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin: 2px 0;
  }
  #info .data-footprint-more {
    font-size: 10px;
    color: var(--muted);
    margin: 2px 0 2px 12px;
    font-style: italic;
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

    <h2>Health</h2>
    <div class="stat health-row" id="health-call-cycles-row" data-health="call-cycles">
      <span class="label">call cycles</span><span id="health-call-cycles">0</span>
    </div>
    <div class="stat health-row" id="health-struct-cycles-row" data-health="struct-cycles">
      <span class="label">struct cycles</span><span id="health-struct-cycles">0</span>
    </div>
    <div class="stat health-row" id="health-unused-fields-row" data-health="unused-fields">
      <span class="label">unused fields</span><span id="health-unused-fields">0</span>
    </div>
    <div class="stat health-row" id="health-orphan-types-row" data-health="orphan-types">
      <span class="label">untouched types</span><span id="health-orphan-types">0</span>
    </div>
    <div class="stat health-row" id="health-recursive-row" data-health="recursive">
      <span class="label">self-recursive</span><span id="health-recursive">0</span>
    </div>
    <div class="stat health-row" id="health-inline-row" data-health="inline">
      <span class="label">inline candidates</span><span id="health-inline">0</span>
    </div>

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
    <button class="preset" id="preset-flow">Data flow view</button>
    <button class="preset" id="preset-reset">Reset all filters</button>

    <h2>Find path</h2>
    <input id="path-from" type="search" placeholder="from (canonical name)" />
    <input id="path-to" type="search" placeholder="to (canonical name)" />
    <button class="preset" id="path-find">Find shortest path</button>
    <button class="preset" id="path-find-call">Find call path</button>
    <button class="preset" id="path-find-data">Find data path</button>
    <div id="path-status"></div>

    <h2>Top imported modules</h2>
    <div id="top-imported"></div>

    <h2>Top called functions</h2>
    <div id="top-called"></div>

    <h2>Top touched types</h2>
    <div id="top-touched"></div>

    <h2>Top mutators</h2>
    <div id="top-mutators"></div>

    <h2>Top readers</h2>
    <div id="top-readers"></div>

    <h2>Top hot fields</h2>
    <div id="top-hot-fields"></div>

    <h2>Data clumps</h2>
    <div id="data-clumps"></div>

    <h2>Unused fields</h2>
    <div id="unused-fields"></div>

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
        <div class="item"><kbd>presets</kbd><div class="desc">Three quick views: "Module dependency" (module + imports), "Data structure" (struct/class/enum + field/variant via contains/field_of_type/aggregates), "Data flow" (method/function/field via reads_field/writes_field).</div></div>

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
// Phase 3h: data-path-restricted successors. Only field_of_type and
// aggregates edges count, mirroring the find_data_path SQL helper.
// The "Find data path" button uses this map instead of the full
// successors so the path search walks the structural graph (how
// types reach types) rather than the union graph (anything reaches
// anything via any edge kind).
const dataSuccessors = new Map();
for (const n of data.nodes) dataSuccessors.set(n.id, new Set());
for (const l of links) {
  if (l.kind === "field_of_type" || l.kind === "aggregates") {
    dataSuccessors.get(l.source).add(l.target);
  }
}
// Phase 3q: calls-only successors. Sister adjacency map for the
// "Find call path" button. The default Find shortest path uses
// the full union adjacency, which is permissive but can return
// "paths" that hop through imports / contains / references_type —
// not what the user usually means when they say "show me how A
// calls B". This restricted map gives them the strict answer.
const callSuccessors = new Map();
for (const n of data.nodes) callSuccessors.set(n.id, new Set());
for (const l of links) {
  if (l.kind === "calls") {
    callSuccessors.get(l.source).add(l.target);
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

  // Field nodes get a prominent "Type:" badge showing the source
  // type expression (e.g. "Map<string, User>", "Vec<Foo>") plus
  // the resolved containment chain ("map", "vec.option", etc.).
  // Pulled from the field_of_type edge metadata that ts-core /
  // rust-core attach in phases 3a + 3c. Most useful info for a
  // user examining a field — surface it above the neighbor
  // sections instead of burying it in the auto-rendered metadata.
  if (d.kind === "field") {
    const typeRows = [];
    for (const link of links) {
      if (link.kind !== "field_of_type") continue;
      const src = typeof link.source === "object" ? link.source.id : link.source;
      if (src !== d.id) continue;
      const dst = typeof link.target === "object" ? link.target.id : link.target;
      const meta = link.metadata || {};
      typeRows.push({
        target: dst,
        containment: meta.containment || "direct",
        typeExpr: meta.typeExpr || "",
        keyType: meta.keyType || null,
      });
    }
    if (typeRows.length > 0) {
      html += '<div class="section"><div class="section-title">Type</div>';
      for (const tr of typeRows) {
        html +=
          '<div class="field-type-row">' +
          (tr.typeExpr
            ? '<div class="type-expr">' + escapeHtml(tr.typeExpr) + '</div>'
            : "") +
          '<div class="containment">' +
          escapeHtml(tr.containment) +
          (tr.keyType ? ' &middot; key: ' + escapeHtml(tr.keyType) : "") +
          '</div>' +
          '<div class="neighbor-row" data-target="' +
          escapeHtml(tr.target) +
          '">' +
          '<span class="kind">→</span><span class="name">' +
          escapeHtml(shortName(tr.target)) +
          '</span></div>' +
          '</div>';
      }
      html += '</div>';
    }
  }

  // Phase 3k: type "touched by" section. When the focused node is
  // a class/interface/struct, find all the APIs that read or write
  // any of its fields. Symmetric to the function data footprint —
  // answers "which methods touch this type's data" without making
  // the user click each field one at a time. Walks:
  //   1. The class's own contains edges → its fields
  //   2. Each field's incoming reads_field / writes_field edges
  //      → the methods/functions touching it
  // Deduped per (api, op) pair, since a single method can touch
  // multiple fields of the same class.
  if (d.kind === "class" || d.kind === "interface" || d.kind === "struct") {
    const ownFields = new Set();
    for (const link of links) {
      if (link.kind !== "contains") continue;
      const src = typeof link.source === "object" ? link.source.id : link.source;
      if (src !== d.id) continue;
      const dst = typeof link.target === "object" ? link.target.id : link.target;
      const dstNode = nodeById.get(dst);
      if (dstNode && dstNode.kind === "field") ownFields.add(dst);
    }
    if (ownFields.size > 0) {
      // Walk every link looking for reads_field / writes_field edges
      // landing on one of our fields. Map each touching api → which
      // ops it performs ("R", "W", or "RW") so the rendered row
      // collapses the detail.
      const touchingApi = new Map();
      for (const link of links) {
        if (link.kind !== "reads_field" && link.kind !== "writes_field") continue;
        const dst = typeof link.target === "object" ? link.target.id : link.target;
        if (!ownFields.has(dst)) continue;
        const src = typeof link.source === "object" ? link.source.id : link.source;
        const op = link.kind === "reads_field" ? "R" : "W";
        const existing = touchingApi.get(src);
        if (!existing) {
          touchingApi.set(src, op);
        } else if (existing !== op && existing !== "RW") {
          touchingApi.set(src, "RW");
        }
      }
      if (touchingApi.size > 0) {
        let nReaders = 0;
        let nWriters = 0;
        for (const op of touchingApi.values()) {
          if (op === "R" || op === "RW") nReaders++;
          if (op === "W" || op === "RW") nWriters++;
        }
        html += '<div class="section"><div class="section-title">Touched by APIs</div>';
        html +=
          '<div class="data-footprint-summary">' +
          '<span class="data-footprint-reads">readers: ' + nReaders + '</span>' +
          ' &middot; ' +
          '<span class="data-footprint-writes">writers: ' + nWriters + '</span>' +
          '</div>';
        // List up to 8 touching APIs (most types have a small handful)
        const cap = 8;
        const entries = Array.from(touchingApi.entries()).slice(0, cap);
        html += '<div class="data-footprint-group">';
        for (const [api, op] of entries) {
          html +=
            '<div class="neighbor-row" data-target="' +
            escapeHtml(api) +
            '">' +
            '<span class="kind">' + op + '</span>' +
            '<span class="name">' +
            escapeHtml(shortName(api)) +
            '</span></div>';
        }
        if (touchingApi.size > cap) {
          html += '<div class="data-footprint-more">+' + (touchingApi.size - cap) + ' more</div>';
        }
        html += '</div>';
        html += '</div>';
      }
    }
  }

  // Phase 3j: function/method data footprint. When the focused node
  // is an API (function/method), surface its reads_field/writes_field
  // outgoing edges in a dedicated section so the user can see what
  // data the API touches at a glance — instead of scanning the
  // generic "Outgoing" section that mixes calls, contains, etc. and
  // is capped at 6 entries total. This is the API ↔ data join the
  // unified visualization story is built around.
  if (d.kind === "function" || d.kind === "method") {
    const reads = [];
    const writes = [];
    for (const link of links) {
      const src = typeof link.source === "object" ? link.source.id : link.source;
      if (src !== d.id) continue;
      const dst = typeof link.target === "object" ? link.target.id : link.target;
      if (link.kind === "reads_field") reads.push(dst);
      else if (link.kind === "writes_field") writes.push(dst);
    }
    // Phase 3l-frontend: BFS-walk calls edges from the focused
    // method up to TRANSITIVE_DATA_FOOTPRINT_DEPTH hops, then
    // collect every reads_field/writes_field outgoing from any
    // reachable callee. This is the viewer-side companion to the
    // find_api_data_footprint query intent — answers "what does
    // this method ultimately touch via its call chain" without
    // needing a backend round-trip. Bounded depth so the BFS
    // stays cheap on big graphs.
    const TRANSITIVE_DATA_FOOTPRINT_DEPTH = 4;
    const transitiveReads = new Set(reads);
    const transitiveWrites = new Set(writes);
    let reachableCallees = 0;
    {
      const visited = new Set([d.id]);
      let frontier = [d.id];
      for (let hop = 0; hop < TRANSITIVE_DATA_FOOTPRINT_DEPTH; hop++) {
        const next = [];
        for (const id of frontier) {
          const buckets = outEdgesByKind.get(id);
          if (!buckets) continue;
          const callTargets = buckets.calls || [];
          for (const callee of callTargets) {
            if (visited.has(callee)) continue;
            visited.add(callee);
            reachableCallees++;
            next.push(callee);
            // Pull every reads_field / writes_field this callee
            // performs into the transitive sets.
            const calleeBuckets = outEdgesByKind.get(callee);
            if (!calleeBuckets) continue;
            for (const r of calleeBuckets.reads_field || []) transitiveReads.add(r);
            for (const w of calleeBuckets.writes_field || []) transitiveWrites.add(w);
          }
        }
        if (next.length === 0) break;
        frontier = next;
      }
    }
    // The transitive sets are supersets of the direct lists. The
    // "via callees" delta is what came from the BFS walk and not
    // from the focused method's own outgoing edges.
    const transitiveReadsExtra = transitiveReads.size - reads.length;
    const transitiveWritesExtra = transitiveWrites.size - writes.length;

    if (reads.length > 0 || writes.length > 0 || transitiveReadsExtra > 0 || transitiveWritesExtra > 0) {
      html += '<div class="section"><div class="section-title">Data footprint</div>';
      // Render the counts up front so the user has a one-glance summary
      html +=
        '<div class="data-footprint-summary">' +
        '<span class="data-footprint-reads">reads: ' + reads.length + '</span>' +
        ' &middot; ' +
        '<span class="data-footprint-writes">writes: ' + writes.length + '</span>' +
        '</div>';
      // If the call chain reaches more fields than the direct list,
      // surface the delta as a second summary line. This is the
      // value-add of Phase 3l-frontend: the user sees "this method
      // looks small but actually touches 47 fields via its callees"
      // without having to walk the call graph by hand.
      if (transitiveReadsExtra > 0 || transitiveWritesExtra > 0) {
        html +=
          '<div class="data-footprint-summary data-footprint-transitive">' +
          'via ' + reachableCallees + ' callee' + (reachableCallees === 1 ? '' : 's') +
          ': <span class="data-footprint-reads">+' + transitiveReadsExtra + ' reads</span>' +
          ' &middot; ' +
          '<span class="data-footprint-writes">+' + transitiveWritesExtra + ' writes</span>' +
          '</div>';
      }
      // Render up to 6 reads + 6 writes as clickable rows
      const cap = 6;
      if (reads.length > 0) {
        html += '<div class="data-footprint-group">';
        html += '<div class="data-footprint-label">reads</div>';
        for (const target of reads.slice(0, cap)) {
          html +=
            '<div class="neighbor-row" data-target="' +
            escapeHtml(target) +
            '">' +
            '<span class="kind">R</span>' +
            '<span class="name">' +
            escapeHtml(shortName(target)) +
            '</span></div>';
        }
        if (reads.length > cap) {
          html += '<div class="data-footprint-more">+' + (reads.length - cap) + ' more</div>';
        }
        html += '</div>';
      }
      if (writes.length > 0) {
        html += '<div class="data-footprint-group">';
        html += '<div class="data-footprint-label">writes</div>';
        for (const target of writes.slice(0, cap)) {
          html +=
            '<div class="neighbor-row" data-target="' +
            escapeHtml(target) +
            '">' +
            '<span class="kind">W</span>' +
            '<span class="name">' +
            escapeHtml(shortName(target)) +
            '</span></div>';
        }
        if (writes.length > cap) {
          html += '<div class="data-footprint-more">+' + (writes.length - cap) + ' more</div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
  }

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

// Phase 3p-frontend: viewer-side companion to find_unused_fields.
// Walks every field node in the inlined data and looks for any
// incoming reads_field / writes_field edge. The fields with NO
// such incoming edges are dead state — refactor candidates the
// user should see at a glance. Pure inline computation; no
// backend round-trip.
function buildUnusedFieldsPanel(containerId) {
  // Collect every field id with at least one incoming touch
  const touched = new Set();
  for (const l of links) {
    if (l.kind !== "reads_field" && l.kind !== "writes_field") continue;
    const dst = typeof l.target === "object" ? l.target.id : l.target;
    touched.add(dst);
  }
  // Now find every field node not in the touched set
  const unused = [];
  for (const n of data.nodes) {
    if (n.kind !== "field") continue;
    if (touched.has(n.id)) continue;
    unused.push(n);
  }
  // Sort by id for deterministic ordering
  unused.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const top = unused.slice(0, 8);
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  if (top.length === 0) {
    container.innerHTML = '<div class="hub-row" style="cursor:default"><div class="name" style="color:var(--muted);font-style:italic">none</div></div>';
    return;
  }
  for (const node of top) {
    const row = document.createElement("div");
    row.className = "hub-row";
    row.title = node.id;
    // The deg column shows the dead-state count (0) explicitly so
    // the user can tell at a glance these have no touchers, not
    // that the count is missing. Total dead count is in the title.
    row.innerHTML =
      '<div class="deg">0</div>' +
      '<div class="name">' + escapeHtml(shortName(node.id)) + '</div>';
    row.onclick = () => {
      focused = node.id;
      applyFocus();
      showInfo(node);
      saveHashState();
    };
    container.appendChild(row);
  }
  // If there are more than the cap, append a "+N more" indicator
  if (unused.length > top.length) {
    const more = document.createElement("div");
    more.className = "hub-row";
    more.style.cursor = "default";
    more.innerHTML =
      '<div class="name" style="color:var(--muted);font-style:italic">+' +
      (unused.length - top.length) + ' more</div>';
    container.appendChild(more);
  }
}

// Phase 3t-frontend: viewer-side companion to find_top_hot_fields.
// Field-level granularity sibling of buildTopTouchedTypesPanel.
// Counts distinct method touchers per individual field via
// reads_field/writes_field edges and renders the top 8. Each row
// shows the toucher count plus a R/W breakdown so the user can
// tell read-mostly hot spots apart from write-heavy ones.
function buildTopHotFieldsPanel(containerId) {
  // Build field → Set<touching method id> AND r/w counts
  const fieldTouchers = new Map();
  const fieldReadCounts = new Map();
  const fieldWriteCounts = new Map();
  for (const l of links) {
    if (l.kind !== "reads_field" && l.kind !== "writes_field") continue;
    const dst = typeof l.target === "object" ? l.target.id : l.target;
    const src = typeof l.source === "object" ? l.source.id : l.source;
    let set = fieldTouchers.get(dst);
    if (!set) {
      set = new Set();
      fieldTouchers.set(dst, set);
    }
    set.add(src);
    if (l.kind === "reads_field") {
      fieldReadCounts.set(dst, (fieldReadCounts.get(dst) || 0) + 1);
    } else {
      fieldWriteCounts.set(dst, (fieldWriteCounts.get(dst) || 0) + 1);
    }
  }
  const ranked = [];
  for (const [id, touchers] of fieldTouchers) {
    const node = nodeById.get(id);
    if (!node) continue;
    if (node.kind !== "field") continue;
    ranked.push({
      id,
      count: touchers.size,
      reads: fieldReadCounts.get(id) || 0,
      writes: fieldWriteCounts.get(id) || 0,
      node,
    });
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
    row.title = hub.id + " — " + hub.reads + " reads, " + hub.writes + " writes";
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

// Phase 3v-frontend: data clumps panel. Pure-inline data-clump
// detector — finds field pairs that are touched together by the
// same method, ranked by co-occurrence count. Surfaces refactor
// candidates for sub-object extraction.
//
// Algorithm:
//   1. Build src → Set<field id> map of every method's touched
//      fields (reads_field/writes_field union)
//   2. For every method that touches >= 2 fields, generate every
//      pair (a, b) with a < b
//   3. For each pair, count distinct methods that hit it
//   4. Restrict to pairs whose fields share the same parent class
//      via contains edges (cross-class pairs aren't clumps —
//      that's just a method bridging two types)
//   5. Render top 8 pairs ranked by co_occurrence
function buildDataClumpsPanel(containerId) {
  // Step 1: build src method → set of touched field ids
  const methodFields = new Map();
  for (const l of links) {
    if (l.kind !== "reads_field" && l.kind !== "writes_field") continue;
    const src = typeof l.source === "object" ? l.source.id : l.source;
    const dst = typeof l.target === "object" ? l.target.id : l.target;
    let set = methodFields.get(src);
    if (!set) {
      set = new Set();
      methodFields.set(src, set);
    }
    set.add(dst);
  }
  // Step 2: build field → parent class via contains edges
  const fieldToParent = new Map();
  for (const l of links) {
    if (l.kind !== "contains") continue;
    const src = typeof l.source === "object" ? l.source.id : l.source;
    const dst = typeof l.target === "object" ? l.target.id : l.target;
    const dstNode = nodeById.get(dst);
    if (dstNode && dstNode.kind === "field") {
      fieldToParent.set(dst, src);
    }
  }
  // Step 3: count co-occurrences per pair (same parent only)
  const pairCounts = new Map();
  for (const fields of methodFields.values()) {
    if (fields.size < 2) continue;
    const arr = Array.from(fields).sort();
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      const pa = fieldToParent.get(a);
      if (!pa) continue;
      for (let j = i + 1; j < arr.length; j++) {
        const b = arr[j];
        const pb = fieldToParent.get(b);
        if (pb !== pa) continue;
        const key = a + "|" + b;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
  }
  // Step 4: rank
  const ranked = [];
  for (const [key, count] of pairCounts) {
    if (count < 2) continue; // only show actual clumps
    const sep = key.indexOf("|");
    const a = key.substring(0, sep);
    const b = key.substring(sep + 1);
    ranked.push({ a, b, count });
  }
  ranked.sort((x, y) => y.count - x.count);
  const top = ranked.slice(0, 8);
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  if (top.length === 0) {
    container.innerHTML = '<div class="hub-row" style="cursor:default"><div class="name" style="color:var(--muted);font-style:italic">none</div></div>';
    return;
  }
  for (const clump of top) {
    const row = document.createElement("div");
    row.className = "hub-row";
    row.title = clump.a + " ↔ " + clump.b;
    // Render the pair as "a ↔ b" with shortName collapse
    row.innerHTML =
      '<div class="deg">' + clump.count + '</div>' +
      '<div class="name">' +
      escapeHtml(shortName(clump.a)) + ' ↔ ' + escapeHtml(shortName(clump.b)) +
      '</div>';
    row.onclick = () => {
      // Click jumps focus to the first field of the pair
      if (nodeById.has(clump.a)) {
        focused = clump.a;
        applyFocus();
        showInfo(nodeById.get(clump.a));
        saveHashState();
      }
    };
    container.appendChild(row);
  }
}

// Phase 3r: health badge. Computes aggregate red-flag counts inline
// from the loaded graph and renders them as a sticky stats block at
// the top of the sidebar. Lets the user open a fresh workspace and
// immediately see if it has any of the red-flag patterns the
// individual MCP queries detect.
//
// Computes:
//   - call_cycles:    pairs of methods that mutually call each other
//                     (mirrors find_call_cycles)
//   - struct_cycles:  pairs of types that mutually contain each
//                     other via aggregates (mirrors find_struct_cycles)
//   - unused_fields:  field nodes with no incoming reads_field /
//                     writes_field (mirrors find_unused_fields)
//   - orphan_types:   class/struct/interface nodes whose contained
//                     fields receive zero touches AND nothing
//                     references_type the type itself (a softer
//                     "untouched type" signal)
//
// Each row has a clickable jump-to-first-instance handler when the
// count is > 0. Rows with count = 0 render in green to give a clean
// codebase a positive signal.
function buildHealthBadge() {
  // Step 1: call cycles. Find any (a, b) where a calls b and b
  // calls a; emit one row per pair (canonical_name < other).
  const callPairs = new Set();
  const callCycleNodes = [];
  {
    const callsBetween = new Set();
    for (const l of links) {
      if (l.kind !== "calls") continue;
      const s = typeof l.source === "object" ? l.source.id : l.source;
      const t = typeof l.target === "object" ? l.target.id : l.target;
      callsBetween.add(s + "->" + t);
    }
    for (const l of links) {
      if (l.kind !== "calls") continue;
      const s = typeof l.source === "object" ? l.source.id : l.source;
      const t = typeof l.target === "object" ? l.target.id : l.target;
      if (s >= t) continue; // canonical ordering, skip dupes
      if (callsBetween.has(t + "->" + s)) {
        const key = s + "|" + t;
        if (!callPairs.has(key)) {
          callPairs.add(key);
          const sNode = nodeById.get(s);
          const tNode = nodeById.get(t);
          if (sNode && tNode) {
            const sIsApi = sNode.kind === "function" || sNode.kind === "method";
            const tIsApi = tNode.kind === "function" || tNode.kind === "method";
            if (sIsApi && tIsApi) callCycleNodes.push(s);
          }
        }
      }
    }
  }

  // Step 2: struct cycles via aggregates edges
  const structPairs = new Set();
  const structCycleNodes = [];
  {
    const aggBetween = new Set();
    for (const l of links) {
      if (l.kind !== "aggregates") continue;
      const s = typeof l.source === "object" ? l.source.id : l.source;
      const t = typeof l.target === "object" ? l.target.id : l.target;
      aggBetween.add(s + "->" + t);
    }
    for (const l of links) {
      if (l.kind !== "aggregates") continue;
      const s = typeof l.source === "object" ? l.source.id : l.source;
      const t = typeof l.target === "object" ? l.target.id : l.target;
      if (s >= t) continue;
      if (aggBetween.has(t + "->" + s)) {
        const key = s + "|" + t;
        if (!structPairs.has(key)) {
          structPairs.add(key);
          const sNode = nodeById.get(s);
          const tNode = nodeById.get(t);
          if (sNode && tNode) {
            const isType = (k) => k === "struct" || k === "class" || k === "interface";
            if (isType(sNode.kind) && isType(tNode.kind)) {
              structCycleNodes.push(s);
            }
          }
        }
      }
    }
  }

  // Step 3: unused fields (reuses Phase 3p-frontend's logic inline)
  const touchedFields = new Set();
  for (const l of links) {
    if (l.kind !== "reads_field" && l.kind !== "writes_field") continue;
    const dst = typeof l.target === "object" ? l.target.id : l.target;
    touchedFields.add(dst);
  }
  const unusedFieldNodes = [];
  for (const n of data.nodes) {
    if (n.kind === "field" && !touchedFields.has(n.id)) {
      unusedFieldNodes.push(n.id);
    }
  }

  // Step 4: orphan types — class/struct/interface with NO incoming
  // references_type, NO field with any toucher, and NO incoming
  // aggregates. Picks types that appear "marooned" in the graph.
  const refTargets = new Set();
  for (const l of links) {
    if (l.kind === "references_type" || l.kind === "aggregates") {
      const t = typeof l.target === "object" ? l.target.id : l.target;
      refTargets.add(t);
    }
  }
  // Build parent → fields map (one walk through links)
  const parentFields = new Map();
  for (const l of links) {
    if (l.kind !== "contains") continue;
    const s = typeof l.source === "object" ? l.source.id : l.source;
    const t = typeof l.target === "object" ? l.target.id : l.target;
    const tNode = nodeById.get(t);
    if (!tNode || tNode.kind !== "field") continue;
    let set = parentFields.get(s);
    if (!set) {
      set = new Set();
      parentFields.set(s, set);
    }
    set.add(t);
  }
  const orphanTypeNodes = [];
  for (const n of data.nodes) {
    if (n.kind !== "class" && n.kind !== "struct" && n.kind !== "interface") continue;
    if (refTargets.has(n.id)) continue;
    const fields = parentFields.get(n.id);
    if (fields) {
      let anyTouched = false;
      for (const f of fields) {
        if (touchedFields.has(f)) { anyTouched = true; break; }
      }
      if (anyTouched) continue;
    }
    orphanTypeNodes.push(n.id);
  }

  // Step 5: self-recursive methods (Phase 3x). Walk every calls
  // edge looking for src == dst on a function/method node.
  const recursiveNodes = [];
  {
    const seen = new Set();
    for (const l of links) {
      if (l.kind !== "calls") continue;
      const s = typeof l.source === "object" ? l.source.id : l.source;
      const t = typeof l.target === "object" ? l.target.id : l.target;
      if (s !== t) continue;
      if (seen.has(s)) continue;
      const node = nodeById.get(s);
      if (!node) continue;
      if (node.kind !== "function" && node.kind !== "method") continue;
      seen.add(s);
      recursiveNodes.push(s);
    }
  }

  // Step 6: inline candidates (Phase 3w). Methods called by exactly
  // one OTHER method (excluding self-recursion). The walker counts
  // distinct callers per callee, then keeps callees with exactly 1.
  const inlineCandidateNodes = [];
  {
    // callee → Set of caller ids (excluding self-calls)
    const callersOf = new Map();
    for (const l of links) {
      if (l.kind !== "calls") continue;
      const s = typeof l.source === "object" ? l.source.id : l.source;
      const t = typeof l.target === "object" ? l.target.id : l.target;
      if (s === t) continue;
      const callerNode = nodeById.get(s);
      const calleeNode = nodeById.get(t);
      if (!callerNode || !calleeNode) continue;
      if (callerNode.kind !== "function" && callerNode.kind !== "method") continue;
      if (calleeNode.kind !== "function" && calleeNode.kind !== "method") continue;
      let set = callersOf.get(t);
      if (!set) {
        set = new Set();
        callersOf.set(t, set);
      }
      set.add(s);
    }
    for (const [callee, callers] of callersOf) {
      if (callers.size === 1) inlineCandidateNodes.push(callee);
    }
  }

  // Render each row, wiring a click handler that focuses the first
  // instance when the count is > 0. The optional fourth arg
  // enableCycles flips the global cycles overlay on so the user
  // immediately SEES the cycle in the rendered graph instead of
  // just jumping to a node and wondering where the rest is.
  const renderRow = (rowId, valueId, nodes, enableCycles) => {
    const row = document.getElementById(rowId);
    const valueEl = document.getElementById(valueId);
    if (!row || !valueEl) return;
    valueEl.textContent = String(nodes.length);
    if (nodes.length > 0) {
      row.classList.add("has-issues");
      row.classList.remove("clean");
      row.onclick = () => {
        if (enableCycles && !cyclesOn) {
          cyclesOn = true;
          const ct = document.getElementById("cycle-toggle");
          if (ct) ct.classList.remove("disabled");
        }
        const firstId = nodes[0];
        if (nodeById.has(firstId)) {
          focused = firstId;
          applyFocus();
          showInfo(nodeById.get(firstId));
          saveHashState();
        } else if (enableCycles) {
          // Cycle row with no resolvable first node — still
          // re-render so the overlay flips on
          render();
          saveHashState();
        }
      };
    } else {
      row.classList.add("clean");
      row.classList.remove("has-issues");
      row.onclick = null;
    }
  };
  renderRow("health-call-cycles-row", "health-call-cycles", callCycleNodes, true);
  renderRow("health-struct-cycles-row", "health-struct-cycles", structCycleNodes, true);
  renderRow("health-unused-fields-row", "health-unused-fields", unusedFieldNodes, false);
  renderRow("health-orphan-types-row", "health-orphan-types", orphanTypeNodes, false);
  renderRow("health-recursive-row", "health-recursive", recursiveNodes, false);
  renderRow("health-inline-row", "health-inline", inlineCandidateNodes, false);
}

// Phase 3o-frontend: viewer-side companion to find_top_field_writers
// and find_top_field_readers. Counts DISTINCT field targets per
// source method via the supplied edge_kind. Symmetric to the
// existing Top called functions list, but for field-mutation
// (writes_field) or field-consumption (reads_field) instead of
// calls. Surfaces the methods doing the most state mutation /
// reading.
function buildTopFieldAccessorsPanel(containerId, edgeKind) {
  const accessors = new Map(); // src → Set of distinct field targets
  for (const l of links) {
    if (l.kind !== edgeKind) continue;
    const src = typeof l.source === "object" ? l.source.id : l.source;
    const dst = typeof l.target === "object" ? l.target.id : l.target;
    const node = nodeById.get(src);
    if (!node) continue;
    if (node.kind !== "function" && node.kind !== "method") continue;
    let set = accessors.get(src);
    if (!set) {
      set = new Set();
      accessors.set(src, set);
    }
    set.add(dst);
  }
  const ranked = [];
  for (const [id, fields] of accessors) {
    const node = nodeById.get(id);
    if (!node) continue;
    ranked.push({ id, count: fields.size, node });
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

// Phase 3m-frontend: viewer-side companion to find_top_touched_types.
// Two-hop walk: for each (class/struct/interface, field) pair via
// contains, count DISTINCT sources of reads_field/writes_field
// landing on any of that parent's fields. Each touching API counts
// once per parent. The result is the data-side analog of the
// "Top called functions" hub list — surfaces "the central pieces
// of state" that the codebase actually revolves around.
function buildTopTouchedTypesPanel(containerId) {
  // Step 1: build a parent → set of field ids map via contains edges
  const parentToFields = new Map();
  for (const l of links) {
    if (l.kind !== "contains") continue;
    const parent = nodeById.get(l.source);
    const child = nodeById.get(l.target);
    if (!parent || !child) continue;
    if (parent.kind !== "class" && parent.kind !== "struct" && parent.kind !== "interface") continue;
    if (child.kind !== "field") continue;
    let set = parentToFields.get(l.source);
    if (!set) {
      set = new Set();
      parentToFields.set(l.source, set);
    }
    set.add(l.target);
  }

  // Step 2: walk reads_field/writes_field edges, group touchers by parent
  // (the source of the access edge is the touching API; the target's
  // owning class is the parent we're counting toward).
  const fieldToParent = new Map();
  for (const [parent, fields] of parentToFields) {
    for (const f of fields) fieldToParent.set(f, parent);
  }
  const parentTouchers = new Map();
  for (const l of links) {
    if (l.kind !== "reads_field" && l.kind !== "writes_field") continue;
    const parent = fieldToParent.get(l.target);
    if (!parent) continue;
    let set = parentTouchers.get(parent);
    if (!set) {
      set = new Set();
      parentTouchers.set(parent, set);
    }
    set.add(l.source);
  }

  // Step 3: rank by toucher count desc and render the top 8
  const ranked = [];
  for (const [id, touchers] of parentTouchers) {
    const node = nodeById.get(id);
    if (!node) continue;
    ranked.push({ id, count: touchers.size, node });
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
function applyDataFlowView() {
  // Show methods + functions + fields, connected by reads_field +
  // writes_field. Answers "what data does each API touch and how"
  // visually — the dual of "Data structure view" which shows the
  // type relationships rather than the access patterns.
  activeKinds.clear();
  for (const k of ["method", "function", "field"]) {
    activeKinds.add(k);
  }
  activeEdgeKinds.clear();
  for (const k of ["reads_field", "writes_field", "contains"]) {
    activeEdgeKinds.add(k);
  }
  buildKindLegend();
  buildEdgeLegend();
  render();
  saveHashState();
}
document.getElementById("preset-modules").addEventListener("click", applyModuleDepView);
document.getElementById("preset-data").addEventListener("click", applyDataStructureView);
document.getElementById("preset-flow").addEventListener("click", applyDataFlowView);
document.getElementById("preset-reset").addEventListener("click", applyResetView);

// Path-finding wiring: button click + Enter-key in either input.
document.getElementById("path-find").addEventListener("click", findAndShowPath);
document.getElementById("path-find-call").addEventListener("click", findAndShowCallPath);
document.getElementById("path-find-data").addEventListener("click", findAndShowDataPath);
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

// Phase 3q: calls-only path search. Sister of findAndShowDataPath.
// The default Find shortest path uses the full union adjacency,
// which is permissive but can return paths that hop through
// imports / contains / references_type — not what the user
// usually means when they say "show me how A calls B". This
// strict variant walks the calls-only adjacency so the answer is
// the literal call chain. Mirrors find_call_chain on the backend.
function findAndShowCallPath() {
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
  // Use the calls-only adjacency so the BFS walks only calls
  // edges. The pure helper is the same shortestPath() — different
  // adjacency map is the only thing that changes (matches the
  // Phase 3h pattern).
  const trail = shortestPath(src, dst, callSuccessors, nodeById);
  if (!trail) {
    status.textContent = "no call path found (no chain of calls edges)";
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
    // Only encode the calls edge between this pair
    for (const l of links) {
      const ls = typeof l.source === "object" ? l.source.id : l.source;
      const lt = typeof l.target === "object" ? l.target.id : l.target;
      if (ls === a && lt === b && l.kind === "calls") {
        pathEdgeKeys.add(l.kind + "|" + a + "|" + b);
      }
    }
  }
  status.textContent =
    "call path: " + trail.length + " methods, " + (trail.length - 1) + " hops";
  status.className = "ok";
  render();
}

// Phase 3h: data-path search. Same UI as findAndShowPath but walks
// the dataSuccessors map (field_of_type + aggregates only) so the
// BFS resolves "how does Container structurally reach User" rather
// than "is there any chain of any edge kind from A to B". Mirrors
// the find_data_path query intent and the snapshot-stats
// --data-path-from / --data-path-to CLI flags.
function findAndShowDataPath() {
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
  // Use the data-restricted successors so the BFS only walks
  // field_of_type / aggregates edges. The pure helper is the same
  // shortestPath() from VIEWER_PURE_JS — different adjacency map
  // is the only thing that changes.
  const trail = shortestPath(src, dst, dataSuccessors, nodeById);
  if (!trail) {
    status.textContent =
      "no data path found (no field_of_type / aggregates chain)";
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
    // Only encode field_of_type / aggregates edges between this
    // pair — render() walks links and matches by (kind|src|dst).
    for (const l of links) {
      const ls = typeof l.source === "object" ? l.source.id : l.source;
      const lt = typeof l.target === "object" ? l.target.id : l.target;
      if (
        ls === a &&
        lt === b &&
        (l.kind === "field_of_type" || l.kind === "aggregates")
      ) {
        pathEdgeKeys.add(l.kind + "|" + a + "|" + b);
      }
    }
  }
  status.textContent =
    "data path: " + trail.length + " types, " + (trail.length - 1) + " hops";
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
buildTopTouchedTypesPanel("top-touched");
buildTopFieldAccessorsPanel("top-mutators", "writes_field");
buildTopFieldAccessorsPanel("top-readers", "reads_field");
buildTopHotFieldsPanel("top-hot-fields");
buildDataClumpsPanel("data-clumps");
buildUnusedFieldsPanel("unused-fields");
buildHealthBadge();

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

