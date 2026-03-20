import { describe, expect, test } from 'bun:test';
import { normalizeRelationPayload } from './relation';
import type { RelationPayload } from './types';

async function loadFixture(name: string): Promise<RelationPayload> {
  const path = `${import.meta.dir}/../../test/fixtures/${name}`;
  return (await Bun.file(path).json()) as RelationPayload;
}

describe('normalizeRelationPayload', () => {
  test('flattens incoming fixture', async () => {
    const payload = await loadFixture('incoming.json');
    const normalized = normalizeRelationPayload(payload);

    expect(normalized.mode).toBe('incoming');
    expect(normalized.provider).toBe('clangd-mcp');
    expect(normalized.rootName).toBe('main');
    expect(normalized.items.length).toBe(2);
    expect(normalized.items[0]?.label).toBe('bootstrap');
    expect(normalized.items[0]?.relationType).toBe('incoming');
  });

  test('flattens outgoing fixture', async () => {
    const payload = await loadFixture('outgoing.json');
    const normalized = normalizeRelationPayload(payload);

    expect(normalized.mode).toBe('outgoing');
    expect(normalized.provider).toBe('clangd-mcp');
    expect(normalized.rootName).toBe('main');
    expect(normalized.items.length).toBe(2);
    expect(normalized.items[1]?.label).toBe('start_workers');
    expect(normalized.items[1]?.relationType).toBe('outgoing');
  });

  test('returns empty state for empty fixture', async () => {
    const payload = await loadFixture('empty.json');
    const normalized = normalizeRelationPayload(payload);

    expect(normalized.rootName).toBe('<none>');
    expect(normalized.items).toEqual([]);
  });
});
