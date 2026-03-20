import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import cp from 'node:child_process';
import type { BackendQuery, BackendRelationPayload } from './backend-types';
import { logInfo, logWarn } from './logger';

/**
 * Normalise a workspace root path.
 * If the path ends with a VCS marker directory (.git, .hg, .svn) AND that
 * path is a directory on disk, return its parent instead.
 * This is the single source of truth inside clangd-mcp-client.ts.
 */
export function normaliseWorkspaceRoot(rawRoot: string): string {
  const resolved = resolve(rawRoot);
  const name = basename(resolved);
  const markerDirs = new Set(['.git', '.hg', '.svn']);
  if (markerDirs.has(name)) {
    try {
      const st = statSync(resolved);
      if (st.isDirectory()) {
        logWarn('backend', 'workspace-root points inside a VCS marker dir — using parent', { rawRoot, resolved });
        return dirname(resolved);
      }
    } catch {
      // stat failed — leave as-is
    }
  }
  return resolved;
}

type RpcResponse = {
  result?: any;
  error?: { code?: number; message?: string };
};

const SYMBOL_KIND_MAP: Record<string, number> = {
  File: 1,
  Module: 2,
  Namespace: 3,
  Package: 4,
  Class: 5,
  Method: 6,
  Property: 7,
  Field: 8,
  Constructor: 9,
  Enum: 10,
  Interface: 11,
  Function: 12,
  Variable: 13,
  Constant: 14,
  String: 15,
  Number: 16,
  Boolean: 17,
  Array: 18,
  Object: 19,
  Key: 20,
  Null: 21,
  EnumMember: 22,
  Struct: 23,
  Event: 24,
  Operator: 25,
  TypeParameter: 26,
};

export async function fetchRelationsFromClangdMcp(query: BackendQuery): Promise<BackendRelationPayload> {
  const workspaceRoot = query.workspaceRoot ? resolve(query.workspaceRoot) : findWorkspaceRoot(query.filePath);
  const mcpUrl = normalizeMcpUrl(query.mcpUrl || (await resolveMcpUrl(workspaceRoot)));
  logInfo('backend', 'resolved mcp endpoint', { workspaceRoot, mcpUrl, mode: query.mode });

  const init = await sendRpc(mcpUrl, null, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: {
      name: 'q-relation-tui',
      version: '0.1.0',
    },
  });

  const sessionId = init.sessionId;
  if (!sessionId) {
    throw new Error('MCP initialize did not return session id');
  }

  const point = {
    file: resolve(query.filePath),
    line: query.line,
    character: query.character,
  };

  const resolved = await resolveBestPointForSymbol(mcpUrl, sessionId, point);
  const root = parseHoverForRoot(resolved.hoverText);
  logInfo('backend', 'symbol point resolved', {
    requested: point,
    resolved: resolved.point,
    root: root.name,
    probed: resolved.probed,
  });

  if (query.mode === 'incoming') {
    const incomingText = await callTool(mcpUrl, sessionId, 'lsp_incoming_calls', resolved.point);
    const calledBy = parseIncomingCalls(incomingText, workspaceRoot);

    return {
      mode: 'incoming',
      provider: 'clangd-mcp',
      result: {
        [root.name]: {
          symbolKind: root.symbolKind,
          filePath: resolved.point.file,
          lineNumber: resolved.point.line,
          character: resolved.point.character,
          calledBy,
        },
      },
    };
  }

  const outgoingText = await callTool(mcpUrl, sessionId, 'lsp_outgoing_calls', resolved.point);
  const directCalls = parseOutgoingCalls(outgoingText, workspaceRoot);
  const registrationCalls = inferRegisteredHandlerCalls(
    resolved.point.file,
    resolved.point.line,
    workspaceRoot,
    root.name,
  );
  const calls = mergeOutgoingCalls(directCalls, registrationCalls);

  return {
    mode: 'outgoing',
    provider: 'clangd-mcp',
    result: {
      [root.name]: {
        symbolKind: root.symbolKind,
        filePath: resolved.point.file,
        lineNumber: resolved.point.line,
        character: resolved.point.character,
        calls,
      },
    },
  };
}

export async function doctorClangdMcp(query: BackendQuery): Promise<{
  connected: boolean;
  workspaceRoot: string;
  mcpUrl: string;
  requestedPoint: { file: string; line: number; character: number };
  resolvedPoint: { file: string; line: number; character: number };
  hoverFirstLine: string;
}> {
  const workspaceRoot = query.workspaceRoot ? resolve(query.workspaceRoot) : findWorkspaceRoot(query.filePath);
  const mcpUrl = normalizeMcpUrl(query.mcpUrl || (await resolveMcpUrl(workspaceRoot)));

  const init = await sendRpc(mcpUrl, null, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: {
      name: 'q-relation-tui-doctor',
      version: '0.1.0',
    },
  });

  const sessionId = init.sessionId;
  if (!sessionId) {
    throw new Error('MCP initialize did not return session id');
  }

  const requestedPoint = {
    file: resolve(query.filePath),
    line: query.line,
    character: query.character,
  };
  const resolved = await resolveBestPointForSymbol(mcpUrl, sessionId, requestedPoint);
  const firstLine = stripIndexSuffix(resolved.hoverText).split('\n').find((l) => l.trim()) || '';

  return {
    connected: true,
    workspaceRoot,
    mcpUrl,
    requestedPoint,
    resolvedPoint: resolved.point,
    hoverFirstLine: firstLine,
  };
}

function parseJsonFile(filePath: string): any | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function findWorkspaceRoot(filePath: string): string {
  let current = resolve(dirname(filePath));

  while (true) {
    if (
      existsSync(join(current, '.clangd-mcp-state.json')) ||
      existsSync(join(current, '.clangd-mcp.json')) ||
      existsSync(join(current, '.git'))
    ) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return dirname(resolve(filePath));
    }
    current = parent;
  }
}

async function resolveMcpUrl(workspaceRoot: string): Promise<string> {
  const envUrl = process.env.CLANGD_MCP_URL;
  if (envUrl && envUrl.trim()) {
    return envUrl.trim();
  }

  // Always normalise before reading the state file so we look in the right place
  const root = normaliseWorkspaceRoot(workspaceRoot);
  const statePath = join(root, '.clangd-mcp-state.json');
  let state = parseJsonFile(statePath);
  let port = Number(state?.httpPort);
  if (Number.isFinite(port) && port > 0 && (await isPortOpen(port))) {
    logInfo('backend', 'mcp already live', { root, port });
    return `http://127.0.0.1:${port}/mcp`;
  }

  const autoStartEnabled = process.env.TUI_RELATION_MCP_AUTOSTART !== '0';
  if (autoStartEnabled) {
    logInfo('backend', 'mcp not live, attempting auto-start', { root, statePath });
    await tryAutoStartMcp(root, state);
    state = parseJsonFile(statePath);
    port = Number(state?.httpPort);
    if (Number.isFinite(port) && port > 0 && (await isPortOpen(port))) {
      logInfo('backend', 'mcp auto-start succeeded', { root, port });
      return `http://127.0.0.1:${port}/mcp`;
    }
    logWarn('backend', 'mcp auto-start did not produce live httpPort', { root, state });
  }

  throw new Error(
    `Could not resolve clangd-mcp endpoint. Set CLANGD_MCP_URL or ensure ${statePath} contains httpPort.`
  );
}

async function tryAutoStartMcp(workspaceRoot: string, state: any) {
  // Belt-and-suspenders: normalise root here too so the daemon never starts
  // with a .git path even if the caller forgot to normalise.
  const root = normaliseWorkspaceRoot(workspaceRoot);
  const command = buildAutoStartCommand(root, state);
  logInfo('backend', 'starting mcp daemon', { command, root });

  const child = cp.spawn(command[0], command.slice(1), {
    cwd: root,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  await waitForHttpPort(root, 20000);
}

function resolveBunBin(): string {
  // 1. Explicit env override
  if (process.env.BUN_BIN) return process.env.BUN_BIN;
  // 2. Bun sets BUN_INSTALL at startup; use that if present
  const bunInstall = process.env.BUN_INSTALL;
  if (bunInstall) {
    const candidate = join(bunInstall, 'bin', 'bun');
    if (existsSync(candidate)) return candidate;
  }
  // 3. process.execPath is the running bun binary itself
  if (process.execPath && existsSync(process.execPath)) return process.execPath;
  // 4. Fall back to PATH lookup
  return 'bun';
}

function resolveClangdMcpScript(): string {
  // 1. Explicit env override
  if (process.env.CLANGD_MCP_SCRIPT) return process.env.CLANGD_MCP_SCRIPT;
  // 2. Derive from the running script's location: this file lives at
  //    <project>/src/lib/clangd-mcp-client.ts; the clangd-mcp sibling
  //    project is expected at <project>/../clangd-mcp/dist/index.js
  const siblingScript = join(
    import.meta.dir,   // …/src/lib
    '..', '..', '..', // up to workspace/qprojects
    'clangd-mcp', 'dist', 'index.js',
  );
  if (existsSync(siblingScript)) return siblingScript;
  // 3. No script found — caller will surface a clear error
  throw new Error(
    'Cannot locate clangd-mcp script. ' +
    'Set CLANGD_MCP_SCRIPT=/path/to/clangd-mcp/dist/index.js or install clangd-mcp next to this project.',
  );
}

function resolveClangdBin(config: any, state: any): string {
  // Priority: .clangd-mcp.json > state file > env > PATH candidates
  if (config?.clangd) return config.clangd;
  if (state?.clangdBin) return state.clangdBin;
  if (process.env.CLANGD_BIN) return process.env.CLANGD_BIN;
  // Try common versioned binaries in order of preference
  for (const candidate of [
    '/usr/local/bin/clangd-20',
    '/usr/bin/clangd-20',
    '/usr/local/bin/clangd-18',
    '/usr/bin/clangd-18',
    '/usr/local/bin/clangd',
    '/usr/bin/clangd',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return 'clangd'; // last resort: PATH lookup
}

function buildAutoStartCommand(workspaceRoot: string, state: any): string[] {
  const bun    = resolveBunBin();
  const script = resolveClangdMcpScript();
  const config = parseJsonFile(join(workspaceRoot, '.clangd-mcp.json')) || {};

  const clangdBin = resolveClangdBin(config, state);
  const clangdArgs: string[] = Array.isArray(config.args)
    ? config.args
    : Array.isArray(state?.clangdArgs)
      ? state.clangdArgs
      : ['--background-index', '--enable-config', '--log=error'];

  return [
    bun,
    script,
    '--http-daemon-mode',
    '--root',
    workspaceRoot,
    '--clangd',
    clangdBin,
    '--clangd-args',
    clangdArgs.join(','),
  ];
}

async function waitForHttpPort(workspaceRoot: string, timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  const statePath = join(workspaceRoot, '.clangd-mcp-state.json');

  while (Date.now() < deadline) {
    const state = parseJsonFile(statePath);
    const port = Number(state?.httpPort);
    if (Number.isFinite(port) && port > 0 && (await isPortOpen(port))) {
      return port;
    }
    await sleep(250);
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let done = false;

    const finish = (ok: boolean) => {
      if (done) {
        return;
      }
      done = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function normalizeMcpUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/mcp';
  }
  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return url.toString();
}

async function callTool(mcpUrl: string, sessionId: string, name: string, args: Record<string, unknown>) {
  const response = await sendRpc(mcpUrl, sessionId, 'tools/call', {
    name,
    arguments: args,
  });

  const text = response.payload?.result?.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error(`Invalid MCP tool response for ${name}`);
  }

  return text;
}

async function sendRpc(
  mcpUrl: string,
  sessionId: string | null,
  method: string,
  params: Record<string, unknown>
): Promise<{ payload: RpcResponse; sessionId: string | null }> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 10_000_000),
    method,
    params,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
  }

  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers,
    body,
  });

  const raw = await res.text();
  const payload = parseRpcPayload(raw, res.headers.get('content-type'));

  if (!res.ok || payload.error) {
    const message = payload.error?.message || raw || `HTTP ${res.status}`;
    throw new Error(`MCP request failed for ${method}: ${message}`);
  }

  return {
    payload,
    sessionId: res.headers.get('mcp-session-id'),
  };
}

function parseRpcPayload(raw: string, contentType: string | null): RpcResponse {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }

  const isSse =
    (contentType || '').includes('text/event-stream') ||
    trimmed.startsWith('event:') ||
    trimmed.startsWith('data:');

  if (!isSse) {
    return JSON.parse(trimmed) as RpcResponse;
  }

  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('data:')) {
      continue;
    }
    const data = line.slice(5).trim();
    if (!data) {
      continue;
    }
    return JSON.parse(data) as RpcResponse;
  }

  throw new Error('Could not parse SSE RPC payload');
}

function stripIndexSuffix(text: string): string {
  return text.replace(/\n\n\[Index.*$/s, '').trim();
}

// Maps hover text keyword prefixes to LSP symbol kind numbers.
// clangd hover lines look like: "function foo", "method Bar::baz", "struct Foo", etc.
const HOVER_KIND_MAP: Array<[RegExp, number]> = [
  [/^function\b/i,      12], // Function
  [/^method\b/i,         6], // Method
  [/^constructor\b/i,    9], // Constructor
  [/^class\b/i,          5], // Class
  [/^struct\b/i,        23], // Struct
  [/^enum\b/i,          10], // Enum
  [/^enumerator\b/i,    22], // EnumMember
  [/^interface\b/i,     11], // Interface
  [/^namespace\b/i,      3], // Namespace
  [/^variable\b/i,      13], // Variable
  [/^field\b/i,          8], // Field
  [/^parameter\b/i,     13], // Variable (parameters shown as variable)
  [/^type\b/i,          25], // TypeParameter
  [/^typedef\b/i,       25], // TypeParameter
  [/^using\b/i,         25], // TypeParameter
  [/^macro\b/i,         14], // Constant (macros treated as constants)
  [/^constant\b/i,      14], // Constant
];

function parseHoverForRoot(hoverText: string): { name: string; symbolKind: number } {
  const cleaned = stripIndexSuffix(hoverText);
  const firstLine = cleaned.split('\n').find((line) => line.trim()) || '';
  if (!isHoverUsable(firstLine)) {
    logWarn('backend', 'hover root parse fallback', { firstLine });
    return { name: 'unknown_symbol', symbolKind: 12 };
  }

  // Strip markdown bold/code markers
  const plain = firstLine.replace(/[*`]/g, '').trim();

  // Detect symbol kind from the leading keyword
  let symbolKind = 12; // default: Function
  for (const [pattern, kind] of HOVER_KIND_MAP) {
    if (pattern.test(plain)) {
      symbolKind = kind;
      break;
    }
  }

  // Extract the symbol name: first non-keyword token before any '(' or '<'
  // e.g. "function wlan_check_if_arp_or_ns_pkt" → "wlan_check_if_arp_or_ns_pkt"
  //      "method Foo::bar(int x)" → "Foo::bar"
  const withoutKind = plain.replace(/^\w+\s+/, ''); // strip leading keyword
  const name = withoutKind.split(/[\s(<]/)[0]?.replace(/[;,]$/, '') || 'unknown';

  return { name, symbolKind };
}

function isHoverUsable(firstLine: string): boolean {
  const lower = firstLine.toLowerCase();
  if (!lower) {
    return false;
  }

  if (
    lower.startsWith('no ') ||
    lower.includes('unknown argument') ||
    lower.includes('error:') ||
    lower.includes('clang:') ||
    lower.includes('not found')
  ) {
    return false;
  }

  return true;
}

function isAliasLikeHover(firstLine: string): boolean {
  const lower = firstLine.toLowerCase().trim();
  if (!lower) return false;
  return (
    lower.startsWith('type ') ||
    lower.startsWith('typedef ') ||
    lower.startsWith('using ') ||
    lower.includes('type-alias') ||
    lower.includes('type alias')
  );
}

async function resolveBestPointForSymbol(
  mcpUrl: string,
  sessionId: string,
  requestedPoint: { file: string; line: number; character: number }
): Promise<{
  point: { file: string; line: number; character: number };
  hoverText: string;
  probed: number;
}> {
  const firstHover = await callTool(mcpUrl, sessionId, 'lsp_hover', requestedPoint);
  const firstLine = stripIndexSuffix(firstHover).split('\n').find((line) => line.trim()) || '';
  if (isHoverUsable(firstLine) && !isAliasLikeHover(firstLine)) {
    return { point: requestedPoint, hoverText: firstHover, probed: 0 };
  }

  const lineText = getLineText(requestedPoint.file, requestedPoint.line);
  if (!lineText) {
    return { point: requestedPoint, hoverText: firstHover, probed: 0 };
  }

  const candidates = identifierCandidateColumns(lineText, requestedPoint.character);
  let probed = 0;
  for (const character of candidates) {
    if (character === requestedPoint.character) {
      continue;
    }
    const candidatePoint = {
      file: requestedPoint.file,
      line: requestedPoint.line,
      character,
    };
    const hover = await callTool(mcpUrl, sessionId, 'lsp_hover', candidatePoint);
    probed += 1;
    const line = stripIndexSuffix(hover).split('\n').find((l) => l.trim()) || '';
    if (isHoverUsable(line) && !isAliasLikeHover(line)) {
      return { point: candidatePoint, hoverText: hover, probed };
    }
  }

  return { point: requestedPoint, hoverText: firstHover, probed };
}

function getLineText(filePath: string, oneBasedLine: number): string {
  try {
    const text = readFileSync(filePath, 'utf8');
    const lines = text.split(/\r?\n/);
    const idx = oneBasedLine - 1;
    if (idx < 0 || idx >= lines.length) {
      return '';
    }
    return lines[idx] || '';
  } catch {
    return '';
  }
}

function identifierCandidateColumns(lineText: string, cursorCharacter: number): number[] {
  const out: Array<{ character: number; distance: number }> = [];
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(lineText)) !== null) {
    const start = match.index + 1; // 1-based
    const token = match[0];
    const center = start + Math.floor(Math.max(token.length - 1, 0) / 2);
    out.push({
      character: center,
      distance: Math.abs(center - cursorCharacter),
    });
  }

  out.sort((a, b) => a.distance - b.distance);
  // Cap at 8 probes to avoid excessive MCP round-trips on dense lines (TD-008)
  return out.slice(0, 8).map((x) => x.character);
}

function parseIncomingCalls(text: string, workspaceRoot: string) {
  const cleaned = stripIndexSuffix(text);
  if (
    cleaned.includes('No incoming calls') ||
    cleaned.includes('No call hierarchy item') ||
    cleaned.includes('No symbol found')
  ) {
    return [];
  }

  const lines = cleaned.split('\n').filter((line) => line.includes('<-'));
  return lines
    .map((line) => {
      // Use a non-greedy path match anchored to the last :line:col at end of line.
      // Pattern: <- [Kind] symbolName  at /path/to/file.cpp:42:7
      // The path may contain spaces or " at " substrings, so we match everything
      // up to the LAST occurrence of ":digits:digits" at end of line.
      const match = line.match(/<-\s+\[(\w+)\]\s+(\S+)\s+at\s+(.*):(\d+):\d+\s*$/);
      if (!match) {
        return null;
      }

      const [, kind, caller, relPath, lineStr] = match;
      return {
        caller,
        filePath: isAbsolute(relPath) ? relPath : join(workspaceRoot, relPath),
        lineNumber: Number(lineStr),
        symbolKind: SYMBOL_KIND_MAP[kind] ?? 12,
        connectionKind: 'api_call' as const,
      };
    })
    .filter((item): item is {
      caller: string;
      filePath: string;
      lineNumber: number;
      symbolKind: number;
      connectionKind: 'api_call';
    } => item !== null);
}

function parseOutgoingCalls(text: string, workspaceRoot: string) {
  const cleaned = stripIndexSuffix(text);
  if (
    cleaned.includes('No outgoing calls') ||
    cleaned.includes('No call hierarchy item') ||
    cleaned.includes('No symbol found')
  ) {
    return [];
  }

  const lines = cleaned.split('\n').filter((line) => line.includes('->'));
  return lines
    .map((line) => {
      // Same non-greedy fix as parseIncomingCalls — anchor to last :line:col.
      const match = line.match(/->\s+\[(\w+)\]\s+(\S+)\s+at\s+(.*):(\d+):\d+\s*$/);
      if (!match) {
        return null;
      }

      const [, kind, callee, relPath, lineStr] = match;
      return {
        callee,
        filePath: isAbsolute(relPath) ? relPath : join(workspaceRoot, relPath),
        lineNumber: Number(lineStr),
        symbolKind: SYMBOL_KIND_MAP[kind] ?? 12,
        connectionKind: isRegistrationApiName(callee) ? ('interface_registration' as const) : ('api_call' as const),
      };
    })
    .filter((item): item is {
      callee: string;
      filePath: string;
      lineNumber: number;
      symbolKind: number;
      connectionKind: 'api_call' | 'interface_registration';
    } => item !== null);
}

function isRegistrationApiName(name: string): boolean {
  const n = name.toLowerCase();
  if (n.includes('register') || n.includes('unregister')) return true;
  if (n.includes('subscribe') || n.includes('attach') || n.includes('hook')) return true;
  if (n.includes('notif') && (n.includes('handler') || n.includes('cb') || n.includes('callback'))) return true;
  if (n.includes('offldmgr_register_nondata_offload')) return true;
  return false;
}

function mergeOutgoingCalls(
  base: Array<{
    callee: string;
    filePath: string;
    lineNumber: number;
    symbolKind: number;
    connectionKind?: 'api_call' | 'interface_registration';
    viaRegistrationApi?: string;
  }>,
  extra: Array<{
    callee: string;
    filePath: string;
    lineNumber: number;
    symbolKind: number;
    connectionKind?: 'api_call' | 'interface_registration';
    viaRegistrationApi?: string;
  }>,
) {
  const out = [...base];
  const seen = new Set(base.map((x) => `${x.callee}|${x.filePath}|${x.lineNumber}|${x.connectionKind || 'api_call'}`));
  for (const item of extra) {
    const key = `${item.callee}|${item.filePath}|${item.lineNumber}|${item.connectionKind || 'api_call'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function inferRegisteredHandlerCalls(
  filePath: string,
  rootLine: number,
  workspaceRoot: string,
  rootName: string,
) {
  const source = safeReadFile(filePath);
  if (!source) return [];

  const fnBody = extractFunctionBodyAtLine(source, rootLine);
  if (!fnBody) return [];

  const statements = fnBody.split(';');
  const out: Array<{
    callee: string;
    filePath: string;
    lineNumber: number;
    symbolKind: number;
    connectionKind: 'interface_registration';
    viaRegistrationApi: string;
  }> = [];
  const seen = new Set<string>();

  for (const stmtRaw of statements) {
    const stmt = stmtRaw.replace(/\s+/g, ' ').trim();
    if (!stmt) continue;
    const callMatch = stmt.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)\s*$/);
    if (!callMatch) continue;
    const regApi = callMatch[1];
    if (!isRegistrationApiName(regApi)) continue;

    const argsText = callMatch[2] || '';
    const callbacks = extractCallbackIdentifiers(argsText, regApi, rootName);
    for (const cb of callbacks) {
      const cbLoc = findFunctionDefinitionInWorkspace(workspaceRoot, filePath, cb);
      const key = `${cb}|${cbLoc.filePath}|${cbLoc.lineNumber}|${regApi}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        callee: cb,
        filePath: cbLoc.filePath,
        lineNumber: cbLoc.lineNumber,
        symbolKind: 12,
        connectionKind: 'interface_registration',
        viaRegistrationApi: regApi,
      });
    }
  }

  return out;
}

function safeReadFile(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function extractFunctionBodyAtLine(source: string, lineNumber: number): string {
  const lines = source.split(/\r?\n/);
  const startIdx = Math.max(0, lineNumber - 1);
  const textFromLine = lines.slice(startIdx, Math.min(lines.length, startIdx + 260)).join('\n');
  const openIdx = textFromLine.indexOf('{');
  if (openIdx < 0) return '';

  let depth = 0;
  for (let i = openIdx; i < textFromLine.length; i += 1) {
    const ch = textFromLine[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    if (depth === 0) {
      return textFromLine.slice(openIdx + 1, i);
    }
  }
  return '';
}

function extractCallbackIdentifiers(argsText: string, regApi: string, rootName: string): string[] {
  const tokens = argsText.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of tokens) {
    if (tok === regApi || tok === rootName) continue;
    if (/^[A-Z0-9_]+$/.test(tok)) continue;
    if (/^(NULL|void|int|char|long|short|float|double|const|static|return)$/i.test(tok)) continue;
    if (!/(handler|cb|callback|notif|event|dispatch|indication)/i.test(tok) && !tok.startsWith('_')) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

function findFunctionDefinitionInWorkspace(workspaceRoot: string, fallbackFile: string, symbol: string): { filePath: string; lineNumber: number } {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const defRe = new RegExp(`\\b${escaped}\\s*\\([^;]*\\)\\s*\\{`);

  const fallbackSource = safeReadFile(fallbackFile);
  if (fallbackSource) {
    const lines = fallbackSource.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (defRe.test(lines[i] || '')) {
        return { filePath: fallbackFile, lineNumber: i + 1 };
      }
    }
  }

  try {
    const rgCmd = ['rg', '-n', '--no-heading', '--glob', '*.[ch]', `\\b${escaped}\\s*\\(`, workspaceRoot];
    const res = cp.spawnSync(rgCmd[0], rgCmd.slice(1), { encoding: 'utf8' });
    if (res.status === 0 && res.stdout) {
      const line = res.stdout.split(/\r?\n/).find((x) => x.trim().length > 0);
      if (line) {
        const m = line.match(/^(.*?):(\d+):/);
        if (m) {
          return {
            filePath: isAbsolute(m[1]) ? m[1] : join(workspaceRoot, m[1]),
            lineNumber: Number(m[2]),
          };
        }
      }
    }
  } catch {
    // Best-effort fallback below.
  }

  return { filePath: fallbackFile, lineNumber: 1 };
}
