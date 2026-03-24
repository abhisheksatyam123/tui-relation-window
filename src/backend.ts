import { resolve } from 'node:path';
import { doctorClangdMcp, fetchRelationsFromClangdMcp, normaliseWorkspaceRoot } from './lib/clangd-mcp-client';
import { clearWorkspaceCache, getCacheStats } from './lib/relation-cache';
import type { BackendMode, BackendQuery } from './lib/backend-types';
import { getLogDir, logError, logInfo } from './lib/logger';

function parseArgs(argv: string[]): BackendQuery {
  const args = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith('--')) {
      continue;
    }

    const key = current.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      args.set(key, 'true');
      continue;
    }

    args.set(key, value);
    i += 1;
  }

  const mode = (args.get('mode') || 'incoming') as BackendMode;
  if (mode !== 'incoming' && mode !== 'outgoing') {
    throw new Error(`Invalid --mode '${mode}', expected incoming|outgoing`);
  }

  const filePath = args.get('file');
  if (!filePath) {
    throw new Error('Missing required --file <absolute-or-relative-path>');
  }

  const line = Number(args.get('line') || '1');
  const character = Number(args.get('character') || '1');

  if (!Number.isFinite(line) || line <= 0) {
    throw new Error('Invalid --line, expected positive integer');
  }
  if (!Number.isFinite(character) || character <= 0) {
    throw new Error('Invalid --character, expected positive integer');
  }

  return {
    mode,
    filePath: resolve(filePath),
    line,
    character,
    workspaceRoot: args.get('workspace-root')
      ? normaliseWorkspaceRoot(args.get('workspace-root') as string)
      : undefined,
    mcpUrl: args.get('mcp-url') || undefined,
  };
}

async function main() {
  const clearCacheMode = Bun.argv.includes('--clear-cache');
  const cacheStatsMode = Bun.argv.includes('--cache-stats');
  const doctorMode = Bun.argv.includes('--doctor');
  
  // Handle cache management commands
  if (clearCacheMode || cacheStatsMode) {
    const args = new Map<string, string>();
    for (let i = 0; i < Bun.argv.length; i += 1) {
      const current = Bun.argv[i];
      if (!current.startsWith('--')) continue;
      const key = current.slice(2);
      const value = Bun.argv[i + 1];
      if (!value || value.startsWith('--')) {
        args.set(key, 'true');
        continue;
      }
      args.set(key, value);
      i += 1;
    }
    
    const workspaceRoot = args.get('workspace-root');
    if (!workspaceRoot) {
      throw new Error('--workspace-root required for cache operations');
    }
    const normalized = normaliseWorkspaceRoot(workspaceRoot);
    
    if (clearCacheMode) {
      clearWorkspaceCache(normalized);
      logInfo('backend', 'cache cleared', { workspaceRoot: normalized });
      process.stdout.write(JSON.stringify({ success: true, message: 'Cache cleared', workspaceRoot: normalized }) + '\n');
      return;
    }
    
    if (cacheStatsMode) {
      const stats = getCacheStats(normalized);
      logInfo('backend', 'cache stats', { workspaceRoot: normalized, stats });
      process.stdout.write(JSON.stringify({ success: true, stats, workspaceRoot: normalized }) + '\n');
      return;
    }
  }
  
  const query = parseArgs(Bun.argv.slice(2));
  logInfo('backend', 'backend query start', { logDir: getLogDir(), query });
  if (doctorMode) {
    const diag = await doctorClangdMcp(query);
    logInfo('backend', 'doctor success', diag);
    process.stdout.write(`${JSON.stringify({ doctor: true, ...diag })}\n`);
    return;
  }

  const payload = await fetchRelationsFromClangdMcp(query);
  logInfo('backend', 'backend query success', {
    mode: payload.mode,
    provider: payload.provider,
    roots: payload.result ? Object.keys(payload.result).length : 0,
  });
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  logError('backend', 'backend query failed', { error: message });
  process.stderr.write(`backend error: ${message}\n`);
  process.exit(1);
});
