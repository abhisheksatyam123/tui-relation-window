/**
 * tui-relation-window/html-viewer/render.test.ts
 *
 * Tests the CLI bridge that pipes a GraphJson document on stdin into
 * the rendered HTML viewer on stdout. Spawned as a real subprocess
 * via Bun.spawn so the stdin/stdout/exit-code contract is exercised
 * the same way the user's shell pipeline does.
 */

import { describe, it, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const renderScript = join(__dirname, "render.ts")
const fixturePath = join(
  __dirname,
  "__fixtures__",
  "data-structure-graph.json",
)

async function runRender(stdin: string): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  const proc = Bun.spawn(["bun", "run", renderScript], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  proc.stdin.write(stdin)
  await proc.stdin.end()
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  return { exitCode, stdout, stderr }
}

describe("render.ts CLI bridge", () => {
  it("renders a real GraphJson fixture on stdin to HTML on stdout (exit 0)", async () => {
    const fixture = readFileSync(fixturePath, "utf8")
    const result = await runRender(fixture)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout.startsWith("<!doctype html>")).toBe(true)
    expect(result.stdout).toContain("</html>")
    // Workspace path from the fixture appears in the rendered HTML
    expect(result.stdout).toContain("/tmp/data-struct-fixture")
    // The Phase 3 elements are inlined
    expect(result.stdout).toContain("module:src/model.ts#Box.members")
    expect(result.stdout).toContain('"containment":"array"')
  })

  it("returns exit 1 + helpful error on empty stdin", async () => {
    const result = await runRender("")
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("empty stdin")
    expect(result.stderr).toContain("intelgraph snapshot-stats")
    expect(result.stdout).toBe("")
  })

  it("returns exit 1 + helpful error on invalid JSON", async () => {
    const result = await runRender("not valid json {{{")
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("failed to parse stdin as JSON")
    expect(result.stdout).toBe("")
  })

  it("returns exit 2 when JSON is valid but not a GraphJson", async () => {
    const result = await runRender(JSON.stringify({ foo: "bar" }))
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("doesn't have the GraphJson shape")
    expect(result.stdout).toBe("")
  })

  it("accepts a minimal but valid GraphJson", async () => {
    const minimal = {
      workspace: "/tmp/x",
      snapshot_id: 1,
      total_nodes: 0,
      total_edges: 0,
      nodes: [],
      edges: [],
    }
    const result = await runRender(JSON.stringify(minimal))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.startsWith("<!doctype html>")).toBe(true)
    // Even an empty graph still produces a real document with the
    // viewer chrome (legends, presets, help overlay, etc.)
    expect(result.stdout.length).toBeGreaterThan(40_000)
    expect(result.stdout).toContain("/tmp/x")
  })
})
