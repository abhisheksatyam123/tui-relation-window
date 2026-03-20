import React from 'react';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { App } from './App';
import { startBridge } from './lib/bridge';
import { getLogDir, logError, logInfo } from './lib/logger';

function hideCursor() {
  process.stdout.write('\u001b[?25l');
}

function showCursor() {
  process.stdout.write('\u001b[?25h');
}

async function main() {
  logInfo('app', 'starting tui app', { logDir: getLogDir(), pid: process.pid });
  hideCursor();
  startBridge();

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  });

  createRoot(renderer).render(<App />);
  logInfo('app', 'tui render started');
}

process.on('exit', () => {
  showCursor();
});

process.on('SIGINT', () => {
  showCursor();
});

process.on('SIGTERM', () => {
  showCursor();
});

main().catch((error) => {
  showCursor();
  logError('app', 'failed to start tui', { error: String(error) });
  process.stderr.write(`Failed to start TUI: ${String(error)}\n`);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  showCursor();
  logError('app', 'uncaught exception', { error: error.message, stack: error.stack });
});

process.on('unhandledRejection', (reason) => {
  showCursor();
  logError('app', 'unhandled rejection', { reason: String(reason) });
});
