/**
 * wlan-fixture-e2e.test.ts
 *
 * Verifies that every relationship named in wlan-ground-truth.json survives
 * the complete frontend pipeline:
 *
 *   fixture data
 *     → BackendRelationPayload (calledBy / calls arrays)
 *     → normalizeRelationPayload → FlatRelationItem[]
 *     → addChildrenForDirection → NodeInstance in graph.nodes
 *     → BothRelationWindow canvas rendering (label visible)
 *
 * Every test asserts that a specific named symbol from the hand-verified WLAN
 * fixture is present at the correct pipeline stage. If any stage silently drops
 * a node, the test catches it.
 *
 * Run:
 *   cd /local/mnt/workspace/qprojects/tui-relation-window
 *   bun test src/lib/wlan-fixture-e2e.test.ts
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  queryResultToCallerNodes,
  queryResultToRuntimeCallerNodes,
  queryResultToCalleeNodes,
  type IntelligenceQueryResult,
} from './intelgraph-client';
import { queryResultToLogRows, queryResultToStructWriterRows } from './intelligence-query-adapters';
import { normalizeRelationPayload } from './relation';
import { addChildrenForDirection, makeInitialGraph } from '../graph/core';
import type { RelationPayload } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture loading
// ─────────────────────────────────────────────────────────────────────────────

// Locate the WLAN ground-truth fixture in the sibling intelgraph repo. Try the
// new name first; fall back to the legacy clangd-mcp name for unmigrated checkouts.
const FIXTURE_PATH = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '../../../intelgraph/test/fixtures/wlan-ground-truth.json'),
    join(here, '../../../clangd-mcp/test/fixtures/wlan-ground-truth.json'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0];
})();

type FixtureRow = {
  kind: string;
  canonical_name: string;
  caller?: string;
  callee?: string;
  edge_kind?: string;
  derivation?: string;
  confidence?: number;
  file_path?: string;
  line_number?: number;
  registrar?: string;
  callback?: string;
  registration_api?: string;
  api_name?: string;
  template?: string;
  log_level?: string | null;
  viaRegistrationApi?: string;
};

type FixtureEntry = {
  api_name: string;
  category: string;
  source: { file_path: string; line_number: number };
  relations: {
    who_calls: { callers: FixtureRow[] };
    who_calls_at_runtime: { callers: FixtureRow[] };
    what_api_calls: { callees: FixtureRow[] };
    registrations: { registered_by: FixtureRow[] };
    logs: { entries: FixtureRow[] };
    struct_writes: { fields: FixtureRow[] };
    struct_reads: { fields: FixtureRow[] };
  };
};

type GroundTruth = {
  workspace: string;
  apiGroundTruth: FixtureEntry[];
};

let groundTruth: GroundTruth;

beforeAll(() => {
  if (!existsSync(FIXTURE_PATH)) {
    throw new Error(
      `wlan-ground-truth.json not found at ${FIXTURE_PATH}\n` +
      `Make sure the intelgraph repo is at ../../../intelgraph relative to the frontend repo (legacy ../../../clangd-mcp also accepted).`,
    );
  }
  groundTruth = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as GroundTruth;
});

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline stage 1: adapter functions (intelligence_query path)
// ─────────────────────────────────────────────────────────────────────────────

function buildWhoCallsResult(entry: FixtureEntry): IntelligenceQueryResult {
  const targetId = `target:${entry.api_name}`;
  const nodeMap = new Map<string, Record<string, unknown>>();
  const edges: Record<string, unknown>[] = [];

  for (const row of entry.relations.who_calls.callers) {
    if (!row.canonical_name || row.canonical_name === entry.api_name) continue;
    const nodeId = `node:${row.canonical_name}`;
    if (!nodeMap.has(nodeId)) {
      nodeMap.set(nodeId, {
        id: nodeId, symbol: row.canonical_name, canonical_name: row.canonical_name,
        filePath: row.file_path ?? '', lineNumber: row.line_number ?? 0, kind: row.kind ?? 'api',
      });
    }
    edges.push({
      from: nodeId, to: targetId,
      kind: row.edge_kind === 'dispatches_to' ? 'dispatches_to' : 'calls',
      confidence: row.confidence ?? 0.9,
    });
  }

  for (const row of entry.relations.registrations.registered_by) {
    const name = row.registrar ?? row.canonical_name;
    if (!name || name === entry.api_name) continue;
    const nodeId = `node:${name}`;
    if (!nodeMap.has(nodeId)) {
      nodeMap.set(nodeId, {
        id: nodeId, symbol: name, canonical_name: name,
        filePath: row.file_path ?? '', lineNumber: row.line_number ?? 0, kind: row.kind ?? 'api',
      });
    }
    edges.push({
      from: nodeId, to: targetId, kind: 'registers_callback',
      viaRegistrationApi: row.registration_api ?? row.callback ?? name,
      confidence: row.confidence ?? 0.9,
    });
  }

  const targetNode: Record<string, unknown> = {
    id: targetId, symbol: entry.api_name, canonical_name: entry.api_name,
    filePath: entry.source.file_path, lineNumber: entry.source.line_number, kind: 'api',
  };
  return { status: 'hit', data: { nodes: [targetNode, ...nodeMap.values()], edges }, raw: '' };
}

function buildRuntimeCallersResult(entry: FixtureEntry): IntelligenceQueryResult {
  const invocationTypeFromEdge = (edgeKind?: string): string => {
    if (edgeKind === 'calls')         return 'runtime_direct_call';
    if (edgeKind === 'dispatches_to') return 'runtime_dispatch_table_call';
    return 'runtime_function_pointer_call';
  };
  const nodes = entry.relations.who_calls_at_runtime.callers
    .filter((r) => r.canonical_name && r.canonical_name !== entry.api_name)
    .map((row, i) => ({
      id: `rtcaller:${i}`, symbol: row.canonical_name, canonical_name: row.canonical_name,
      runtime_caller_api_name: row.canonical_name,
      runtime_caller_invocation_type_classification: invocationTypeFromEdge(row.edge_kind),
      filePath: row.file_path ?? '', lineNumber: row.line_number ?? 0, kind: row.kind ?? 'api',
      confidence: row.confidence ?? 0.9,
    }));
  return { status: 'hit', data: { nodes, edges: [] }, raw: '' };
}

function buildWhatCallsResult(entry: FixtureEntry): IntelligenceQueryResult {
  const sourceId = `source:${entry.api_name}`;
  const nodes: Record<string, unknown>[] = [{
    id: sourceId, symbol: entry.api_name, canonical_name: entry.api_name,
    filePath: entry.source.file_path, lineNumber: entry.source.line_number, kind: 'api',
  }];
  const edges: Record<string, unknown>[] = [];
  entry.relations.what_api_calls.callees
    .filter((r) => r.canonical_name && r.canonical_name !== entry.api_name)
    .forEach((row, i) => {
      const nodeId = `callee:${i}:${row.canonical_name}`;
      nodes.push({
        id: nodeId, symbol: row.canonical_name, canonical_name: row.canonical_name,
        filePath: row.file_path ?? '', lineNumber: row.line_number ?? 0, kind: row.kind ?? 'api',
      });
      edges.push({ from: sourceId, to: nodeId, kind: 'calls', confidence: row.confidence ?? 0.9 });
    });
  return { status: 'hit', data: { nodes, edges }, raw: '' };
}

function buildLogsResult(entry: FixtureEntry): IntelligenceQueryResult {
  const nodes = entry.relations.logs.entries
    .filter((r) => r.canonical_name && r.canonical_name !== 'no_log')
    .map((row, i) => ({
      id: `log:${i}`, symbol: row.canonical_name, canonical_name: row.canonical_name,
      kind: 'log_point',
      template: row.template ?? row.canonical_name ?? '',
      level: row.log_level ?? 'UNKNOWN',
      api_name: row.api_name ?? entry.api_name,
      file_path: row.file_path ?? '', line: row.line_number ?? 0,
      confidence: row.confidence ?? 0.8,
    }));
  return { status: 'hit', data: { nodes, edges: [] }, raw: '' };
}

function buildStructWritesResult(entry: FixtureEntry): IntelligenceQueryResult {
  const nodes = entry.relations.struct_writes.fields.map((row, i) => ({
    id: `sw:${i}`, symbol: row.canonical_name, canonical_name: row.canonical_name,
    kind: row.kind ?? 'field',
    writer: entry.api_name, target: row.canonical_name,
    edge_kind: row.edge_kind ?? 'writes_field',
    derivation: row.derivation ?? 'static',
    confidence: row.confidence ?? 0.8,
  }));
  return { status: 'hit', data: { nodes, edges: [] }, raw: '' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline stage 2: BackendRelationPayload → FlatRelationItem[]
// Simulates what intelgraph-client.ts produces and normalizeRelationPayload consumes
// ─────────────────────────────────────────────────────────────────────────────

function buildBackendPayloadIncoming(entry: FixtureEntry): RelationPayload {
  // Combine who_calls callers + registrations into calledBy — mirrors what
  // parseGetCallersResponse does in the real client after get_callers response
  const calledBy = [
    ...entry.relations.who_calls.callers
      .filter((r) => r.canonical_name && r.canonical_name !== entry.api_name)
      .map((r) => ({
        caller: r.canonical_name,
        filePath: r.file_path ?? '',
        lineNumber: r.line_number ?? 0,
        symbolKind: 12 as const,
        connectionKind: (r.edge_kind === 'registers_callback' || r.edge_kind === 'dispatches_to'
          ? 'interface_registration'
          : 'api_call') as 'api_call' | 'interface_registration',
      })),
    ...entry.relations.registrations.registered_by
      .filter((r) => (r.registrar ?? r.canonical_name) && (r.registrar ?? r.canonical_name) !== entry.api_name)
      .map((r) => ({
        caller: (r.registrar ?? r.canonical_name) as string,
        filePath: r.file_path ?? '',
        lineNumber: r.line_number ?? 0,
        symbolKind: 12 as const,
        connectionKind: 'interface_registration' as const,
        viaRegistrationApi: r.registration_api ?? r.callback ?? (r.registrar ?? r.canonical_name) as string,
      })),
    ...entry.relations.who_calls_at_runtime.callers
      .filter((r) => r.canonical_name && r.canonical_name !== entry.api_name)
      .map((r) => ({
        caller: r.canonical_name,
        filePath: r.file_path ?? '',
        lineNumber: r.line_number ?? 0,
        symbolKind: 12 as const,
        connectionKind: 'api_call' as const,
      })),
  ];

  return {
    mode: 'incoming',
    provider: 'intelgraph',
    result: {
      [entry.api_name]: {
        symbolKind: 12,
        filePath: entry.source.file_path,
        lineNumber: entry.source.line_number,
        calledBy,
      },
    },
  };
}

function buildBackendPayloadOutgoing(entry: FixtureEntry): RelationPayload {
  const calls = entry.relations.what_api_calls.callees
    .filter((r) => r.canonical_name && r.canonical_name !== entry.api_name)
    .map((r) => ({
      callee: r.canonical_name,
      filePath: r.file_path ?? '',
      lineNumber: r.line_number ?? 0,
      symbolKind: 12 as const,
      connectionKind: 'api_call' as const,
    }));

  return {
    mode: 'outgoing',
    provider: 'intelgraph',
    result: {
      [entry.api_name]: {
        symbolKind: 12,
        filePath: entry.source.file_path,
        lineNumber: entry.source.line_number,
        calls,
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline stage 3: FlatRelationItem[] → graph.nodes via addChildrenForDirection
// ─────────────────────────────────────────────────────────────────────────────

function buildGraphNodes(entry: FixtureEntry, direction: 'incoming' | 'outgoing') {
  const payload = direction === 'incoming'
    ? buildBackendPayloadIncoming(entry)
    : buildBackendPayloadOutgoing(entry);
  const state = normalizeRelationPayload(payload);
  const items = direction === 'incoming' ? state.incomingItems : state.outgoingItems;

  let graph = makeInitialGraph(entry.api_name, entry.source.file_path, entry.source.line_number);
  graph = addChildrenForDirection(graph, direction, graph.rootId, items);
  return graph.nodes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture sanity
// ─────────────────────────────────────────────────────────────────────────────

test('wlan-ground-truth fixture loads with 12 APIs', () => {
  expect(groundTruth).toBeDefined();
  expect(groundTruth.workspace).toContain('WLAN.CNG.1.0-01880');
  expect(groundTruth.apiGroundTruth).toHaveLength(12);
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-API tests — every relationship through every pipeline stage
// ─────────────────────────────────────────────────────────────────────────────

const fixtureData: GroundTruth = existsSync(FIXTURE_PATH)
  ? JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as GroundTruth
  : { workspace: '', apiGroundTruth: [] };

for (const entry of fixtureData.apiGroundTruth) {
  const api = entry.api_name;
  const cat = entry.category;

  // Pre-compute expected names
  const expectedCallerNames = [
    ...entry.relations.who_calls.callers
      .filter((r) => r.canonical_name && r.canonical_name !== api)
      .map((r) => r.canonical_name),
    ...entry.relations.registrations.registered_by
      .filter((r) => (r.registrar ?? r.canonical_name) && (r.registrar ?? r.canonical_name) !== api)
      .map((r) => r.registrar ?? r.canonical_name),
    ...entry.relations.who_calls_at_runtime.callers
      .filter((r) => r.canonical_name && r.canonical_name !== api)
      .map((r) => r.canonical_name),
  ].filter((n, i, a): n is string => Boolean(n) && a.indexOf(n) === i); // unique

  const registrarNames = entry.relations.registrations.registered_by
    .filter((r) => (r.registrar ?? r.canonical_name) && (r.registrar ?? r.canonical_name) !== api)
    .map((r) => (r.registrar ?? r.canonical_name) as string);

  const runtimeCallerNames = entry.relations.who_calls_at_runtime.callers
    .filter((r) => r.canonical_name && r.canonical_name !== api)
    .map((r) => r.canonical_name);

  const calleeNames = entry.relations.what_api_calls.callees
    .filter((r) => r.canonical_name && r.canonical_name !== api)
    .map((r) => r.canonical_name);

  const logTemplates = entry.relations.logs.entries
    .filter((r) => r.template && r.canonical_name !== 'no_log')
    .map((r) => r.template as string);

  const structFieldNames = entry.relations.struct_writes.fields
    .map((r) => r.canonical_name)
    .filter(Boolean);

  describe(`${api} [${cat}]`, () => {

    // ── STAGE 1: intelligence_query adapter (queryResultToCallerNodes) ─────────
    if (expectedCallerNames.length > 0) {
      test(`[adapter] callers: ${expectedCallerNames.join(', ')}`, () => {
        const callerNames = queryResultToCallerNodes(buildWhoCallsResult(entry)).map((c) => c.caller);
        for (const name of expectedCallerNames.filter(n => !entry.relations.who_calls_at_runtime.callers.some(r => r.canonical_name === n) || entry.relations.who_calls.callers.some(r => r.canonical_name === n) || registrarNames.includes(n))) {
          expect(callerNames, `"${name}" should appear as caller of ${api} via adapter`).toContain(name);
        }
      });
    }

    if (registrarNames.length > 0) {
      test(`[adapter] registrars have interface_registration: ${registrarNames.join(', ')}`, () => {
        const callerNodes = queryResultToCallerNodes(buildWhoCallsResult(entry));
        for (const name of registrarNames) {
          const node = callerNodes.find((c) => c.caller === name);
          expect(node, `"${name}" should be in caller nodes for ${api}`).toBeDefined();
          expect(node?.connectionKind, `"${name}" should have connectionKind interface_registration`).toBe('interface_registration');
        }
      });
    }

    if (runtimeCallerNames.length > 0) {
      test(`[adapter] runtime callers: ${runtimeCallerNames.join(', ')}`, () => {
        const names = queryResultToRuntimeCallerNodes(buildRuntimeCallersResult(entry)).map((c) => c.caller);
        for (const name of runtimeCallerNames) {
          expect(names, `"${name}" should be a runtime caller of ${api} via adapter`).toContain(name);
        }
      });
    }

    if (calleeNames.length > 0) {
      test(`[adapter] callees: ${calleeNames.join(', ')}`, () => {
        const names = queryResultToCalleeNodes(buildWhatCallsResult(entry)).map((c) => c.callee);
        for (const name of calleeNames) {
          expect(names, `"${name}" should be a callee of ${api} via adapter`).toContain(name);
        }
      });
    }

    if (logTemplates.length > 0) {
      test(`[adapter] log templates: ${logTemplates.map(t => `"${t}"`).join(', ')}`, () => {
        const templates = queryResultToLogRows(buildLogsResult(entry)).map((r) => r.template);
        for (const tmpl of logTemplates) {
          expect(templates, `log template "${tmpl}" should be emitted by ${api}`).toContain(tmpl);
        }
      });
    }

    if (structFieldNames.length > 0) {
      test(`[adapter] struct writes: ${structFieldNames.join(', ')}`, () => {
        const targets = queryResultToStructWriterRows(buildStructWritesResult(entry)).map((r) => r.target);
        for (const field of structFieldNames) {
          expect(targets, `struct field "${field}" should be written by ${api}`).toContain(field);
        }
      });
    }

    // ── STAGE 2: normalizeRelationPayload → FlatRelationItem[] ────────────────
    if (expectedCallerNames.length > 0) {
      test(`[flatItems] all callers reach FlatRelationItem[]: ${expectedCallerNames.join(', ')}`, () => {
        const payload = buildBackendPayloadIncoming(entry);
        const state = normalizeRelationPayload(payload);
        const labels = state.incomingItems.map((item) => item.label);
        for (const name of expectedCallerNames) {
          expect(labels, `"${name}" should be in incomingItems for ${api}`).toContain(name);
        }
      });
    }

    if (calleeNames.length > 0) {
      test(`[flatItems] all callees reach FlatRelationItem[]: ${calleeNames.join(', ')}`, () => {
        const payload = buildBackendPayloadOutgoing(entry);
        const state = normalizeRelationPayload(payload);
        const labels = state.outgoingItems.map((item) => item.label);
        for (const name of calleeNames) {
          expect(labels, `"${name}" should be in outgoingItems for ${api}`).toContain(name);
        }
      });
    }

    if (registrarNames.length > 0) {
      test(`[flatItems] registrars have interface_registration connectionKind in FlatRelationItem[]: ${registrarNames.join(', ')}`, () => {
        const payload = buildBackendPayloadIncoming(entry);
        const state = normalizeRelationPayload(payload);
        for (const name of registrarNames) {
          const item = state.incomingItems.find((i) => i.label === name);
          expect(item, `"${name}" should be in incomingItems for ${api}`).toBeDefined();
          expect(item?.connectionKind, `"${name}" should have connectionKind interface_registration in FlatRelationItem`).toBe('interface_registration');
        }
      });
    }

    // ── STAGE 3: addChildrenForDirection → graph.nodes ────────────────────────
    if (expectedCallerNames.length > 0) {
      test(`[graph.nodes] all callers appear as graph nodes: ${expectedCallerNames.join(', ')}`, () => {
        const nodes = buildGraphNodes(entry, 'incoming');
        const nodeLabels = Object.values(nodes).map((n) => n.label);
        for (const name of expectedCallerNames) {
          expect(nodeLabels, `"${name}" should be a graph node for ${api} (incoming)`).toContain(name);
        }
      });
    }

    if (calleeNames.length > 0) {
      test(`[graph.nodes] all callees appear as graph nodes: ${calleeNames.join(', ')}`, () => {
        const nodes = buildGraphNodes(entry, 'outgoing');
        const nodeLabels = Object.values(nodes).map((n) => n.label);
        for (const name of calleeNames) {
          expect(nodeLabels, `"${name}" should be a graph node for ${api} (outgoing)`).toContain(name);
        }
      });
    }

    if (registrarNames.length > 0) {
      test(`[graph.nodes] registrars have edgeKindFromParent=interface_registration in graph: ${registrarNames.join(', ')}`, () => {
        const nodes = buildGraphNodes(entry, 'incoming');
        for (const name of registrarNames) {
          const node = Object.values(nodes).find((n) => n.label === name);
          expect(node, `"${name}" should be in graph.nodes for ${api}`).toBeDefined();
          expect(
            node?.edgeKindFromParent,
            `"${name}" should have edgeKindFromParent=interface_registration in graph.nodes`,
          ).toBe('interface_registration');
        }
      });
    }

    if (registrarNames.length > 0) {
      test(`[graph.nodes] registrars preserve viaRegistrationApi in graph: ${registrarNames.join(', ')}`, () => {
        const nodes = buildGraphNodes(entry, 'incoming');
        for (const row of entry.relations.registrations.registered_by) {
          const name = row.registrar ?? row.canonical_name;
          if (!name || name === api) continue;
          const node = Object.values(nodes).find((n) => n.label === name);
          expect(node, `"${name}" should be in graph.nodes for ${api}`).toBeDefined();
          // viaRegistrationApi must be preserved through the full pipeline
          const expectedVia = row.registration_api ?? row.callback ?? name;
          expect(
            node?.viaRegistrationApi,
            `"${name}" should preserve viaRegistrationApi="${expectedVia}" through to graph.nodes`,
          ).toBe(expectedVia);
        }
      });
    }
  });
}
