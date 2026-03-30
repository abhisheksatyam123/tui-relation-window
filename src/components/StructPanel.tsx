import React from 'react';
import type { StructWriterRow } from '../lib/intelligence-query-adapters';

const EDGE_KIND_LABELS: Record<string, string> = {
  writes_field: 'write',
  reads_field: 'read',
  operates_on_struct: 'init',
  runtime_write_field_assignment: 'write',
  runtime_read_field_access: 'read',
  runtime_struct_initialization: 'init',
  runtime_struct_mutation: 'mutate',
};

type Props = {
  apiName: string;
  rows: StructWriterRow[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
};

export function StructPanel({ apiName, rows, loading, error, onClose: _onClose }: Props) {
  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      borderStyle="single"
      border={true}
      borderColor="#e5c07b"
    >
      {/* Header */}
      <box height={1} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text fg="#e5c07b" attributes={1}>{'Struct Writes: '}</text>
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
          <text fg="#6272a4">{'Loading struct writes…'}</text>
        </box>
      ) : error ? (
        <box flexGrow={1} paddingLeft={2} paddingTop={1}>
          <text fg="#ff5555">{error}</text>
        </box>
      ) : rows.length === 0 ? (
        <box flexGrow={1} paddingLeft={2} paddingTop={1}>
          <text fg="#6272a4">{`No struct writes found for ${apiName}`}</text>
        </box>
      ) : (
        <scrollbox flexGrow={1} scrollY={true}>
          {rows.map((row, i) => {
            const kindLabel = EDGE_KIND_LABELS[row.edgeKind] ?? row.edgeKind;
            const pct = `${Math.round(row.confidence * 100)}%`;
            const path = row.accessPath
              ? row.accessPath.length > 30
                ? `${row.accessPath.slice(0, 27)}...`
                : row.accessPath
              : '';
            return (
              <box key={i} flexDirection="row" paddingLeft={1} paddingRight={1} height={1}>
                <text fg="#f8f8f2" attributes={1} width={28} flexShrink={0}>
                  {row.writer.slice(0, 27).padEnd(27)}
                </text>
                <text fg="#8be9fd" width={24} flexShrink={0}>
                  {row.target.slice(0, 23).padEnd(23)}
                </text>
                <text fg="#e5c07b" width={8} flexShrink={0}>
                  {kindLabel.slice(0, 7).padEnd(7)}
                </text>
                <text fg="#50fa7b" width={6} flexShrink={0}>
                  {pct.padEnd(5)}
                </text>
                {path && (
                  <text fg="#6272a4" flexGrow={1}>
                    {path}
                  </text>
                )}
              </box>
            );
          })}
        </scrollbox>
      )}
    </box>
  );
}
