/**
 * tui-relation-window/html-viewer/graph-to-html.test.ts
 *
 * Tests the self-contained HTML viewer that consumes intelgraph
 * GraphJson documents. Two layers:
 *
 *   1. graphJsonToHtml smoke + structural assertions on a tiny
 *      synthetic GraphJson — every viewer feature must produce its
 *      expected hooks (string-grep) AND the inlined <script> body
 *      must parse cleanly via `new Function(...)`.
 *
 *   2. VIEWER_PURE_JS unit tests — eval the inlined viewer-runtime
 *      block and call into the pure functions (BFS, shortestPath,
 *      resolveSymbol, hashHue, dirOf, buildVSCodeUrl) with concrete
 *      inputs. This catches regressions in the algorithmic core
 *      without spinning up a JSDOM/d3 sandbox.
 *
 * Mirrors the coverage that lived in
 *   /home/abhi/qprojects/clangd-mcp/test/integration/snapshot-stats-cli.test.ts
 * before the UI code was moved here for separation of concerns.
 */

import { describe, it, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  graphJsonToHtml,
  VIEWER_PURE_JS,
  type GraphJson,
} from "./graph-to-html"

const __dirname = dirname(fileURLToPath(import.meta.url))
const dataStructFixturePath = join(
  __dirname,
  "__fixtures__",
  "data-structure-graph.json",
)

function makeGraph(
  nodeIds: string[],
  edges: Array<{ src: string; dst: string; kind: string }>,
): GraphJson {
  return {
    workspace: "/tmp/x",
    snapshot_id: 1,
    total_nodes: nodeIds.length,
    total_edges: edges.length,
    nodes: nodeIds.map((id) => ({
      id,
      kind: id.includes("#") ? "function" : "module",
      file_path: id.includes("#") ? null : id.replace(/^module:/, ""),
      line: id.includes("#") ? 1 : null,
      end_line: null,
      line_count: null,
      exported: false,
      doc: null,
      owning_class: null,
    })),
    edges: edges.map((e) => ({
      src: e.src,
      dst: e.dst,
      kind: e.kind,
      resolution_kind: null,
      metadata: null,
    })),
  }
}

describe("graphJsonToHtml — structural assertions", () => {
  const fixture = makeGraph(
    [
      "module:src/foo.ts",
      "module:src/bar.ts",
      "module:src/foo.ts#Greeter",
      "module:src/foo.ts#greet",
    ],
    [
      { src: "module:src/bar.ts", dst: "module:src/foo.ts", kind: "imports" },
      { src: "module:src/foo.ts", dst: "module:src/foo.ts#Greeter", kind: "contains" },
      { src: "module:src/foo.ts", dst: "module:src/foo.ts#greet", kind: "contains" },
      { src: "module:src/foo.ts#greet", dst: "module:src/foo.ts#Greeter", kind: "calls" },
    ],
  )

  it("emits a self-contained HTML document", () => {
    const html = graphJsonToHtml(fixture)
    expect(html.startsWith("<!doctype html>")).toBe(true)
    expect(html).toContain("</html>")
    expect(html).toContain("<svg")
    expect(html).toContain("d3.forceSimulation")
    // d3 from a pinned CDN
    expect(html).toContain("d3@7.9.0")
    // Workspace and known fixture name appear
    expect(html).toContain(fixture.workspace)
    expect(html).toContain("Greeter")
  })

  it("inlined script parses as valid JS (template-literal regression guard)", () => {
    const html = graphJsonToHtml(fixture)
    const start = html.indexOf("<script>")
    const end = html.indexOf("</script>", start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const inlined = html.substring(start + "<script>".length, end)
    // Catches the class of bug where a stray backtick inside a comment
    // closes the outer template literal and corrupts the rest of the
    // viewer. Fired twice during development on the intelgraph side.
    expect(() => new Function("document", "window", "d3", inlined)).not.toThrow()
  })

  it("escapes </ in the inlined data block to defend against script-tag injection", () => {
    const html = graphJsonToHtml(fixture)
    const dataMatch = html.match(/const data = (\{[\s\S]*?\});\nconst KIND_COLORS/)
    expect(dataMatch).not.toBeNull()
    expect(dataMatch![1]).not.toContain("</script")
  })

  it("renders all viewer features (string-grep on the rendered HTML)", () => {
    const html = graphJsonToHtml(fixture)

    // Directional arrowheads (one marker per edge_kind plus default + hit)
    expect(html).toContain("ARROW_KINDS")
    expect(html).toContain('"arrow-"')
    expect(html).toContain("marker-end")

    // Multi-hop slider + neighborhood BFS
    expect(html).toContain('id="hop-slider"')
    expect(html).toContain("function neighborhood(rootId, hops, direction, succ, pred)")
    expect(html).toContain("function nbhd(rootId, hops, direction)")

    // Walk direction radios (in/out/both) — paired with the server-side centerDirection
    expect(html).toContain("let walkDirection")
    expect(html).toContain('name="dir"')
    expect(html).toContain('value="both"')
    expect(html).toContain('value="out"')
    expect(html).toContain('value="in"')

    // Cycle highlighting
    expect(html).toContain("cycleNodes")
    expect(html).toContain("cycleEdgeKeys")
    expect(html).toContain('id="cycle-toggle"')
    expect(html).toContain(".link.cycle")

    // Directory tinting
    expect(html).toContain("dirHueByNode")
    expect(html).toContain("function hashHue")
    expect(html).toContain('id="tint-toggle"')

    // URL hash state save + load
    expect(html).toContain("function saveHashState")
    expect(html).toContain("function loadHashState")
    expect(html).toContain("history.replaceState")
    expect(html).toContain("URLSearchParams")

    // Top hubs panels
    expect(html).toContain("function buildHubPanel")
    expect(html).toContain('id="top-imported"')
    expect(html).toContain('id="top-called"')

    // Quick view presets + live stats badge
    expect(html).toContain('id="preset-modules"')
    expect(html).toContain('id="preset-reset"')
    expect(html).toContain("function applyModuleDepView")
    expect(html).toContain('id="badge"')
    expect(html).toContain("function updateBadge")

    // Path-finding wiring
    expect(html).toContain("function shortestPath(srcId, dstId, succ, nodeIds)")
    expect(html).toContain("function findAndShowPath")
    expect(html).toContain('id="path-from"')
    expect(html).toContain('id="path-to"')
    expect(html).toContain(".node.path-on")

    // Live "Center on focused" filter
    expect(html).toContain("let centerSet")
    expect(html).toContain('id="center-on-focused"')
    expect(html).toContain("centerSet && !centerSet.has")

    // Pre-filter totals + "X of Y" badge
    expect(html).toContain("TOTAL_NODES")
    expect(html).toContain("function fmtBadgePart")

    // Caller / callee navigation in info panel
    expect(html).toContain("outEdgesByKind")
    expect(html).toContain("inEdgesByKind")
    expect(html).toContain("function renderNeighborSection")
    expect(html).toContain(".neighbor-row")

    // Help overlay (?)
    expect(html).toContain('id="help-overlay"')
    expect(html).toContain("intelgraph viewer · keyboard")
    expect(html).toContain('ev.key === "?"')

    // Fit view button + f shortcut
    expect(html).toContain('id="fit-button"')
    expect(html).toContain("function fitView")
    expect(html).toContain('ev.key === "f"')

    // Search highlight
    expect(html).toContain("const searchMatches")
    expect(html).toContain(".node.search-hit")
    expect(html).toContain('id="search-count"')

    // "Open in VS Code" link
    expect(html).toContain(".open-link")
    expect(html).toContain('"vscode://file"')
    expect(html).toContain("open in VS Code")

    // Phase 3f: data-structure styling + "Data structure view" preset
    // New kind colors (field, enum_variant) and edge colors
    // (reads_field, writes_field, field_of_type, aggregates)
    expect(html).toContain("field:")
    expect(html).toContain("enum_variant:")
    expect(html).toContain("field_of_type:")
    expect(html).toContain("aggregates:")
    expect(html).toContain("reads_field:")
    expect(html).toContain("writes_field:")
    // Per-edge-kind CSS classes (for the dashed/heavy styling)
    expect(html).toContain(".link.field_of_type")
    expect(html).toContain(".link.writes_field")
    expect(html).toContain(".link.aggregates")
    // The link's class attr now includes d.kind so the CSS hooks fire
    expect(html).toContain('"link " + d.kind')
    // New "Data structure view" preset button + handler
    expect(html).toContain('id="preset-data"')
    expect(html).toContain("function applyDataStructureView")
    // Help overlay mentions the new preset
    expect(html).toContain("Data structure view")

    // "Data flow view" preset (new): method/function/field nodes
    // connected by reads_field/writes_field
    expect(html).toContain('id="preset-flow"')
    expect(html).toContain("function applyDataFlowView")
    expect(html).toContain("Data flow")

    // Field type info panel: when a field is focused, the info
    // panel surfaces the typeExpr + containment from the
    // field_of_type edge metadata. CSS classes wired in.
    expect(html).toContain(".field-type-row")
    expect(html).toContain(".type-expr")
    expect(html).toContain(".containment")
    expect(html).toContain('d.kind === "field"')
  })
})

// ── Phase 3 fixture: data-structure graph (field nodes, enum_variants,
// ── field_of_type with containment, aggregates rollup, reads_field).
// This is the shape intelgraph's ts-core / rust-core extractors emit
// after the c39df7e..b8f09c9 commit chain. Loading a checked-in fixture
// keeps the test fast and decoupled from intelgraph's extraction code,
// while still verifying the viewer correctly renders every Phase 3
// element on a realistic-looking GraphJson.

describe("graphJsonToHtml — Phase 3 data-structure rendering", () => {
  const fixtureJson = readFileSync(dataStructFixturePath, "utf8")
  const fixture = JSON.parse(fixtureJson) as GraphJson

  it("renders a graph that contains field, enum_variant nodes and the new edge kinds", () => {
    // Sanity-check the fixture itself first
    const fields = fixture.nodes.filter((n) => n.kind === "field")
    const variants = fixture.nodes.filter((n) => n.kind === "enum_variant")
    const fotEdges = fixture.edges.filter((e) => e.kind === "field_of_type")
    const aggEdges = fixture.edges.filter((e) => e.kind === "aggregates")
    const readsEdges = fixture.edges.filter((e) => e.kind === "reads_field")
    expect(fields.length).toBe(5)        // 2 User + 3 Box
    expect(variants.length).toBe(2)      // Status.Active + Status.Inactive
    expect(fotEdges.length).toBe(3)      // Box.owner / .members / .fallback
    expect(aggEdges.length).toBe(1)      // Box → User
    expect(readsEdges.length).toBe(1)    // Box.greet → Box.owner

    // Render and verify the inlined data carries the Phase 3 elements.
    // The viewer auto-discovers kinds and edge_kinds from data.nodes
    // and data.edges, so the legends will pick them up.
    const html = graphJsonToHtml(fixture)
    expect(html).toContain("module:src/model.ts#User.id")
    expect(html).toContain("module:src/model.ts#Box.members")
    expect(html).toContain("module:src/model.ts#Status.Active")
    expect(html).toContain("module:src/model.ts#Status.Inactive")

    // Containment metadata flows through to the inlined JSON literal
    expect(html).toContain('"containment":"direct"')
    expect(html).toContain('"containment":"array"')
    expect(html).toContain('"containment":"optional"')
    // typeExpr too — used by the info panel
    expect(html).toContain('"typeExpr":"User[]"')
    expect(html).toContain('"typeExpr":"User | undefined"')

    // The aggregates edge metadata flows through too
    expect(html).toContain('"rolledUpFrom":"field_of_type"')

    // Inlined script must still parse on this richer fixture
    const start = html.indexOf("<script>")
    const end = html.indexOf("</script>", start)
    expect(start).toBeGreaterThan(0)
    const inlined = html.substring(start + "<script>".length, end)
    expect(() =>
      new Function("document", "window", "d3", inlined),
    ).not.toThrow()
  })

  it("VIEWER_PURE_JS resolveSymbol can find a field via the suffix-after-# strategy", () => {
    const fixture2 = JSON.parse(fixtureJson) as GraphJson
    // Reuse the unit-test accessor to grab resolveSymbol from
    // VIEWER_PURE_JS, then run it on real fixture node ids.
    const accessor = `
      ${VIEWER_PURE_JS}
      return { resolveSymbol };
    `
    const fns = new Function(accessor)() as {
      resolveSymbol: (q: string, ids: Set<string>) => string | null
    }
    const ids = new Set(fixture2.nodes.map((n) => n.id))

    // The suffix-after-# strategy resolves "Box.members" to the
    // canonical name without needing the user to type the full path.
    expect(fns.resolveSymbol("Box.members", ids)).toBe(
      "module:src/model.ts#Box.members",
    )
    // Substring fallback finds Status.Active by partial match
    expect(fns.resolveSymbol("Status", ids)).not.toBeNull()
  })

  it("VIEWER_PURE_JS neighborhood walks the new contains/field_of_type edges correctly", () => {
    const fixture3 = JSON.parse(fixtureJson) as GraphJson
    const accessor = `
      ${VIEWER_PURE_JS}
      return { neighborhood };
    `
    const fns = new Function(accessor)() as {
      neighborhood: (
        rootId: string,
        hops: number,
        direction: "in" | "out" | "both",
        succ: Map<string, Set<string>>,
        pred: Map<string, Set<string>>,
      ) => Set<string>
    }
    // Build the same directed adjacency the inlined viewer builds
    const succ = new Map<string, Set<string>>()
    const pred = new Map<string, Set<string>>()
    for (const n of fixture3.nodes) {
      succ.set(n.id, new Set())
      pred.set(n.id, new Set())
    }
    for (const e of fixture3.edges) {
      succ.get(e.src)?.add(e.dst)
      pred.get(e.dst)?.add(e.src)
    }
    // From Box at depth 1 (forward) we should reach: Box itself,
    // its 4 contained members (owner, members, fallback, greet),
    // and User via the aggregates edge.
    const out = fns.neighborhood(
      "module:src/model.ts#Box",
      1,
      "out",
      succ,
      pred,
    )
    expect(out.has("module:src/model.ts#Box")).toBe(true)
    expect(out.has("module:src/model.ts#Box.owner")).toBe(true)
    expect(out.has("module:src/model.ts#Box.members")).toBe(true)
    expect(out.has("module:src/model.ts#Box.fallback")).toBe(true)
    expect(out.has("module:src/model.ts#Box.greet")).toBe(true)
    expect(out.has("module:src/model.ts#User")).toBe(true) // via aggregates
  })

  it("Phase 3h: surfaces the Find data path button + dataSuccessors map", () => {
    // The find_data_path query intent has a viewer-side companion:
    // a dataSuccessors map (field_of_type + aggregates only) and a
    // dedicated button that runs shortestPath() over it. This test
    // pins the names so a future refactor doesn't silently lose
    // the wiring.
    const html = graphJsonToHtml(fixture)
    // The button must exist with the canonical id used by the
    // click binding.
    expect(html).toContain('id="path-find-data"')
    // The dispatch function and adjacency map are inlined.
    expect(html).toContain("function findAndShowDataPath")
    expect(html).toContain("const dataSuccessors")
    // The map is built only from the two data-path edge kinds.
    expect(html).toContain('"field_of_type" || l.kind === "aggregates"')
    // The button is wired to the click handler.
    expect(html).toContain(
      'document.getElementById("path-find-data").addEventListener',
    )
    // The status message is the data-path-specific one (so the
    // user sees "data path: N types" instead of "path: N nodes")
    expect(html).toContain('"data path: "')
    // Inlined script must still parse on the richer fixture.
    const start = html.indexOf("<script>")
    const end = html.indexOf("</script>", start)
    expect(start).toBeGreaterThan(0)
    const inlined = html.substring(start + "<script>".length, end)
    expect(() =>
      new Function("document", "window", "d3", inlined),
    ).not.toThrow()
  })

  it("Phase 3k: type 'Touched by APIs' section is wired into showInfo", () => {
    // The symmetric counterpart to Phase 3j: when the focused node
    // is a class/interface/struct, walk its contained fields and
    // collect every method/function with an incoming reads_field /
    // writes_field edge. Pin the markers so a future refactor
    // doesn't silently lose the wiring.
    const html = graphJsonToHtml(fixture)
    expect(html).toContain(
      '"class" || d.kind === "interface" || d.kind === "struct"',
    )
    expect(html).toContain('"section-title">Touched by APIs')
    // The two-step walk uses contains to find own fields, then
    // reads_field / writes_field to find touching APIs
    expect(html).toContain('"contains"')
    expect(html).toContain('"reads_field"')
    expect(html).toContain('"writes_field"')
    // The R / W / RW collapse for an api that does both
    expect(html).toContain('"RW"')
    // Reuses the data-footprint summary CSS hooks from Phase 3j
    expect(html).toContain("readers: ")
    expect(html).toContain("writers: ")
    // Inlined script must still parse
    const start = html.indexOf("<script>")
    const end = html.indexOf("</script>", start)
    expect(start).toBeGreaterThan(0)
    const inlined = html.substring(start + "<script>".length, end)
    expect(() =>
      new Function("document", "window", "d3", inlined),
    ).not.toThrow()
  })

  it("Phase 3q: Find call path button is wired in (calls-only adjacency)", () => {
    // The strict-call variant of the find_path button. Mirrors
    // Find data path's design — same UI fields, different adjacency
    // map (calls-only instead of field_of_type/aggregates).
    const html = graphJsonToHtml(fixture)
    expect(html).toContain('id="path-find-call"')
    expect(html).toContain("function findAndShowCallPath")
    expect(html).toContain("const callSuccessors")
    expect(html).toContain('"calls"')
    // The button click handler is wired
    expect(html).toContain(
      'document.getElementById("path-find-call").addEventListener',
    )
    // Status message uses the call-path-specific label
    expect(html).toContain('"call path: "')
    // Inlined script must still parse
    const start = html.indexOf("<script>")
    const end = html.indexOf("</script>", start)
    expect(start).toBeGreaterThan(0)
    const inlined = html.substring(start + "<script>".length, end)
    expect(() =>
      new Function("document", "window", "d3", inlined),
    ).not.toThrow()
  })

  it("Phase 3p-frontend: Unused fields panel is wired in", () => {
    // Pure inline computation walking links to find field nodes
    // with no incoming reads_field/writes_field. Pin the markers
    // so a future refactor doesn't lose the wiring.
    const html = graphJsonToHtml(fixture)
    expect(html).toContain('<h2>Unused fields</h2>')
    expect(html).toContain('id="unused-fields"')
    expect(html).toContain("function buildUnusedFieldsPanel")
    expect(html).toContain('buildUnusedFieldsPanel("unused-fields")')
    // The walker checks both edge kinds
    expect(html).toContain('"reads_field" && l.kind !== "writes_field"')
    // Inlined script must still parse — guards against the
    // backtick-in-comment issue we hit on the first pass
    const start = html.indexOf("<script>")
    const end = html.indexOf("</script>", start)
    expect(start).toBeGreaterThan(0)
    const inlined = html.substring(start + "<script>".length, end)
    expect(() =>
      new Function("document", "window", "d3", inlined),
    ).not.toThrow()
  })

  it("Phase 3o-frontend: Top mutators / Top readers hub panels are wired in", () => {
    // Symmetric to Top touched types but from the API side. Pin
    // the markers + the parameterized helper so a future refactor
    // doesn't lose the wiring.
    const html = graphJsonToHtml(fixture)
    expect(html).toContain('<h2>Top mutators</h2>')
    expect(html).toContain('id="top-mutators"')
    expect(html).toContain('<h2>Top readers</h2>')
    expect(html).toContain('id="top-readers"')
    expect(html).toContain("function buildTopFieldAccessorsPanel")
    expect(html).toContain('buildTopFieldAccessorsPanel("top-mutators", "writes_field")')
    expect(html).toContain('buildTopFieldAccessorsPanel("top-readers", "reads_field")')
    // Inlined script must still parse
    const start = html.indexOf("<script>")
    const end = html.indexOf("</script>", start)
    expect(start).toBeGreaterThan(0)
    const inlined = html.substring(start + "<script>".length, end)
    expect(() =>
      new Function("document", "window", "d3", inlined),
    ).not.toThrow()
  })

  it("Phase 3m-frontend: Top touched types panel is wired in", () => {
    // The data-side analog of the Top called functions hub panel.
    // Pin the markers so a future refactor doesn't lose the panel.
    const html = graphJsonToHtml(fixture)
    expect(html).toContain('<h2>Top touched types</h2>')
    expect(html).toContain('id="top-touched"')
    expect(html).toContain("function buildTopTouchedTypesPanel")
    expect(html).toContain('buildTopTouchedTypesPanel("top-touched")')
    // The two-hop walk uses contains then reads_field/writes_field
    expect(html).toContain("parentToFields")
    expect(html).toContain("fieldToParent")
    expect(html).toContain("parentTouchers")
    // Inlined script must still parse
    const start = html.indexOf("<script>")
    const end = html.indexOf("</script>", start)
    expect(start).toBeGreaterThan(0)
    const inlined = html.substring(start + "<script>".length, end)
    expect(() =>
      new Function("document", "window", "d3", inlined),
    ).not.toThrow()
  })

  it("Phase 3l-frontend: transitive data footprint walker is wired in", () => {
    // The Phase 3j data footprint section now also walks calls
    // edges from the focused method up to a bounded depth and
    // collects every reads_field/writes_field from any reachable
    // callee. Pin the markers so the BFS depth + transitive
    // summary line don't get accidentally removed.
    const html = graphJsonToHtml(fixture)
    expect(html).toContain("TRANSITIVE_DATA_FOOTPRINT_DEPTH")
    // The walker uses the existing outEdgesByKind buckets — keyed
    // by edge_kind so it's a fast O(1) lookup per callee.
    expect(html).toContain("buckets.calls")
    expect(html).toContain("calleeBuckets.reads_field")
    expect(html).toContain("calleeBuckets.writes_field")
    // The summary line shows the transitive delta
    expect(html).toContain("data-footprint-transitive")
    expect(html).toContain("via ")
    expect(html).toContain("transitiveReadsExtra")
    expect(html).toContain("transitiveWritesExtra")
    // Inlined script must still parse
    const start = html.indexOf("<script>")
    const end = html.indexOf("</script>", start)
    expect(start).toBeGreaterThan(0)
    const inlined = html.substring(start + "<script>".length, end)
    expect(() =>
      new Function("document", "window", "d3", inlined),
    ).not.toThrow()
  })

  it("Phase 3j: function/method data footprint section is wired into showInfo", () => {
    // The data footprint surfaces reads_field/writes_field outgoing
    // edges in a dedicated section when the focused node is a
    // function or method. This is the API ↔ data join the unified
    // visualization story is built around — pin the markers so a
    // future refactor doesn't silently lose them.
    const html = graphJsonToHtml(fixture)
    // The data-footprint section is conditional on the focused
    // node's kind, so the plumbing has to be inlined as code (not
    // as a static DOM marker).
    expect(html).toContain('"function" || d.kind === "method"')
    expect(html).toContain('"section-title">Data footprint')
    // The reads/writes summary counts pull from the link arrays
    expect(html).toContain('"reads_field"')
    expect(html).toContain('"writes_field"')
    // Per-row CSS hooks
    expect(html).toContain(".data-footprint-summary")
    expect(html).toContain(".data-footprint-reads")
    expect(html).toContain(".data-footprint-writes")
    expect(html).toContain(".data-footprint-group")
    expect(html).toContain(".data-footprint-label")
    // The clickable rows reuse the existing .neighbor-row class so
    // the showInfo click handler picks them up unchanged
    expect(html).toContain('<span class="kind">R</span>')
    expect(html).toContain('<span class="kind">W</span>')
    // Inlined script must still parse
    const start = html.indexOf("<script>")
    const end = html.indexOf("</script>", start)
    expect(start).toBeGreaterThan(0)
    const inlined = html.substring(start + "<script>".length, end)
    expect(() =>
      new Function("document", "window", "d3", inlined),
    ).not.toThrow()
  })

  it("Phase 3h: shortestPath finds a data-path chain when given dataSuccessors", () => {
    // Build dataSuccessors the same way the inlined viewer does and
    // run the pure shortestPath helper from VIEWER_PURE_JS over it.
    // This proves the algorithm + adjacency combination resolves
    // a real chain in the fixture: Box → User via the aggregates
    // edge (the only field_of_type/aggregates chain in the fixture
    // since the field_of_type edges go from field nodes to their
    // declared types).
    const fixture4 = JSON.parse(fixtureJson) as GraphJson
    const accessor = `
      ${VIEWER_PURE_JS}
      return { shortestPath };
    `
    const fns = new Function(accessor)() as {
      shortestPath: (
        srcId: string,
        dstId: string,
        succ: Map<string, Set<string>>,
        nodeIds: Set<string>,
      ) => string[] | null
    }
    const dataSucc = new Map<string, Set<string>>()
    for (const n of fixture4.nodes) dataSucc.set(n.id, new Set())
    for (const e of fixture4.edges) {
      if (e.kind === "field_of_type" || e.kind === "aggregates") {
        dataSucc.get(e.src)?.add(e.dst)
      }
    }
    const ids = new Set(fixture4.nodes.map((n) => n.id))
    // Box has an aggregates edge → User in the fixture
    const trail = fns.shortestPath(
      "module:src/model.ts#Box",
      "module:src/model.ts#User",
      dataSucc,
      ids,
    )
    expect(trail).not.toBeNull()
    expect(trail).toEqual([
      "module:src/model.ts#Box",
      "module:src/model.ts#User",
    ])
    // No path the other way — field_of_type/aggregates is directional
    const reverse = fns.shortestPath(
      "module:src/model.ts#User",
      "module:src/model.ts#Box",
      dataSucc,
      ids,
    )
    expect(reverse).toBeNull()
  })

  it("renders within the size budget for a real-shaped data-structure graph", () => {
    const html = graphJsonToHtml(fixture)
    // 13 nodes + 17 edges with metadata. Reasonable budget: 700KB
    // (most of that is the static viewer template + d3 hooks).
    expect(html.length).toBeLessThan(700_000)
    // And it must be a real document, not a stub
    expect(html.length).toBeGreaterThan(50_000)
  })

  it("inlines the typeExpr metadata so the field type panel can render it on click", () => {
    // The data-structure fixture has Box.members: User[] with
    // typeExpr "User[]" and containment "array". When the user
    // clicks Box.members, the showInfo function reads the
    // field_of_type edge metadata from the inlined `links` array
    // and emits a Type panel. We verify the metadata flows through
    // to the inlined data block (the click-time rendering itself
    // requires a browser, but if the metadata is in the data block
    // and the field-type rendering code is in the script, the two
    // sides connect at runtime).
    const html = graphJsonToHtml(fixture)

    // Metadata in the inlined data block
    expect(html).toContain('"typeExpr":"User[]"')
    expect(html).toContain('"typeExpr":"User"')
    expect(html).toContain('"typeExpr":"User | undefined"')

    // The showInfo function has the field-kind branch that reads
    // links[i].metadata and renders the type panel
    expect(html).toContain('d.kind === "field"')
    expect(html).toContain('link.kind !== "field_of_type"')
    expect(html).toContain('field-type-row')
    expect(html).toContain('type-expr')
    expect(html).toContain('section-title">Type</div>')
  })
})

describe("VIEWER_PURE_JS — pure-function unit tests", () => {
  // Eval the inlined viewer-runtime block once and capture references
  // via a tiny accessor. This catches regressions in the BFS /
  // shortestPath / resolveSymbol logic without a JSDOM sandbox.
  const fns = (() => {
    const accessor = `
      ${VIEWER_PURE_JS}
      return {
        dirOf,
        hashHue,
        neighborhood,
        shortestPath,
        resolveSymbol,
        buildVSCodeUrl,
      };
    `
    return new Function(accessor)() as {
      dirOf: (filePath: string) => string
      hashHue: (s: string) => number
      neighborhood: (
        rootId: string,
        hops: number,
        direction: "in" | "out" | "both",
        succ: Map<string, Set<string>>,
        pred: Map<string, Set<string>>,
      ) => Set<string>
      shortestPath: (
        srcId: string,
        dstId: string,
        succ: Map<string, Set<string>>,
        nodeIds: Set<string>,
      ) => string[] | null
      resolveSymbol: (
        query: string,
        nodeIds: Set<string> | string[],
      ) => string | null
      buildVSCodeUrl: (
        filePath: string | null | undefined,
        workspaceRoot: string | null | undefined,
        line: number | null | undefined,
      ) => string | null
    }
  })()

  describe("dirOf", () => {
    it("returns parent directory for a path", () => {
      expect(fns.dirOf("src/util/format.ts")).toBe("src/util")
    })
    it("returns empty string for path with no slash", () => {
      expect(fns.dirOf("foo.ts")).toBe("")
    })
    it("returns empty string for empty input", () => {
      expect(fns.dirOf("")).toBe("")
    })
  })

  describe("hashHue", () => {
    it("returns a number 0..359", () => {
      const h = fns.hashHue("src/util")
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(360)
    })
    it("is stable across calls", () => {
      expect(fns.hashHue("src/util")).toBe(fns.hashHue("src/util"))
    })
    it("returns different hues for different inputs", () => {
      expect(fns.hashHue("src/util")).not.toBe(fns.hashHue("src/cli"))
    })
  })

  describe("neighborhood", () => {
    // Build a tiny graph:
    //   A → B → C
    //   A → D
    //   E → A
    const succ = new Map<string, Set<string>>([
      ["A", new Set(["B", "D"])],
      ["B", new Set(["C"])],
      ["C", new Set()],
      ["D", new Set()],
      ["E", new Set(["A"])],
    ])
    const pred = new Map<string, Set<string>>([
      ["A", new Set(["E"])],
      ["B", new Set(["A"])],
      ["C", new Set(["B"])],
      ["D", new Set(["A"])],
      ["E", new Set()],
    ])

    it("undirected BFS at hops=1 includes both directions", () => {
      const got = fns.neighborhood("A", 1, "both", succ, pred)
      expect([...got].sort()).toEqual(["A", "B", "D", "E"])
    })
    it("forward-only BFS at hops=1 only walks successors", () => {
      const got = fns.neighborhood("A", 1, "out", succ, pred)
      expect([...got].sort()).toEqual(["A", "B", "D"])
    })
    it("backward-only BFS at hops=1 only walks predecessors", () => {
      const got = fns.neighborhood("A", 1, "in", succ, pred)
      expect([...got].sort()).toEqual(["A", "E"])
    })
    it("forward BFS at hops=2 reaches grandchildren", () => {
      const got = fns.neighborhood("A", 2, "out", succ, pred)
      expect([...got].sort()).toEqual(["A", "B", "C", "D"])
    })
    it("BFS terminates when frontier empties before max hops", () => {
      const got = fns.neighborhood("C", 5, "out", succ, pred)
      expect([...got]).toEqual(["C"])
    })
  })

  describe("shortestPath", () => {
    const ids = new Set(["A", "B", "C", "D"])
    const succ = new Map<string, Set<string>>([
      ["A", new Set(["B", "C"])],
      ["B", new Set(["D"])],
      ["C", new Set(["D"])],
      ["D", new Set()],
    ])

    it("finds the direct path A→B", () => {
      expect(fns.shortestPath("A", "B", succ, ids)).toEqual(["A", "B"])
    })
    it("finds a 2-hop path A→D (via B or C)", () => {
      const path = fns.shortestPath("A", "D", succ, ids)
      expect(path).not.toBeNull()
      expect(path!.length).toBe(3)
      expect(path![0]).toBe("A")
      expect(path![2]).toBe("D")
      expect(["B", "C"]).toContain(path![1])
    })
    it("returns [src] for src===dst", () => {
      expect(fns.shortestPath("A", "A", succ, ids)).toEqual(["A"])
    })
    it("returns null when no path exists (D→A)", () => {
      expect(fns.shortestPath("D", "A", succ, ids)).toBeNull()
    })
    it("returns null when src is unknown", () => {
      expect(fns.shortestPath("Z", "A", succ, ids)).toBeNull()
    })
    it("returns null when dst is unknown", () => {
      expect(fns.shortestPath("A", "Z", succ, ids)).toBeNull()
    })
  })

  describe("resolveSymbol", () => {
    const ids = new Set([
      "module:src/foo.ts",
      "module:src/foo.ts#Greeter",
      "module:src/foo.ts#Greeter.greet",
      "module:src/util.ts#format",
    ])
    it("returns the exact match when present", () => {
      expect(fns.resolveSymbol("module:src/foo.ts#Greeter", ids)).toBe(
        "module:src/foo.ts#Greeter",
      )
    })
    it("returns the suffix-after-# match when no exact match", () => {
      expect(fns.resolveSymbol("Greeter", ids)).toBe("module:src/foo.ts#Greeter")
    })
    it("returns the substring match as a last resort", () => {
      const got = fns.resolveSymbol("format", ids)
      expect(got).toBe("module:src/util.ts#format")
    })
    it("returns null when nothing matches", () => {
      expect(fns.resolveSymbol("totally_made_up_xyz", ids)).toBeNull()
    })
    it("returns null for empty query", () => {
      expect(fns.resolveSymbol("", ids)).toBeNull()
    })
    it("works with an iterable that's not already a Set", () => {
      const arr = [...ids]
      expect(fns.resolveSymbol("Greeter", arr)).toBe("module:src/foo.ts#Greeter")
    })
  })

  describe("buildVSCodeUrl", () => {
    it("returns null when filePath is empty", () => {
      expect(fns.buildVSCodeUrl("", "/ws", 10)).toBeNull()
      expect(fns.buildVSCodeUrl(null, "/ws", 10)).toBeNull()
      expect(fns.buildVSCodeUrl(undefined, "/ws", 10)).toBeNull()
    })
    it("uses absolute filePath verbatim", () => {
      expect(fns.buildVSCodeUrl("/abs/path/foo.ts", "/different/ws", 5)).toBe(
        "vscode://file/abs/path/foo.ts:5",
      )
    })
    it("resolves relative filePath against workspaceRoot", () => {
      expect(fns.buildVSCodeUrl("src/foo.ts", "/ws", 12)).toBe(
        "vscode://file/ws/src/foo.ts:12",
      )
    })
    it("trims trailing slash on workspaceRoot", () => {
      expect(fns.buildVSCodeUrl("src/foo.ts", "/ws/", 12)).toBe(
        "vscode://file/ws/src/foo.ts:12",
      )
    })
    it("omits the line suffix when line is missing", () => {
      expect(fns.buildVSCodeUrl("src/foo.ts", "/ws", null)).toBe(
        "vscode://file/ws/src/foo.ts",
      )
      expect(fns.buildVSCodeUrl("src/foo.ts", "/ws", undefined)).toBe(
        "vscode://file/ws/src/foo.ts",
      )
    })
    it("omits the line suffix for non-positive lines", () => {
      expect(fns.buildVSCodeUrl("src/foo.ts", "/ws", 0)).toBe(
        "vscode://file/ws/src/foo.ts",
      )
      expect(fns.buildVSCodeUrl("src/foo.ts", "/ws", -3)).toBe(
        "vscode://file/ws/src/foo.ts",
      )
    })
    it("handles empty workspaceRoot for an absolute path", () => {
      expect(fns.buildVSCodeUrl("/abs/foo.ts", "", 5)).toBe(
        "vscode://file/abs/foo.ts:5",
      )
    })
  })
})
