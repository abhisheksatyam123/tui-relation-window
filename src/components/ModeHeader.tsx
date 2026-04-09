import React from 'react';

export type ViewMode = 1 | 2 | 3 | 4;

const MODE_LABELS: Record<ViewMode, string> = {
  1: 'Module', 2: 'Class', 3: 'API', 4: 'Data',
};

type Props = {
  activeMode: ViewMode;
  rootName: string;
  rootFilePath?: string;
  rootLineNumber?: number;
};

export function ModeHeader({ activeMode, rootName, rootFilePath, rootLineNumber }: Props) {
  const location = rootFilePath
    ? `${rootFilePath}${rootLineNumber != null ? `:${rootLineNumber}` : ''}`
    : rootName;

  return (
    <box flexDirection="row" height={1} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row">
        {([1, 2, 3, 4] as ViewMode[]).map((m) => (
          <text
            key={m}
            attributes={m === activeMode ? 1 : 0}
            fg={m === activeMode ? '#8be9fd' : '#6272a4'}
          >
            {`[${m}:${MODE_LABELS[m]}] `}
          </text>
        ))}
      </box>
      <box flexGrow={1} />
      <text fg="#6272a4">{location}</text>
      <text fg="#6272a4">{'  ?:help  q:quit'}</text>
    </box>
  );
}
