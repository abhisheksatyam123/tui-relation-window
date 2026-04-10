# View Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single API view in RelationWindow with 4 switchable modes: Module (file deps), Class (UML structure), API (call flow, existing BothRelationWindow), Data (field flow).

**Architecture:** Add `viewMode` state to RelationWindow, render mode-specific components via ModeRouter, share query callbacks through App.tsx. Each view is an independent component using OpenTUI boxes. New query intents wired through intelgraph-client.ts.

**Tech Stack:** React + OpenTUI (ink-based), TypeScript, Bun test runner, SQLite intelligence graph via MCP intents.

---

## File Map

**Create:**
- `src/components/ModeHeader.tsx` — tab bar showing `[1:Module] [2:Class] [3:API] [4:Data]` + file:line
- `src/components/shared/EntityBox.tsx` — reusable OpenTUI box: border, title, member list rows
- `src/components/ModuleView.tsx` — Mode 1: file dependency left/center/right layout
- `src/components/ClassView.tsx` — Mode 2: type structure with inheritance/members/consumers
- `src/components/ApiView.tsx` — Mode 3: migrate BothRelationWindow into standalone view
- `src/components/DataView.tsx` — Mode 4: field flow writers/type/readers layout

**Modify:**
- `src/components/RelationWindow.tsx` — add `viewMode` state (1-4), render ModeHeader + view router
- `src/App.tsx` — add `requestModuleData`, `requestClassData`, `requestDataModeData` callbacks; pass to RelationWindow
- `src/lib/intelgraph-client.ts` — add `queryTypeConsumers`, `queryTypeFields`, `queryFieldReaders`, `queryFieldWriters`, `queryTypeAggregators`
- `src/lib/intelligence-query-adapters.ts` — add row types + converters for type consumers, fields, field access, aggregators

---

### Task 1: Row types and query adapter functions for new intents

**Files:**
- Modify: `src/lib/intelligence-query-adapters.ts`

- [ ] **Step 1: Add new row types**

Open `src/lib/intelligence-query-adapters.ts` and add after existing type definitions:

```typescript
export type TypeConsumerRow = {
  consumer: string;
  filePath?: string;
  lineNumber?: number;
  kind?: string;
};

export type TypeFieldRow = {
  field: string;
  fieldType?: string;
  filePath?: string;
  lineNumber?: number;
};

export type FieldAccessRow = {
  accessor: string;
  fieldName?: string;
  filePath?: string;
  lineNumber?: number;
  accessKind: 'read' | 'write';
};

export type TypeAggregatorRow = {
  aggregator: string;
  filePath?: string;
  lineNumber?: number;
};
```

- [ ] **Step 2: Add converter functions**

Add after the existing converter functions:

```typescript
export function queryResultToTypeConsumerRows(result: IntelligenceQueryResult): TypeConsumerRow[] {
  if (!result?.data?.nodes) return [];
  return result.data.nodes.map((n: any) => ({
    consumer: n.canonical_name ?? n.symbol ?? n.name ?? '',
    filePath: n.file_path ?? n.filePath,
    lineNumber: n.line_number ?? n.lineNumber,
    kind: n.kind,
  }));
}

export function queryResultToTypeFieldRows(result: IntelligenceQueryResult): TypeFieldRow[] {
  if (!result?.data?.nodes) return [];
  return result.data.nodes.map((n: any) => ({
    field: n.canonical_name ?? n.symbol ?? n.name ?? '',
    fieldType: n.field_type ?? n.type_name,
    filePath: n.file_path ?? n.filePath,
    lineNumber: n.line_number ?? n.lineNumber,
  }));
}

export function queryResultToFieldAccessRows(result: IntelligenceQueryResult, accessKind: 'read' | 'write'): FieldAccessRow[] {
  if (!result?.data?.nodes) return [];
  return result.data.nodes.map((n: any) => ({
    accessor: n.canonical_name ?? n.symbol ?? n.name ?? '',
    fieldName: n.field_name ?? n.target,
    filePath: n.file_path ?? n.filePath,
    lineNumber: n.line_number ?? n.lineNumber,
    accessKind,
  }));
}

export function queryResultToTypeAggregatorRows(result: IntelligenceQueryResult): TypeAggregatorRow[] {
  if (!result?.data?.nodes) return [];
  return result.data.nodes.map((n: any) => ({
    aggregator: n.canonical_name ?? n.symbol ?? n.name ?? '',
    filePath: n.file_path ?? n.filePath,
    lineNumber: n.line_number ?? n.lineNumber,
  }));
}
```

- [ ] **Step 3: Run existing tests to verify no regressions**

```bash
cd /home/abhi/qprojects/tui-relation-window && bun test src/lib/intelligence-query-adapters.test.ts 2>&1 | tail -20
```

Expected: all pass (we only added, didn't change).

- [ ] **Step 4: Commit**

```bash
cd /home/abhi/qprojects/tui-relation-window
git add src/lib/intelligence-query-adapters.ts
git commit -m "feat(adapters): add row types and converters for view mode 1/2/4 queries"
```

---

### Task 2: New query functions in intelgraph-client.ts

**Files:**
- Modify: `src/lib/intelgraph-client.ts`

- [ ] **Step 1: Add 5 new query functions**

Find the section near `queryModuleImports` in `src/lib/intelgraph-client.ts` and add after the last existing module/class query function:

```typescript
export async function queryTypeConsumers(opts: {
  workspaceRoot: string;
  symbolName: string;
  mcpUrl?: string;
}): Promise<IntelligenceQueryResult> {
  const mcpUrl = normalizeMcpUrl(opts.mcpUrl || (await resolveMcpUrl(opts.workspaceRoot)));
  return callIntelligenceQuery(opts.workspaceRoot, mcpUrl, 'find_type_consumers', {
    symbol: opts.symbolName,
  });
}

export async function queryTypeFields(opts: {
  workspaceRoot: string;
  symbolName: string;
  mcpUrl?: string;
}): Promise<IntelligenceQueryResult> {
  const mcpUrl = normalizeMcpUrl(opts.mcpUrl || (await resolveMcpUrl(opts.workspaceRoot)));
  return callIntelligenceQuery(opts.workspaceRoot, mcpUrl, 'find_type_fields', {
    symbol: opts.symbolName,
  });
}

export async function queryFieldReaders(opts: {
  workspaceRoot: string;
  symbolName: string;
  mcpUrl?: string;
}): Promise<IntelligenceQueryResult> {
  const mcpUrl = normalizeMcpUrl(opts.mcpUrl || (await resolveMcpUrl(opts.workspaceRoot)));
  return callIntelligenceQuery(opts.workspaceRoot, mcpUrl, 'find_field_readers', {
    symbol: opts.symbolName,
  });
}

export async function queryFieldWriters(opts: {
  workspaceRoot: string;
  symbolName: string;
  mcpUrl?: string;
}): Promise<IntelligenceQueryResult> {
  const mcpUrl = normalizeMcpUrl(opts.mcpUrl || (await resolveMcpUrl(opts.workspaceRoot)));
  return callIntelligenceQuery(opts.workspaceRoot, mcpUrl, 'find_field_writers', {
    symbol: opts.symbolName,
  });
}

export async function queryTypeAggregators(opts: {
  workspaceRoot: string;
  symbolName: string;
  mcpUrl?: string;
}): Promise<IntelligenceQueryResult> {
  const mcpUrl = normalizeMcpUrl(opts.mcpUrl || (await resolveMcpUrl(opts.workspaceRoot)));
  return callIntelligenceQuery(opts.workspaceRoot, mcpUrl, 'find_type_aggregators', {
    symbol: opts.symbolName,
  });
}
```

Note: `callIntelligenceQuery` is the internal helper used by `queryApiLogs` etc. Find its exact name in the file — it may be `callMcpTool` or `runIntelligenceQuery`. Use whatever is used by `queryModuleImports`.

- [ ] **Step 2: Verify the file compiles**

```bash
cd /home/abhi/qprojects/tui-relation-window && bun tsc --noEmit 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /home/abhi/qprojects/tui-relation-window
git add src/lib/intelgraph-client.ts
git commit -m "feat(client): add queryTypeConsumers/Fields/Readers/Writers/Aggregators"
```

---

### Task 3: App.tsx — new query callbacks for modes 1, 2, 4

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add imports**

At the top of `src/App.tsx`, add to the existing intelgraph-client import line:

```typescript
import {
  // ... existing imports ...
  queryModuleImports,
  queryModuleDependents,
  queryModuleSymbols,
  queryClassInheritance,
  queryClassSubtypes,
  queryInterfaceImplementors,
  queryTypeConsumers,
  queryTypeFields,
  queryFieldReaders,
  queryFieldWriters,
  queryTypeAggregators,
} from './lib/intelgraph-client';
import {
  // ... existing imports ...
  queryResultToModuleRows,
  queryResultToModuleSymbolRows,
  queryResultToClassRows,
  queryResultToTypeConsumerRows,
  queryResultToTypeFieldRows,
  queryResultToFieldAccessRows,
  queryResultToTypeAggregatorRows,
} from './lib/intelligence-query-adapters';
import type {
  ModuleRow,
  ModuleSymbolRow,
  ClassRow,
  TypeConsumerRow,
  TypeFieldRow,
  FieldAccessRow,
  TypeAggregatorRow,
} from './lib/intelligence-query-adapters';
```

- [ ] **Step 2: Add Module mode callbacks**

After `requestStructWrites`, add:

```typescript
const requestModuleImports = useCallback(async (filePath: string): Promise<ModuleRow[]> => {
  await ensureSnapshotInitialized({ workspaceRoot, mcpUrl });
  const result = await queryModuleImports({ workspaceRoot, filePath, mcpUrl });
  return queryResultToModuleRows(result);
}, [workspaceRoot, mcpUrl]);

const requestModuleDependents = useCallback(async (filePath: string): Promise<ModuleRow[]> => {
  await ensureSnapshotInitialized({ workspaceRoot, mcpUrl });
  const result = await queryModuleDependents({ workspaceRoot, filePath, mcpUrl });
  return queryResultToModuleRows(result);
}, [workspaceRoot, mcpUrl]);

const requestModuleSymbols = useCallback(async (filePath: string): Promise<ModuleSymbolRow[]> => {
  await ensureSnapshotInitialized({ workspaceRoot, mcpUrl });
  const result = await queryModuleSymbols({ workspaceRoot, filePath, mcpUrl });
  return queryResultToModuleSymbolRows(result);
}, [workspaceRoot, mcpUrl]);
```

- [ ] **Step 3: Add Class mode callbacks**

```typescript
const requestClassInheritance = useCallback(async (symbolName: string): Promise<ClassRow[]> => {
  await ensureSnapshotInitialized({ workspaceRoot, mcpUrl });
  const result = await queryClassInheritance({ workspaceRoot, symbolName, mcpUrl });
  return queryResultToClassRows(result);
}, [workspaceRoot, mcpUrl]);

const requestClassSubtypes = useCallback(async (symbolName: string): Promise<ClassRow[]> => {
  await ensureSnapshotInitialized({ workspaceRoot, mcpUrl });
  const result = await queryClassSubtypes({ workspaceRoot, symbolName, mcpUrl });
  return queryResultToClassRows(result);
}, [workspaceRoot, mcpUrl]);

const requestInterfaceImplementors = useCallback(async (symbolName: string): Promise<ClassRow[]> => {
  await ensureSnapshotInitialized({ workspaceRoot, mcpUrl });
  const result = await queryInterfaceImplementors({ workspaceRoot, symbolName, mcpUrl });
  return queryResultToClassRows(result);
}, [workspaceRoot, mcpUrl]);

const requestTypeConsumers = useCallback(async (symbolName: string): Promise<TypeConsumerRow[]> => {
  await ensureSnapshotInitialized({ workspaceRoot, mcpUrl });
  const result = await queryTypeConsumers({ workspaceRoot, symbolName, mcpUrl });
  return queryResultToTypeConsumerRows(result);
}, [workspaceRoot, mcpUrl]);
```

- [ ] **Step 4: Add Data mode callbacks**

```typescript
const requestTypeFields = useCallback(async (symbolName: string): Promise<TypeFieldRow[]> => {
  await ensureSnapshotInitialized({ workspaceRoot, mcpUrl });
  const result = await queryTypeFields({ workspaceRoot, symbolName, mcpUrl });
  return queryResultToTypeFieldRows(result);
}, [workspaceRoot, mcpUrl]);

const requestFieldReaders = useCallback(async (symbolName: string): Promise<FieldAccessRow[]> => {
  await ensureSnapshotInitialized({ workspaceRoot, mcpUrl });
  const result = await queryFieldReaders({ workspaceRoot, symbolName, mcpUrl });
  return queryResultToFieldAccessRows(result, 'read');
}, [workspaceRoot, mcpUrl]);

const requestFieldWriters = useCallback(async (symbolName: string): Promise<FieldAccessRow[]> => {
  await ensureSnapshotInitialized({ workspaceRoot, mcpUrl });
  const result = await queryFieldWriters({ workspaceRoot, symbolName, mcpUrl });
  return queryResultToFieldAccessRows(result, 'write');
}, [workspaceRoot, mcpUrl]);

const requestTypeAggregators = useCallback(async (symbolName: string): Promise<TypeAggregatorRow[]> => {
  await ensureSnapshotInitialized({ workspaceRoot, mcpUrl });
  const result = await queryTypeAggregators({ workspaceRoot, symbolName, mcpUrl });
  return queryResultToTypeAggregatorRows(result);
}, [workspaceRoot, mcpUrl]);
```

- [ ] **Step 5: Pass new callbacks to RelationWindow in JSX**

Find the `<RelationWindow ...>` render in App.tsx and add:

```tsx
<RelationWindow
  // ... existing props ...
  requestModuleImports={requestModuleImports}
  requestModuleDependents={requestModuleDependents}
  requestModuleSymbols={requestModuleSymbols}
  requestClassInheritance={requestClassInheritance}
  requestClassSubtypes={requestClassSubtypes}
  requestInterfaceImplementors={requestInterfaceImplementors}
  requestTypeConsumers={requestTypeConsumers}
  requestTypeFields={requestTypeFields}
  requestFieldReaders={requestFieldReaders}
  requestFieldWriters={requestFieldWriters}
  requestTypeAggregators={requestTypeAggregators}
/>
```

- [ ] **Step 6: Verify compile**

```bash
cd /home/abhi/qprojects/tui-relation-window && bun tsc --noEmit 2>&1 | head -40
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd /home/abhi/qprojects/tui-relation-window
git add src/App.tsx
git commit -m "feat(app): add query callbacks for module/class/data view modes"
```

---

### Task 4: ModeHeader component

**Files:**
- Create: `src/components/ModeHeader.tsx`

- [ ] **Step 1: Write the component**

```typescript
// src/components/ModeHeader.tsx
import React from 'react';
import { Box, Text } from 'ink';

export type ViewMode = 1 | 2 | 3 | 4;

const MODE_LABELS: Record<ViewMode, string> = {
  1: 'Module',
  2: 'Class',
  3: 'API',
  4: 'Data',
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
    <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
      <Box flexDirection="row" gap={1}>
        {([1, 2, 3, 4] as ViewMode[]).map((m) => (
          <Text
            key={m}
            bold={m === activeMode}
            dimColor={m !== activeMode}
            color={m === activeMode ? 'cyan' : undefined}
          >
            [{m}:{MODE_LABELS[m]}]
          </Text>
        ))}
      </Box>
      <Box flexDirection="row" gap={2}>
        <Text dimColor>{location}</Text>
        <Text dimColor>?:help  q:quit</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 2: Verify compile**

```bash
cd /home/abhi/qprojects/tui-relation-window && bun tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /home/abhi/qprojects/tui-relation-window
git add src/components/ModeHeader.tsx
git commit -m "feat(ui): add ModeHeader component with 1-4 tab display"
```

---

### Task 5: EntityBox shared component

**Files:**
- Create: `src/components/shared/EntityBox.tsx`

- [ ] **Step 1: Write the component**

```typescript
// src/components/shared/EntityBox.tsx
import React from 'react';
import { Box, Text } from 'ink';

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
  onSelect?: (row: EntityRow) => void;
  selectedIndex?: number;
};

export function EntityBox({ title, subtitle, rows, focused, maxRows, selectedIndex }: Props) {
  const borderStyle = focused ? 'double' : 'single';
  const visibleRows = maxRows != null ? rows.slice(0, maxRows) : rows;
  const overflow = maxRows != null && rows.length > maxRows ? rows.length - maxRows : 0;

  return (
    <Box borderStyle={borderStyle} flexDirection="column" paddingX={1}>
      <Text bold color={focused ? 'yellow' : 'cyan'}>{title}</Text>
      {subtitle && <Text dimColor>{subtitle}</Text>}
      {visibleRows.length > 0 && (
        <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} marginTop={0}>
          <Box flexDirection="column">
            {visibleRows.map((row, i) => (
              <Box key={i} flexDirection="row" gap={1}>
                <Text
                  color={i === selectedIndex ? 'green' : row.dimmed ? undefined : 'white'}
                  dimColor={row.dimmed}
                  bold={i === selectedIndex}
                >
                  {row.label}
                </Text>
                {row.detail && <Text dimColor>{row.detail}</Text>}
              </Box>
            ))}
          </Box>
        </Box>
      )}
      {overflow > 0 && <Text dimColor>  {overflow} more...</Text>}
    </Box>
  );
}
```

- [ ] **Step 2: Verify compile**

```bash
cd /home/abhi/qprojects/tui-relation-window && bun tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /home/abhi/qprojects/tui-relation-window
git add src/components/shared/EntityBox.tsx
git commit -m "feat(ui): add EntityBox shared component"
```

---

### Task 6: ModuleView (Mode 1)

**Files:**
- Create: `src/components/ModuleView.tsx`

- [ ] **Step 1: Write ModuleView**

```typescript
// src/components/ModuleView.tsx
import React, { useEffect, useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { EntityBox, type EntityRow } from './shared/EntityBox';
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

export function ModuleView({
  rootFilePath,
  rootName,
  requestModuleImports,
  requestModuleDependents,
  requestModuleSymbols,
  onOpenLocation,
}: Props) {
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

  const activeList = activePane === 'imports' ? imports : activePane === 'dependents' ? dependents : symbols;

  useInput((input, key) => {
    if (key.tab) {
      setActivePane(p => p === 'imports' ? 'center' : p === 'center' ? 'dependents' : 'imports');
      setSelectedIdx(0);
    }
    if (key.downArrow || input === 'j') setSelectedIdx(i => Math.min(i + 1, activeList.length - 1));
    if (key.upArrow || input === 'k') setSelectedIdx(i => Math.max(i - 1, 0));
    if (key.return || input === 'o') {
      const item = activeList[selectedIdx];
      if (item?.filePath) {
        onOpenLocation({ id: item.filePath, label: item.name ?? item.filePath, filePath: item.filePath, lineNumber: 1, relationType: 'incoming' });
      }
    }
  });

  if (loading) return <Text dimColor>Loading module graph...</Text>;

  const moduleClasses = symbols.filter(s => ['class', 'interface', 'struct', 'trait', 'enum'].includes(s.kind ?? ''));
  const moduleFunctions = symbols.filter(s => ['function', 'method'].includes(s.kind ?? ''));

  const centerSubtitle = `${moduleClasses.length} types, ${moduleFunctions.length} functions, ${imports.length} imports`;

  const importRows: EntityRow[] = imports.map(m => ({ label: m.name ?? m.filePath ?? '', detail: m.filePath, filePath: m.filePath }));
  const dependentRows: EntityRow[] = dependents.map(m => ({ label: m.name ?? m.filePath ?? '', filePath: m.filePath }));

  return (
    <Box flexDirection="row" gap={2} padding={1}>
      <Box flexDirection="column" width={30}>
        <Text bold dimColor>imports from</Text>
        {importRows.length === 0
          ? <Text dimColor>(none)</Text>
          : <EntityBox title="imports" rows={importRows} focused={activePane === 'imports'} selectedIndex={activePane === 'imports' ? selectedIdx : undefined} maxRows={10} />
        }
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        <EntityBox
          title={filePath.split('/').pop() ?? filePath}
          subtitle={centerSubtitle}
          rows={symbols.map(s => ({ label: `${s.name}`, detail: s.kind, filePath: s.filePath, lineNumber: s.lineNumber }))}
          focused={activePane === 'center'}
          selectedIndex={activePane === 'center' ? selectedIdx : undefined}
          maxRows={15}
        />
      </Box>

      <Box flexDirection="column" width={30}>
        <Text bold dimColor>used by</Text>
        {dependentRows.length === 0
          ? <Text dimColor>(none)</Text>
          : <EntityBox title="dependents" rows={dependentRows} focused={activePane === 'dependents'} selectedIndex={activePane === 'dependents' ? selectedIdx : undefined} maxRows={10} />
        }
      </Box>
    </Box>
  );
}
```

- [ ] **Step 2: Verify compile**

```bash
cd /home/abhi/qprojects/tui-relation-window && bun tsc --noEmit 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /home/abhi/qprojects/tui-relation-window
git add src/components/ModuleView.tsx
git commit -m "feat(ui): add ModuleView (Mode 1) — file dependency graph"
```

---

### Task 7: ClassView (Mode 2)

**Files:**
- Create: `src/components/ClassView.tsx`

- [ ] **Step 1: Write ClassView**

```typescript
// src/components/ClassView.tsx
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { EntityBox, type EntityRow } from './shared/EntityBox';
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

export function ClassView({
  rootName,
  rootFilePath,
  requestModuleSymbols,
  requestClassInheritance,
  requestClassSubtypes,
  requestInterfaceImplementors,
  requestTypeConsumers,
  onOpenLocation,
}: Props) {
  const [members, setMembers] = useState<ModuleSymbolRow[]>([]);
  const [parents, setParents] = useState<ClassRow[]>([]);
  const [subtypes, setSubtypes] = useState<ClassRow[]>([]);
  const [implementors, setImplementors] = useState<ClassRow[]>([]);
  const [consumers, setConsumers] = useState<TypeConsumerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedMemberIdx, setSelectedMemberIdx] = useState(0);

  useEffect(() => {
    setLoading(true);
    const filePath = rootFilePath ?? '';
    Promise.all([
      filePath ? requestModuleSymbols(filePath) : Promise.resolve([]),
      requestClassInheritance(rootName),
      requestClassSubtypes(rootName),
      requestInterfaceImplementors(rootName),
      requestTypeConsumers(rootName),
    ]).then(([syms, par, sub, impl, cons]) => {
      // Filter to members of this class (contains edge from rootName)
      setMembers(syms.filter(s => ['method', 'function', 'field'].includes(s.kind ?? '')));
      setParents(par);
      setSubtypes(sub);
      setImplementors(impl);
      setConsumers(cons);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [rootName, rootFilePath]);

  useInput((input, key) => {
    if (key.downArrow || input === 'j') setSelectedMemberIdx(i => Math.min(i + 1, members.length - 1));
    if (key.upArrow || input === 'k') setSelectedMemberIdx(i => Math.max(i - 1, 0));
    if (key.return || input === 'o') {
      const m = members[selectedMemberIdx];
      if (m?.filePath) {
        onOpenLocation({ id: m.filePath, label: m.name ?? '', filePath: m.filePath, lineNumber: m.lineNumber ?? 1, relationType: 'incoming' });
      }
    }
  });

  if (loading) return <Text dimColor>Loading class structure...</Text>;

  const allAbove = [...parents, ...implementors];
  const memberFields = members.filter(m => m.kind === 'field');
  const memberMethods = members.filter(m => m.kind !== 'field');

  const mainRows: EntityRow[] = [
    ...memberFields.map(f => ({ label: `${f.name}`, detail: f.kind, filePath: f.filePath, lineNumber: f.lineNumber })),
    ...memberMethods.map(m => ({ label: `${m.name}()`, detail: m.kind, filePath: m.filePath, lineNumber: m.lineNumber })),
  ];

  return (
    <Box flexDirection="column" padding={1} gap={1}>
      {/* Parents row */}
      {allAbove.length > 0 && (
        <Box flexDirection="row" gap={2}>
          {allAbove.slice(0, 3).map((p, i) => (
            <EntityBox key={i} title={p.name} rows={[]} />
          ))}
        </Box>
      )}

      {/* Main class box */}
      <EntityBox
        title={rootName}
        subtitle="(focused)"
        rows={mainRows}
        focused={true}
        selectedIndex={selectedMemberIdx}
        maxRows={20}
      />

      {/* Consumers / subtypes */}
      {(subtypes.length > 0 || consumers.length > 0) && (
        <Box flexDirection="row" gap={2}>
          {subtypes.slice(0, 2).map((s, i) => (
            <EntityBox key={`sub-${i}`} title={s.name} rows={[]} />
          ))}
          {consumers.length > 0 && (
            <Text dimColor>  used by {consumers.length} type{consumers.length > 1 ? 's' : ''}</Text>
          )}
        </Box>
      )}
    </Box>
  );
}
```

- [ ] **Step 2: Verify compile**

```bash
cd /home/abhi/qprojects/tui-relation-window && bun tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 3: Commit**

```bash
cd /home/abhi/qprojects/tui-relation-window
git add src/components/ClassView.tsx
git commit -m "feat(ui): add ClassView (Mode 2) — type structure with inheritance"
```

---

### Task 8: DataView (Mode 4)

**Files:**
- Create: `src/components/DataView.tsx`

- [ ] **Step 1: Write DataView**

```typescript
// src/components/DataView.tsx
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { EntityBox, type EntityRow } from './shared/EntityBox';
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

export function DataView({
  rootName,
  requestTypeFields,
  requestFieldReaders,
  requestFieldWriters,
  requestTypeAggregators,
  onOpenLocation,
}: Props) {
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
    ]).then(([f, r, w, a]) => {
      setFields(f);
      setReaders(r);
      setWriters(w);
      setAggregators(a);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [rootName]);

  const activeList = activePane === 'writers' ? writers : activePane === 'readers' ? readers : fields;

  useInput((input, key) => {
    if (key.tab) {
      setActivePane(p => p === 'writers' ? 'center' : p === 'center' ? 'readers' : 'writers');
      setSelectedIdx(0);
    }
    if (key.downArrow || input === 'j') setSelectedIdx(i => Math.min(i + 1, activeList.length - 1));
    if (key.upArrow || input === 'k') setSelectedIdx(i => Math.max(i - 1, 0));
    if (key.return || input === 'o') {
      const item = activeList[selectedIdx] as any;
      if (item?.filePath) {
        onOpenLocation({ id: item.filePath, label: item.accessor ?? item.field ?? '', filePath: item.filePath, lineNumber: item.lineNumber ?? 1, relationType: 'incoming' });
      }
    }
  });

  if (loading) return <Text dimColor>Loading data flow...</Text>;

  const writerRows: EntityRow[] = writers.map(w => ({ label: w.accessor, detail: w.fieldName ? `writes: ${w.fieldName}` : undefined, filePath: w.filePath }));
  const readerRows: EntityRow[] = readers.map(r => ({ label: r.accessor, detail: r.fieldName ? `reads: ${r.fieldName}` : undefined, filePath: r.filePath }));
  const fieldRows: EntityRow[] = fields.map(f => ({ label: f.field, detail: f.fieldType }));

  return (
    <Box flexDirection="column" padding={1} gap={1}>
      <Box flexDirection="row" gap={2}>
        {/* Writers column */}
        <Box flexDirection="column" width={28}>
          <Text bold dimColor>writers</Text>
          {writerRows.length === 0
            ? <Text dimColor>(none)</Text>
            : <EntityBox title="writers" rows={writerRows} focused={activePane === 'writers'} selectedIndex={activePane === 'writers' ? selectedIdx : undefined} maxRows={10} />
          }
        </Box>

        {/* Center: type fields */}
        <Box flexDirection="column" flexGrow={1}>
          <EntityBox
            title={rootName}
            subtitle="(type)"
            rows={fieldRows}
            focused={activePane === 'center'}
            selectedIndex={activePane === 'center' ? selectedIdx : undefined}
            maxRows={15}
          />
          {aggregators.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>aggregated by</Text>
              {aggregators.slice(0, 3).map((a, i) => (
                <EntityBox key={i} title={a.aggregator} rows={[]} />
              ))}
            </Box>
          )}
        </Box>

        {/* Readers column */}
        <Box flexDirection="column" width={28}>
          <Text bold dimColor>readers</Text>
          {readerRows.length === 0
            ? <Text dimColor>(none)</Text>
            : <EntityBox title="readers" rows={readerRows} focused={activePane === 'readers'} selectedIndex={activePane === 'readers' ? selectedIdx : undefined} maxRows={10} />
          }
        </Box>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 2: Verify compile**

```bash
cd /home/abhi/qprojects/tui-relation-window && bun tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 3: Commit**

```bash
cd /home/abhi/qprojects/tui-relation-window
git add src/components/DataView.tsx
git commit -m "feat(ui): add DataView (Mode 4) — field flow with writers/type/readers"
```

---

### Task 9: ApiView (Mode 3) — migrate from BothRelationWindow

**Files:**
- Create: `src/components/ApiView.tsx`

- [ ] **Step 1: Create ApiView as a thin wrapper around BothRelationWindow**

The API view is functionally identical to the existing BothRelationWindow. Rather than duplicating 900+ lines, ApiView is a named re-export alias.

```typescript
// src/components/ApiView.tsx
/**
 * Mode 3: API / Call Flow view.
 * Delegates entirely to BothRelationWindow — the call flow logic lives there.
 * This file exists so ModeRouter can import ApiView without knowing about BothRelationWindow.
 */
export { BothRelationWindow as ApiView } from './BothRelationWindow';
export type { Props as ApiViewProps } from './BothRelationWindow';
```

Note: If BothRelationWindow doesn't export its Props type, add `export type Props = { ... }` to BothRelationWindow.tsx first, or just use the inline spread approach:

```typescript
// src/components/ApiView.tsx
import { BothRelationWindow } from './BothRelationWindow';
export { BothRelationWindow as ApiView };
```

- [ ] **Step 2: Verify compile**

```bash
cd /home/abhi/qprojects/tui-relation-window && bun tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
cd /home/abhi/qprojects/tui-relation-window
git add src/components/ApiView.tsx
git commit -m "feat(ui): add ApiView (Mode 3) wrapping BothRelationWindow"
```

---

### Task 10: Wire RelationWindow with mode routing

**Files:**
- Modify: `src/components/RelationWindow.tsx`

- [ ] **Step 1: Update Props type**

Replace the existing Props type in `src/components/RelationWindow.tsx` with:

```typescript
import React, { useState } from 'react';
import { Box, useInput } from 'ink';
import type { FlatRelationItem, QueryMode } from '../lib/types';
import type { LogRow, StructWriterRow, ModuleRow, ModuleSymbolRow, ClassRow, TypeConsumerRow, TypeFieldRow, FieldAccessRow, TypeAggregatorRow } from '../lib/intelligence-query-adapters';
import { BothRelationWindow } from './BothRelationWindow';
import { ModeHeader, type ViewMode } from './ModeHeader';
import { ModuleView } from './ModuleView';
import { ClassView } from './ClassView';
import { DataView } from './DataView';

type Props = {
  mode: 'incoming' | 'outgoing' | 'both';
  provider: string;
  rootName: string;
  rootFilePath?: string;
  rootLineNumber?: number;
  items: FlatRelationItem[];
  incomingItems: FlatRelationItem[];
  outgoingItems: FlatRelationItem[];
  requestExpand: (node: { id: string; label: string; filePath: string; lineNumber: number; mode: QueryMode }) => Promise<FlatRelationItem[]>;
  requestHover?: (node: { id: string; label: string; filePath: string; lineNumber: number }) => Promise<string>;
  requestLogs?: (apiName: string) => Promise<LogRow[]>;
  requestStructWrites?: (apiName: string) => Promise<StructWriterRow[]>;
  workspaceRoot?: string;
  onOpenLocation: (item: FlatRelationItem) => void;
  onRefresh: () => void;
  // Mode 1
  requestModuleImports?: (filePath: string) => Promise<ModuleRow[]>;
  requestModuleDependents?: (filePath: string) => Promise<ModuleRow[]>;
  requestModuleSymbols?: (filePath: string) => Promise<ModuleSymbolRow[]>;
  // Mode 2
  requestClassInheritance?: (symbolName: string) => Promise<ClassRow[]>;
  requestClassSubtypes?: (symbolName: string) => Promise<ClassRow[]>;
  requestInterfaceImplementors?: (symbolName: string) => Promise<ClassRow[]>;
  requestTypeConsumers?: (symbolName: string) => Promise<TypeConsumerRow[]>;
  // Mode 4
  requestTypeFields?: (symbolName: string) => Promise<TypeFieldRow[]>;
  requestFieldReaders?: (symbolName: string) => Promise<FieldAccessRow[]>;
  requestFieldWriters?: (symbolName: string) => Promise<FieldAccessRow[]>;
  requestTypeAggregators?: (symbolName: string) => Promise<TypeAggregatorRow[]>;
};
```

- [ ] **Step 2: Replace component body with mode router**

```typescript
export function RelationWindow(props: Props) {
  const {
    rootName, rootFilePath, rootLineNumber,
    incomingItems, outgoingItems,
    requestExpand, requestHover, requestLogs, requestStructWrites,
    onOpenLocation, onRefresh,
    requestModuleImports, requestModuleDependents, requestModuleSymbols,
    requestClassInheritance, requestClassSubtypes, requestInterfaceImplementors, requestTypeConsumers,
    requestTypeFields, requestFieldReaders, requestFieldWriters, requestTypeAggregators,
  } = props;

  const [viewMode, setViewMode] = useState<ViewMode>(3);

  useInput((input) => {
    if (input === '1') setViewMode(1);
    if (input === '2') setViewMode(2);
    if (input === '3') setViewMode(3);
    if (input === '4') setViewMode(4);
    if (input === 'r') onRefresh();
  });

  const noop = () => Promise.resolve([]);

  return (
    <Box flexDirection="column">
      <ModeHeader
        activeMode={viewMode}
        rootName={rootName}
        rootFilePath={rootFilePath}
        rootLineNumber={rootLineNumber}
      />

      {viewMode === 1 && (
        <ModuleView
          rootFilePath={rootFilePath}
          rootName={rootName}
          requestModuleImports={requestModuleImports ?? (() => Promise.resolve([]))}
          requestModuleDependents={requestModuleDependents ?? (() => Promise.resolve([]))}
          requestModuleSymbols={requestModuleSymbols ?? (() => Promise.resolve([]))}
          onOpenLocation={onOpenLocation}
        />
      )}

      {viewMode === 2 && (
        <ClassView
          rootName={rootName}
          rootFilePath={rootFilePath}
          rootLineNumber={rootLineNumber}
          requestModuleSymbols={requestModuleSymbols ?? (() => Promise.resolve([]))}
          requestClassInheritance={requestClassInheritance ?? (() => Promise.resolve([]))}
          requestClassSubtypes={requestClassSubtypes ?? (() => Promise.resolve([]))}
          requestInterfaceImplementors={requestInterfaceImplementors ?? (() => Promise.resolve([]))}
          requestTypeConsumers={requestTypeConsumers ?? (() => Promise.resolve([]))}
          onOpenLocation={onOpenLocation}
        />
      )}

      {viewMode === 3 && (
        <BothRelationWindow
          rootName={rootName}
          rootFilePath={rootFilePath}
          rootLineNumber={rootLineNumber}
          incomingItems={incomingItems}
          outgoingItems={outgoingItems}
          requestExpand={requestExpand}
          requestHover={requestHover}
          requestLogs={requestLogs}
          requestStructWrites={requestStructWrites}
          onOpenLocation={onOpenLocation}
        />
      )}

      {viewMode === 4 && (
        <DataView
          rootName={rootName}
          rootFilePath={rootFilePath}
          requestTypeFields={requestTypeFields ?? (() => Promise.resolve([]))}
          requestFieldReaders={requestFieldReaders ?? (() => Promise.resolve([]))}
          requestFieldWriters={requestFieldWriters ?? (() => Promise.resolve([]))}
          requestTypeAggregators={requestTypeAggregators ?? (() => Promise.resolve([]))}
          onOpenLocation={onOpenLocation}
        />
      )}
    </Box>
  );
}
```

- [ ] **Step 3: Verify compile**

```bash
cd /home/abhi/qprojects/tui-relation-window && bun tsc --noEmit 2>&1 | head -40
```

Expected: no errors.

- [ ] **Step 4: Run all tests**

```bash
cd /home/abhi/qprojects/tui-relation-window && bun test 2>&1 | tail -30
```

Expected: all existing tests pass (new components have no tests yet, existing RelationWindow tests should still pass).

- [ ] **Step 5: Commit**

```bash
cd /home/abhi/qprojects/tui-relation-window
git add src/components/RelationWindow.tsx
git commit -m "feat(ui): wire RelationWindow with 4 view modes via 1-4 key switching"
```

---

### Task 11: Smart auto-mode selection

The spec says: when the TUI opens, pick the initial mode based on symbol kind:
- import/module → Mode 1
- class/struct/trait/interface → Mode 2
- function/method → Mode 3
- field/typedef → Mode 4

**Files:**
- Modify: `src/components/RelationWindow.tsx`
- Modify: `src/lib/types.ts` (check if symbolKind is in RelationPayload)

- [ ] **Step 1: Add auto-mode selector to RelationWindow**

In RelationWindow.tsx, replace `useState<ViewMode>(3)` with:

```typescript
function inferInitialMode(rootName: string, symbolKind?: number): ViewMode {
  // LSP symbol kinds: Module=2, Class=5, Interface=11, Struct=23, Function=12, Method=6, Field=8, Property=7
  if (symbolKind === 2) return 1; // Module → Module view
  if (symbolKind === 5 || symbolKind === 11 || symbolKind === 23 || symbolKind === 24) return 2; // Class/Interface/Struct/Enum
  if (symbolKind === 12 || symbolKind === 6 || symbolKind === 9) return 3; // Function/Method/Constructor
  if (symbolKind === 8 || symbolKind === 7 || symbolKind === 26) return 4; // Field/Property/TypeParameter
  // Fallback: check name patterns
  if (rootName.endsWith('.ts') || rootName.endsWith('.rs') || rootName.endsWith('.c') || rootName.endsWith('.h')) return 1;
  return 3; // Default to API view
}

// In component:
const [viewMode, setViewMode] = useState<ViewMode>(() => inferInitialMode(rootName, /* symbolKind from props */));
```

To pass symbolKind, check `props.items[0]?.symbolKind` or `payload.result?.[rootName]?.symbolKind` from App.tsx. Add `initialSymbolKind?: number` to Props and pass it through.

In App.tsx, find where RelationWindow is rendered and add:
```tsx
initialSymbolKind={payload?.result ? Object.values(payload.result)[0]?.symbolKind : undefined}
```

In RelationWindow.tsx Props, add: `initialSymbolKind?: number`

Update useState:
```typescript
const [viewMode, setViewMode] = useState<ViewMode>(() => inferInitialMode(rootName, initialSymbolKind));
```

- [ ] **Step 2: Verify compile**

```bash
cd /home/abhi/qprojects/tui-relation-window && bun tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 3: Commit**

```bash
cd /home/abhi/qprojects/tui-relation-window
git add src/components/RelationWindow.tsx src/App.tsx
git commit -m "feat(ui): smart auto-mode selection based on symbol kind"
```

---

### Task 12: Final integration verification

- [ ] **Step 1: Build the TUI**

```bash
cd /home/abhi/qprojects/tui-relation-window && bun run build 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 2: Run all tests**

```bash
cd /home/abhi/qprojects/tui-relation-window && bun test 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 3: Verify the TUI starts**

```bash
cd /home/abhi/qprojects/tui-relation-window && echo '{"rootName":"test","rootFilePath":"/tmp/test.ts","rootLineNumber":1,"incomingItems":[],"outgoingItems":[],"mode":"both","provider":"test"}' | timeout 3 bun run src/index.tsx 2>&1 | head -10
```

Expected: TUI renders without crash (may exit on TTY detection, that's fine).

- [ ] **Step 4: Final commit**

```bash
cd /home/abhi/qprojects/tui-relation-window
git log --oneline -10
```

Verify all tasks are committed.
