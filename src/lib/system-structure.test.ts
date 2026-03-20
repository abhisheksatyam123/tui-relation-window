import { describe, expect, test } from 'bun:test';
import { buildSystemStructureFromPayload, tracePath } from './system-structure';
import type { RelationPayload } from './types';

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
      provider: 'clangd-mcp',
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
