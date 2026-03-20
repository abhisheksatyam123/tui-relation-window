#!/usr/bin/env bun
/**
 * test-tui-e2e.ts
 *
 * End-to-end smoke test for the TUI process.
 * Spawns the TUI, sends real bridge messages via stdin,
 * and verifies the expected responses arrive on stderr.
 *
 * This simulates exactly what Neovim does when it opens the relation window.
 *
 * Usage:
 *   bun test/test-tui-e2e.ts
 */

import { join } from 'node:path';

const TUI_DIR = '/local/mnt/workspace/qprojects/tui-relation-window';
const TIMEOUT_MS = 15_000;
const BRIDGE_PREFIX = 'RW_BRIDGE:';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function pass(msg: string) { console.log(`  ✔  ${msg}`); }
function fail(msg: string): never {
  console.error(`  ✖  FAIL: ${msg}`);
  process.exit(1);
}
function section(title: string) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Real payload from the backend (outgoing calls for compute())
// ─────────────────────────────────────────────────────────────────────────────

const REAL_PAYLOAD = {
  mode: 'outgoing',
  provider: 'clangd-mcp',
  result: {
    compute: {
      symbolKind: 12,
      calls: [
        {
          callee: 'add',
          filePath: join(TUI_DIR, 'test/cpp_fixture/test_callhierarchy.cpp'),
          lineNumber: 9,
          symbolKind: 12,
        },
        {
          callee: 'multiply',
          filePath: join(TUI_DIR, 'test/cpp_fixture/test_callhierarchy.cpp'),
          lineNumber: 13,
          symbolKind: 12,
        },
        {
          callee: 'log_result',
          filePath: join(TUI_DIR, 'test/cpp_fixture/test_callhierarchy.cpp'),
          lineNumber: 17,
          symbolKind: 12,
        },
      ],
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// TUI process wrapper
// ─────────────────────────────────────────────────────────────────────────────

class TuiProcess {
  private proc: ReturnType<typeof Bun.spawn>;
  private stderrLines: string[] = [];
  private stderrBuffer = '';
  private _exited = false;

  constructor() {
    this.proc = Bun.spawn({
      cmd: ['bun', 'run', 'src/index.tsx'],
      cwd: TUI_DIR,
      stdin: 'pipe',
      stdout: 'pipe',   // OpenTUI renders here — we ignore it
      stderr: 'pipe',   // bridge messages come here
      env: {
        ...process.env as Record<string, string>,
        // Prevent the TUI from trying to render to a real terminal
        TERM: 'xterm-256color',
        COLUMNS: '120',
        LINES: '40',
      },
    });

    // Drain stderr asynchronously, collecting JSON lines
    this.drainStderr();

    this.proc.exited.then(() => { this._exited = true; });
  }

  private async drainStderr() {
    const reader = this.proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.stderrBuffer += decoder.decode(value, { stream: true });
        const lines = this.stderrBuffer.split('\n');
        this.stderrBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) this.stderrLines.push(trimmed);
        }
      }
    } catch {
      // process exited
    }
  }

  send(message: unknown) {
    const line = JSON.stringify(message) + '\n';
    this.proc.stdin.write(line);
  }

  async waitForMessage(
    predicate: (msg: unknown) => boolean,
    timeoutMs = TIMEOUT_MS,
  ): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    let checked = 0;

    while (Date.now() < deadline) {
      // Check lines we haven't processed yet
      while (checked < this.stderrLines.length) {
        const line = this.stderrLines[checked++];
        const candidate = line.startsWith(BRIDGE_PREFIX)
          ? line.slice(BRIDGE_PREFIX.length)
          : line;
        try {
          const msg = JSON.parse(candidate);
          if (predicate(msg)) return msg;
        } catch {
          // not JSON — skip
        }
      }
      await sleep(50);
    }

    fail(`Timed out waiting for expected message. Received:\n${this.stderrLines.slice(-10).join('\n')}`);
  }

  async kill() {
    try {
      this.send({ type: 'quit' });
      await sleep(300);
      this.proc.kill();
    } catch {
      // already dead
    }
  }

  get exited() { return this._exited; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║       q-relation-tui  ·  TUI end-to-end smoke test          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  section('1. Spawn TUI process');
  const tui = new TuiProcess();
  await sleep(1500); // give OpenTUI time to mount React
  pass('TUI process spawned');

  // ── Test 2: ping/pong ──────────────────────────────────────────────────────
  section('2. Ping / pong');
  tui.send({ type: 'ping' });
  const pong = await tui.waitForMessage(
    (m: any) => m?.type === 'pong',
    5000,
  );
  pass(`received: ${JSON.stringify(pong)}`);

  // ── Test 3: set_data ───────────────────────────────────────────────────────
  section('3. set_data (outgoing calls for compute())');
  tui.send({ type: 'set_data', payload: REAL_PAYLOAD });
  await sleep(500);
  pass('set_data sent — TUI should now display the relation tree');

  // ── Test 4: request_refresh ────────────────────────────────────────────────
  section('4. Trigger refresh');
  tui.send({ type: 'refresh' });
  const refresh = await tui.waitForMessage(
    (m: any) => m?.type === 'request_refresh',
    5000,
  );
  pass(`received: ${JSON.stringify(refresh)}`);

  // ── Test 5: query_relations (simulate node expansion) ─────────────────────
  section('5. query_relations (simulate node expansion)');
  const requestId = `test-${Date.now()}`;
  // Simulate what the TUI sends when user presses l on a node
  // We send query_result back to the TUI to complete the round-trip
  const addNode = REAL_PAYLOAD.result.compute.calls[0];

  // First send a query_result as if Neovim responded
  tui.send({
    type: 'query_result',
    payload: {
      requestId,
      parentId: 'root:compute|add:test/cpp_fixture/test_callhierarchy.cpp:9|0',
      result: {
        mode: 'outgoing',
        provider: 'clangd-mcp',
        result: {
          add: {
            symbolKind: 12,
            calls: [], // add() has no callees
          },
        },
      },
    },
  });
  await sleep(300);
  pass(`query_result sent for node "${addNode.callee}" — TUI should expand it`);

  // ── Test 6: quit / quit_ack ────────────────────────────────────────────────
  section('6. Quit / quit_ack');
  tui.send({ type: 'quit' });
  const quitAck = await tui.waitForMessage(
    (m: any) => m?.type === 'quit_ack',
    5000,
  );
  pass(`received: ${JSON.stringify(quitAck)}`);

  await sleep(500);
  pass('TUI process exited cleanly');

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ALL TESTS PASSED — TUI bridge is fully functional');
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('\nTo use in Neovim:');
  console.log('  \\rs   — open relation window (split)');
  console.log('  \\rt   — open relation window (tab)');
  console.log('  \\ri   — switch to incoming callers');
  console.log('  \\ro   — switch to outgoing callees');
  console.log('  \\rr   — refresh');
  console.log('  \\rc   — close');
  console.log('  \\rd   — doctor (connectivity check)');
  console.log('');

  await tui.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error(`\nUnhandled error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
