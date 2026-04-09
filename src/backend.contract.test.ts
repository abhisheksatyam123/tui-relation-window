import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startMockMcpServer } from '../test/mock-mcp-server';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0, cleanup.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'rw-backend-'));
  cleanup.push(ws);
  mkdirSync(join(ws, 'src'), { recursive: true });

  const file = join(ws, 'src', 'demo.cpp');
  writeFileSync(
    file,
    [
      'int resolve_check() { return 0; }',
      'int main() {',
      '  resolve_check();',
      '  return 0;',
      '}',
    ].join('\n'),
    'utf8'
  );

  return { ws, file };
}

describe('backend process contract', () => {
  test('backend doctor and incoming mode output valid JSON contract', async () => {
    const mock = await startMockMcpServer();
    const { ws, file } = makeTempWorkspace();

    const baseArgs = [
      '--file', file,
      '--line', '3',
      '--character', '1',
      '--workspace-root', ws,
    ];

    const doctor = await runBackend(['--doctor', '--mode', 'incoming', ...baseArgs], {
      INTELGRAPH_URL: mock.url,
      TUI_RELATION_MCP_AUTOSTART: '0',
    });
    expect(doctor.doctor).toBe(true);
    expect(doctor.connected).toBe(true);
    expect(doctor.mcpUrl).toContain('/mcp');

    const incoming = await runBackend(['--mode', 'incoming', ...baseArgs], {
      INTELGRAPH_URL: mock.url,
      TUI_RELATION_MCP_AUTOSTART: '0',
    });
    expect(incoming.mode).toBe('incoming');
    expect(incoming.provider).toBe('intelgraph');
    const root = Object.keys(incoming.result || {})[0];
    expect(root).toBeString();
    // Mock now returns a real get_callers response — assert on actual callers.
    const calledBy: unknown[] = incoming.result?.[root]?.calledBy ?? [];
    expect(Array.isArray(calledBy)).toBe(true);
    // alpha_caller should appear as a direct caller
    expect(calledBy.some((c: unknown) => (c as { caller?: string })?.caller === 'alpha_caller')).toBe(true);
    // setup_handlers should appear as a registrar (interface_registration)
    const registrar = calledBy.find(
      (c: unknown) => (c as { caller?: string })?.caller === 'setup_handlers',
    ) as { connectionKind?: string } | undefined;
    expect(registrar).toBeDefined();
    expect(registrar?.connectionKind).toBe('interface_registration');

    await mock.close();
  });

  // TEST-009: outgoing mode contract test
  test('backend outgoing mode output valid JSON contract', async () => {
    const mock = await startMockMcpServer();
    const { ws, file } = makeTempWorkspace();

    const baseArgs = [
      '--file', file,
      '--line', '3',
      '--character', '1',
      '--workspace-root', ws,
    ];

    const outgoing = await runBackend(['--mode', 'outgoing', ...baseArgs], {
      INTELGRAPH_URL: mock.url,
      TUI_RELATION_MCP_AUTOSTART: '0',
    });
    expect(outgoing.mode).toBe('outgoing');
    expect(outgoing.provider).toBe('intelgraph');
    const root = Object.keys(outgoing.result || {})[0];
    expect(root).toBeString();
    expect((outgoing.result?.[root]?.calls || []).length).toBeGreaterThan(0);

    await mock.close();
  });

  // TEST: workspace-root pointing to .git dir is auto-corrected (BUG-018 guard)
  test('backend normalises .git workspace-root to parent', async () => {
    const mock = await startMockMcpServer();
    const { ws, file } = makeTempWorkspace();

    // Simulate Neovim passing .git as workspace-root
    const gitDir = join(ws, '.git');
    mkdirSync(gitDir, { recursive: true });

    const result = await runBackend([
      '--doctor', '--mode', 'incoming',
      '--file', file,
      '--line', '3',
      '--character', '1',
      '--workspace-root', gitDir,   // intentionally wrong
    ], {
      INTELGRAPH_URL: mock.url,
      TUI_RELATION_MCP_AUTOSTART: '0',
    });

    // workspaceRoot in the response should be the parent, not .git
    expect(result.workspaceRoot).toBe(ws);
    expect(result.connected).toBe(true);

    await mock.close();
  });
});

async function runBackend(args: string[], extraEnv: Record<string, string>) {
  const proc = Bun.spawn({
    cmd: ['bun', 'run', 'src/backend.ts', ...args],
    cwd: '/local/mnt/workspace/qprojects/tui-relation-window',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      ...extraEnv,
    },
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`backend failed (${code}): ${stderr || stdout}`);
  }

  return JSON.parse(stdout.trim());
}
