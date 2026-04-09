/**
 * BackendApi — thin, typed facade over intelgraph-client + intelligence-query-adapters.
 *
 * Goals:
 *   - Bind workspaceRoot/mcpUrl ONCE at construction so callers don't repeat them.
 *   - Return domain types (CallerNode, LogRow, ModuleRow, …) instead of the
 *     raw IntelligenceQueryResult shape.
 *   - Provide a small, stable surface the UI components can depend on while the
 *     underlying transport in intelgraph-client.ts evolves.
 *   - Stay purely additive: no existing code is touched.
 *
 * Dependency injection:
 *   The factory accepts an optional `deps` argument that lets tests substitute
 *   the underlying client functions. In production, defaults are wired to the
 *   real exports from intelgraph-client.ts and intelligence-query-adapters.ts.
 */

import {
  ensureSnapshotInitialized as defaultEnsureSnapshotInitialized,
  fetchRelationsFromIntelgraph as defaultFetchRelations,
  intelligenceQuery as defaultIntelligenceQuery,
  queryApiLogs as defaultQueryApiLogs,
  queryApiStructWrites as defaultQueryApiStructWrites,
  queryApiStructReads as defaultQueryApiStructReads,
  queryClassInheritance as defaultQueryClassInheritance,
  queryClassSubtypes as defaultQueryClassSubtypes,
  queryInterfaceImplementors as defaultQueryInterfaceImplementors,
  queryModuleDependents as defaultQueryModuleDependents,
  queryModuleImports as defaultQueryModuleImports,
  queryModuleSymbols as defaultQueryModuleSymbols,
  type IntelligenceQueryArgs,
  type IntelligenceQueryIntent,
  type IntelligenceQueryResult,
} from './intelgraph-client';
import {
  queryResultToClassRows,
  queryResultToLogRows,
  queryResultToModuleRows,
  queryResultToModuleSymbolRows,
  queryResultToStructReaderRows,
  queryResultToStructWriterRows,
  type ClassRow,
  type LogRow,
  type ModuleRow,
  type ModuleSymbolRow,
  type StructReaderRow,
  type StructWriterRow,
} from './intelligence-query-adapters';
import type { BackendQuery, BackendRelationPayload } from './backend-types';
import type { CallerNode, CalleeNode } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type BackendApiConfig = {
  /** Absolute path to the workspace root (project containing the source). */
  workspaceRoot: string;
  /** Optional MCP URL override. If omitted, the client auto-discovers it. */
  mcpUrl?: string;
};

export type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'VERBOSE' | 'TRACE';

export type SymbolLocation = {
  /** Absolute or workspace-relative file path. */
  filePath: string;
  /** 1-based line number. */
  lineNumber: number;
  /** 1-based character. Optional — the underlying client will infer if omitted. */
  character?: number;
};

export type RelationsForLocation = {
  /** Provider that produced the result (e.g. "get_callers", "lsp"). */
  provider: string;
  /** Direct callers / callees (depending on the call). */
  items: Array<CallerNode | CalleeNode>;
  /** The full backend payload, in case a caller wants more detail. */
  raw: BackendRelationPayload;
};

/**
 * The set of methods exposed by the facade. Components should depend on this
 * interface, never on the concrete factory return type, so tests can pass a
 * mock.
 */
export interface BackendApi {
  /** Snapshot lifecycle: ensure intelligence_query has a valid snapshotId. */
  ensureSnapshot(): Promise<number>;

  /** Direct callers of the symbol at the given location. */
  getCallersAt(location: SymbolLocation): Promise<RelationsForLocation>;

  /** Direct callees of the symbol at the given location. */
  getCalleesAt(location: SymbolLocation): Promise<RelationsForLocation>;

  /** Logs emitted by the named API (intent: find_api_logs / find_api_logs_by_level). */
  getApiLogs(args: { apiName: string; level?: LogLevel }): Promise<LogRow[]>;

  /** Structs that the named API writes (intent: find_api_struct_writes). */
  getApiStructWrites(args: { apiName: string }): Promise<StructWriterRow[]>;

  /** Structs that the named API reads (intent: find_api_struct_reads). */
  getApiStructReads(args: { apiName: string }): Promise<StructReaderRow[]>;

  /** Modules imported by the given module (intent: find_module_imports). */
  getModuleImports(args: { moduleName: string }): Promise<ModuleRow[]>;

  /** Modules that import the given module (intent: find_module_dependents). */
  getModuleDependents(args: { moduleName: string }): Promise<ModuleRow[]>;

  /** Symbols declared inside the given module (intent: find_module_symbols). */
  getModuleSymbols(args: { moduleName: string }): Promise<ModuleSymbolRow[]>;

  /** Parent classes/interfaces of a class or interface (intent: find_class_inheritance). */
  getClassInheritance(args: { className: string }): Promise<ClassRow[]>;

  /** Subclasses/sub-interfaces of a class or interface (intent: find_class_subtypes). */
  getClassSubtypes(args: { className: string }): Promise<ClassRow[]>;

  /** Classes that implement a given interface (intent: find_interface_implementors). */
  getInterfaceImplementors(args: { interfaceName: string }): Promise<ClassRow[]>;

  /**
   * Generic escape hatch for any intelligence_query intent the facade does not
   * yet expose as a typed method. Returns the raw IntelligenceQueryResult.
   */
  query(args: {
    intent: IntelligenceQueryIntent;
    params: IntelligenceQueryArgs['params'];
  }): Promise<IntelligenceQueryResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dependency injection seam
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The set of underlying client functions the facade depends on. Tests can
 * substitute mocks for any subset; missing entries fall back to the real
 * implementations.
 */
export type BackendApiDeps = {
  ensureSnapshotInitialized?: typeof defaultEnsureSnapshotInitialized;
  fetchRelations?: typeof defaultFetchRelations;
  intelligenceQuery?: typeof defaultIntelligenceQuery;
  queryApiLogs?: typeof defaultQueryApiLogs;
  queryApiStructWrites?: typeof defaultQueryApiStructWrites;
  queryApiStructReads?: typeof defaultQueryApiStructReads;
  queryModuleImports?: typeof defaultQueryModuleImports;
  queryModuleDependents?: typeof defaultQueryModuleDependents;
  queryModuleSymbols?: typeof defaultQueryModuleSymbols;
  queryClassInheritance?: typeof defaultQueryClassInheritance;
  queryClassSubtypes?: typeof defaultQueryClassSubtypes;
  queryInterfaceImplementors?: typeof defaultQueryInterfaceImplementors;
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Flatten a BackendRelationPayload into a single list of caller-or-callee
 * items, regardless of which root key the backend returned. The TUI graph
 * code already does this — replicating the small piece here keeps the facade
 * self-contained.
 */
function flattenRelationPayload(payload: BackendRelationPayload): Array<CallerNode | CalleeNode> {
  if (!payload.result) return [];
  const items: Array<CallerNode | CalleeNode> = [];
  for (const root of Object.values(payload.result)) {
    if (!root) continue;
    if (payload.mode === 'incoming' && root.calledBy) {
      for (const c of root.calledBy) items.push(c);
    } else if (payload.mode === 'outgoing' && root.calls) {
      for (const c of root.calls) items.push(c);
    }
  }
  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createBackendApi(config: BackendApiConfig, deps: BackendApiDeps = {}): BackendApi {
  if (!config.workspaceRoot) {
    throw new Error('createBackendApi: config.workspaceRoot is required');
  }

  // Resolve injected deps with sensible defaults.
  const ensureSnapshot = deps.ensureSnapshotInitialized ?? defaultEnsureSnapshotInitialized;
  const fetchRelations = deps.fetchRelations ?? defaultFetchRelations;
  const intelQuery = deps.intelligenceQuery ?? defaultIntelligenceQuery;
  const apiLogs = deps.queryApiLogs ?? defaultQueryApiLogs;
  const apiStructWrites = deps.queryApiStructWrites ?? defaultQueryApiStructWrites;
  const apiStructReads = deps.queryApiStructReads ?? defaultQueryApiStructReads;
  const moduleImports = deps.queryModuleImports ?? defaultQueryModuleImports;
  const moduleDependents = deps.queryModuleDependents ?? defaultQueryModuleDependents;
  const moduleSymbols = deps.queryModuleSymbols ?? defaultQueryModuleSymbols;
  const classInheritance = deps.queryClassInheritance ?? defaultQueryClassInheritance;
  const classSubtypes = deps.queryClassSubtypes ?? defaultQueryClassSubtypes;
  const interfaceImplementors = deps.queryInterfaceImplementors ?? defaultQueryInterfaceImplementors;

  const { workspaceRoot, mcpUrl } = config;

  /** Build a BackendQuery for the given mode + location. */
  const buildBackendQuery = (mode: 'incoming' | 'outgoing', loc: SymbolLocation): BackendQuery => ({
    mode,
    filePath: loc.filePath,
    line: loc.lineNumber,
    character: loc.character ?? 1,
    workspaceRoot,
    mcpUrl,
  });

  return {
    async ensureSnapshot() {
      return ensureSnapshot({ workspaceRoot, mcpUrl });
    },

    async getCallersAt(location) {
      const payload = await fetchRelations(buildBackendQuery('incoming', location));
      return {
        provider: payload.provider,
        items: flattenRelationPayload(payload),
        raw: payload,
      };
    },

    async getCalleesAt(location) {
      const payload = await fetchRelations(buildBackendQuery('outgoing', location));
      return {
        provider: payload.provider,
        items: flattenRelationPayload(payload),
        raw: payload,
      };
    },

    async getApiLogs(args) {
      const result = await apiLogs({
        workspaceRoot,
        mcpUrl,
        apiName: args.apiName,
        logLevel: args.level,
      });
      return queryResultToLogRows(result);
    },

    async getApiStructWrites(args) {
      const result = await apiStructWrites({
        workspaceRoot,
        mcpUrl,
        apiName: args.apiName,
      });
      return queryResultToStructWriterRows(result);
    },

    async getApiStructReads(args) {
      const result = await apiStructReads({
        workspaceRoot,
        mcpUrl,
        apiName: args.apiName,
      });
      return queryResultToStructReaderRows(result);
    },

    async getModuleImports(args) {
      const result = await moduleImports({
        workspaceRoot,
        mcpUrl,
        moduleName: args.moduleName,
      });
      return queryResultToModuleRows(result);
    },

    async getModuleDependents(args) {
      const result = await moduleDependents({
        workspaceRoot,
        mcpUrl,
        moduleName: args.moduleName,
      });
      return queryResultToModuleRows(result);
    },

    async getModuleSymbols(args) {
      const result = await moduleSymbols({
        workspaceRoot,
        mcpUrl,
        moduleName: args.moduleName,
      });
      return queryResultToModuleSymbolRows(result);
    },

    async getClassInheritance(args) {
      const result = await classInheritance({
        workspaceRoot,
        mcpUrl,
        className: args.className,
      });
      return queryResultToClassRows(result);
    },

    async getClassSubtypes(args) {
      const result = await classSubtypes({
        workspaceRoot,
        mcpUrl,
        className: args.className,
      });
      return queryResultToClassRows(result);
    },

    async getInterfaceImplementors(args) {
      const result = await interfaceImplementors({
        workspaceRoot,
        mcpUrl,
        interfaceName: args.interfaceName,
      });
      return queryResultToClassRows(result);
    },

    async query(args) {
      return intelQuery({
        workspaceRoot,
        mcpUrl,
        intent: args.intent,
        params: args.params,
      });
    },
  };
}
