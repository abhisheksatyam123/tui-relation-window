import type { BridgeIncomingMessage, BridgeOutgoingMessage } from './types';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { logError, logInfo } from './logger';

const BRIDGE_PREFIX = 'RW_BRIDGE:';
const INBOX_POLL_MS = 40;
const inboxPath = process.env.RW_BRIDGE_INBOX?.trim() || '';
const outboxPath = process.env.RW_BRIDGE_OUTBOX?.trim() || '';

const listeners = new Set<(message: BridgeIncomingMessage) => void>();
const pending: BridgeIncomingMessage[] = [];
let inboxOffset = 0;
let inboxBuffer = '';
let inboxTimer: ReturnType<typeof setInterval> | null = null;

export function startBridge() {
  logInfo('app', 'bridge started', { mode: inboxPath ? 'inbox' : 'stdin', inboxPath: inboxPath || undefined });

  if (inboxPath) {
    startInboxBridge();
    return;
  }

  process.stdin.setEncoding('utf8');
  process.stdin.resume();

  let buffer = '';
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;

    let split = buffer.indexOf('\n');
    while (split !== -1) {
      const line = buffer.slice(0, split).trim();
      buffer = buffer.slice(split + 1);

      if (line.length > 0) {
        parseLine(line);
      }

      split = buffer.indexOf('\n');
    }
  });
}

export function onBridgeMessage(listener: (message: BridgeIncomingMessage) => void) {
  listeners.add(listener);

  if (pending.length > 0) {
    for (const queued of pending.splice(0, pending.length)) {
      listener(queued);
    }
  }

  return () => {
    listeners.delete(listener);
  };
}

export function sendBridgeMessage(message: BridgeOutgoingMessage) {
  logInfo('app', 'bridge send', { type: message.type });
  if (outboxPath) {
    try {
      appendFileSync(outboxPath, `${JSON.stringify(message)}\n`, 'utf8');
      return;
    } catch (error) {
      logError('app', 'outbox write failed; falling back to stderr bridge', {
        outboxPath,
        error: String(error),
        type: message.type,
      });
    }
  }
  // Use stderr so TUI render output on stdout is not polluted.
  process.stderr.write(`${BRIDGE_PREFIX}${JSON.stringify(message)}\n`);
}

function startInboxBridge() {
  try {
    // Ensure file exists; Neovim also creates/truncates this file per session.
    appendFileSync(inboxPath, '', 'utf8');
    inboxOffset = 0;
    inboxBuffer = '';
  } catch (error) {
    logError('app', 'failed to init inbox bridge; falling back to stdin', { inboxPath, error: String(error) });
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    return;
  }

  inboxTimer = setInterval(() => {
    try {
      if (!existsSync(inboxPath)) {
        return;
      }

      const content = readFileSync(inboxPath, 'utf8');
      if (content.length < inboxOffset) {
        // File was rotated/truncated.
        inboxOffset = 0;
      }
      if (content.length === inboxOffset) {
        return;
      }

      const chunk = content.slice(inboxOffset);
      inboxOffset = content.length;
      processInboxChunk(chunk);
    } catch (error) {
      logError('app', 'inbox poll failed', { inboxPath, error: String(error) });
    }
  }, INBOX_POLL_MS);

  inboxTimer.unref?.();

  process.on('exit', () => {
    if (inboxTimer) {
      clearInterval(inboxTimer);
      inboxTimer = null;
    }
  });
}

function processInboxChunk(chunk: string) {
  if (!chunk) return;
  inboxBuffer += chunk;

  let split = inboxBuffer.indexOf('\n');
  while (split !== -1) {
    const line = inboxBuffer.slice(0, split).trim();
    inboxBuffer = inboxBuffer.slice(split + 1);
    if (line.length > 0) {
      parseLine(line);
    }
    split = inboxBuffer.indexOf('\n');
  }
}

function parseLine(line: string) {
  const cleaned = extractJsonCandidate(stripAnsiNoise(line));

  try {
    if (!cleaned) {
      return;
    }

    const parsed = JSON.parse(cleaned) as BridgeIncomingMessage;
    logInfo('app', 'bridge receive', { type: parsed.type });

    if (listeners.size === 0) {
      pending.push(parsed);
      return;
    }

    for (const listener of listeners) {
      listener(parsed);
    }
  } catch {
    logError('app', 'bridge parse error', { line, cleaned });
    // Ignore malformed lines to avoid refresh loops/noise in the UI.
  }
}

function stripAnsiNoise(input: string): string {
  return input
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\u001bP.*?\u001b\\/g, '') // DCS ... ST
    .replace(/\u001b\].*?(?:\u0007|\u001b\\)/g, '') // OSC ... BEL/ST
    .replace(/\u001b[@-_]/g, '') // single-char ESC
    .trim();
}

function extractJsonCandidate(input: string): string | null {
  if (!input) {
    return null;
  }

  const first = input.indexOf('{');
  if (first === -1) {
    return null;
  }

  // Walk forward tracking brace depth so we find the matching closing brace
  // even when JSON string values contain '}' characters (BUG-007).
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = first; i < input.length; i++) {
    const ch = input[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return input.slice(first, i + 1);
      }
    }
  }

  return null;
}

export const __test = {
  stripAnsiNoise,
  extractJsonCandidate,
};
