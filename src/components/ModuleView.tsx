import React, { useEffect, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import { EntityBox } from './shared/EntityBox';
import type { ModuleRow, ModuleSymbolRow } from '../lib/intelligence-query-adapters';
import type { FlatRelationItem } from '../lib/types';

type Props = {
  rootFilePath?: string;
  rootName: string;
  requestModuleImports: (filePath: string) => Promise<ModuleRow[]>;
  requestModuleDependents: (filePath: string) => Promise<ModuleRow[]>;
  requestModuleSymbols: (filePath: string) => Promise<ModuleSymbolRow[]>;
  onOpenLocation: (item: FlatRelationItem) => void;
};

export function ModuleView({ rootFilePath, rootName, requestModuleImports, requestModuleDependents, requestModuleSymbols, onOpenLocation }: Props) {
  const [imports, setImports] = useState<ModuleRow[]>([]);
  const [dependents, setDependents] = useState<ModuleRow[]>([]);
  const [symbols, setSymbols] = useState<ModuleSymbolRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [activePane, setActivePane] = useState<'imports' | 'center' | 'dependents'>('center');
  const [selectedIdx, setSelectedIdx] = useState(0);

  const filePath = rootFilePath ?? rootName;

  useEffect(() => {
    setLoading(true);
    Promise.all([
      requestModuleImports(filePath),
      requestModuleDependents(filePath),
      requestModuleSymbols(filePath),
    ]).then(([imp, dep, sym]) => {
      setImports(imp);
      setDependents(dep);
      setSymbols(sym);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [filePath]);

  const activeList: Array<{ filePath?: string; name?: string }> =
    activePane === 'imports' ? imports : activePane === 'dependents' ? dependents : symbols;

  useKeyboard((event) => {
    const key = event?.name ?? '';
    const seq = event?.sequence ?? '';
    if (key === 'tab') { setActivePane(p => p === 'imports' ? 'center' : p === 'center' ? 'dependents' : 'imports'); setSelectedIdx(0); return; }
    if (key === 'down' || (key === 'j' && seq === 'j')) setSelectedIdx(i => Math.min(i + 1, activeList.length - 1));
    if (key === 'up' || (key === 'k' && seq === 'k')) setSelectedIdx(i => Math.max(i - 1, 0));
    if (key === 'return' || (key === 'o' && seq === 'o')) {
      const item = activeList[selectedIdx];
      if (item?.filePath) onOpenLocation({ id: item.filePath, label: item.name ?? item.filePath, filePath: item.filePath, lineNumber: 1, relationType: 'incoming' });
    }
  });

  if (loading) return <text fg="#6272a4">{'Loading module graph...'}</text>;

  const moduleTypes = symbols.filter(s => ['class', 'interface', 'struct', 'trait', 'enum'].includes(s.kind ?? ''));
  const moduleFns = symbols.filter(s => ['function', 'method'].includes(s.kind ?? ''));
  const centerSubtitle = `${moduleTypes.length} types, ${moduleFns.length} functions`;

  return (
    <box flexDirection="row" padding={1}>
      <box flexDirection="column" width={28}>
        <text fg="#6272a4" attributes={1}>{'imports from'}</text>
        {imports.length === 0 ? <text fg="#6272a4">{'(none)'}</text> : (
          <EntityBox title="imports" rows={imports.map(m => ({ label: m.name ?? m.filePath ?? '', detail: m.filePath }))} focused={activePane === 'imports'} selectedIndex={activePane === 'imports' ? selectedIdx : undefined} maxRows={10} />
        )}
      </box>
      <box flexDirection="column" flexGrow={1} marginLeft={2}>
        <EntityBox title={filePath.split('/').pop() ?? filePath} subtitle={centerSubtitle} rows={symbols.map(s => ({ label: s.name ?? '', detail: s.kind, filePath: s.filePath, lineNumber: s.lineNumber }))} focused={activePane === 'center'} selectedIndex={activePane === 'center' ? selectedIdx : undefined} maxRows={15} />
      </box>
      <box flexDirection="column" width={28} marginLeft={2}>
        <text fg="#6272a4" attributes={1}>{'used by'}</text>
        {dependents.length === 0 ? <text fg="#6272a4">{'(none)'}</text> : (
          <EntityBox title="dependents" rows={dependents.map(m => ({ label: m.name ?? m.filePath ?? '', filePath: m.filePath }))} focused={activePane === 'dependents'} selectedIndex={activePane === 'dependents' ? selectedIdx : undefined} maxRows={10} />
        )}
      </box>
    </box>
  );
}
