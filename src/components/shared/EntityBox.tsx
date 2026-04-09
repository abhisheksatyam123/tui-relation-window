import React from 'react';

export type EntityRow = {
  label: string;
  detail?: string;
  dimmed?: boolean;
  filePath?: string;
  lineNumber?: number;
};

type Props = {
  title: string;
  subtitle?: string;
  rows: EntityRow[];
  focused?: boolean;
  maxRows?: number;
  selectedIndex?: number;
};

export function EntityBox({ title, subtitle, rows, focused, maxRows, selectedIndex }: Props) {
  const borderColor = focused ? '#f1fa8c' : '#44475a';
  const titleFg = focused ? '#f1fa8c' : '#8be9fd';
  const visibleRows = maxRows != null ? rows.slice(0, maxRows) : rows;
  const overflow = maxRows != null && rows.length > maxRows ? rows.length - maxRows : 0;

  return (
    <box flexDirection="column" border={true} borderStyle="single" borderColor={borderColor} paddingLeft={1} paddingRight={1}>
      <text fg={titleFg} attributes={1}>{title}</text>
      {subtitle && <text fg="#6272a4">{subtitle}</text>}
      {visibleRows.map((row, i) => (
        <box key={i} flexDirection="row">
          <text
            fg={i === selectedIndex ? '#50fa7b' : row.dimmed ? '#6272a4' : '#f8f8f2'}
            attributes={i === selectedIndex ? 1 : 0}
          >
            {row.label}
          </text>
          {row.detail && <text fg="#6272a4">{` ${row.detail}`}</text>}
        </box>
      ))}
      {overflow > 0 && <text fg="#6272a4">{`  ${overflow} more...`}</text>}
    </box>
  );
}
