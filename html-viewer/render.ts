#!/usr/bin/env bun
/**
 * tui-relation-window/html-viewer/render.ts
 *
 * CLI bridge: read a GraphJson document on stdin, write the
 * self-contained HTML viewer on stdout. The intended pipeline:
 *
 *   intelgraph snapshot-stats <workspace> --graph-json |\
 *     bun run /home/abhi/qprojects/tui-relation-window/html-viewer/render.ts > out.html
 *
 * Or with a saved snapshot:
 *
 *   bun run html-viewer/render.ts < graph.json > out.html
 *
 * No flags — the GraphJson on stdin already encodes any filters
 * (centerOf, maxNodes, edgeKinds, symbolKinds) that the producer
 * applied. The viewer renders whatever it's given.
 *
 * Exit codes:
 *   0 — success, HTML written to stdout
 *   1 — stdin was empty or could not be parsed as JSON
 *   2 — JSON parsed but didn't have the expected GraphJson shape
 */

import { graphJsonToHtml, type GraphJson } from "./graph-to-html"

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = []
  // @ts-expect-error — Bun's stdin is a ReadableStream
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk as Uint8Array)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

function isGraphJson(value: unknown): value is GraphJson {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return (
    typeof v.workspace === "string" &&
    typeof v.snapshot_id === "number" &&
    Array.isArray(v.nodes) &&
    Array.isArray(v.edges)
  )
}

async function main(): Promise<number> {
  const raw = await readStdin()
  if (!raw.trim()) {
    process.stderr.write(
      "render: empty stdin. Pipe a GraphJson document into this command.\n" +
        "  intelgraph snapshot-stats <ws> --graph-json | bun run render.ts > out.html\n",
    )
    return 1
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    process.stderr.write(
      "render: failed to parse stdin as JSON: " +
        (err instanceof Error ? err.message : String(err)) +
        "\n",
    )
    return 1
  }

  if (!isGraphJson(parsed)) {
    process.stderr.write(
      "render: stdin parsed as JSON but doesn't have the GraphJson shape.\n" +
        "       Expected fields: workspace (string), snapshot_id (number),\n" +
        "       nodes (array), edges (array).\n",
    )
    return 2
  }

  const html = graphJsonToHtml(parsed)
  process.stdout.write(html)
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      "render: unexpected error: " +
        (err instanceof Error ? err.stack ?? err.message : String(err)) +
        "\n",
    )
    process.exit(1)
  })
