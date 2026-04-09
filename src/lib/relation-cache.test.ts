import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initCache,
  getCacheKey,
  getCacheDbPath,
  computeFileHash,
  extractEvidenceFiles,
  lookupCache,
  storeCache,
  validateCacheFreshness,
  deleteCache,
  clearWorkspaceCache,
  getCacheStats,
  type CacheQuery,
} from './relation-cache';
import type { BackendRelationPayload } from './backend-types';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0, cleanup.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'rw-cache-test-'));
  cleanup.push(ws);
  mkdirSync(join(ws, 'src'), { recursive: true });
  return ws;
}

describe('relation-cache', () => {
  describe('getCacheDbPath', () => {
    test('stores cache DB at workspace root for WLAN workspaces', () => {
      const ws = '/workspace/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1';
      const dbPath = getCacheDbPath(ws);
      expect(dbPath).toBe('/workspace/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1/relation-cache.db');
    });

    test('stores cache DB at workspace root for other WLAN workspaces', () => {
      const ws = '/workspace/WLAN.HELIUM.2.0-12345';
      const dbPath = getCacheDbPath(ws);
      expect(dbPath).toBe('/workspace/WLAN.HELIUM.2.0-12345/relation-cache.db');
    });

    test('stores cache DB at workspace root for non-WLAN workspaces', () => {
      const ws = '/workspace/my-project';
      const dbPath = getCacheDbPath(ws);
      expect(dbPath).toBe('/workspace/my-project/relation-cache.db');
    });
  });

  describe('getCacheKey', () => {
    test('produces stable hash for same query', () => {
      const query: CacheQuery = {
        workspaceRoot: '/workspace',
        filePath: '/workspace/src/foo.c',
        line: 10,
        character: 5,
        mode: 'incoming',
        resolvedSymbol: 'my_function',
      };

      const key1 = getCacheKey(query);
      const key2 = getCacheKey(query);

      expect(key1).toBe(key2);
      expect(key1).toBeString();
      expect(key1.length).toBe(64); // SHA-256 hex
    });

    test('produces different hash for different symbols', () => {
      const query1: CacheQuery = {
        workspaceRoot: '/workspace',
        filePath: '/workspace/src/foo.c',
        line: 10,
        character: 5,
        mode: 'incoming',
        resolvedSymbol: 'function_a',
      };

      const query2: CacheQuery = {
        ...query1,
        resolvedSymbol: 'function_b',
      };

      const key1 = getCacheKey(query1);
      const key2 = getCacheKey(query2);

      expect(key1).not.toBe(key2);
    });

    test('produces different hash for different modes', () => {
      const query1: CacheQuery = {
        workspaceRoot: '/workspace',
        filePath: '/workspace/src/foo.c',
        line: 10,
        character: 5,
        mode: 'incoming',
        resolvedSymbol: 'my_function',
      };

      const query2: CacheQuery = {
        ...query1,
        mode: 'outgoing',
      };

      const key1 = getCacheKey(query1);
      const key2 = getCacheKey(query2);

      expect(key1).not.toBe(key2);
    });
  });

  describe('computeFileHash', () => {
    test('returns consistent SHA-256 for file content', () => {
      const ws = makeTempWorkspace();
      const file = join(ws, 'src', 'test.c');
      writeFileSync(file, 'int main() { return 0; }\n', 'utf8');

      const hash1 = computeFileHash(file);
      const hash2 = computeFileHash(file);

      expect(hash1).toBe(hash2);
      expect(hash1).toBeString();
      expect(hash1.length).toBe(64); // SHA-256 hex
    });

    test('returns different hash for different content', () => {
      const ws = makeTempWorkspace();
      const file1 = join(ws, 'src', 'test1.c');
      const file2 = join(ws, 'src', 'test2.c');
      writeFileSync(file1, 'int main() { return 0; }\n', 'utf8');
      writeFileSync(file2, 'int main() { return 1; }\n', 'utf8');

      const hash1 = computeFileHash(file1);
      const hash2 = computeFileHash(file2);

      expect(hash1).not.toBe(hash2);
    });

    test('returns empty hash for missing file', () => {
      const hash = computeFileHash('/nonexistent/file.c');
      expect(hash).toBe('');
    });
  });

  describe('extractEvidenceFiles', () => {
    test('extracts all file paths from payload', () => {
      const payload: BackendRelationPayload = {
        mode: 'incoming',
        provider: 'intelgraph',
        result: {
          my_function: {
            filePath: '/workspace/src/target.c',
            lineNumber: 10,
            calledBy: [
              { caller: 'caller_a', filePath: '/workspace/src/caller_a.c', lineNumber: 20 },
              { caller: 'caller_b', filePath: '/workspace/src/caller_b.c', lineNumber: 30 },
            ],
            systemNodes: [
              { id: 'node1', name: 'Node1', kind: 'api', filePath: '/workspace/src/node1.c', lineNumber: 40 },
            ],
          },
        },
      };

      const files = extractEvidenceFiles(payload);

      expect(files).toContain('/workspace/src/target.c');
      expect(files).toContain('/workspace/src/caller_a.c');
      expect(files).toContain('/workspace/src/caller_b.c');
      expect(files).toContain('/workspace/src/node1.c');
      expect(files.length).toBe(4);
    });

    test('deduplicates file paths', () => {
      const payload: BackendRelationPayload = {
        mode: 'incoming',
        provider: 'intelgraph',
        result: {
          my_function: {
            filePath: '/workspace/src/target.c',
            lineNumber: 10,
            calledBy: [
              { caller: 'caller_a', filePath: '/workspace/src/target.c', lineNumber: 20 },
              { caller: 'caller_b', filePath: '/workspace/src/target.c', lineNumber: 30 },
            ],
          },
        },
      };

      const files = extractEvidenceFiles(payload);

      expect(files).toEqual(['/workspace/src/target.c']);
    });

    test('returns empty array for empty payload', () => {
      const payload: BackendRelationPayload = {
        mode: 'incoming',
        provider: 'intelgraph',
        result: null,
      };

      const files = extractEvidenceFiles(payload);

      expect(files).toEqual([]);
    });
  });

  describe('cache operations', () => {
    test('lookupCache returns null for missing key', () => {
      const ws = makeTempWorkspace();
      const db = initCache(ws);

      const result = lookupCache(db, 'nonexistent-key');

      expect(result).toBeNull();
      db.close();
    });

    test('storeCache persists payload and lookupCache retrieves it', () => {
      const ws = makeTempWorkspace();
      const db = initCache(ws);

      const query: CacheQuery = {
        workspaceRoot: ws,
        filePath: join(ws, 'src', 'test.c'),
        line: 10,
        character: 5,
        mode: 'incoming',
        resolvedSymbol: 'my_function',
      };

      const payload: BackendRelationPayload = {
        mode: 'incoming',
        provider: 'intelgraph',
        result: {
          my_function: {
            filePath: join(ws, 'src', 'test.c'),
            lineNumber: 10,
            calledBy: [{ caller: 'caller_a', filePath: join(ws, 'src', 'caller.c'), lineNumber: 20 }],
          },
        },
      };

      const key = getCacheKey(query);
      storeCache(db, key, query, payload, []);

      const cached = lookupCache(db, key);

      expect(cached).not.toBeNull();
      expect(cached?.payload.mode).toBe('incoming');
      expect(cached?.payload.provider).toBe('intelgraph');
      expect(cached?.payload.result?.my_function?.calledBy?.length).toBe(1);
      db.close();
    });

    test('validateCacheFreshness returns true when all files unchanged', () => {
      const ws = makeTempWorkspace();
      const file1 = join(ws, 'src', 'test.c');
      const file2 = join(ws, 'src', 'caller.c');
      writeFileSync(file1, 'int main() { return 0; }\n', 'utf8');
      writeFileSync(file2, 'void caller() {}\n', 'utf8');

      const db = initCache(ws);

      const query: CacheQuery = {
        workspaceRoot: ws,
        filePath: file1,
        line: 10,
        character: 5,
        mode: 'incoming',
        resolvedSymbol: 'my_function',
      };

      const payload: BackendRelationPayload = {
        mode: 'incoming',
        provider: 'intelgraph',
        result: {
          my_function: {
            filePath: file1,
            lineNumber: 10,
            calledBy: [{ caller: 'caller_a', filePath: file2, lineNumber: 20 }],
          },
        },
      };

      const key = getCacheKey(query);
      const evidenceFiles = extractEvidenceFiles(payload);
      storeCache(db, key, query, payload, evidenceFiles);

      const isFresh = validateCacheFreshness(db, key);

      expect(isFresh).toBe(true);
      db.close();
    });

    test('validateCacheFreshness returns false when any file changed', () => {
      const ws = makeTempWorkspace();
      const file1 = join(ws, 'src', 'test.c');
      const file2 = join(ws, 'src', 'caller.c');
      writeFileSync(file1, 'int main() { return 0; }\n', 'utf8');
      writeFileSync(file2, 'void caller() {}\n', 'utf8');

      const db = initCache(ws);

      const query: CacheQuery = {
        workspaceRoot: ws,
        filePath: file1,
        line: 10,
        character: 5,
        mode: 'incoming',
        resolvedSymbol: 'my_function',
      };

      const payload: BackendRelationPayload = {
        mode: 'incoming',
        provider: 'intelgraph',
        result: {
          my_function: {
            filePath: file1,
            lineNumber: 10,
            calledBy: [{ caller: 'caller_a', filePath: file2, lineNumber: 20 }],
          },
        },
      };

      const key = getCacheKey(query);
      const evidenceFiles = extractEvidenceFiles(payload);
      storeCache(db, key, query, payload, evidenceFiles);

      // Modify one of the evidence files
      writeFileSync(file2, 'void caller() { /* modified */ }\n', 'utf8');

      const isFresh = validateCacheFreshness(db, key);

      expect(isFresh).toBe(false);
      db.close();
    });

    test('deleteCache removes entry', () => {
      const ws = makeTempWorkspace();
      const db = initCache(ws);

      const query: CacheQuery = {
        workspaceRoot: ws,
        filePath: join(ws, 'src', 'test.c'),
        line: 10,
        character: 5,
        mode: 'incoming',
        resolvedSymbol: 'my_function',
      };

      const payload: BackendRelationPayload = {
        mode: 'incoming',
        provider: 'intelgraph',
        result: {
          my_function: {
            filePath: join(ws, 'src', 'test.c'),
            lineNumber: 10,
            calledBy: [],
          },
        },
      };

      const key = getCacheKey(query);
      storeCache(db, key, query, payload, []);

      expect(lookupCache(db, key)).not.toBeNull();

      deleteCache(db, key);

      expect(lookupCache(db, key)).toBeNull();
      db.close();
    });

    test('clearWorkspaceCache removes all entries for workspace', () => {
      const ws = makeTempWorkspace();
      const db = initCache(ws);

      const query1: CacheQuery = {
        workspaceRoot: ws,
        filePath: join(ws, 'src', 'test1.c'),
        line: 10,
        character: 5,
        mode: 'incoming',
        resolvedSymbol: 'function_a',
      };

      const query2: CacheQuery = {
        workspaceRoot: ws,
        filePath: join(ws, 'src', 'test2.c'),
        line: 20,
        character: 10,
        mode: 'incoming',
        resolvedSymbol: 'function_b',
      };

      const payload: BackendRelationPayload = {
        mode: 'incoming',
        provider: 'intelgraph',
        result: {
          test: {
            filePath: join(ws, 'src', 'test.c'),
            lineNumber: 10,
            calledBy: [],
          },
        },
      };

      const key1 = getCacheKey(query1);
      const key2 = getCacheKey(query2);
      storeCache(db, key1, query1, payload, []);
      storeCache(db, key2, query2, payload, []);

      expect(lookupCache(db, key1)).not.toBeNull();
      expect(lookupCache(db, key2)).not.toBeNull();

      db.close();

      clearWorkspaceCache(ws);

      const db2 = initCache(ws);
      expect(lookupCache(db2, key1)).toBeNull();
      expect(lookupCache(db2, key2)).toBeNull();
      db2.close();
    });

    test('getCacheStats returns correct counts', () => {
      const ws = makeTempWorkspace();
      const db = initCache(ws);

      const query: CacheQuery = {
        workspaceRoot: ws,
        filePath: join(ws, 'src', 'test.c'),
        line: 10,
        character: 5,
        mode: 'incoming',
        resolvedSymbol: 'my_function',
      };

      const payload: BackendRelationPayload = {
        mode: 'incoming',
        provider: 'intelgraph',
        result: {
          my_function: {
            filePath: join(ws, 'src', 'test.c'),
            lineNumber: 10,
            calledBy: [],
          },
        },
      };

      const key = getCacheKey(query);
      storeCache(db, key, query, payload, []);
      db.close();

      const stats = getCacheStats(ws);

      expect(stats.entryCount).toBe(1);
      expect(stats.totalSize).toBeGreaterThan(0);
      expect(stats.oldestEntry).not.toBeNull();
      expect(stats.newestEntry).not.toBeNull();
    });
  });
});
