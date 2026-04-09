/**
 * tui-relation-window/html-viewer/real-workspaces.test.ts
 *
 * Real-workspace integration test for the viewer pipeline. Spawns
 * the intelgraph snapshot-stats CLI to produce GraphJson on real
 * codebases, pipes it into render.ts, and asserts the rendered HTML
 * is well-formed end-to-end.
 *
 * Targets (skipped cleanly when missing):
 *   - /home/abhi/qprojects/opencode/packages/opencode (TS, ~700 files)
 *   - /home/abhi/qprojects/openclaude     (TS, ~1900 files)
 *   - /home/abhi/qprojects/markdown-oxide             (Rust, ~67 files)
 *
 * The intelgraph CLI is also gated — if /home/abhi/qprojects/intelgraph
 * isn't on the host (e.g. in CI), the entire suite skips. The two
 * repos are intentionally decoupled, so this test only runs in the
 * developer environment that has both checked out.
 *
 * What this catches that the unit + fixture tests don't:
 *   - Real canonical names with weird characters (URL-like paths,
 *     dots, hashes, lifetimes in Rust)
 *   - Real graph density (5K-20K nodes after extraction)
 *   - Real edge_kind distribution (the hand-written fixture only
 *     has 17 edges; real workspaces have 100K+)
 *   - The maxNodes truncation pipeline at production scale
 *   - The full intelgraph → render.ts subprocess chain that the
 *     user actually runs
 */

import { describe, it, expect } from "bun:test"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const renderScript = join(__dirname, "render.ts")
const INTELGRAPH_DIR = "/home/abhi/qprojects/intelgraph"
const SNAPSHOT_STATS = join(INTELGRAPH_DIR, "src/bin/snapshot-stats.ts")

const HAVE_INTELGRAPH = existsSync(SNAPSHOT_STATS)

interface WorkspaceCase {
  name: string
  path: string
  /** A canonical-name substring expected to appear in the rendered HTML. */
  expectedSubstring: string
  /** Cap nodes for the test pipeline so HTML stays bounded. */
  maxNodes: number
}

const CASES: WorkspaceCase[] = [
  {
    name: "opencode/packages/opencode",
    path: "/home/abhi/qprojects/opencode/packages/opencode",
    expectedSubstring: "src/",
    maxNodes: 200,
  },
  {
    name: "openclaude",
    path: "/home/abhi/qprojects/openclaude",
    expectedSubstring: "src/",
    maxNodes: 200,
  },
  {
    name: "markdown-oxide",
    path: "/home/abhi/qprojects/markdown-oxide",
    expectedSubstring: ".rs",
    maxNodes: 200,
  },
]

async function runPipeline(
  workspace: string,
  maxNodes: number,
): Promise<{
  graphJsonBytes: number
  htmlBytes: number
  html: string
  exitCode: number
}> {
  // Step 1: spawn intelgraph snapshot-stats and capture graph-json
  const ingest = Bun.spawn(
    [
      "npx",
      "tsx",
      SNAPSHOT_STATS,
      workspace,
      "--graph-json",
      `--max-nodes=${maxNodes}`,
    ],
    {
      cwd: INTELGRAPH_DIR,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const graphJson = await new Response(ingest.stdout).text()
  await ingest.exited

  // Step 2: pipe the graph-json into render.ts
  const renderProc = Bun.spawn(["bun", "run", renderScript], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  renderProc.stdin.write(graphJson)
  await renderProc.stdin.end()
  const html = await new Response(renderProc.stdout).text()
  const exitCode = await renderProc.exited

  return {
    graphJsonBytes: graphJson.length,
    htmlBytes: html.length,
    html,
    exitCode,
  }
}

for (const wcase of CASES) {
  const skip = !HAVE_INTELGRAPH || !existsSync(wcase.path)

  describe.skipIf(skip)(
    `viewer pipeline — ${wcase.name}`,
    () => {
      it(
        "intelgraph snapshot-stats → render.ts produces valid HTML",
        async () => {
          const result = await runPipeline(wcase.path, wcase.maxNodes)

          // The render subprocess must have succeeded
          expect(result.exitCode).toBe(0)

          // Both stages produced something nontrivial
          expect(result.graphJsonBytes).toBeGreaterThan(1000)
          expect(result.htmlBytes).toBeGreaterThan(50_000)
          // And nothing crazy — even a 200-node graph stays under
          // ~600 KB of HTML thanks to the static template + the
          // truncated data block
          expect(result.htmlBytes).toBeLessThan(800_000)

          // Document is well-formed
          expect(result.html.startsWith("<!doctype html>")).toBe(true)
          expect(result.html).toContain("</html>")
          // Workspace path appears (echoed via data.workspace)
          expect(result.html).toContain(wcase.path)
          // The expected substring (e.g. "src/") shows up in the
          // inlined node ids
          expect(result.html).toContain(wcase.expectedSubstring)
        },
        180_000,
      )

      it(
        "rendered HTML carries the new Phase 3 viewer features",
        async () => {
          const { html } = await runPipeline(wcase.path, wcase.maxNodes)

          // The three quick-view presets are present
          expect(html).toContain('id="preset-modules"')
          expect(html).toContain('id="preset-data"')
          expect(html).toContain('id="preset-flow"')

          // The field type panel hooks (CSS classes + d.kind branch)
          expect(html).toContain(".field-type-row")
          expect(html).toContain('d.kind === "field"')

          // The new edge kinds get auto-discovered colors (the kind
          // legend is built at runtime, but the color tables are
          // inlined and we can grep them).
          expect(html).toContain("field_of_type:")
          expect(html).toContain("aggregates:")

          // Inlined script must parse — the ultimate regression
          // guard against template-literal corruption from rogue
          // canonical names in the real workspace.
          const start = html.indexOf("<script>")
          const end = html.indexOf("</script>", start)
          expect(start).toBeGreaterThan(0)
          const inlined = html.substring(start + "<script>".length, end)
          expect(() =>
            new Function("document", "window", "d3", inlined),
          ).not.toThrow()
        },
        180_000,
      )
    },
  )
}
