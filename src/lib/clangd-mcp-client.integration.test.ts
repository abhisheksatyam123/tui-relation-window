import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { doctorClangdMcp, fetchRelationsFromClangdMcp } from './clangd-mcp-client';
import { startMockMcpServer } from '../../test/mock-mcp-server';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0, cleanup.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.CLANGD_MCP_URL;
});

describe('clangd-mcp client integration (mock server)', () => {
  test('doctor + incoming/outgoing queries return compatible payloads', async () => {
    const mock = await startMockMcpServer();
    process.env.CLANGD_MCP_URL = mock.url;

    const ws = mkdtempSync(join(tmpdir(), 'rw-mcp-'));
    cleanup.push(ws);
    mkdirSync(join(ws, 'src'), { recursive: true });

    const file = join(ws, 'src', 'demo.cpp');
    writeFileSync(
      file,
      [
        '#include <stdio.h>',
        'int resolve_check() { return 0; }',
        'int main() {',
        '  resolve_check();',
        '  return 0;',
        '}',
      ].join('\n'),
      'utf8'
    );

    const query = {
      mode: 'incoming' as const,
      filePath: file,
      line: 4,
      character: 1, // intentionally bad char; fallback probing should fix it
      workspaceRoot: ws,
    };

    const diag = await doctorClangdMcp(query);
    expect(diag.connected).toBe(true);
    expect(diag.mcpUrl).toContain('/mcp');
    expect(diag.hoverFirstLine.length).toBeGreaterThan(0);

    const incoming = await fetchRelationsFromClangdMcp(query);
    expect(incoming.mode).toBe('incoming');
    expect(incoming.provider).toBe('clangd-mcp');
    const inRoot = Object.keys(incoming.result || {})[0];
    expect(inRoot).toBeString();
    const inCount = incoming.result?.[inRoot]?.calledBy?.length ?? 0;
    expect(inCount).toBeGreaterThan(0);

    const outgoing = await fetchRelationsFromClangdMcp({
      ...query,
      mode: 'outgoing',
    });
    expect(outgoing.mode).toBe('outgoing');
    const outRoot = Object.keys(outgoing.result || {})[0];
    const outCount = outgoing.result?.[outRoot]?.calls?.length ?? 0;
    expect(outCount).toBeGreaterThan(0);

    await mock.close();
  });
});

