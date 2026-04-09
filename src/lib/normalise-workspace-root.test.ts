/**
 * Direct unit tests for normaliseWorkspaceRoot.
 *
 * The function resolves the raw path and, if the basename is a VCS marker
 * directory (.git, .hg, .svn) AND that path is a real directory on disk,
 * returns the parent. Otherwise it returns the resolved path.
 *
 * Tests that require a real directory on disk use mkdtempSync so they are
 * hermetic and clean up after themselves.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { normaliseWorkspaceRoot } from './intelgraph-client';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0, cleanup.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rw-nwr-'));
  cleanup.push(dir);
  return dir;
}

describe('normaliseWorkspaceRoot', () => {
  test('returns resolved path unchanged when no VCS marker in basename', () => {
    const ws = makeTempDir();
    expect(normaliseWorkspaceRoot(ws)).toBe(resolve(ws));
  });

  test('returns parent when path ends with .git and .git is a real directory', () => {
    const ws = makeTempDir();
    const gitDir = join(ws, '.git');
    mkdirSync(gitDir);

    expect(normaliseWorkspaceRoot(gitDir)).toBe(ws);
  });

  test('returns parent when path ends with .hg and .hg is a real directory', () => {
    const ws = makeTempDir();
    const hgDir = join(ws, '.hg');
    mkdirSync(hgDir);

    expect(normaliseWorkspaceRoot(hgDir)).toBe(ws);
  });

  test('returns parent when path ends with .svn and .svn is a real directory', () => {
    const ws = makeTempDir();
    const svnDir = join(ws, '.svn');
    mkdirSync(svnDir);

    expect(normaliseWorkspaceRoot(svnDir)).toBe(ws);
  });

  test('returns resolved path as-is when .git does not exist on disk (stat fails)', () => {
    // Path looks like it ends with .git but the directory does not exist
    const nonExistent = '/tmp/some-project/.git';
    // stat will throw → function returns the resolved path unchanged
    expect(normaliseWorkspaceRoot(nonExistent)).toBe(resolve(nonExistent));
  });

  test('resolves relative paths to absolute', () => {
    // A relative path that does not end with a VCS marker
    const result = normaliseWorkspaceRoot('.');
    expect(result).toBe(resolve('.'));
    expect(result.startsWith('/')).toBe(true);
  });

  test('handles nested .git path — returns direct parent, not project root', () => {
    // /tmp/ws/subdir/.git → should return /tmp/ws/subdir
    const ws = makeTempDir();
    const subdir = join(ws, 'subdir');
    mkdirSync(subdir);
    const gitDir = join(subdir, '.git');
    mkdirSync(gitDir);

    expect(normaliseWorkspaceRoot(gitDir)).toBe(subdir);
  });

  test('does not strip .git when it is a file, not a directory', () => {
    // .git can be a file (git worktrees) — must not strip in that case
    const ws = makeTempDir();
    const gitFile = join(ws, '.git');
    // Write a file named .git (simulating a git worktree)
    Bun.write(gitFile, 'gitdir: ../.git/worktrees/foo');

    // stat succeeds but isDirectory() is false → return resolved path unchanged
    expect(normaliseWorkspaceRoot(gitFile)).toBe(resolve(gitFile));
  });

  test('handles a normal project path with .git in a parent segment (not basename)', () => {
    // /home/user/.git/hooks — basename is "hooks", not ".git"
    // This should NOT be stripped
    const ws = makeTempDir();
    const gitDir = join(ws, '.git');
    mkdirSync(gitDir);
    const hooksDir = join(gitDir, 'hooks');
    mkdirSync(hooksDir);

    // basename is "hooks" — not a VCS marker — return resolved path
    expect(normaliseWorkspaceRoot(hooksDir)).toBe(resolve(hooksDir));
  });
});
