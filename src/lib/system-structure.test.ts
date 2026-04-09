import { describe, expect, test } from 'bun:test';
import { buildSystemStructureFromPayload, tracePath } from './system-structure';
import type { RelationPayload, SystemConnectionKind } from './types';
import type { SystemStructureGraph } from './system-structure';

async function loadFixture(name: string): Promise<RelationPayload> {
  const path = `${import.meta.dir}/../../test/fixtures/${name}`;
  return (await Bun.file(path).json()) as RelationPayload;
}

describe('buildSystemStructureFromPayload', () => {
  test('builds incoming system graph from caller relations', async () => {
    const payload = await loadFixture('incoming.json');
    const graph = buildSystemStructureFromPayload(payload);

    expect(graph.mode).toBe('incoming');
    expect(graph.rootId).not.toBeNull();
    expect(Object.keys(graph.nodes).length).toBe(3);
    expect(graph.links.length).toBe(2);
    expect(graph.links.every((e) => e.kind === 'api_call')).toBe(true);
    expect(graph.links.every((e) => e.direction === 'in')).toBe(true);
  });

  test('builds outgoing system graph from callee relations', async () => {
    const payload = await loadFixture('outgoing.json');
    const graph = buildSystemStructureFromPayload(payload);

    expect(graph.mode).toBe('outgoing');
    expect(graph.rootId).not.toBeNull();
    expect(Object.keys(graph.nodes).length).toBe(3);
    expect(graph.links.length).toBe(2);
    expect(graph.links.every((e) => e.kind === 'api_call')).toBe(true);
    expect(graph.links.every((e) => e.direction === 'out')).toBe(true);
  });

  test('supports mixed system topology nodes/links and tracing', () => {
    const payload: RelationPayload = {
      mode: 'incoming',
      provider: 'intelgraph',
      result: {
        root_api: {
          filePath: '/tmp/a.c',
          lineNumber: 10,
          calledBy: [],
          systemNodes: [
            { id: 'irq:rx', name: 'RX IRQ', kind: 'hw_interrupt' },
            { id: 'ring:rx', name: 'RX Ring', kind: 'hw_ring' },
            { id: 'thread:napi', name: 'NAPI Thread', kind: 'sw_thread' },
          ],
          systemLinks: [
            { fromId: 'irq:rx', toId: 'ring:rx', kind: 'hw_interrupt', direction: 'out' },
            { fromId: 'ring:rx', toId: 'thread:napi', kind: 'ring_signal', direction: 'out' },
          ],
        },
      },
    };

    const graph = buildSystemStructureFromPayload(payload);
    expect(graph.nodes['irq:rx']?.kind).toBe('hw_interrupt');
    expect(graph.links.some((l) => l.kind === 'ring_signal')).toBe(true);

    const trace = tracePath(graph, 'irq:rx', 'thread:napi');
    expect(trace).not.toBeNull();
    expect(trace?.nodeIds).toEqual(['irq:rx', 'ring:rx', 'thread:napi']);
    expect(trace?.linkIds.length).toBe(2);
  });

  test('returns empty graph for empty payload', async () => {
    const payload = await loadFixture('empty.json');
    const graph = buildSystemStructureFromPayload(payload);

    expect(graph.rootId).toBeNull();
    expect(graph.links).toEqual([]);
    expect(graph.nodes).toEqual({});
  });
});

// ─── tracePath edge cases ────────────────────────────────────────────────────

/** Build a minimal graph directly without going through buildSystemStructureFromPayload */
function makeGraph(
  nodeIds: string[],
  edges: Array<{ from: string; to: string; kind?: SystemConnectionKind; direction?: 'in' | 'out' | 'bi' }>,
): SystemStructureGraph {
  const nodes: SystemStructureGraph['nodes'] = {};
  for (const id of nodeIds) {
    nodes[id] = { id, name: id, kind: 'api' };
  }

  const links: SystemStructureGraph['links'] = [];
  const adjacency: SystemStructureGraph['adjacency'] = {};
  for (const id of nodeIds) adjacency[id] = [];

  for (const edge of edges) {
    const kind: SystemConnectionKind = edge.kind ?? 'api_call';
    const direction = edge.direction ?? 'out';
    const id = `${edge.from}->${edge.to}:${kind}`;
    links.push({ id, from: edge.from, to: edge.to, kind, direction });
    adjacency[edge.from] = [...(adjacency[edge.from] ?? []), id];
    adjacency[edge.to] = [...(adjacency[edge.to] ?? []), id];
  }

  return { version: 1, mode: 'incoming', provider: 'test', rootId: nodeIds[0] ?? null, nodes, links, adjacency };
}

describe('tracePath', () => {
  test('returns null when source node does not exist', () => {
    const graph = makeGraph(['A', 'B'], [{ from: 'A', to: 'B' }]);
    expect(tracePath(graph, 'X', 'B')).toBeNull();
  });

  test('returns null when target node does not exist', () => {
    const graph = makeGraph(['A', 'B'], [{ from: 'A', to: 'B' }]);
    expect(tracePath(graph, 'A', 'Z')).toBeNull();
  });

  test('returns single-node trace when source equals target', () => {
    const graph = makeGraph(['A', 'B'], [{ from: 'A', to: 'B' }]);
    const trace = tracePath(graph, 'A', 'A');
    expect(trace).not.toBeNull();
    expect(trace?.nodeIds).toEqual(['A']);
    expect(trace?.linkIds).toEqual([]);
  });

  test('returns null for disconnected graph (no path between source and target)', () => {
    // A→B and C→D — no connection between the two components
    const graph = makeGraph(['A', 'B', 'C', 'D'], [
      { from: 'A', to: 'B' },
      { from: 'C', to: 'D' },
    ]);
    expect(tracePath(graph, 'A', 'D')).toBeNull();
    expect(tracePath(graph, 'C', 'B')).toBeNull();
  });

  test('returns null when directed edges prevent reaching target', () => {
    // A→B→C but we ask for C→A (directed, no reverse path)
    const graph = makeGraph(['A', 'B', 'C'], [
      { from: 'A', to: 'B', direction: 'out' },
      { from: 'B', to: 'C', direction: 'out' },
    ]);
    expect(tracePath(graph, 'C', 'A')).toBeNull();
  });

  test('terminates without infinite loop on a cycle (A→B→C→A)', () => {
    const graph = makeGraph(['A', 'B', 'C'], [
      { from: 'A', to: 'B', direction: 'out' },
      { from: 'B', to: 'C', direction: 'out' },
      { from: 'C', to: 'A', direction: 'out' },
    ]);
    // A→B→C→A: path from A to C exists
    const trace = tracePath(graph, 'A', 'C');
    expect(trace).not.toBeNull();
    expect(trace?.nodeIds).toEqual(['A', 'B', 'C']);
    // No path from A to a node not in the cycle
    const noTrace = tracePath(graph, 'A', 'X' as string);
    expect(noTrace).toBeNull();
  });

  test('terminates without infinite loop on a bidirectional cycle', () => {
    // A↔B↔C — bidirectional edges form a cycle
    const graph = makeGraph(['A', 'B', 'C', 'D'], [
      { from: 'A', to: 'B', direction: 'bi' },
      { from: 'B', to: 'C', direction: 'bi' },
      { from: 'C', to: 'A', direction: 'bi' },
    ]);
    // D is disconnected — must not loop forever
    expect(tracePath(graph, 'A', 'D')).toBeNull();
    // Path within cycle should still work
    const trace = tracePath(graph, 'A', 'C');
    expect(trace).not.toBeNull();
  });

  test('returns a valid path when multiple paths exist (A→B→D and A→C→D)', () => {
    const graph = makeGraph(['A', 'B', 'C', 'D'], [
      { from: 'A', to: 'B', direction: 'out' },
      { from: 'A', to: 'C', direction: 'out' },
      { from: 'B', to: 'D', direction: 'out' },
      { from: 'C', to: 'D', direction: 'out' },
    ]);
    const trace = tracePath(graph, 'A', 'D');
    expect(trace).not.toBeNull();
    // BFS guarantees shortest path (length 2 hops = 3 nodes)
    expect(trace?.nodeIds.length).toBe(3);
    expect(trace?.nodeIds[0]).toBe('A');
    expect(trace?.nodeIds[trace!.nodeIds.length - 1]).toBe('D');
    // Intermediate node must be B or C
    expect(['B', 'C']).toContain(trace!.nodeIds[1]);
  });

  test('handles large graph (100 nodes linear chain) without timeout', () => {
    const N = 100;
    const nodeIds = Array.from({ length: N }, (_, i) => `n${i}`);
    const edges = Array.from({ length: N - 1 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}`, direction: 'out' as const }));
    const graph = makeGraph(nodeIds, edges);

    const start = Date.now();
    const trace = tracePath(graph, 'n0', `n${N - 1}`);
    const elapsed = Date.now() - start;

    expect(trace).not.toBeNull();
    expect(trace?.nodeIds.length).toBe(N);
    expect(trace?.nodeIds[0]).toBe('n0');
    expect(trace?.nodeIds[N - 1]).toBe(`n${N - 1}`);
    // Should complete well under 1 second
    expect(elapsed).toBeLessThan(1000);
  });

  test('handles large graph (100 nodes) with no path — returns null quickly', () => {
    const N = 100;
    // Two disconnected chains of 50 nodes each
    const nodeIds = Array.from({ length: N }, (_, i) => `n${i}`);
    const edges = [
      ...Array.from({ length: 49 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}`, direction: 'out' as const })),
      ...Array.from({ length: 49 }, (_, i) => ({ from: `n${i + 50}`, to: `n${i + 51}`, direction: 'out' as const })),
    ];
    const graph = makeGraph(nodeIds, edges);

    const start = Date.now();
    const trace = tracePath(graph, 'n0', 'n99');
    const elapsed = Date.now() - start;

    expect(trace).toBeNull();
    expect(elapsed).toBeLessThan(1000);
  });
});
