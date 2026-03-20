import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_DIR = join(homedir(), '.local', 'share', 'tui-relation-window', 'logs');

function ensureLogDir() {
  mkdirSync(LOG_DIR, { recursive: true });
}

function stringifyMeta(meta?: unknown): string {
  if (meta === undefined) {
    return '';
  }

  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return ' {"meta":"<unserializable>"}';
  }
}

function writeLine(fileName: string, line: string) {
  try {
    ensureLogDir();
    appendFileSync(join(LOG_DIR, fileName), `${line}\n`, 'utf8');
  } catch {
    // Keep app running even if logging fails (e.g. permission issues).
  }
}

export function log(scope: string, level: LogLevel, message: string, meta?: unknown) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] [${scope}] ${message}${stringifyMeta(meta)}`;
  writeLine(`${scope}.log`, line);
}

export function logInfo(scope: string, message: string, meta?: unknown) {
  log(scope, 'INFO', message, meta);
}

export function logWarn(scope: string, message: string, meta?: unknown) {
  log(scope, 'WARN', message, meta);
}

export function logError(scope: string, message: string, meta?: unknown) {
  log(scope, 'ERROR', message, meta);
}

export function getLogDir() {
  return LOG_DIR;
}

export function writeUiSnapshot(name: string, content: string) {
  try {
    ensureLogDir();
    writeFileSync(join(LOG_DIR, `${name}.ui.log`), content, 'utf8');
  } catch {
    // Keep app running even if logging fails.
  }
}
