import React, { useEffect, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import { EntityBox } from './shared/EntityBox';
import type { TypeFieldRow, FieldAccessRow, TypeAggregatorRow } from '../lib/intelligence-query-adapters';
import type { FlatRelationItem } from '../lib/types';

type Props = {
  rootName: string;
  rootFilePath?: string;
  requestTypeFields: (symbolName: string) => Promise<TypeFieldRow[]>;
  requestFieldReaders: (symbolName: string) => Promise<FieldAccessRow[]>;
  requestFieldWriters: (symbolName: string) => Promise<FieldAccessRow[]>;
  requestTypeAggregators: (symbolName: string) => Promise<TypeAggregatorRow[]>;
  onOpenLocation: (item: FlatRelationItem) => void;
};

export function DataView({ rootName, requestTypeFields, requestFieldReaders, requestFieldWriters, requestTypeAggregators, onOpenLocation }: Props) {
  const [fields, setFields] = useState<TypeFieldRow[]>([]);
  const [readers, setReaders] = useState<FieldAccessRow[]>([]);
  const [writers, setWriters] = useState<FieldAccessRow[]>([]);
  const [aggregators, setAggregators] = useState<TypeAggregatorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [activePane, setActivePane] = useState<'writers' | 'center' | 'readers'>('center');
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      requestTypeFields(rootName),
      requestFieldReaders(rootName),
      requestFieldWriters(rootName),
      requestTypeAggregators(rootName),
    ]).then(([f, r, w, a]) => { setFields(f); setReaders(r); setWriters(w); setAggregators(a); setLoading(false); })
      .catch(() => setLoading(false));
  }, [rootName]);

  const activeList = activePane === 'writers' ? writers : activePane === 'readers' ? readers : fields;

  useKeyboard((event) => {
    const key = event?.name ?? '';
    const seq = event?.sequence ?? '';
    if (key === 'tab') { setActivePane(p => p === 'writers' ? 'center' : p === 'center' ? 'readers' : 'writers'); setSelectedIdx(0); return; }
    if (key === 'down' || (key === 'j' && seq === 'j')) setSelectedIdx(i => Math.min(i + 1, activeList.length - 1));
    if (key === 'up' || (key === 'k' && seq === 'k')) setSelectedIdx(i => Math.max(i - 1, 0));
    if (key === 'return' || (key === 'o' && seq === 'o')) {
      const item = activeList[selectedIdx] as any;
      if (item?.filePath) onOpenLocation({ id: item.filePath, label: item.accessor ?? item.field ?? '', filePath: item.filePath, lineNumber: item.lineNumber ?? 1, relationType: 'incoming' });
    }
  });

  if (loading) return <text fg="#6272a4">{'Loading data flow...'}</text>;

  return (
    <box flexDirection="row" padding={1}>
      <box flexDirection="column" width={28}>
        <text fg="#6272a4" attributes={1}>{'writers'}</text>
        {writers.length === 0 ? <text fg="#6272a4">{'(none)'}</text> : (
          <EntityBox title="writers" rows={writers.map(w => ({ label: w.accessor, detail: w.fieldName ? `writes: ${w.fieldName}` : undefined, filePath: w.filePath }))} focused={activePane === 'writers'} selectedIndex={activePane === 'writers' ? selectedIdx : undefined} maxRows={10} />
        )}
      </box>
      <box flexDirection="column" flexGrow={1} marginLeft={2}>
        <EntityBox title={rootName} subtitle="(type)" rows={fields.map(f => ({ label: f.field, detail: f.fieldType }))} focused={activePane === 'center'} selectedIndex={activePane === 'center' ? selectedIdx : undefined} maxRows={15} />
        {aggregators.length > 0 && (
          <box flexDirection="column" marginTop={1}>
            <text fg="#6272a4">{'aggregated by'}</text>
            {aggregators.slice(0, 3).map((a, i) => <EntityBox key={i} title={a.aggregator} rows={[]} />)}
          </box>
        )}
      </box>
      <box flexDirection="column" width={28} marginLeft={2}>
        <text fg="#6272a4" attributes={1}>{'readers'}</text>
        {readers.length === 0 ? <text fg="#6272a4">{'(none)'}</text> : (
          <EntityBox title="readers" rows={readers.map(r => ({ label: r.accessor, detail: r.fieldName ? `reads: ${r.fieldName}` : undefined, filePath: r.filePath }))} focused={activePane === 'readers'} selectedIndex={activePane === 'readers' ? selectedIdx : undefined} maxRows={10} />
        )}
      </box>
    </box>
  );
}
