import React, { useEffect, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import { EntityBox } from './shared/EntityBox';
import type { ClassRow, ModuleSymbolRow, TypeConsumerRow } from '../lib/intelligence-query-adapters';
import type { FlatRelationItem } from '../lib/types';

type Props = {
  rootName: string;
  rootFilePath?: string;
  rootLineNumber?: number;
  requestModuleSymbols: (filePath: string) => Promise<ModuleSymbolRow[]>;
  requestClassInheritance: (symbolName: string) => Promise<ClassRow[]>;
  requestClassSubtypes: (symbolName: string) => Promise<ClassRow[]>;
  requestInterfaceImplementors: (symbolName: string) => Promise<ClassRow[]>;
  requestTypeConsumers: (symbolName: string) => Promise<TypeConsumerRow[]>;
  onOpenLocation: (item: FlatRelationItem) => void;
};

export function ClassView({ rootName, rootFilePath, rootLineNumber: _rootLineNumber, requestModuleSymbols, requestClassInheritance, requestClassSubtypes, requestInterfaceImplementors, requestTypeConsumers, onOpenLocation }: Props) {
  const [members, setMembers] = useState<ModuleSymbolRow[]>([]);
  const [parents, setParents] = useState<ClassRow[]>([]);
  const [subtypes, setSubtypes] = useState<ClassRow[]>([]);
  const [consumers, setConsumers] = useState<TypeConsumerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      rootFilePath ? requestModuleSymbols(rootFilePath) : Promise.resolve([]),
      requestClassInheritance(rootName),
      requestClassSubtypes(rootName),
      requestInterfaceImplementors(rootName),
      requestTypeConsumers(rootName),
    ]).then(([syms, par, sub, impl, cons]) => {
      setMembers(syms.filter(s => ['method', 'function', 'field', 'property'].includes(s.kind ?? '')));
      setParents([...par, ...impl]);
      setSubtypes(sub);
      setConsumers(cons);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [rootName, rootFilePath]);

  useKeyboard((event) => {
    const key = event?.name ?? '';
    const seq = event?.sequence ?? '';
    if (key === 'down' || (key === 'j' && seq === 'j')) setSelectedIdx(i => Math.min(i + 1, members.length - 1));
    if (key === 'up' || (key === 'k' && seq === 'k')) setSelectedIdx(i => Math.max(i - 1, 0));
    if (key === 'return' || (key === 'o' && seq === 'o')) {
      const m = members[selectedIdx];
      if (m?.filePath) onOpenLocation({ id: m.filePath, label: m.name ?? '', filePath: m.filePath, lineNumber: m.lineNumber ?? 1, relationType: 'incoming' });
    }
  });

  if (loading) return <text fg="#6272a4">{'Loading class structure...'}</text>;

  const fields = members.filter(m => m.kind === 'field' || m.kind === 'property');
  const methods = members.filter(m => m.kind !== 'field' && m.kind !== 'property');
  const mainRows = [
    ...fields.map(f => ({ label: f.name ?? '', detail: f.kind })),
    ...methods.map(m => ({ label: `${m.name ?? ''}()`, detail: m.kind })),
  ];

  return (
    <box flexDirection="column" padding={1}>
      {parents.length > 0 && (
        <box flexDirection="row">
          {parents.slice(0, 4).map((p, i) => <EntityBox key={i} title={p.name} rows={[]} />)}
        </box>
      )}
      <EntityBox title={rootName} subtitle="(focused)" rows={mainRows} focused selectedIndex={selectedIdx} maxRows={20} />
      {(subtypes.length > 0 || consumers.length > 0) && (
        <box flexDirection="row" marginTop={1}>
          {subtypes.slice(0, 2).map((s, i) => <EntityBox key={i} title={s.name} rows={[]} />)}
          {consumers.length > 0 && <text fg="#6272a4">{`used by ${consumers.length} type${consumers.length > 1 ? 's' : ''}`}</text>}
        </box>
      )}
    </box>
  );
}
