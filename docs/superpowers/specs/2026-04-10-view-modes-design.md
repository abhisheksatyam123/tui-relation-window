# TUI View Modes Design Spec

## Goal

Replace the single caller/callee view with 4 purpose-built modes, each showing a different lens on the intelligence graph. Language-agnostic — works for TypeScript, Rust, C/C++, and any future extractor that emits the standard node/edge kinds. Switch between modes with number keys `1`-`4`.

## Language-Agnostic Foundation

All extractors (ts-core, rust-core, clangd-core) emit the same graph primitives:

**Node kinds** (what the modes operate on):

| Concept | TS | Rust | C/C++ | Graph node kind |
|---|---|---|---|---|
| File | file | file/mod.rs | .c/.h file | `module` |
| Type with methods | class, interface | struct+impl, trait | struct | `class`, `interface`, `struct`, `trait` |
| Method/member | method | method | function (in struct) | `method`, `function` |
| Free function | function | function | function | `function` |
| Field | field | field | field | `field` |
| Type alias | typedef | typedef | typedef | `typedef` |

**Edge kinds** (what the modes query):

| Relationship | Edge kind | Available in |
|---|---|---|
| A calls B | `calls` | All |
| A runtime-calls B | `runtime_calls` | C/C++ |
| A contains B | `contains` | All (module→class, class→method) |
| A imports B | `imports` | TS, Rust |
| A extends B | `extends` | TS, Rust |
| A implements B | `implements` | TS, Rust |
| A references type B | `references_type` | All |
| A reads field B | `reads_field` | All |
| A writes field B | `writes_field` | All |
| A's field has type B | `field_of_type` | All |
| A aggregates B | `aggregates` | All |
| A registers callback B | `registers_callback` | C/C++ |
| A dispatches to B | `dispatches_to` | C/C++ |
| A logs event B | `logs_event` | C/C++ |

The view modes query by edge kind, not by language. A mode works for any language that emits the relevant edges.

## Architecture

```
RelationWindow.tsx          ← router: reads viewMode, renders correct view
  ├── ModuleView.tsx        ← Mode 1: file dependency boxes (OpenTUI box-based)
  ├── ClassView.tsx         ← Mode 2: type structure diagram (OpenTUI box-based)
  ├── ApiView.tsx           ← Mode 3: call flow with grouped boxes (hybrid)
  └── DataView.tsx          ← Mode 4: field data flow (OpenTUI box-based)
```

Each view is an independent React component. All share the same `requestExpand` callback and graph state pattern from `App.tsx`. The router passes mode + data; each view owns its own layout, keybindings, and rendering.

## Rendering Strategy

- **Module, Class, Data views**: OpenTUI `<box border="single">` with flexbox layout. Real box-drawing borders, nested containers, padding, colors per `<text>` segment.
- **API view**: Hybrid — OpenTUI boxes for the module/class grouping containers, character-grid canvas for edge routing between function nodes.

## Header Bar (all modes)

```
[1:Module] [2:Class] [3:API] [4:Data]    src/intelligence/init.ts:45    ?:help  q:quit
```

Active mode highlighted (bright + bold). Inactive dimmed. File:line always visible.

## Mode 1: Module

**Purpose**: File-level dependency graph. What does this file import, who depends on it.

**Works for**: All languages. C/C++ files without `imports` edges show `contains` relationships instead (header→source inclusion).

**Center**: The file the cursor is in.

**Layout**:
```
 imports (left)                    current file (center)              imported by (right)
+-------------------------+      +---------------------------+      +----------------------+
| backend-factory.ts      |----->| init.ts                   |----->| tools/index.ts       |
| (3 exports, 2 classes)  |      |                           |      | (15 imports)         |
+-------------------------+      | 4 classes, 2 functions    |      +----------------------+
                                 | 9 imports                 |
+-------------------------+      +---------------------------+      used by 3 more...
| db/sqlite/client.ts     |----->
+-------------------------+      imports 7 more...
```

**Data source**: `find_module_imports` (left), `find_module_dependents` (right), `find_module_symbols` (center summary).

**Box content**: Filename, summary (N classes, N functions, N structs), import/export count.

**Expand**: "imports N more..." / "used by N more..." expandable with `l`. Collapse with `h`.

**Navigation**: `j`/`k` move between boxes, `l` expand, `h` collapse, `o` open file.

## Mode 2: Class (Type Structure)

**Purpose**: Show the type under cursor — its members, inheritance chain, and consumers. Language-agnostic: works for TS classes, Rust structs/traits, C structs.

**Center**: The type the cursor is inside. Detected by node kind: `class`, `interface`, `struct`, `trait`, `enum`.

**Layout**:
```
       implements/trait                                  extends/super
+------------------+                              +------------------+
| IDbFoundation    |                              | EventEmitter     |
+------------------+                              +------------------+
        ^                                                ^
        |                                                |
+==========================================+
| SqliteDbFoundation              class    |   ← double border = focused
|------------------------------------------|
| db       : BetterSQLite3Database         |   ← fields section
| raw      : Database                      |
|------------------------------------------|
| initSchema()                             |   ← methods section
| beginSnapshot()                          |
| commitSnapshot()                         |
+==========================================+
                    |
             used by 5 types...                    ← expandable
```

**Language adaptations** (all handled by the same component, just different edge queries):

| Language | "Implements" box | "Extends" box | Members |
|---|---|---|---|
| TypeScript | `implements` edges → interfaces | `extends` edges → parent class | methods + fields via `contains` |
| Rust | `implements` edges → traits | — (no class inheritance) | methods via `contains` from impl block |
| C/C++ | — (no interfaces) | — (no inheritance in C) | fields via `contains`, functions that take struct* as first arg |

**Data source**:
- Members: `find_module_symbols` filtered to `contains` edges from this type
- Inheritance: `find_class_inheritance` (extends), `find_interface_implementors` (implements, reversed)
- Consumers: `find_type_consumers` (references_type pointing here)

**Navigation**: `j`/`k` move between members, `Tab` jump between type boxes, `l` expand consumers, `o` open at member line.

## Mode 3: API (Call Flow)

**Purpose**: Who calls this function, what does it call. Grouped by class-within-file for boundary context.

**Center**: The function/method the cursor is on.

**Layout**:
```
CALLERS                                getLogger()                    CALLEES

+- init.ts -------------------+                              +- logging/ ----------+
| initIntelligenceBackend  :78|-----+                   +--->| createLogStream  :12|
+-----------------------------+     |                   |    | formatTimestamp  :28|
+- reason-engine/llm-adv.ts --+     |  +-----------+   |    +---------------------+
|  +- LlmAdvisor ------------+|     +--| getLogger |---+
|  | extractJson             ||-----+  | logger:45 |
|  | requestReasonProposals  ||-----+  +-----------+
|  +--------------------------+|
+------------------------------+
```

**Grouping hierarchy**: file → class → function. If a caller is a free function, it's directly inside the file box. If it's a method, it's inside a class box inside the file box.

**Language adaptations**:

| Language | Grouping | Extra edge kinds shown |
|---|---|---|
| TypeScript | file → class → method | `calls` only |
| Rust | file → impl block → method | `calls` only |
| C/C++ | file → struct → function | `calls`, `runtime_calls`, `registers_callback`, `dispatches_to` with edge glyphs |

**C/C++ extras**: Edge glyphs for indirect callers: `║` registration, `╎` interrupt, `┈` timer, `┄` thread. HW entity nodes rendered with special badges.

**Data source**: `who_calls_api` (incoming), `what_api_calls` (outgoing). For methods, also queries parent class/struct name.

**Navigation**: `j`/`k` move nodes, `h`/`l` switch panes, `Tab` toggle active pane, `o` open at line, `l` expand a caller recursively.

## Mode 4: Data (Field Flow)

**Purpose**: How data flows through a type's fields. Who reads, who writes, what types aggregate this one.

**Center**: The type the cursor is on (data perspective: fields and access patterns, not methods).

**Layout**:
```
      writers                       type                           readers
+-------------------+    +==========================+    +-------------------+
| parseArgs         |--->| WorkspaceConfig          |--->| resolveBackend    |
|  writes: root     |    |--------------------------|    |  reads: language  |
+-------------------+    | root?      : string      |    +-------------------+
                         | language?  : string      |
+-------------------+    | server?    : string      |    +-------------------+
| setConfig         |--->| intelligence?: Kind      |--->| readConfig        |
|  writes: language |    +==========================+    |  reads: root,     |
+-------------------+             |                      |         server    |
                            aggregated by                +-------------------+
                     +-------------------+
                     | LifecycleConfig   |
                     +-------------------+
```

**Works for all languages**: Any type with `field` children and `reads_field`/`writes_field` edges. C structs with field access patterns are the primary use case, but works for TS interfaces and Rust structs too.

**Data source**:
- Fields: `find_type_fields` (contains edges to field children)
- Field types: `find_field_type` (field_of_type edges)
- Readers: `find_field_readers` (reads_field edges)
- Writers: `find_field_writers` (writes_field edges)
- Aggregation: `find_type_aggregators` (aggregates edges)

**Navigation**: `j`/`k` move between fields, `h`/`l` switch columns (writers/type/readers), `o` open at field line.

## Mode Switching

- Keys `1`, `2`, `3`, `4` switch modes instantly
- Active mode stored in component state
- When switching, the center entity maps:
  - Cursor on method → API shows that method, Class shows parent class, Module shows parent file, Data shows parent type
  - Cursor on class → Class shows that class, API shows first method, Module shows parent file, Data shows that class's fields
  - Cursor on import line → Module shows that file

## Smart Auto-Mode Selection

When `<leader>rb` opens the TUI, initial mode is picked from symbol kind:

| Cursor on | Default mode | Rationale |
|---|---|---|
| `import`/`#include` | Module (1) | You're thinking about dependencies |
| Class/struct/trait/interface declaration | Class (2) | You're thinking about type structure |
| Function/method body | API (3) | You're thinking about call flow |
| Type alias / field declaration | Data (4) | You're thinking about data shape |

User can override with `1`-`4` at any time.

## New Components

| File | LOC est. | Purpose |
|------|----------|---------|
| `src/components/ModeRouter.tsx` | ~50 | Reads mode, renders correct view |
| `src/components/ModuleView.tsx` | ~200 | Mode 1 |
| `src/components/ClassView.tsx` | ~250 | Mode 2 |
| `src/components/ApiView.tsx` | ~400 | Mode 3 (migrated from BothRelationWindow) |
| `src/components/DataView.tsx` | ~200 | Mode 4 |
| `src/components/shared/EntityBox.tsx` | ~80 | Reusable box: border, title, member list |
| `src/components/shared/ModeHeader.tsx` | ~40 | Header bar with mode tabs |

## Query Intents Used (all already exist)

- **Module**: `find_module_imports`, `find_module_dependents`, `find_module_symbols`
- **Class**: `find_module_symbols`, `find_class_inheritance`, `find_class_subtypes`, `find_interface_implementors`, `find_type_consumers`
- **API**: `who_calls_api`, `what_api_calls` (+ `who_calls_api_at_runtime` for C/C++)
- **Data**: `find_type_fields`, `find_field_type`, `find_field_readers`, `find_field_writers`, `find_type_aggregators`

No new MCP intents needed.

## Keybindings Summary

| Key | All modes | Notes |
|-----|-----------|-------|
| `1`-`4` | Switch mode | Instant, preserves center entity |
| `j`/`k` | Move selection | Within current column/list |
| `h`/`l` | Collapse/expand or switch panes | Mode-dependent |
| `Tab` | Jump between boxes/panes | Mode-dependent |
| `o`/`Enter` | Open in editor | At selected node's file:line |
| `r` | Refresh | Re-query from graph |
| `?` | Help overlay | Mode-specific key hints |
| `q` | Quit | Close TUI |
| `/` | Search | Filter visible nodes by name |
