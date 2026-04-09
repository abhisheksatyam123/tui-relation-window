/**
 * bridge-dispatch.test.ts
 *
 * Tests for bridge message dispatch lifecycle:
 *   - onBridgeMessage + startBridge (stdin mode)
 *   - sendBridgeMessage (stderr + outbox file mode)
 *   - inbox file mode (processInboxChunk)
 *   - pending queue (messages arrive before listener registered)
 *   - error resilience (malformed JSON, unknown types)
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onBridgeMessage, sendBridgeMessage, startBridge, __test } from './bridge';
import type { BridgeIncomingMessage, BridgeOutgoingMessage } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Emit a line of text on process.stdin as if Neovim sent it. */
function emitStdinLine(line: string) {
  process.stdin.emit('data', `${line}\n`);
}

/** Capture all writes to process.stderr during fn(), return them joined. */
async function captureStderr(fn: () => void | Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  // @ts-ignore — override for test
  process.stderr.write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  try {
    await fn();
  } finally {
    // @ts-ignore
    process.stderr.write = orig;
  }
  return chunks.join('');
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  __test.resetForTest();
});

afterEach(() => {
  __test.resetForTest();
});

// ---------------------------------------------------------------------------
// 1. onBridgeMessage + startBridge — stdin dispatch
// ---------------------------------------------------------------------------

describe('onBridgeMessage + startBridge — stdin dispatch', () => {
  test('set_data message dispatched to registered listener', () => {
    startBridge();
    const received: BridgeIncomingMessage[] = [];
    onBridgeMessage((msg) => received.push(msg));

    const payload = { mode: 'incoming' as const, result: null };
    emitStdinLine(JSON.stringify({ type: 'set_data', payload }));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: 'set_data', payload });
  });

  test('query_result message dispatched to registered listener', () => {
    startBridge();
    const received: BridgeIncomingMessage[] = [];
    onBridgeMessage((msg) => received.push(msg));

    const msg = {
      type: 'query_result' as const,
      payload: { requestId: 'r1', parentId: 'p1', result: { mode: 'outgoing' as const, result: null } },
    };
    emitStdinLine(JSON.stringify(msg));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(msg);
  });

  test('query_error message dispatched to registered listener', () => {
    startBridge();
    const received: BridgeIncomingMessage[] = [];
    onBridgeMessage((msg) => received.push(msg));

    const msg = { type: 'query_error' as const, payload: { requestId: 'r2', parentId: 'p2', error: 'timeout' } };
    emitStdinLine(JSON.stringify(msg));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(msg);
  });

  test('refresh message dispatched', () => {
    startBridge();
    const received: BridgeIncomingMessage[] = [];
    onBridgeMessage((msg) => received.push(msg));

    emitStdinLine(JSON.stringify({ type: 'refresh' }));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: 'refresh' });
  });

  test('ping message dispatched', () => {
    startBridge();
    const received: BridgeIncomingMessage[] = [];
    onBridgeMessage((msg) => received.push(msg));

    emitStdinLine(JSON.stringify({ type: 'ping' }));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: 'ping' });
  });

  test('multiple listeners all receive the same message', () => {
    startBridge();
    const a: BridgeIncomingMessage[] = [];
    const b: BridgeIncomingMessage[] = [];
    onBridgeMessage((msg) => a.push(msg));
    onBridgeMessage((msg) => b.push(msg));

    emitStdinLine(JSON.stringify({ type: 'refresh' }));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).toEqual(b[0]);
  });

  test('unsubscribe stops delivery', () => {
    startBridge();
    const received: BridgeIncomingMessage[] = [];
    const unsub = onBridgeMessage((msg) => received.push(msg));

    emitStdinLine(JSON.stringify({ type: 'ping' }));
    expect(received).toHaveLength(1);

    unsub();
    emitStdinLine(JSON.stringify({ type: 'ping' }));
    expect(received).toHaveLength(1); // no new delivery
  });

  test('malformed JSON does not crash and is silently ignored', () => {
    startBridge();
    const received: BridgeIncomingMessage[] = [];
    onBridgeMessage((msg) => received.push(msg));

    expect(() => emitStdinLine('{ not valid json }')).not.toThrow();
    expect(received).toHaveLength(0);
  });

  test('non-JSON line (no braces) does not crash', () => {
    startBridge();
    const received: BridgeIncomingMessage[] = [];
    onBridgeMessage((msg) => received.push(msg));

    expect(() => emitStdinLine('just plain text')).not.toThrow();
    expect(received).toHaveLength(0);
  });

  test('empty line does not crash', () => {
    startBridge();
    const received: BridgeIncomingMessage[] = [];
    onBridgeMessage((msg) => received.push(msg));

    expect(() => emitStdinLine('')).not.toThrow();
    expect(received).toHaveLength(0);
  });

  test('ANSI-wrapped JSON is stripped and dispatched', () => {
    startBridge();
    const received: BridgeIncomingMessage[] = [];
    onBridgeMessage((msg) => received.push(msg));

    const noisy = '\u001bP>|libvterm(0.3)\u001b\\{"type":"ping"}';
    emitStdinLine(noisy);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: 'ping' });
  });

  test('multi-line chunk: both messages dispatched', () => {
    startBridge();
    const received: BridgeIncomingMessage[] = [];
    onBridgeMessage((msg) => received.push(msg));

    // Emit two messages in one chunk (no trailing newline on second — stays in buffer)
    process.stdin.emit('data', '{"type":"ping"}\n{"type":"refresh"}\n');

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ type: 'ping' });
    expect(received[1]).toEqual({ type: 'refresh' });
  });
});

// ---------------------------------------------------------------------------
// 2. Pending queue — messages arrive before listener registered
// ---------------------------------------------------------------------------

describe('pending queue', () => {
  test('messages queued before listener registered are flushed on registration', () => {
    startBridge();
    // No listener yet — message goes to pending
    emitStdinLine(JSON.stringify({ type: 'ping' }));
    emitStdinLine(JSON.stringify({ type: 'refresh' }));

    const received: BridgeIncomingMessage[] = [];
    onBridgeMessage((msg) => received.push(msg));

    // Both pending messages should be flushed immediately
    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ type: 'ping' });
    expect(received[1]).toEqual({ type: 'refresh' });
  });

  test('pending queue is cleared after flush', () => {
    startBridge();
    emitStdinLine(JSON.stringify({ type: 'ping' }));

    const first: BridgeIncomingMessage[] = [];
    onBridgeMessage((msg) => first.push(msg));
    expect(first).toHaveLength(1);

    // Second listener registered after flush — should NOT receive the already-flushed message
    const second: BridgeIncomingMessage[] = [];
    onBridgeMessage((msg) => second.push(msg));
    expect(second).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. sendBridgeMessage — outgoing messages via stderr
// ---------------------------------------------------------------------------

describe('sendBridgeMessage — stderr output', () => {
  test('query_relations message written to stderr with RW_BRIDGE: prefix', async () => {
    const msg: BridgeOutgoingMessage = {
      type: 'query_relations',
      payload: {
        requestId: 'req-1',
        parentId: 'parent-1',
        filePath: '/src/foo.c',
        lineNumber: 42,
        mode: 'incoming',
      },
    };

    const output = await captureStderr(() => sendBridgeMessage(msg));

    expect(output).toContain('RW_BRIDGE:');
    const jsonPart = output.replace('RW_BRIDGE:', '').trim();
    const parsed = JSON.parse(jsonPart);
    expect(parsed).toEqual(msg);
  });

  test('open_location message written to stderr with correct shape', async () => {
    const msg: BridgeOutgoingMessage = {
      type: 'open_location',
      payload: { filePath: '/src/bar.c', lineNumber: 10, label: 'myFunc' },
    };

    const output = await captureStderr(() => sendBridgeMessage(msg));

    expect(output).toContain('RW_BRIDGE:');
    const jsonPart = output.replace('RW_BRIDGE:', '').trim();
    const parsed = JSON.parse(jsonPart);
    expect(parsed).toEqual(msg);
  });

  test('request_refresh message written to stderr', async () => {
    const msg: BridgeOutgoingMessage = { type: 'request_refresh' };
    const output = await captureStderr(() => sendBridgeMessage(msg));
    expect(output).toContain('RW_BRIDGE:');
    const jsonPart = output.replace('RW_BRIDGE:', '').trim();
    expect(JSON.parse(jsonPart)).toEqual(msg);
  });

  test('pong message written to stderr', async () => {
    const msg: BridgeOutgoingMessage = { type: 'pong' };
    const output = await captureStderr(() => sendBridgeMessage(msg));
    expect(output).toContain('RW_BRIDGE:');
    const jsonPart = output.replace('RW_BRIDGE:', '').trim();
    expect(JSON.parse(jsonPart)).toEqual(msg);
  });

  test('output is newline-terminated', async () => {
    const msg: BridgeOutgoingMessage = { type: 'pong' };
    const output = await captureStderr(() => sendBridgeMessage(msg));
    expect(output.endsWith('\n')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Inbox file mode — processInboxChunk (exposed via __test)
// ---------------------------------------------------------------------------

describe('inbox file mode — processInboxChunk', () => {
  test('set_data chunk dispatched via processInboxChunk', () => {
    const received: BridgeIncomingMessage[] = [];
    onBridgeMessage((msg) => received.push(msg));

    const payload = { mode: 'both' as const, result: null };
    __test.processInboxChunk(JSON.stringify({ type: 'set_data', payload }) + '\n');

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: 'set_data', payload });
  });

  test('query_result chunk dispatched via processInboxChunk', () => {
    const received: BridgeIncomingMessage[] = [];
    onBridgeMessage((msg) => received.push(msg));

    const msg = {
      type: 'query_result' as const,
      payload: { requestId: 'r3', parentId: 'p3', result: { mode: 'incoming' as const, result: null } },
    };
    __test.processInboxChunk(JSON.stringify(msg) + '\n');

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(msg);
  });

  test('query_error chunk dispatched via processInboxChunk', () => {
    const received: BridgeIncomingMessage[] = [];
    onBridgeMessage((msg) => received.push(msg));

    const msg = { type: 'query_error' as const, payload: { requestId: 'r4', parentId: 'p4', error: 'not found' } };
    __test.processInboxChunk(JSON.stringify(msg) + '\n');

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(msg);
  });

  test('multiple messages in one chunk all dispatched', () => {
    const received: BridgeIncomingMessage[] = [];
    onBridgeMessage((msg) => received.push(msg));

    const chunk =
      JSON.stringify({ type: 'ping' }) + '\n' +
      JSON.stringify({ type: 'refresh' }) + '\n';
    __test.processInboxChunk(chunk);

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ type: 'ping' });
    expect(received[1]).toEqual({ type: 'refresh' });
  });

  test('partial line buffered until newline arrives', () => {
    const received: BridgeIncomingMessage[] = [];
    onBridgeMessage((msg) => received.push(msg));

    const full = JSON.stringify({ type: 'ping' });
    // Send first half — no newline yet
    __test.processInboxChunk(full.slice(0, 5));
    expect(received).toHaveLength(0);

    // Send rest + newline
    __test.processInboxChunk(full.slice(5) + '\n');
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: 'ping' });
  });

  test('malformed JSON in chunk does not crash', () => {
    const received: BridgeIncomingMessage[] = [];
    onBridgeMessage((msg) => received.push(msg));

    expect(() => __test.processInboxChunk('{ bad json }\n')).not.toThrow();
    expect(received).toHaveLength(0);
  });

  test('empty chunk is a no-op', () => {
    const received: BridgeIncomingMessage[] = [];
    onBridgeMessage((msg) => received.push(msg));

    expect(() => __test.processInboxChunk('')).not.toThrow();
    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Outbox file mode — sendBridgeMessage writes to file when outboxPath set
// ---------------------------------------------------------------------------

describe('outbox file mode — sendBridgeMessage writes to file', () => {
  let tmpDir: string;
  let outboxFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bridge-test-'));
    outboxFile = join(tmpDir, 'outbox.jsonl');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('query_relations written to outbox file when RW_BRIDGE_OUTBOX is set', async () => {
    // We test the file-write path by running a subprocess with the env var set.
    const msg: BridgeOutgoingMessage = {
      type: 'query_relations',
      payload: {
        requestId: 'req-file-1',
        parentId: 'parent-file-1',
        filePath: '/src/baz.c',
        lineNumber: 99,
        mode: 'outgoing',
      },
    };

    const script = `
      import { sendBridgeMessage } from '${import.meta.dir}/bridge.ts';
      sendBridgeMessage(${JSON.stringify(msg)});
    `;

    const result = Bun.spawnSync({
      cmd: ['bun', '--eval', script],
      env: { ...process.env, RW_BRIDGE_OUTBOX: outboxFile },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const fileContent = readFileSync(outboxFile, 'utf8').trim();
    const parsed = JSON.parse(fileContent);
    expect(parsed).toEqual(msg);
  });

  test('open_location written to outbox file', async () => {
    const msg: BridgeOutgoingMessage = {
      type: 'open_location',
      payload: { filePath: '/src/qux.c', lineNumber: 5, label: 'quxFunc' },
    };

    const script = `
      import { sendBridgeMessage } from '${import.meta.dir}/bridge.ts';
      sendBridgeMessage(${JSON.stringify(msg)});
    `;

    Bun.spawnSync({
      cmd: ['bun', '--eval', script],
      env: { ...process.env, RW_BRIDGE_OUTBOX: outboxFile },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const fileContent = readFileSync(outboxFile, 'utf8').trim();
    const parsed = JSON.parse(fileContent);
    expect(parsed).toEqual(msg);
  });

  test('multiple messages appended to outbox file', async () => {
    const msgs: BridgeOutgoingMessage[] = [
      { type: 'pong' },
      { type: 'request_refresh' },
    ];

    const script = `
      import { sendBridgeMessage } from '${import.meta.dir}/bridge.ts';
      sendBridgeMessage(${JSON.stringify(msgs[0])});
      sendBridgeMessage(${JSON.stringify(msgs[1])});
    `;

    Bun.spawnSync({
      cmd: ['bun', '--eval', script],
      env: { ...process.env, RW_BRIDGE_OUTBOX: outboxFile },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const lines = readFileSync(outboxFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(msgs[0]);
    expect(JSON.parse(lines[1])).toEqual(msgs[1]);
  });
});

// ---------------------------------------------------------------------------
// 6. Outbox file creation failure — sendBridgeMessage fallback behavior
// ---------------------------------------------------------------------------

describe('outbox file creation failure — fallback to stderr', () => {
  /**
   * When RW_BRIDGE_OUTBOX is set to a path whose parent directory does not
   * exist, appendFileSync throws ENOENT. The bridge catches this error and
   * falls back to writing the message to stderr with the RW_BRIDGE: prefix.
   *
   * This is a known limitation: if the outbox file cannot be created, the
   * message is NOT lost — it falls back to stderr. Neovim reads stderr for
   * RW_BRIDGE: prefixed messages, so the message is still delivered.
   *
   * Source: bridge.ts lines 63-76
   *   try { appendFileSync(outboxPath, ...) } catch { logError(...); }
   *   // fallthrough to: process.stderr.write(`RW_BRIDGE:${JSON.stringify(message)}\n`)
   */
  test('when outbox path is invalid (nonexistent dir), message falls back to stderr', async () => {
    const msg: BridgeOutgoingMessage = {
      type: 'query_relations',
      payload: {
        requestId: 'req-fallback-1',
        parentId: 'parent-fallback-1',
        filePath: '/src/foo.c',
        lineNumber: 42,
        mode: 'incoming',
      },
    };

    // Use a path whose parent directory does not exist
    const invalidOutboxPath = '/nonexistent/dir/that/cannot/exist/outbox.txt';

    const script = `
      import { sendBridgeMessage } from '${import.meta.dir}/bridge.ts';
      sendBridgeMessage(${JSON.stringify(msg)});
    `;

    const result = Bun.spawnSync({
      cmd: ['bun', '--eval', script],
      env: { ...process.env, RW_BRIDGE_OUTBOX: invalidOutboxPath },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stderrOutput = result.stderr.toString('utf8');

    // The message must appear on stderr with the RW_BRIDGE: prefix
    expect(stderrOutput).toContain('RW_BRIDGE:');
    const bridgeLine = stderrOutput
      .split('\n')
      .find((line) => line.startsWith('RW_BRIDGE:'));
    expect(bridgeLine).toBeDefined();

    const jsonPart = bridgeLine!.replace('RW_BRIDGE:', '').trim();
    const parsed = JSON.parse(jsonPart);
    expect(parsed).toEqual(msg);
  });

  test('when outbox path is invalid, process does not crash', async () => {
    const msg: BridgeOutgoingMessage = { type: 'pong' };
    const invalidOutboxPath = '/nonexistent/dir/outbox.txt';

    const script = `
      import { sendBridgeMessage } from '${import.meta.dir}/bridge.ts';
      sendBridgeMessage(${JSON.stringify(msg)});
      process.exit(0);
    `;

    const result = Bun.spawnSync({
      cmd: ['bun', '--eval', script],
      env: { ...process.env, RW_BRIDGE_OUTBOX: invalidOutboxPath },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Process must exit cleanly (exit code 0)
    expect(result.exitCode).toBe(0);
  });

  test('when outbox path is invalid, fallback stderr message is newline-terminated', async () => {
    const msg: BridgeOutgoingMessage = { type: 'request_refresh' };
    const invalidOutboxPath = '/nonexistent/dir/outbox.txt';

    const script = `
      import { sendBridgeMessage } from '${import.meta.dir}/bridge.ts';
      sendBridgeMessage(${JSON.stringify(msg)});
    `;

    const result = Bun.spawnSync({
      cmd: ['bun', '--eval', script],
      env: { ...process.env, RW_BRIDGE_OUTBOX: invalidOutboxPath },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stderrOutput = result.stderr.toString('utf8');
    const bridgeLine = stderrOutput
      .split('\n')
      .find((line) => line.startsWith('RW_BRIDGE:'));
    expect(bridgeLine).toBeDefined();
    // The full output line ends with \n (split removes it, but the raw output has it)
    expect(stderrOutput).toMatch(/RW_BRIDGE:.*\n/);
  });

  // KNOWN LIMITATION: if outbox write fails AND stderr is also unavailable,
  // the message is silently lost. In practice, stderr is always available
  // in the Neovim terminal session, so this is not a concern in production.
  // The fallback is: outbox failure → stderr (with RW_BRIDGE: prefix).
});

// ---------------------------------------------------------------------------
// 7. Inbox file mode — full poll cycle via subprocess
// ---------------------------------------------------------------------------

describe('inbox file mode — full poll cycle', () => {
  let tmpDir: string;
  let inboxFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bridge-inbox-test-'));
    inboxFile = join(tmpDir, 'inbox.jsonl');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('message written to inbox file is read and dispatched', async () => {
    const msg = { type: 'ping' };
    const outFile = join(tmpDir, 'received.json');

    // Script: start bridge in inbox mode, register listener, write message to inbox,
    // wait for poll interval, then write received messages to outFile.
    const script = `
      import { startBridge, onBridgeMessage } from '${import.meta.dir}/bridge.ts';
      import { writeFileSync, appendFileSync } from 'node:fs';

      const received = [];
      startBridge();
      onBridgeMessage((msg) => received.push(msg));

      // Write the message to the inbox file
      appendFileSync(process.env.RW_BRIDGE_INBOX, JSON.stringify(${JSON.stringify(msg)}) + '\\n', 'utf8');

      // Wait for 2 poll cycles (40ms each)
      await new Promise(r => setTimeout(r, 120));

      writeFileSync('${outFile}', JSON.stringify(received), 'utf8');
      process.exit(0);
    `;

    Bun.spawnSync({
      cmd: ['bun', '--eval', script],
      env: { ...process.env, RW_BRIDGE_INBOX: inboxFile },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 5000,
    });

    const received = JSON.parse(readFileSync(outFile, 'utf8'));
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(msg);
  });
});
