#!/usr/bin/env bun
/**
 * test-mcp-connectivity.ts
 *
 * Standalone connectivity test for the intelgraph server.
 * Tests the full pipeline: state file discovery → HTTP connect → doctor →
 * incoming calls → outgoing calls.
 *
 * Usage:
 *   bun test/test-mcp-connectivity.ts
 *
 * Override defaults:
 *   MCP_URL=http://127.0.0.1:44865/mcp bun test/test-mcp-connectivity.ts
 *   CPP_FILE=/abs/path/file.cpp CPP_LINE=42 CPP_CHAR=5 bun test/test-mcp-connectivity.ts
 */

const CPP_FILE =
  process.env.CPP_FILE ??
  '/local/mnt/workspace/qprojects/tui-relation-window/test/cpp_fixture/test_callhierarchy.cpp';
const CPP_LINE   = Number(process.env.CPP_LINE   ?? '23');
const CPP_CHAR   = Number(process.env.CPP_CHAR   ?? '5');
const WORKSPACE  = process.env.WORKSPACE ?? '/local/mnt/workspace/qprojects/tui-relation-window';
const MCP_URL    = process.env.MCP_URL;   // optional override

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function pass(msg: string) {
  console.log(`  ✔  ${msg}`);
}

function fail(msg: string): never {
  console.error(`  ✖  FAIL: ${msg}`);
  process.exit(1);
}

function section(title: string) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

async function runBackend(args: string[], extraEnv: Record<string, string> = {}): Promise<unknown> {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    TUI_RELATION_MCP_AUTOSTART: '0',
    ...extraEnv,
  };
  if (MCP_URL) env.INTELGRAPH_URL = MCP_URL;

  const proc = Bun.spawn({
    cmd: [process.execPath, 'src/backend.ts', ...args],
    cwd: '/local/mnt/workspace/qprojects/tui-relation-window',
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;

  if (code !== 0) {
    fail(`backend exited ${code}: ${stderr.trim() || stdout.trim()}`);
  }

  const trimmed = stdout.trim();
  if (!trimmed) fail('backend returned empty stdout');

  try {
    return JSON.parse(trimmed);
  } catch {
    fail(`backend returned invalid JSON: ${trimmed.slice(0, 200)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

async function testStateFileDiscovery() {
  section('1. State file discovery');

  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');

  const statePath = join(WORKSPACE, '.intelgraph-state.json');
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    fail(`state file not found or invalid JSON: ${statePath}`);
  }

  const httpPort = Number(state.httpPort);
  if (!Number.isFinite(httpPort) || httpPort <= 0) {
    fail(`state file missing httpPort: ${statePath}`);
  }
  pass(`state file found: ${statePath}`);
  pass(`httpPort = ${httpPort}`);

  return httpPort;
}

async function testHttpConnectivity(httpPort: number) {
  section('2. HTTP connectivity');

  const url = MCP_URL ?? `http://127.0.0.1:${httpPort}/mcp`;
  console.log(`  → testing ${url}`);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'connectivity-test', version: '0.1.0' },
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    fail(`HTTP request failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!res.ok) fail(`HTTP ${res.status} from MCP server`);

  const sessionId = res.headers.get('mcp-session-id');
  if (!sessionId) fail('MCP initialize did not return mcp-session-id header');

  const raw = await res.text();
  const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
  const payload = dataLine ? JSON.parse(dataLine.slice(5).trim()) : JSON.parse(raw.trim());

  const serverName = payload?.result?.serverInfo?.name ?? 'unknown';
  const serverVersion = payload?.result?.serverInfo?.version ?? 'unknown';

  pass(`connected: ${url}`);
  pass(`session-id: ${sessionId}`);
  pass(`server: ${serverName} v${serverVersion}`);

  return url;
}

async function testDoctorMode() {
  section('3. Doctor mode');

  const result = await runBackend([
    '--doctor',
    '--mode', 'incoming',
    '--file', CPP_FILE,
    '--line', String(CPP_LINE),
    '--character', String(CPP_CHAR),
    '--workspace-root', WORKSPACE,
  ]) as Record<string, unknown>;

  if (!result.doctor)    fail(`doctor=false in response`);
  if (!result.connected) fail(`connected=false in response`);
  if (!result.mcpUrl)    fail(`mcpUrl missing in response`);

  const hover = String(result.hoverFirstLine ?? '');
  const resolved = result.resolvedPoint as { file: string; line: number; character: number };

  pass(`connected = true`);
  pass(`mcpUrl = ${result.mcpUrl}`);
  pass(`requested = ${CPP_FILE}:${CPP_LINE}:${CPP_CHAR}`);
  pass(`resolved  = ${resolved?.file}:${resolved?.line}:${resolved?.character}`);
  pass(`hover     = "${hover}"`);

  if (!hover || hover.toLowerCase().includes('no hover') || hover.toLowerCase().includes('error')) {
    console.log(`  ⚠  hover returned "${hover}" — clangd may not have indexed this file yet`);
  }
}

async function testIncomingCalls() {
  section('4. Incoming calls (calledBy)');

  const result = await runBackend([
    '--mode', 'incoming',
    '--file', CPP_FILE,
    '--line', String(CPP_LINE),
    '--character', String(CPP_CHAR),
    '--workspace-root', WORKSPACE,
  ]) as Record<string, unknown>;

  if (result.mode !== 'incoming') fail(`mode mismatch: got "${result.mode}"`);
  if (result.provider !== 'intelgraph') fail(`provider mismatch: got "${result.provider}"`);

  const roots = Object.keys((result.result as Record<string, unknown>) ?? {});
  if (roots.length === 0) fail('result has no root symbols');

  const root = roots[0];
  const rootNode = (result.result as Record<string, { calledBy?: unknown[] }>)[root];
  const calledBy = rootNode?.calledBy ?? [];

  pass(`mode = incoming`);
  pass(`provider = intelgraph`);
  pass(`root symbol = "${root}"`);
  pass(`calledBy entries = ${calledBy.length}`);

  if (calledBy.length === 0) {
    console.log(`  ⚠  no callers found — symbol may not be called from anywhere in the indexed files`);
  } else {
    for (const caller of calledBy as Array<{ caller: string; filePath: string; lineNumber: number }>) {
      console.log(`     ◀── ${caller.caller}  at ${caller.filePath}:${caller.lineNumber}`);
    }
  }
}

async function testOutgoingCalls() {
  section('5. Outgoing calls (calls)');

  const result = await runBackend([
    '--mode', 'outgoing',
    '--file', CPP_FILE,
    '--line', String(CPP_LINE),
    '--character', String(CPP_CHAR),
    '--workspace-root', WORKSPACE,
  ]) as Record<string, unknown>;

  if (result.mode !== 'outgoing') fail(`mode mismatch: got "${result.mode}"`);
  if (result.provider !== 'intelgraph') fail(`provider mismatch: got "${result.provider}"`);

  const roots = Object.keys((result.result as Record<string, unknown>) ?? {});
  if (roots.length === 0) fail('result has no root symbols');

  const root = roots[0];
  const rootNode = (result.result as Record<string, { calls?: unknown[] }>)[root];
  const calls = rootNode?.calls ?? [];

  pass(`mode = outgoing`);
  pass(`provider = intelgraph`);
  pass(`root symbol = "${root}"`);
  pass(`calls entries = ${calls.length}`);

  if (calls.length === 0) {
    console.log(`  ⚠  no callees found — symbol may not call anything in the indexed files`);
  } else {
    for (const callee of calls as Array<{ callee: string; filePath: string; lineNumber: number }>) {
      console.log(`     ──▶ ${callee.callee}  at ${callee.filePath}:${callee.lineNumber}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║       q-relation-tui  ·  intelgraph connectivity test       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`\n  workspace : ${WORKSPACE}`);
  console.log(`  file      : ${CPP_FILE}`);
  console.log(`  position  : line ${CPP_LINE}, char ${CPP_CHAR}`);
  if (MCP_URL) console.log(`  mcp-url   : ${MCP_URL} (override)`);

  const httpPort = await testStateFileDiscovery();
  await testHttpConnectivity(httpPort);
  await testDoctorMode();
  await testIncomingCalls();
  await testOutgoingCalls();

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ALL TESTS PASSED — intelgraph connection is healthy');
  console.log('══════════════════════════════════════════════════════════════════\n');
}

main().catch((e) => {
  console.error(`\nUnhandled error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
