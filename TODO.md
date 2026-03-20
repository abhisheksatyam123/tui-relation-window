# q-relation-tui — Project TODO & Release Tracker

> **Version:** 0.1.0 (pre-release)
> **Last updated:** 2026-03-20 (log-driven runtime tracking added)

---

## Table of Contents

- [Release 0.1.0 — Criteria](#release-010--criteria)
- [Bugs — Open](#bugs--open)
- [Runtime Log Watch](#runtime-log-watch)
- [Tech Debt — Open](#tech-debt--open)
- [Features — Backlog](#features--backlog)
- [Testing Gaps — Open](#testing-gaps--open)
- [Done](#done)

---

## Release 0.1.0 — Criteria

A release is ready when the following checklist passes:

- [x] `bun run typecheck` — zero errors
- [x] `bun test` — all unit tests pass (17/17)
- [x] `bun run test:integration` — mock-MCP contract tests pass
- [x] `bun run test:connectivity` — live MCP connectivity test passes
- [x] `bun run test:e2e` — TUI bridge end-to-end test passes
- [ ] TUI renders correctly in a Neovim split and tab layout (manual verification)
- [ ] Incoming and outgoing modes both display and expand correctly (manual)
- [ ] `Enter` / `o` navigates to the correct file and line in the source window (manual)
- [ ] `r` refresh re-queries the backend and updates the tree (manual)
- [ ] `q` / `Esc` exits cleanly with `quit_ack` (manual)
- [ ] No visible ANSI noise or JSON bleed in the TUI terminal buffer (manual)
- [ ] Logs written correctly to `~/.local/share/tui-relation-window/logs/` (manual)
- [x] README is accurate and complete

---

## Bugs — Open

### High (runtime blockers)

| ID | Component | Description | Evidence | Status |
|----|-----------|-------------|----------|--------|
| BUG-019 | Bridge (Neovim ↔ TUI) | `query_relations` request occasionally gets no `query_result/query_error`, causing expand timeout and no caller-of-caller | `app.log` 2026-03-19 22:50:01 / 23:09:38 / 23:23:28 show `query_relations requested` followed by timeout; `backend.log` has no matching expand query in those runs | **In Progress** — parser hardened to consume prefixed frames from both stdout/stderr; pending fresh runtime validation |
| BUG-020 | Neovim session lifecycle | After closing relation tab, subsequent refresh/open can hit `session is not running` due to stale active session bookkeeping | `nvim.log` 2026-03-20 04:08:45 / 04:19:37 / 04:21:15 `refresh: session is not running` | **In Progress** — dead-session pruning + auto-reopen added in `nvim/relation_window.lua`; pending log re-check |
| BUG-021 | TUI input/query flow | Repeated key handling can flood query requests for the same node before first response, increasing chance of timeouts and inconsistent caller-of-caller expansion | `app.log` 2026-03-19 23:10:24 shows many `query_relations requested` for same parent in the same second | **In Progress** — in-flight dedupe by `parentId` added in `src/App.tsx`; pending log validation |
| BUG-022 | Query cursor position | Expand requests used `character=1`, causing `prepareCallHierarchy` to miss symbol on declaration lines (no prepare item, no deeper callers) | `clangd-mcp.log` 2026-03-19 23:32:50: `call-hierarchy prepare result` count=0 for `bpf_offload.c:223:0`; direct probe confirms `--character 1` resolves to `type-alias` but `--character 16` resolves `wlan_bpf_offload_vdev_filter_handle` with callers | **In Progress** — TUI now infers character from source line + selected label before sending `query_relations` |
| BUG-023 | TUI keyboard input | Control-sequence bytes from terminal can be interpreted as normal keys (`q/r/o/h/j/k/l`), causing accidental quit/refresh/open storms and session teardown | `app.log` 2026-03-19 23:36:04 and 23:40:49 show burst of mixed actions in same millisecond (`open_location`, `request_refresh`, `quit_ack`) | **In Progress** — key handler now requires strict `name+sequence+raw` plain-key match, removed ambiguous uppercase sequence shortcuts, and added short action debounce |

### Low / Polish (non-blocking)

| ID | Component | Description | File | Status |
|----|-----------|-------------|------|--------|
| BUG-008 | TUI / RelationWindow | `process.exit(0)` called inside `useKeyboard` handler on `q`/`Esc` — bypasses React cleanup | `src/components/RelationWindow.tsx` | **Accepted** — TUI has no cleanup to do; `quit_ack` is sent first |
| BUG-015 | TUI / RelationWindow | Help text on the status bar may be truncated on very narrow terminals | `src/components/RelationFooter` | **Low** — footer uses `truncate` prop; acceptable |
| BUG-016 | TUI / RelationWindow | Spinner uses braille frames but interval is 120ms — may feel fast on slow terminals | `src/components/RelationComponents.tsx` | **Low** — cosmetic |

---

## Runtime Log Watch

Log files to monitor:

- `logs/app.log`
- `logs/backend.log`
- `logs/nvim.log`

Current observations (2026-03-20):

- [ ] No new `query timeout` entries after latest bridge/session fixes (still failing: 2026-03-19 23:09:38 request timed out at 23:09:48).
- [ ] No new `refresh: session is not running` entries in `nvim.log`.
- [ ] No unexpected `quit requested from keyboard {"key":"escape"}` entries.
- [ ] Expand (`l`) always returns either `query_result` or `query_error` (timeout window increased from 10s to 30s to avoid false timeout on slower MCP calls).
- [ ] Neovim log should show `bridge query_relations received` on each expand (still required to verify after latest parser change).
- [ ] No duplicate burst of `query_relations requested` for same node while a request is in flight.
- [ ] No mixed action storms from a single input burst (`open_location/request_refresh/quit_ack`) in `app.log`.

Manual check command:

```bash
tail -n 200 logs/app.log
tail -n 200 logs/backend.log
tail -n 200 logs/nvim.log
```

---

## Tech Debt — Open

| ID | Component | Description | Priority |
|----|-----------|-------------|----------|
| TD-004 | TUI / RelationWindow | Animation tick still triggers re-renders every 120ms even when idle | Medium |
| TD-005 | Backend | Text-parsing of `lsp_incoming_calls`/`lsp_outgoing_calls` — replace with structured JSON when clangd-mcp supports it | Medium |
| TD-007 | TUI | Unicode-aware string width for any remaining string operations | Low |

---

## Features — Backlog (post v0.1.0)

| ID | Component | Description |
|----|-----------|-------------|
| FEAT-101 | TUI | Mouse support: click to select a node, double-click to expand |
| FEAT-102 | TUI | Search/filter nodes by name within the tree |
| FEAT-103 | TUI | Show a breadcrumb path from root to selected node |
| FEAT-104 | Backend | Support multiple root symbols (e.g. all symbols in a file) |
| FEAT-105 | Backend | Cache relation results per (file, line, character, mode) to avoid redundant MCP calls |
| FEAT-106 | Neovim | Persist last-used mode per workspace root |
| FEAT-107 | TUI | Export the visible tree as plain text or JSON |
| FEAT-108 | Backend | Support non-clangd providers (e.g. rust-analyzer, pyright) via a provider plugin interface |

---

## Testing Gaps — Open

| ID | Area | Gap | Priority |
|----|------|-----|----------|
| TEST-003 | Frontend | No tests for `RelationWindow` tree state transitions (expand, collapse, selection movement) | High |
| TEST-004 | Frontend | No tests for `App.tsx` query waiter map (requestId correlation, timeout/error handling) | High |
| TEST-007 | Backend | No test for MCP auto-start flow (port polling, timeout) | Low |
| TEST-008 | Neovim | No automated tests for `relation_window.lua` (requires Neovim test harness) | Low |

---

## Done

| ID | Component | Description | Version |
|----|-----------|-------------|---------|
| DONE-001 | Backend | MCP HTTP client with JSON-RPC 2.0 + SSE dual-response support | 0.1.0-dev |
| DONE-002 | Backend | Symbol-point probing (hover fallback to nearest identifier) | 0.1.0-dev |
| DONE-003 | Backend | MCP daemon auto-start with port polling | 0.1.0-dev |
| DONE-004 | Backend | Doctor mode for connectivity diagnostics | 0.1.0-dev |
| DONE-005 | Bridge | ANSI noise stripping + JSON extraction from PTY-polluted stdin | 0.1.0-dev |
| DONE-006 | Bridge | Pending message queue for pre-mount messages | 0.1.0-dev |
| DONE-007 | TUI | Lazy node expansion via `query_relations` / `query_result` protocol | 0.1.0-dev |
| DONE-008 | TUI | Keyboard navigation baseline: j/k/h/l, Enter, r, ?, q | 0.1.0-dev |
| DONE-009 | Neovim | Multi-session support (independent session IDs) | 0.1.0-dev |
| DONE-010 | Neovim | `last_source` fallback for refresh when source window is closed | 0.1.0-dev |
| DONE-011 | Neovim | `stty -echo` PTY echo suppression | 0.1.0-dev |
| DONE-012 | Tests | Unit tests: bridge parsing helpers (9 tests) | 0.1.0-dev |
| DONE-013 | Tests | Unit tests: `normalizeRelationPayload` with fixtures | 0.1.0-dev |
| DONE-014 | Tests | Integration test: backend contract with mock MCP server (incoming + outgoing + .git guard) | 0.1.0-dev |
| DONE-015 | Tests | MCP smoke test script | 0.1.0-dev |
| DONE-016 | TUI | `RelationComponents.tsx` — reusable `SymbolBadge`, `NodeLabel`, `NodeMeta`, `RelationEdge`, `RelationNodeRow`, `RelationTree`, `RelationHeader`, `RelationFooter`, `EmptyState`, `Divider` | 0.1.0-dev |
| DONE-017 | TUI | `RelationWindow.tsx` rewritten — `<scrollbox>` canvas, `scrollChildIntoView` auto-scroll, `scrollBy` manual pan, collapse-before-parent on `h` | 0.1.0-dev |
| DONE-018 | TUI | Symbol kind badges: `[ƒ]` Function, `[M]` Method, `[ℂ]` Class, `[S]` Struct, `[𝓥]` Variable, `[E]` Enum, `[⊕]` Constructor, `[T]` TypeParam | 0.1.0-dev |
| DONE-019 | TUI | Braille spinner (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) replacing the old `\|/-` spinner | 0.1.0-dev |
| DONE-020 | TUI | `useTerminalDimensions()` hook — layout re-renders on terminal resize | 0.1.0-dev |
| DONE-021 | TUI | `buildVisibleOrder()` — flat ordered list of visible nodes for j/k navigation across expanded subtrees | 0.1.0-dev |
| DONE-022 | Backend | **BUG-001/002/003 fixed** — removed all hardcoded paths; `resolveBunBin()`, `resolveClangdMcpScript()`, `resolveClangdBin()` use env vars + `process.execPath` + filesystem probing | 0.1.0-dev |
| DONE-023 | Bridge | **BUG-007 fixed** — `extractJsonCandidate()` uses brace-depth counting; handles `}` inside JSON string values | 0.1.0-dev |
| DONE-024 | Backend | **BUG-011/012 fixed** — `parseIncomingCalls`/`parseOutgoingCalls` regex anchored to `$`; no longer greedy on paths containing ` at ` | 0.1.0-dev |
| DONE-025 | Neovim | **BUG-013 fixed** — `open_location_in_source()` checks for modified buffers; uses `split` instead of `edit` when buffer is dirty | 0.1.0-dev |
| DONE-026 | TUI | **BUG-014 fixed** — `requestId` uses `crypto.randomUUID()` | 0.1.0-dev |
| DONE-027 | Backend | **BUG-017 fixed** — `parseHoverForRoot()` detects `symbolKind` from hover keyword (`function`, `method`, `struct`, etc.) | 0.1.0-dev |
| DONE-028 | Neovim | **BUG-018 fixed** — `default_tui_dir` derived from `debug.getinfo` script path, not `vim.fn.getcwd()` | 0.1.0-dev |
| DONE-029 | Neovim | **BUG (workspace root .git)** — `find_workspace_root_for_file()` uses `vim.loop.fs_stat` to detect directory markers and returns parent | 0.1.0-dev |
| DONE-030 | Backend | **BUG (workspace root .git)** — `normaliseWorkspaceRoot()` in `backend.ts` auto-corrects `.git`-suffixed paths | 0.1.0-dev |
| DONE-031 | Neovim | **TD-006** — `VimResized` autocmd sends ping to all alive sessions | 0.1.0-dev |
| DONE-032 | Backend | **TD-008** — `identifierCandidateColumns()` capped at 8 probes | 0.1.0-dev |
| DONE-033 | Neovim | **FEAT-005** — `M.toggle()` + `:RelationWindowToggle` + `\rx` keymap | 0.1.0-dev |
| DONE-034 | Neovim | **FEAT-006** — `M.switch_mode()` + `:RelationWindowSwitchMode` + `\rm` keymap | 0.1.0-dev |
| DONE-035 | Tests | **TEST-001/002** — 7 new bridge tests: brace-depth extraction, ANSI stripping variants | 0.1.0-dev |
| DONE-036 | Tests | **TEST-009** — outgoing mode contract test + `.git` workspace-root guard test | 0.1.0-dev |
| DONE-037 | Tests | `test:connectivity` — 5-section live MCP connectivity test | 0.1.0-dev |
| DONE-038 | Tests | `test:e2e` — 6-stage TUI bridge end-to-end test | 0.1.0-dev |
| DONE-039 | TUI | Hardening: strict key whitelist + duplicate key-event suppression to stop noisy synthetic key triggers | 0.1.0-dev |
| DONE-040 | TUI | Removed keyboard `q`/`r` actions and Enter-open path; keep explicit `o` for open to prevent accidental jumps | 0.1.0-dev |
| DONE-041 | App | `set_data` payload dedupe to avoid unnecessary tree rebuild/redraw churn | 0.1.0-dev |
| DONE-042 | Neovim | Session lifecycle cleanup on `on_exit`/`TermClose`/`BufWipeout` to improve reopen reliability after manual tab/window close | 0.1.0-dev |
| DONE-043 | Bridge | Neovim→TUI control channel moved to per-session inbox file (`RW_BRIDGE_INBOX`) to keep terminal UI clean and avoid stdin echo corruption | 0.1.0-dev |
| DONE-044 | Bridge | Added app→Neovim outbox file channel (`RW_BRIDGE_OUTBOX`) + Lua polling to prevent `RW_BRIDGE` JSON from rendering in terminal UI | 0.1.0-dev |
| DONE-045 | Data Model / TUI | Root node now carries source location (`filePath`, `lineNumber`) from backend so starter API can be re-queried after collapse when needed | 0.1.0-dev |
| DONE-046 | Data Model | Introduced extensible internal `ApiMap` graph (`nodes`, `edges`, `adjacency`) with connection kinds (`caller`, `callee`, `ring`, `signal`, `interface_registration`, etc.) for future visual components | 0.1.0-dev |
| DONE-047 | Data Model | Reframed internal model to `SystemStructureGraph` for complex-system topology (APIs, HW interrupts, SW threads, HW rings, signals, interface registration) with `tracePath()` support | 0.1.0-dev |
| DONE-048 | UI/Mode | Added `both` mode single-window dual-pane view (outgoing left, incoming right) with per-pane traversal (`j/k`, `l` expand, `h` back, `Tab` switch pane) | 0.1.0-dev |
