#!/usr/bin/env bun

type DoctorResponse = {
  doctor?: boolean;
  connected?: boolean;
  mcpUrl?: string;
  workspaceRoot?: string;
  hoverFirstLine?: string;
  requestedPoint?: { file: string; line: number; character: number };
  resolvedPoint?: { file: string; line: number; character: number };
};

type RelationResponse = {
  mode?: 'incoming' | 'outgoing';
  provider?: string;
  result?: Record<string, { calledBy?: unknown[]; calls?: unknown[] }>;
};

const DEFAULT_WORKSPACE_ROOT =
  '/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1';
const DEFAULT_FILE =
  '/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1/wlan_proc/wlan_sim/cosims_src/Bo/rx_cosim/src/rx_cosim.cpp';
const DEFAULT_LINE = 796;
const DEFAULT_CHAR = 6;

const workspaceRoot = process.env.RW_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT;
const filePath = process.env.RW_FILE || DEFAULT_FILE;
const line = Number(process.env.RW_LINE || DEFAULT_LINE);
const character = Number(process.env.RW_CHAR || DEFAULT_CHAR);
const requireCallers = (process.env.RW_REQUIRE_CALLERS || '1') !== '0';

async function main() {
  console.log('RelationWindow MCP smoke test');
  console.log(`workspaceRoot=${workspaceRoot}`);
  console.log(`file=${filePath}:${line}:${character}`);

  const doctor = await runBackend([
    '--doctor',
    '--mode',
    'incoming',
    '--file',
    filePath,
    '--line',
    String(line),
    '--character',
    String(character),
    '--workspace-root',
    workspaceRoot,
  ]);

  const doctorJson = parseJson<DoctorResponse>(doctor.stdout, 'doctor');
  if (!doctorJson.connected) {
    fail(`doctor connected=false, stderr=${doctor.stderr.trim()}`);
  }

  console.log(`doctor: connected=true mcpUrl=${doctorJson.mcpUrl}`);
  console.log(`doctor: hover='${doctorJson.hoverFirstLine || ''}'`);

  const incoming = await runBackend([
    '--mode',
    'incoming',
    '--file',
    filePath,
    '--line',
    String(line),
    '--character',
    String(character),
    '--workspace-root',
    workspaceRoot,
  ]);

  const incomingJson = parseJson<RelationResponse>(incoming.stdout, 'incoming');
  validateRelationResponse(incomingJson, 'incoming', requireCallers);

  const outgoing = await runBackend([
    '--mode',
    'outgoing',
    '--file',
    filePath,
    '--line',
    String(line),
    '--character',
    String(character),
    '--workspace-root',
    workspaceRoot,
  ]);

  const outgoingJson = parseJson<RelationResponse>(outgoing.stdout, 'outgoing');
  validateRelationResponse(outgoingJson, 'outgoing', false);

  console.log('PASS: MCP connection and basic relation functionality are working.');
}

function validateRelationResponse(
  payload: RelationResponse,
  mode: 'incoming' | 'outgoing',
  requireNonEmpty: boolean
) {
  if (payload.mode !== mode) {
    fail(`${mode} mode mismatch: got '${String(payload.mode)}'`);
  }

  if (payload.provider !== 'clangd-mcp') {
    fail(`${mode} provider mismatch: got '${String(payload.provider)}'`);
  }

  const result = payload.result || {};
  const rootNames = Object.keys(result);
  if (rootNames.length === 0) {
    fail(`${mode} result has no roots`);
  }

  const root = result[rootNames[0]] || {};
  const entries = mode === 'incoming' ? (root.calledBy || []) : (root.calls || []);
  const count = Array.isArray(entries) ? entries.length : 0;
  console.log(`${mode}: root='${rootNames[0]}' entries=${count}`);

  if (requireNonEmpty && count === 0) {
    fail(`${mode} has zero entries but RW_REQUIRE_CALLERS=1`);
  }
}

async function runBackend(args: string[]) {
  const proc = Bun.spawn({
    cmd: [process.execPath, 'src/backend.ts', ...args],
    cwd: '/local/mnt/workspace/qprojects/tui-relation-window',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;

  if (code !== 0) {
    fail(`backend exited ${code}: ${stderr.trim() || stdout.trim()}`);
  }

  return { stdout, stderr };
}

function parseJson<T>(text: string, name: string): T {
  const trimmed = text.trim();
  if (!trimmed) {
    fail(`${name}: empty stdout`);
  }

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    fail(`${name}: invalid JSON stdout='${trimmed.slice(0, 400)}'`);
  }
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

main().catch((error) => {
  fail(`unhandled error: ${error instanceof Error ? error.message : String(error)}`);
});
