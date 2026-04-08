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
import {
  graphJsonToHtml,
  VIEWER_PURE_JS,
  type GraphJson,
} from "./graph-to-html"

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
