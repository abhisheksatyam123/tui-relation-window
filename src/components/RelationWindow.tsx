import React, { useState } from 'react';
import { useKeyboard } from '@opentui/react';
import type { FlatRelationItem, QueryMode } from '../lib/types';
import type { LogRow, StructWriterRow, ModuleRow, ModuleSymbolRow, ClassRow, TypeConsumerRow, TypeFieldRow, FieldAccessRow, TypeAggregatorRow } from '../lib/intelligence-query-adapters';
import { BothRelationWindow } from './BothRelationWindow';
import { ModeHeader, type ViewMode } from './ModeHeader';
import { ModuleView } from './ModuleView';
import { ClassView } from './ClassView';
import { DataView } from './DataView';

function inferInitialMode(rootName: string, symbolKind?: number): ViewMode {
  // LSP symbol kinds
  if (symbolKind === 2) return 1; // Module
  if (symbolKind === 5 || symbolKind === 11 || symbolKind === 23 || symbolKind === 10) return 2; // Class/Interface/Struct/Enum
  if (symbolKind === 12 || symbolKind === 6 || symbolKind === 9) return 3; // Function/Method/Constructor
  if (symbolKind === 8 || symbolKind === 7) return 4; // Field/Property
  // filename pattern fallback
  const ext = rootName.split('.').pop() ?? '';
  if (['ts', 'rs', 'c', 'h', 'cpp', 'py', 'go'].includes(ext)) return 1;
  return 3;
}

type Props = {
  mode: 'incoming' | 'outgoing' | 'both';
  provider: string;
  rootName: string;
  rootFilePath?: string;
  rootLineNumber?: number;
  items: FlatRelationItem[];
  incomingItems: FlatRelationItem[];
  outgoingItems: FlatRelationItem[];
  initialSymbolKind?: number;
  requestExpand: (node: { id: string; label: string; filePath: string; lineNumber: number; mode: QueryMode }) => Promise<FlatRelationItem[]>;
  requestHover?: (node: { id: string; label: string; filePath: string; lineNumber: number }) => Promise<string>;
  requestLogs?: (apiName: string) => Promise<LogRow[]>;
  requestStructWrites?: (apiName: string) => Promise<StructWriterRow[]>;
  workspaceRoot?: string;
  onOpenLocation: (item: FlatRelationItem) => void;
  onRefresh: () => void;
  requestModuleImports?: (filePath: string) => Promise<ModuleRow[]>;
  requestModuleDependents?: (filePath: string) => Promise<ModuleRow[]>;
  requestModuleSymbols?: (filePath: string) => Promise<ModuleSymbolRow[]>;
  requestClassInheritance?: (symbolName: string) => Promise<ClassRow[]>;
  requestClassSubtypes?: (symbolName: string) => Promise<ClassRow[]>;
  requestInterfaceImplementors?: (symbolName: string) => Promise<ClassRow[]>;
  requestTypeConsumers?: (symbolName: string) => Promise<TypeConsumerRow[]>;
  requestTypeFields?: (symbolName: string) => Promise<TypeFieldRow[]>;
  requestFieldReaders?: (symbolName: string) => Promise<FieldAccessRow[]>;
  requestFieldWriters?: (symbolName: string) => Promise<FieldAccessRow[]>;
  requestTypeAggregators?: (symbolName: string) => Promise<TypeAggregatorRow[]>;
};

const noop = () => Promise.resolve([]);

export function RelationWindow(props: Props) {
  const {
    rootName, rootFilePath, rootLineNumber, initialSymbolKind,
    incomingItems, outgoingItems,
    requestExpand, requestHover, requestLogs, requestStructWrites,
    onOpenLocation, onRefresh,
    requestModuleImports = noop, requestModuleDependents = noop, requestModuleSymbols = noop,
    requestClassInheritance = noop, requestClassSubtypes = noop,
    requestInterfaceImplementors = noop, requestTypeConsumers = noop,
    requestTypeFields = noop, requestFieldReaders = noop,
    requestFieldWriters = noop, requestTypeAggregators = noop,
  } = props;

  const [viewMode, setViewMode] = useState<ViewMode>(() => inferInitialMode(rootName, initialSymbolKind));

  useKeyboard((event) => {
    const seq = event?.sequence ?? '';
    if (seq === '1') setViewMode(1);
    if (seq === '2') setViewMode(2);
    if (seq === '3') setViewMode(3);
    if (seq === '4') setViewMode(4);
    if (seq === 'r') onRefresh();
  });

  return (
    <box flexDirection="column" width="100%" height="100%">
      <ModeHeader activeMode={viewMode} rootName={rootName} rootFilePath={rootFilePath} rootLineNumber={rootLineNumber} />
      {viewMode === 1 && <ModuleView rootFilePath={rootFilePath} rootName={rootName} requestModuleImports={requestModuleImports} requestModuleDependents={requestModuleDependents} requestModuleSymbols={requestModuleSymbols} onOpenLocation={onOpenLocation} />}
      {viewMode === 2 && <ClassView rootName={rootName} rootFilePath={rootFilePath} rootLineNumber={rootLineNumber} requestModuleSymbols={requestModuleSymbols} requestClassInheritance={requestClassInheritance} requestClassSubtypes={requestClassSubtypes} requestInterfaceImplementors={requestInterfaceImplementors} requestTypeConsumers={requestTypeConsumers} onOpenLocation={onOpenLocation} />}
      {viewMode === 3 && <BothRelationWindow rootName={rootName} rootFilePath={rootFilePath} rootLineNumber={rootLineNumber} incomingItems={incomingItems} outgoingItems={outgoingItems} requestExpand={requestExpand} requestHover={requestHover} requestLogs={requestLogs} requestStructWrites={requestStructWrites} onOpenLocation={onOpenLocation} />}
      {viewMode === 4 && <DataView rootName={rootName} rootFilePath={rootFilePath} requestTypeFields={requestTypeFields} requestFieldReaders={requestFieldReaders} requestFieldWriters={requestFieldWriters} requestTypeAggregators={requestTypeAggregators} onOpenLocation={onOpenLocation} />}
    </box>
  );
}
