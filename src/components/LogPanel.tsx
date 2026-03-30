import React from 'react';
import type { LogRow } from '../lib/intelligence-query-adapters';

const LEVEL_FG: Record<string, string> = {
  ERROR: '#ff5555',
  WARN: '#ffb86c',
  INFO: '#50fa7b',
  DEBUG: '#8be9fd',
  VERBOSE: '#bd93f9',
  TRACE: '#6272a4',
  UNKNOWN: '#6272a4',
};

type Props = {
  apiName: string;
  rows: LogRow[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
};

export function LogPanel({ apiName, rows, loading, error, onClose: _onClose }: Props) {
  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      borderStyle="single"
      border={true}
      borderColor="#bd93f9"
    >
      {/* Header */}
      <box height={1} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text fg="#bd93f9" attributes={1}>{'Logs: '}</text>
        <text fg="#f8f8f2">{apiName}</text>
        <text fg="#6272a4">{'  [Esc] close'}</text>
      </box>

      {/* Divider */}
      <box height={1}>
        <text fg="#44475a">{'─'.repeat(80)}</text>
      </box>

      {/* Content */}
      {loading ? (
        <box flexGrow={1} justifyContent="center" alignItems="center">
          <text fg="#6272a4">{'Loading logs…'}</text>
        </box>
      ) : error ? (
        <box flexGrow={1} paddingLeft={2} paddingTop={1}>
          <text fg="#ff5555">{error}</text>
        </box>
      ) : rows.length === 0 ? (
        <box flexGrow={1} paddingLeft={2} paddingTop={1}>
          <text fg="#6272a4">{`No logs found for ${apiName}`}</text>
        </box>
      ) : (
        <scrollbox flexGrow={1} scrollY={true}>
          {rows.map((row, i) => (
            <box key={i} flexDirection="row" paddingLeft={1} paddingRight={1} height={1}>
              <text
                attributes={1}
                fg={LEVEL_FG[row.level] ?? '#6272a4'}
                width={8}
              >
                {row.level.slice(0, 7).padEnd(7)}
              </text>
              <text fg="#6272a4" width={12}>
                {(row.subsystem ?? '').slice(0, 11).padEnd(11)}
              </text>
              <text fg="#f8f8f2" flexGrow={1}>
                {row.template}
              </text>
              {row.filePath && (
                <text fg="#6272a4">
                  {` ${row.filePath.split('/').slice(-1)[0]}:${row.line ?? 0}`}
                </text>
              )}
            </box>
          ))}
        </scrollbox>
      )}
    </box>
  );
}
