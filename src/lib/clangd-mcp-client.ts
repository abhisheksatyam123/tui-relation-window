import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import cp from 'node:child_process';
import type { BackendQuery, BackendRelationPayload } from './backend-types';
import { logInfo, logWarn } from './logger';
import {
  initCache,
  getCacheKey,
  lookupCache,
  validateCacheFreshness,
  storeCache,
  updateLastAccessed,
  deleteCache,
  extractEvidenceFiles,
  type CacheQuery,
} from './relation-cache';

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

  // ── CACHE LOOKUP ──
  const db = initCache(workspaceRoot);
  const cacheQuery: CacheQuery = {
    workspaceRoot,
    filePath: resolved.point.file,
    line: resolved.point.line,
    character: resolved.point.character,
    mode: query.mode,
    resolvedSymbol: root.name,
  };
  const cacheKey = getCacheKey(cacheQuery);
  
  const cached = lookupCache(db, cacheKey);
  if (cached) {
    const isFresh = validateCacheFreshness(db, cacheKey);
    if (isFresh) {
      logInfo('backend', 'cache hit (fresh)', { cacheKey: cacheKey.slice(0, 8), symbol: root.name });
      updateLastAccessed(db, cacheKey);
      db.close();
      return cached.payload;
    } else {
      logInfo('backend', 'cache hit (stale)', { cacheKey: cacheKey.slice(0, 8), symbol: root.name });
      deleteCache(db, cacheKey);
    }
  } else {
    logInfo('backend', 'cache miss', { cacheKey: cacheKey.slice(0, 8), symbol: root.name });
  }

  // ── CACHE MISS: existing tool escalation ──
  if (query.mode === 'incoming') {
    const indirectText = await callTool(mcpUrl, sessionId, 'lsp_indirect_callers', {
      ...resolved.point,
      maxNodes: 50,
    });
    const incomingText = await callTool(mcpUrl, sessionId, 'lsp_incoming_calls', resolved.point);
    logInfo('backend', 'indirect-callers-raw-sample', {
      rootName: root.name,
      size: indirectText.length,
      sample: indirectText.split('\n').slice(0, 8),
    });
    const parsed = parseIndirectCallers(
      indirectText,
      workspaceRoot,
      root.name,
      resolved.point.file,
      resolved.point.line,
    );
    const incomingFallback = parseIncomingCalls(incomingText, workspaceRoot);
    const mergedCalledBy = mergeIncomingSources(parsed.calledBy, incomingFallback);
    logInfo('backend', 'incoming-calls-raw-sample', {
      rootName: root.name,
      size: incomingText.length,
      sample: incomingText.split('\n').slice(0, 8),
      parsedCount: incomingFallback.length,
      mergedCount: mergedCalledBy.length,
    });
    let canonicalCalledBy = rankIncomingCallers(dedupeIncomingByCanonicalCaller(mergedCalledBy));
    if (!hasNonTestCaller(canonicalCalledBy)) {
      const referencesText = await callTool(mcpUrl, sessionId, 'lsp_references', resolved.point);
      const refFallback = parseReferenceRegistrations(
        referencesText,
        workspaceRoot,
        root.name,
        resolved.point.file,
        resolved.point.line,
      );
      logInfo('backend', 'references-raw-sample', {
        rootName: root.name,
        size: referencesText.length,
        sample: referencesText.split('\n').slice(0, 12),
      });
      canonicalCalledBy = rankIncomingCallers(
        dedupeIncomingByCanonicalCaller(mergeIncomingSources(canonicalCalledBy, refFallback)),
      );
      logInfo('backend', 'reference-fallback-sample', {
        rootName: root.name,
        size: referencesText.length,
        sample: referencesText.split('\n').slice(0, 8),
        parsedCount: refFallback.length,
        finalCount: canonicalCalledBy.length,
      });
    }
    logInfo('backend', 'indirect-callers-parsed', { rootName: root.name, count: canonicalCalledBy.length });

    const payload: BackendRelationPayload = {
      mode: 'incoming',
      provider: 'clangd-mcp',
      result: {
        [root.name]: {
          symbolKind: root.symbolKind,
          filePath: resolved.point.file,
          lineNumber: resolved.point.line,
          character: resolved.point.character,
          calledBy: canonicalCalledBy,
          ...(parsed.systemNodes?.length ? { systemNodes: parsed.systemNodes } : {}),
          ...(parsed.systemLinks?.length ? { systemLinks: parsed.systemLinks } : {}),
        },
      },
    };

    // ── CACHE STORE ──
    const evidenceFiles = extractEvidenceFiles(payload);
    storeCache(db, cacheKey, cacheQuery, payload, evidenceFiles);
    db.close();

    return payload;
  }

  const outgoingText = await callTool(mcpUrl, sessionId, 'lsp_outgoing_calls', resolved.point);
  const calls = parseOutgoingCalls(outgoingText, workspaceRoot);

  const payload: BackendRelationPayload = {
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

  // ── CACHE STORE ──
  const evidenceFiles = extractEvidenceFiles(payload);
  storeCache(db, cacheKey, cacheQuery, payload, evidenceFiles);
  db.close();

  return payload;
}

function parseIncomingCalls(
  text: string,
  workspaceRoot: string,
): Array<NonNullable<NonNullable<BackendRelationPayload['result']>[string]['calledBy']>[number]> {
  const cleaned = stripIndexSuffix(text);
  if (
    cleaned.includes('No callers found') ||
    cleaned.includes('No call hierarchy item') ||
    cleaned.includes('No symbol found') ||
    cleaned.includes('(none found)')
  ) {
    return [];
  }

  const out: Array<NonNullable<NonNullable<BackendRelationPayload['result']>[string]['calledBy']>[number]> = [];
  for (const raw of cleaned.split('\n')) {
    const line = raw.trimEnd();
    const m = line.match(/^\s*<-\s+\[(\w+)\](?:\s+\[([^\]]+)\])?\s+(\S+)\s+at\s+(.*):(\d+):\d+\s*$/);
    if (!m) continue;
    const [, kind, tags, caller, relPath, lineStr] = m;
    const tagText = (tags || '').toLowerCase();
    const connectionKind: 'api_call' | 'interface_registration' =
      tagText.includes('reg-call') ? 'interface_registration' : 'api_call';
    out.push({
      caller: preferSymbolAlias(caller),
      filePath: isAbsolute(relPath) ? relPath : join(workspaceRoot, relPath),
      lineNumber: Number(lineStr),
      symbolKind: SYMBOL_KIND_MAP[kind] ?? 12,
      connectionKind,
    });
  }
  return out;
}

function mergeIncomingSources(
  primary: Array<NonNullable<NonNullable<BackendRelationPayload['result']>[string]['calledBy']>[number]>,
  secondary: Array<NonNullable<NonNullable<BackendRelationPayload['result']>[string]['calledBy']>[number]>,
): Array<NonNullable<NonNullable<BackendRelationPayload['result']>[string]['calledBy']>[number]> {
  if (!primary.length) return secondary;
  if (!secondary.length) return primary;
  const out = [...primary];
  const seen = new Set(out.map((x) => `${preferSymbolAlias(x.caller)}|${x.connectionKind}|${x.filePath}|${x.lineNumber}`));
  for (const item of secondary) {
    const key = `${preferSymbolAlias(item.caller)}|${item.connectionKind}|${item.filePath}|${item.lineNumber}`;
    if (seen.has(key)) continue;
    out.push(item);
    seen.add(key);
  }
  return out;
}

function hasNonTestCaller(
  items: Array<NonNullable<NonNullable<BackendRelationPayload['result']>[string]['calledBy']>[number]>
): boolean {
  return items.some((x) => !isLikelyTestPath(x.filePath));
}

function parseReferenceRegistrations(
  text: string,
  workspaceRoot: string,
  targetName: string,
  targetFile: string,
  targetLine: number,
): Array<NonNullable<NonNullable<BackendRelationPayload['result']>[string]['calledBy']>[number]> {
  const cleaned = stripIndexSuffix(text);
  if (!cleaned || /No references|No symbol found|No call hierarchy item/i.test(cleaned)) return [];

  const out: Array<NonNullable<NonNullable<BackendRelationPayload['result']>[string]['calledBy']>[number]> = [];
  for (const raw of cleaned.split('\n')) {
    const lineText = raw.trim();
    const m = lineText.match(/^(?:-\s*)?(?<path>(?:file:\/\/)?[^:\s][^:]*?):(?<line>\d+):(?<col>\d+)\s*$/);
    if (!m) continue;
    const relPath = (m.groups?.path || '').replace(/^file:\/\//, '');
    const lineStr = m.groups?.line || '0';
    const filePath = isAbsolute(relPath) ? relPath : join(workspaceRoot, relPath);
    const lineNumber = Number(lineStr);
    if (resolve(filePath) === resolve(targetFile) && lineNumber === targetLine) continue;

    const line = readLineSafe(filePath, lineNumber);
    if (!line) continue;
    if (!line.includes(targetName)) continue;
    if (!/register|offldmgr_/i.test(line)) continue;

    const owner = findEnclosingFunctionName(filePath, lineNumber) ?? basename(filePath);
    const ownerLine = findEnclosingFunctionLine(filePath, lineNumber) ?? lineNumber;
    out.push({
      caller: preferSymbolAlias(owner),
      filePath,
      lineNumber: ownerLine,
      symbolKind: 12,
      connectionKind: 'interface_registration',
    });
  }
  return out;
}

function readLineSafe(filePath: string, lineNumber: number): string {
  try {
    const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
    return lines[Math.max(0, lineNumber - 1)] ?? '';
  } catch {
    return '';
  }
}

function findEnclosingFunctionLine(filePath: string, fromLine: number): number | null {
  try {
    const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (let i = Math.max(0, fromLine - 1); i >= Math.max(0, fromLine - 260); i -= 1) {
      const line = lines[i] ?? '';
      if (looksLikeFunctionDef(line)) return i + 1;
    }
    return null;
  } catch {
    return null;
  }
}

function findEnclosingFunctionName(filePath: string, fromLine: number): string | null {
  try {
    const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (let i = Math.max(0, fromLine - 1); i >= Math.max(0, fromLine - 260); i -= 1) {
      const line = lines[i] ?? '';
      if (!looksLikeFunctionDef(line)) continue;
      const mm = line.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?\s*$/);
      if (!mm) continue;
      const name = mm[1];
      if (/^(if|for|while|switch)$/.test(name)) continue;
      return name;
    }
    return null;
  } catch {
    return null;
  }
}

function looksLikeFunctionDef(line: string): boolean {
  const s = line.trim();
  if (!s || s.startsWith('#')) return false;
  if (!s.includes('(') || !s.includes(')')) return false;
  if (s.endsWith(';')) return false;
  if (/^(if|for|while|switch)\s*\(/.test(s)) return false;
  return /\b[A-Za-z_][A-Za-z0-9_]*\s*\([^;]*\)\s*\{?\s*$/.test(s);
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
  const rawName = withoutKind.split(/[\s(<]/)[0]?.replace(/[;,]$/, '') || 'unknown';
  const name = preferSymbolAlias(rawName);

  return { name, symbolKind };
}

function preferSymbolAlias(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;

  // General canonicalization for alias-style C symbol variants:
  //   _foo, __foo, foo___RAM, _foo___RAM  -> foo
  // This is intentionally generic so it applies to all similar patterns.
  let canonical = trimmed;
  canonical = canonical.replace(/^_+/, '');
  canonical = canonical.replace(/___[A-Za-z0-9_]+$/, '');

  return canonical || trimmed;
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

// ── Section → connectionKind mapping for lsp_indirect_callers output ──────────
type DerivedConnectionKind =
  | 'api_call'
  | 'interface_registration'
  | 'sw_thread_comm'
  | 'hw_interrupt'
  | 'hw_ring'
  | 'ring_signal'
  | 'event'
  | 'timer_callback'
  | 'deferred_work'
  | 'debugfs_op'
  | 'ioctl_dispatch'
  | 'ring_completion'
  | 'custom';

// ── Structured MediatedPath types (mirrors clangd-mcp trace-engine/trace-types) ──
// These are the types emitted in the ---mediated-paths-json--- block.
// Frontend consumes them without local inference.

type MediatedEndpoint = {
  endpointKind: string;
  endpointId: string;
  endpointLabel?: string;
  origin: string;
  filePath?: string;
  lineNumber?: number;
};

type MediationStage = {
  stageKind: string;
  ownerSymbol: string;
  filePath: string;
  lineNumber: number;
  ids?: Record<string, string>;
};

type MediatedPathEntry = {
  pathId: string;
  endpoint: MediatedEndpoint;
  stages: MediationStage[];
  confidence: { score: number; reasons: string[] };
  evidence: Array<{ role: string; filePath: string; lineNumber: number }>;
};

/**
 * Map a MediatedPath endpoint kind to a DerivedConnectionKind for the UI.
 * Backend owns the semantic classification; frontend only maps to visual kind.
 */
function endpointKindToConnectionKind(endpointKind: string): DerivedConnectionKind {
  switch (endpointKind) {
    case 'host_interface':    return 'event';
    case 'fw_signal_message': return 'ring_signal';
    case 'hw_irq_or_ring':    return 'hw_interrupt';
    case 'packet_rx':         return 'hw_ring';
    case 'packet_tx':         return 'hw_ring';
    case 'api_direct':        return 'api_call';
    case 'os_timer':          return 'timer_callback';
    case 'deferred_work':     return 'deferred_work';
    case 'debugfs_op':        return 'debugfs_op';
    case 'ioctl_dispatch':    return 'ioctl_dispatch';
    case 'ring_completion':   return 'ring_completion';
    default:                  return 'custom';
  }
}

/**
 * Map a mediation stage kind to a DerivedConnectionKind for the UI.
 */
function stageKindToConnectionKind(stageKind: string): DerivedConnectionKind {
  switch (stageKind) {
    case 'dispatch_table':
    case 'registration_call':
    case 'struct_store':
    case 'ops_vtable':        return 'interface_registration';
    case 'irq_registration':  return 'hw_interrupt';
    case 'signal_wait':
    case 'signal_raise':      return 'ring_signal';
    case 'ring_dispatch':     return 'hw_ring';
    case 'completion_store':
    case 'completion_dispatch': return 'sw_thread_comm';
    case 'timer_arm':         return 'timer_callback';
    case 'work_schedule':     return 'deferred_work';
    case 'debugfs_register':  return 'debugfs_op';
    case 'ioctl_register':    return 'ioctl_dispatch';
    case 'ring_post':         return 'ring_completion';
    default:                  return 'api_call';
  }
}

/**
 * Extract the ---mediated-paths-json--- block from lsp_indirect_callers text.
 * Returns parsed MediatedPathEntry[] or null if no block is present.
 */
function extractMediatedPathsJson(text: string): MediatedPathEntry[] | null {
  const start = text.indexOf('---mediated-paths-json---');
  const end   = text.indexOf('---end-mediated-paths-json---');
  if (start === -1 || end === -1) return null;
  const json = text.slice(start + '---mediated-paths-json---'.length, end).trim();
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed as MediatedPathEntry[];
    return null;
  } catch {
    return null;
  }
}

/**
 * Convert MediatedPathEntry[] into CallerNode[] + systemNodes[] + systemLinks[].
 *
 * For each path:
 *   - Endpoint → CallerNode with connectionKind from endpointKind
 *   - Endpoint → systemNode (kind: endpoint)
 *   - Each stage → systemNode (kind: mechanism)
 *   - API callback → systemNode (kind: api)
 *   - Links: endpoint -> stage(s) -> api
 *
 * This is the structured-path consumption path (Gate G8).
 * Backend semantics are preserved; no local inference.
 */
function mediatedPathsToCallerNodes(
  paths: MediatedPathEntry[],
  callbackSymbol: string,
  callbackFilePath: string,
  callbackLineNumber: number,
): {
  calledBy: Array<{
    caller: string;
    filePath: string;
    lineNumber: number;
    symbolKind: number;
    connectionKind: DerivedConnectionKind;
    viaRegistrationApi?: string;
  }>;
  systemNodes: NonNullable<import('./types').RelationRootNode['systemNodes']>;
  systemLinks: NonNullable<import('./types').RelationRootNode['systemLinks']>;
} {
  const canonicalCallback = preferSymbolAlias(callbackSymbol);
  const calledBy: ReturnType<typeof mediatedPathsToCallerNodes>['calledBy'] = [];
  const systemNodes: ReturnType<typeof mediatedPathsToCallerNodes>['systemNodes'] = [];
  const systemLinks: ReturnType<typeof mediatedPathsToCallerNodes>['systemLinks'] = [];
  const seenNodes = new Set<string>();
  const seenCallers = new Set<string>();

  const addNode = (id: string, name: string, kind: import('./types').SystemNodeKind, filePath?: string, lineNumber?: number) => {
    if (seenNodes.has(id)) return;
    seenNodes.add(id);
    systemNodes.push({ id, name, kind, filePath, lineNumber });
  };

  // API callback node (always present)
  const apiNodeId = `api-${canonicalCallback}`;
  addNode(apiNodeId, canonicalCallback, 'api', callbackFilePath, callbackLineNumber);

  for (const path of paths) {
    const ep = path.endpoint;
    const connKind = endpointKindToConnectionKind(ep.endpointKind);
    const canonicalEndpointId = preferSymbolAlias(ep.endpointId);
    const epLabel = preferSymbolAlias(ep.endpointLabel ?? ep.endpointId);

    // Emit endpoint as a CallerNode (the "who invokes this API" answer)
    const callerKey = `${canonicalEndpointId}|${connKind}`;
    if (!seenCallers.has(callerKey)) {
      seenCallers.add(callerKey);
      calledBy.push({
        caller: canonicalEndpointId,
        filePath: ep.filePath ?? callbackFilePath,
        lineNumber: ep.lineNumber ?? callbackLineNumber,
        symbolKind: 12,
        connectionKind: connKind,
        viaRegistrationApi: path.stages[0]?.ownerSymbol,
      });
    }

    // Endpoint system node
    const epNodeId = `ep-${canonicalEndpointId}`;
    addNode(epNodeId, epLabel, endpointKindToSystemNodeKind(ep.endpointKind), ep.filePath, ep.lineNumber);

    // Mechanism stage nodes + links
    let prevId = epNodeId;
    for (const stage of path.stages) {
      const canonicalOwner = preferSymbolAlias(stage.ownerSymbol);
      const stageId = `stage-${stage.stageKind}-${canonicalOwner}`;
      addNode(stageId, canonicalOwner, 'interface', stage.filePath, stage.lineNumber);
      systemLinks.push({
        fromId: prevId,
        toId: stageId,
        kind: stageKindToConnectionKind(stage.stageKind),
      });
      prevId = stageId;
    }

    // Link last stage (or endpoint) to API
    systemLinks.push({
      fromId: prevId,
      toId: apiNodeId,
      kind: connKind,
    });
  }

  return { calledBy, systemNodes, systemLinks };
}

function endpointKindToSystemNodeKind(endpointKind: string): import('./types').SystemNodeKind {
  switch (endpointKind) {
    case 'host_interface':    return 'interface';
    case 'fw_signal_message': return 'signal';
    case 'hw_irq_or_ring':    return 'hw_interrupt';
    case 'packet_rx':
    case 'packet_tx':         return 'hw_ring';
    case 'api_direct':        return 'api';
    case 'os_timer':          return 'timer';
    case 'deferred_work':     return 'work_queue';
    default:                  return 'unknown';
  }
}

/**
 * Parse the plain-text output of the `lsp_indirect_callers` clangd-mcp tool
 * into a CallerNode array.
 *
 * Strategy (Gate G8):
 *   1. Try to extract and parse the structured `---mediated-paths-json---` block.
 *      If present, convert MediatedPath[] → CallerNode[] + systemNodes[] + systemLinks[].
 *      This is the primary path — backend semantics are preserved, no local inference.
 *   2. Fall back to text-annotation parsing when no JSON block is present.
 *      This preserves backward compatibility with older clangd-mcp versions.
 *
 * Contract ownership:
 * - Backend (clangd-mcp) owns semantic classification.
 * - Frontend parser only maps explicit backend labels to `connectionKind`.
 */
function parseIndirectCallers(
  text: string,
  workspaceRoot: string,
  callbackSymbol?: string,
  callbackFilePath?: string,
  callbackLineNumber?: number,
): {
  calledBy: Array<{
    caller: string;
    filePath: string;
    lineNumber: number;
    symbolKind: number;
    connectionKind: DerivedConnectionKind;
    viaRegistrationApi?: string;
  }>;
  systemNodes?: NonNullable<import('./types').RelationRootNode['systemNodes']>;
  systemLinks?: NonNullable<import('./types').RelationRootNode['systemLinks']>;
} {
  // ── Path 1: Structured JSON block (Gate G8) ──────────────────────────────
  const mediatedPaths = extractMediatedPathsJson(text);
  if (mediatedPaths && mediatedPaths.length > 0) {
    const result = mediatedPathsToCallerNodes(
      mediatedPaths,
      callbackSymbol ?? '(unknown)',
      callbackFilePath ?? '',
      callbackLineNumber ?? 0,
    );
    return result;
  }

  // ── Path 2: Text-annotation fallback ─────────────────────────────────────
  return { calledBy: parseIndirectCallersFromText(text, workspaceRoot) };
}

/**
 * Text-annotation fallback parser for lsp_indirect_callers output.
 * Used when no structured ---mediated-paths-json--- block is present.
 */
function parseIndirectCallersFromText(
  text: string,
  workspaceRoot: string,
): Array<{
  caller: string;
  filePath: string;
  lineNumber: number;
  symbolKind: number;
  connectionKind: DerivedConnectionKind;
  viaRegistrationApi?: string;
}> {
  const cleaned = stripIndexSuffix(text);
  if (
    cleaned.includes('No callers found') ||
    cleaned.includes('No call hierarchy item') ||
    cleaned.includes('No symbol found') ||
    cleaned.includes('(none found)')
  ) {
    return [];
  }

  type PendingNode = {
    caller: string;
    filePath: string;
    lineNumber: number;
    symbolKind: number;
    connectionKind: DerivedConnectionKind;
    viaRegistrationApi?: string;
    // Real event source metadata (owned by backend; parser does no inference).
    triggerType?: DerivedConnectionKind; // trigger-type: hw_interrupt | ring_signal | ...
    triggerId?: string;                  // trigger-id: A_INUM_* | WLAN_THREAD_SIG_* | ...
    triggerContext?: string;             // trigger-context: <source context>
    dispatchEventId?: string;            // event: WMI_CMD_* (dispatch-table endpoint)
    triggerOrigin?: string;              // trigger-origin: internal | external | host | firmware
  };

  type CallerNode = {
    caller: string;
    filePath: string;
    lineNumber: number;
    symbolKind: number;
    connectionKind: DerivedConnectionKind;
    viaRegistrationApi?: string;
  };

  const out: CallerNode[] = [];
  const seenEventSources = new Set<string>();
  let currentKind: DerivedConnectionKind = 'api_call';
  let pending: PendingNode | null = null;

  const emitEventSource = (
    caller: string,
    connectionKind: DerivedConnectionKind,
    filePath: string,
    lineNumber: number,
    viaRegistrationApi?: string,
  ) => {
    const key = `${caller}|${connectionKind}`;
    if (seenEventSources.has(key)) return;
    seenEventSources.add(key);
    out.push({ caller, filePath, lineNumber, symbolKind: 12, connectionKind, viaRegistrationApi });
  };

  const flush = () => {
    if (!pending) return;

    // Always emit the registrar node
    out.push({
      caller: pending.caller,
      filePath: pending.filePath,
      lineNumber: pending.lineNumber,
      symbolKind: pending.symbolKind,
      connectionKind: pending.connectionKind,
      viaRegistrationApi: pending.viaRegistrationApi,
    });

    // Explicit trigger node emitted only when backend supplies full trigger contract.
    if (pending.triggerType && pending.triggerId) {
      emitEventSource(
        pending.triggerId,
        pending.triggerType,
        pending.filePath,
        pending.lineNumber,
        pending.triggerContext ?? pending.triggerOrigin ?? pending.viaRegistrationApi,
      );
    }

    // Dispatch-table endpoints (e.g., WMI command IDs) are explicit event sources
    // when backend provides `event:` metadata.
    if (pending.dispatchEventId) {
      emitEventSource(
        pending.dispatchEventId,
        'event',
        pending.filePath,
        pending.lineNumber,
        pending.triggerOrigin ?? pending.triggerContext,
      );
    }

    pending = null;
  };

  for (const rawLine of cleaned.split('\n')) {
    const line = rawLine.trimEnd();

    // ── Section header detection ──────────────────────────────────────────────
    if (/^Direct callers\s*\(/i.test(line)) {
      flush(); currentKind = 'api_call'; continue;
    }
    if (/^Dispatch-table registrations\s*\(/i.test(line)) {
      flush(); currentKind = 'interface_registration'; continue;
    }
    if (/^Registration-call registrations\s*\(/i.test(line)) {
      flush(); currentKind = 'interface_registration'; continue;
    }
    if (/^Struct registrations\s*\(/i.test(line)) {
      flush(); currentKind = 'interface_registration'; continue;
    }
    if (/^Signal-based registrations\s*\(/i.test(line)) {
      flush(); currentKind = 'ring_signal'; continue;
    }
    if (/^WMI Dispatch registrations\s*\(/i.test(line)) {
      flush(); currentKind = 'interface_registration'; continue;
    }
    if (/^Hardware interrupt registrations\s*\(/i.test(line)) {
      flush(); currentKind = 'hw_interrupt'; continue;
    }
    if (/^Ring signal registrations\s*\(/i.test(line)) {
      flush(); currentKind = 'ring_signal'; continue;
    }
    if (/^Event registrations\s*\(/i.test(line)) {
      flush(); currentKind = 'event'; continue;
    }
    if (/^Thread signal registrations\s*\(/i.test(line)) {
      flush(); currentKind = 'ring_signal'; continue;
    }
    if (/^Timer callback registrations\s*\(/i.test(line)) {
      flush(); currentKind = 'timer_callback'; continue;
    }
    if (/^Deferred work registrations\s*\(/i.test(line)) {
      flush(); currentKind = 'deferred_work'; continue;
    }
    if (/^DebugFS registrations\s*\(/i.test(line)) {
      flush(); currentKind = 'debugfs_op'; continue;
    }
    if (/^IOCTL dispatch registrations\s*\(/i.test(line)) {
      flush(); currentKind = 'ioctl_dispatch'; continue;
    }
    if (/^Ring completion registrations\s*\(/i.test(line)) {
      flush(); currentKind = 'ring_completion'; continue;
    }
    if (/^Work queue registrations\s*\(/i.test(line)) {
      flush(); currentKind = 'deferred_work'; continue;
    }

    // ── Entry line: "  <- [Kind] name  at path:line:col" ─────────────────────
    const entryMatch = line.match(
      /^\s*<-\s+\[(\w+)\](?:\s+\[[^\]]+\])*\s+(\S+)\s+at\s+(.*):(\d+):\d+\s*$/,
    );
    if (entryMatch) {
      flush();
      const [, kind, caller, relPath, lineStr] = entryMatch;
      const filePath = isAbsolute(relPath) ? relPath : join(workspaceRoot, relPath);
      pending = {
        caller: preferSymbolAlias(caller),
        filePath,
        lineNumber: Number(lineStr),
        symbolKind: SYMBOL_KIND_MAP[kind] ?? 12,
        connectionKind: currentKind,
      };
      continue;
    }

    if (!pending) continue;

    // ── Annotation lines ──────────────────────────────────────────────────────

    // "     via: offldmgr_register_nondata_offload"
    const viaMatch = line.match(/^\s+via:\s+(\S+)/);
    if (viaMatch) { pending.viaRegistrationApi = viaMatch[1]; continue; }

    // "     trigger-type: hw_interrupt"
    const triggerTypeMatch = line.match(/^\s+trigger-type:\s+([a-z_]+)/i);
    if (triggerTypeMatch) {
      const triggerType = triggerTypeMatch[1].toLowerCase() as DerivedConnectionKind;
      if (
        triggerType === 'api_call' ||
        triggerType === 'interface_registration' ||
        triggerType === 'sw_thread_comm' ||
        triggerType === 'hw_interrupt' ||
        triggerType === 'hw_ring' ||
        triggerType === 'ring_signal' ||
        triggerType === 'event' ||
        triggerType === 'timer_callback' ||
        triggerType === 'deferred_work' ||
        triggerType === 'debugfs_op' ||
        triggerType === 'ioctl_dispatch' ||
        triggerType === 'ring_completion' ||
        triggerType === 'custom'
      ) {
        pending.triggerType = triggerType;
      }
      continue;
    }

    // "     trigger-id: WLAN_THREAD_SIG_* or A_INUM_*"
    const triggerIdMatch = line.match(/^\s+trigger-id:\s+(\S+)/);
    if (triggerIdMatch) { pending.triggerId = triggerIdMatch[1]; continue; }

    // "     event: WMI_*"
    const eventMatch = line.match(/^\s+event:\s+(\S+)/);
    if (eventMatch) { pending.dispatchEventId = eventMatch[1]; continue; }

    // "     trigger-origin: external(host)" (optional trigger source owner)
    const triggerOriginMatch = line.match(/^\s+trigger-origin:\s+(.+)/i);
    if (triggerOriginMatch) { pending.triggerOrigin = triggerOriginMatch[1].trim(); continue; }

    // "     trigger-context: cmnos_irq_register(A_INUM_TQM_STATUS_HI, me, WLAN_THREAD_SIG_*)"
    // Full registration call line — attached to the hw_interrupt event source node
    // so the user can see both the interrupt ID and the signal ID together and
    // immediately find where in the code the signal is triggered.
    const trigCtxMatch = line.match(/^\s+trigger-context:\s+(.+)/);
    if (trigCtxMatch) { pending.triggerContext = trigCtxMatch[1].trim(); continue; }

    // Legacy clangd-mcp annotations are ignored; canonical contract is trigger-*.
  }

  flush();
  return out;
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
      // Anchor to last :line:col at end of line.
      const match = line.match(/->\s+\[(\w+)\]\s+(\S+)\s+at\s+(.*):(\d+):\d+\s*$/);
      if (!match) {
        return null;
      }

      const [, kind, callee, relPath, lineStr] = match;
      return {
        callee: preferSymbolAlias(callee),
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

function dedupeIncomingByCanonicalCaller(
  items: NonNullable<BackendRelationPayload['result']>[string]['calledBy']
): Array<NonNullable<NonNullable<BackendRelationPayload['result']>[string]['calledBy']>[number]> {
  if (!items || items.length === 0) return [];
  if (items.length === 1) return [{ ...items[0], caller: preferSymbolAlias(items[0].caller) }];

  const byCaller = new Map<string, (typeof items)[number]>();
  for (const item of items) {
    if (!item) continue;
    const key = preferSymbolAlias(item.caller);
    const existing = byCaller.get(key);
    if (!existing) {
      byCaller.set(key, { ...item, caller: key });
      continue;
    }

    const existingIsRom = /\/rom\//.test(existing.filePath);
    const currentIsRom = /\/rom\//.test(item.filePath);
    if (existingIsRom && !currentIsRom) {
      byCaller.set(key, { ...item, caller: key });
    }
  }

  return Array.from(byCaller.values());
}

function isLikelyTestPath(filePath: string): boolean {
  return /(?:^|\/)wlan_test(?:\/|$)|(?:^|\/)qtf_simxpert(?:\/|$)|(?:^|\/)unit_test(?:\/|$)|_unit_test\./i.test(filePath);
}

function rankIncomingCallers(
  items: Array<NonNullable<NonNullable<BackendRelationPayload['result']>[string]['calledBy']>[number]>
): Array<NonNullable<NonNullable<BackendRelationPayload['result']>[string]['calledBy']>[number]> {
  if (items.length <= 1) return items;
  return [...items].sort((a, b) => {
    const aTest = isLikelyTestPath(a.filePath) ? 1 : 0;
    const bTest = isLikelyTestPath(b.filePath) ? 1 : 0;
    if (aTest !== bTest) return aTest - bTest;

    const aReg = a.connectionKind === 'interface_registration' ? 0 : 1;
    const bReg = b.connectionKind === 'interface_registration' ? 0 : 1;
    if (aReg !== bReg) return aReg - bReg;

    if (a.caller !== b.caller) return a.caller.localeCompare(b.caller);
    if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
    return a.lineNumber - b.lineNumber;
  });
}

function isRegistrationApiName(name: string): boolean {
  const n = name.toLowerCase();
  if (n.includes('offldmgr_register_nondata_offload')) return true;
  return (
    n.includes('register') ||
    n.includes('unregister') ||
    n.includes('subscribe') ||
    n.includes('attach') ||
    n.includes('hook') ||
    (n.includes('notif') && (n.includes('handler') || n.includes('cb') || n.includes('callback')))
  );
}
