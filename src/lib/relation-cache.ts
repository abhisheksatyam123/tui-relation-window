import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import type { BackendRelationPayload } from './backend-types';
import { logInfo, logWarn, logError } from './logger';

export type CacheQuery = {
  workspaceRoot: string;
  filePath: string;
  line: number;
  character: number;
  mode: 'incoming' | 'outgoing';
  resolvedSymbol: string;
};

export type CachedPayload = {
  payload: BackendRelationPayload;
  createdAt: number;
  lastAccessedAt: number;
};

const SCHEMA_VERSION = 1;
const CACHE_DIR_BASE = resolve(homedir(), '.local/share/clangd-mcp');

/**
 * Derive a human-readable workspace slug from the workspace root path.
 * For WLAN.CNG.* workspaces, extracts "CNG" as the slug.
 * For other workspaces, uses first 16 chars of SHA-256 hash.
 */
function deriveWorkspaceSlug(workspaceRoot: string): string {
  const normalized = resolve(workspaceRoot);
  const baseName = basename(normalized);
  
  // Pattern: WLAN.CNG.* → slug = "CNG"
  const cngMatch = baseName.match(/^WLAN\.CNG\./i);
  if (cngMatch) {
    return 'CNG';
  }
  
  // Pattern: WLAN.<PROJECT>.* → slug = "<PROJECT>"
  const wlanMatch = baseName.match(/^WLAN\.([A-Z0-9_-]+)\./i);
  if (wlanMatch) {
    return wlanMatch[1].toUpperCase();
  }
  
  // Fallback: use first 16 chars of SHA-256 hash
  const hash = createHash('sha256').update(normalized).digest('hex');
  return hash.slice(0, 16);
}

/**
 * Get the cache database path for a workspace.
 * Format: ~/.local/share/clangd-mcp/<workspace-slug>/relation-cache.db
 */
export function getCacheDbPath(workspaceRoot: string): string {
  const slug = deriveWorkspaceSlug(workspaceRoot);
  const cacheDir = resolve(CACHE_DIR_BASE, slug);
  
  // Ensure directory exists
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }
  
  return resolve(cacheDir, 'relation-cache.db');
}

/**
 * Initialize cache database with schema.
 */
export function initCache(workspaceRoot: string): Database {
  const dbPath = getCacheDbPath(workspaceRoot);
  const db = new Database(dbPath);
  
  // Create schema
  db.run(`
    CREATE TABLE IF NOT EXISTS relation_cache (
      cache_key TEXT PRIMARY KEY,
      workspace_root TEXT NOT NULL,
      file_path TEXT NOT NULL,
      line INTEGER NOT NULL,
      character INTEGER NOT NULL,
      mode TEXT NOT NULL,
      resolved_symbol TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT ${SCHEMA_VERSION},
      created_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS cache_evidence_files (
      cache_key TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      FOREIGN KEY (cache_key) REFERENCES relation_cache(cache_key) ON DELETE CASCADE,
      PRIMARY KEY (cache_key, file_path)
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_workspace_file ON relation_cache(workspace_root, file_path)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_evidence_key ON cache_evidence_files(cache_key)`);
  
  logInfo('cache', 'initialized cache database', { dbPath, workspaceRoot });
  return db;
}

/**
 * Generate deterministic cache key from query parameters.
 */
export function getCacheKey(query: CacheQuery): string {
  const normalized = {
    workspaceRoot: resolve(query.workspaceRoot),
    filePath: resolve(query.filePath),
    line: query.line,
    character: query.character,
    mode: query.mode,
    resolvedSymbol: query.resolvedSymbol,
  };
  
  const keyString = JSON.stringify(normalized);
  return createHash('sha256').update(keyString).digest('hex');
}

/**
 * Compute SHA-256 hash of file content.
 */
export function computeFileHash(filePath: string): string {
  try {
    const content = readFileSync(filePath);
    return createHash('sha256').update(content).digest('hex');
  } catch (error) {
    logWarn('cache', 'failed to compute file hash', { filePath, error: String(error) });
    // Return empty hash for missing/unreadable files
    return '';
  }
}

/**
 * Extract all evidence file paths from a relation payload.
 */
export function extractEvidenceFiles(payload: BackendRelationPayload): string[] {
  const files = new Set<string>();
  
  if (!payload.result) return [];
  
  for (const rootNode of Object.values(payload.result)) {
    if (!rootNode) continue;
    
    // Add root file
    if (rootNode.filePath) {
      files.add(resolve(rootNode.filePath));
    }
    
    // Add calledBy files
    if (Array.isArray(rootNode.calledBy)) {
      for (const caller of rootNode.calledBy) {
        if (caller?.filePath) {
          files.add(resolve(caller.filePath));
        }
      }
    }
    
    // Add calls files
    if (Array.isArray(rootNode.calls)) {
      for (const callee of rootNode.calls) {
        if (callee?.filePath) {
          files.add(resolve(callee.filePath));
        }
      }
    }
    
    // Add systemNodes files
    if (Array.isArray(rootNode.systemNodes)) {
      for (const node of rootNode.systemNodes) {
        if (node?.filePath) {
          files.add(resolve(node.filePath));
        }
      }
    }
  }
  
  return Array.from(files).sort();
}

/**
 * Look up cached payload by key.
 */
export function lookupCache(db: Database, key: string): CachedPayload | null {
  try {
    const stmt = db.query(`
      SELECT payload_json, created_at, last_accessed_at
      FROM relation_cache
      WHERE cache_key = ? AND schema_version = ?
    `);
    
    const row = stmt.get(key, SCHEMA_VERSION) as { payload_json: string; created_at: number; last_accessed_at: number } | null;
    
    if (!row) {
      return null;
    }
    
    const payload = JSON.parse(row.payload_json) as BackendRelationPayload;
    return {
      payload,
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at,
    };
  } catch (error) {
    logError('cache', 'lookup failed', { key, error: String(error) });
    return null;
  }
}

/**
 * Validate cache freshness by checking evidence file hashes.
 */
export function validateCacheFreshness(db: Database, key: string): boolean {
  try {
    const stmt = db.query(`
      SELECT file_path, file_hash
      FROM cache_evidence_files
      WHERE cache_key = ?
    `);
    
    const rows = stmt.all(key) as Array<{ file_path: string; file_hash: string }>;
    
    if (rows.length === 0) {
      logWarn('cache', 'no evidence files found for cache entry', { key });
      return false;
    }
    
    for (const row of rows) {
      const currentHash = computeFileHash(row.file_path);
      if (currentHash !== row.file_hash) {
        logInfo('cache', 'cache stale: file hash mismatch', {
          key,
          filePath: row.file_path,
          cachedHash: row.file_hash.slice(0, 8),
          currentHash: currentHash.slice(0, 8),
        });
        return false;
      }
    }
    
    return true;
  } catch (error) {
    logError('cache', 'freshness validation failed', { key, error: String(error) });
    return false;
  }
}

/**
 * Store payload in cache with evidence file hashes.
 */
export function storeCache(
  db: Database,
  key: string,
  query: CacheQuery,
  payload: BackendRelationPayload,
  evidenceFiles: string[]
): void {
  try {
    const now = Date.now();
    const payloadJson = JSON.stringify(payload);
    
    // Insert or replace cache entry
    const insertCache = db.query(`
      INSERT OR REPLACE INTO relation_cache (
        cache_key, workspace_root, file_path, line, character, mode,
        resolved_symbol, payload_json, schema_version, created_at, last_accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    insertCache.run(
      key,
      resolve(query.workspaceRoot),
      resolve(query.filePath),
      query.line,
      query.character,
      query.mode,
      query.resolvedSymbol,
      payloadJson,
      SCHEMA_VERSION,
      now,
      now
    );
    
    // Delete old evidence files
    const deleteEvidence = db.query(`DELETE FROM cache_evidence_files WHERE cache_key = ?`);
    deleteEvidence.run(key);
    
    // Insert new evidence files
    const insertEvidence = db.query(`
      INSERT INTO cache_evidence_files (cache_key, file_path, file_hash)
      VALUES (?, ?, ?)
    `);
    
    for (const filePath of evidenceFiles) {
      const fileHash = computeFileHash(filePath);
      if (fileHash) {
        insertEvidence.run(key, filePath, fileHash);
      }
    }
    
    logInfo('cache', 'stored cache entry', {
      key: key.slice(0, 8),
      symbol: query.resolvedSymbol,
      evidenceFileCount: evidenceFiles.length,
    });
  } catch (error) {
    logError('cache', 'store failed', { key, error: String(error) });
  }
}

/**
 * Update last accessed timestamp for cache entry.
 */
export function updateLastAccessed(db: Database, key: string): void {
  try {
    const stmt = db.query(`
      UPDATE relation_cache
      SET last_accessed_at = ?
      WHERE cache_key = ?
    `);
    stmt.run(Date.now(), key);
  } catch (error) {
    logError('cache', 'failed to update last accessed', { key, error: String(error) });
  }
}

/**
 * Delete cache entry and its evidence files.
 */
export function deleteCache(db: Database, key: string): void {
  try {
    const stmt = db.query(`DELETE FROM relation_cache WHERE cache_key = ?`);
    stmt.run(key);
    logInfo('cache', 'deleted stale cache entry', { key: key.slice(0, 8) });
  } catch (error) {
    logError('cache', 'delete failed', { key, error: String(error) });
  }
}

/**
 * Clear all cache entries for a workspace.
 */
export function clearWorkspaceCache(workspaceRoot: string): void {
  try {
    const db = initCache(workspaceRoot);
    const stmt = db.query(`DELETE FROM relation_cache WHERE workspace_root = ?`);
    stmt.run(resolve(workspaceRoot));
    const changes = db.query(`SELECT changes() as count`).get() as { count: number } | null;
    db.close();
    logInfo('cache', 'cleared workspace cache', {
      workspaceRoot,
      deletedCount: changes?.count || 0,
    });
  } catch (error) {
    logError('cache', 'clear workspace cache failed', {
      workspaceRoot,
      error: String(error),
    });
  }
}

/**
 * Get cache statistics for a workspace.
 */
export function getCacheStats(workspaceRoot: string): {
  entryCount: number;
  totalSize: number;
  oldestEntry: number | null;
  newestEntry: number | null;
} {
  try {
    const db = initCache(workspaceRoot);
    
    const countStmt = db.query(`
      SELECT COUNT(*) as count
      FROM relation_cache
      WHERE workspace_root = ?
    `);
    const countRow = countStmt.get(resolve(workspaceRoot)) as { count: number } | null;
    
    const sizeStmt = db.query(`
      SELECT SUM(LENGTH(payload_json)) as size
      FROM relation_cache
      WHERE workspace_root = ?
    `);
    const sizeRow = sizeStmt.get(resolve(workspaceRoot)) as { size: number | null } | null;
    
    const timeStmt = db.query(`
      SELECT MIN(created_at) as oldest, MAX(created_at) as newest
      FROM relation_cache
      WHERE workspace_root = ?
    `);
    const timeRow = timeStmt.get(resolve(workspaceRoot)) as { oldest: number | null; newest: number | null } | null;
    
    db.close();
    
    return {
      entryCount: countRow?.count || 0,
      totalSize: sizeRow?.size || 0,
      oldestEntry: timeRow?.oldest || null,
      newestEntry: timeRow?.newest || null,
    };
  } catch (error) {
    logError('cache', 'get cache stats failed', {
      workspaceRoot,
      error: String(error),
    });
    return {
      entryCount: 0,
      totalSize: 0,
      oldestEntry: null,
      newestEntry: null,
    };
  }
}
