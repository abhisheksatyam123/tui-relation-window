import { describe, expect, test } from 'bun:test';
import { normalizeRelationPayload, mergeFlatItems } from './relation';
import type { RelationPayload, FlatRelationItem } from './types';

async function loadFixture(name: string): Promise<RelationPayload> {
  const path = `${import.meta.dir}/../../test/fixtures/${name}`;
  return (await Bun.file(path).json()) as RelationPayload;
}

describe('normalizeRelationPayload', () => {
  test('flattens incoming fixture', async () => {
    const payload = await loadFixture('incoming.json');
    const normalized = normalizeRelationPayload(payload);

    expect(normalized.mode).toBe('incoming');
    expect(normalized.provider).toBe('intelgraph');
    expect(normalized.rootName).toBe('main');
    expect(normalized.items.length).toBe(2);
    expect(normalized.items[0]?.label).toBe('bootstrap');
    expect(normalized.items[0]?.relationType).toBe('incoming');
  });

  test('flattens outgoing fixture', async () => {
    const payload = await loadFixture('outgoing.json');
    const normalized = normalizeRelationPayload(payload);

    expect(normalized.mode).toBe('outgoing');
    expect(normalized.provider).toBe('intelgraph');
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

  test('frontend passes through runtime-only callers from backend (incoming view)', async () => {
    // TD-002: Frontend runtime-only contract test for incoming view
    // Verifies that normalizeRelationPayload():
    //   1. Passes through connectionKind from backend without modification
    //   2. Does NOT filter nodes based on connectionKind
    //   3. Preserves all callers provided by backend (backend is responsible for filtering)
    // 
    // This fixture simulates backend returning ONLY runtime caller (registration already filtered)
    const payload = await loadFixture('incoming-with-registration.json');
    const normalized = normalizeRelationPayload(payload);

    expect(normalized.mode).toBe('incoming');
    expect(normalized.rootName).toBe('wlan_bpf_filter_offload_handler');
    
    // Frontend contract: pass through all items from backend without filtering
    // This fixture has 3 callers (1 runtime + 2 registration) to test that frontend
    // does NOT filter - in production, backend should only send runtime callers
    expect(normalized.items.length).toBe(3);
    expect(normalized.incomingItems.length).toBe(3);
    
    // Verify all items from backend payload are preserved
    const labels = normalized.items.map(item => item.label);
    expect(labels).toContain('_offldmgr_enhanced_data_handler');
    expect(labels).toContain('wlan_offload_mgr_register_handlers');
    expect(labels).toContain('offload_init_table');
    
    // Verify connectionKind is preserved exactly as provided by backend
    const runtimeCaller = normalized.items.find(item => item.label === '_offldmgr_enhanced_data_handler');
    expect(runtimeCaller?.connectionKind).toBe('api_call');
    
    const registrationNode1 = normalized.items.find(item => item.label === 'wlan_offload_mgr_register_handlers');
    expect(registrationNode1?.connectionKind).toBe('interface_registration');
    
    const registrationNode2 = normalized.items.find(item => item.label === 'offload_init_table');
    expect(registrationNode2?.connectionKind).toBe('interface_registration');
    
    // Note: In production, backend should filter out registration nodes before sending.
    // This test verifies frontend does NOT add filtering logic - it's a pass-through layer.
  });

  test('frontend passes through runtime-only callers from backend (both view)', async () => {
    // TD-003: Frontend runtime-only contract test for both view
    // Verifies that normalizeRelationPayload():
    //   1. Passes through connectionKind for both incoming and outgoing
    //   2. Does NOT filter incoming nodes based on connectionKind
    //   3. Preserves all items provided by backend
    const payload = await loadFixture('both-with-registration.json');
    const normalized = normalizeRelationPayload(payload);

    expect(normalized.mode).toBe('both');
    expect(normalized.rootName).toBe('target_api');
    
    // Frontend contract: pass through all items without filtering
    expect(normalized.incomingItems.length).toBe(4);
    expect(normalized.outgoingItems.length).toBe(1);
    
    // Verify all incoming items from backend are preserved
    const incomingLabels = normalized.incomingItems.map(item => item.label);
    expect(incomingLabels).toContain('runtime_caller_1');
    expect(incomingLabels).toContain('runtime_caller_2');
    expect(incomingLabels).toContain('registration_point_1');
    expect(incomingLabels).toContain('registration_point_2');
    
    // Verify connectionKind is preserved exactly as provided by backend
    const runtimeCaller1 = normalized.incomingItems.find(item => item.label === 'runtime_caller_1');
    expect(runtimeCaller1?.connectionKind).toBe('api_call');
    
    const runtimeCaller2 = normalized.incomingItems.find(item => item.label === 'runtime_caller_2');
    expect(runtimeCaller2?.connectionKind).toBe('hw_interrupt');
    
    const registrationPoint1 = normalized.incomingItems.find(item => item.label === 'registration_point_1');
    expect(registrationPoint1?.connectionKind).toBe('interface_registration');
    
    const registrationPoint2 = normalized.incomingItems.find(item => item.label === 'registration_point_2');
    expect(registrationPoint2?.connectionKind).toBe('interface_registration');
    
    // Verify outgoing items are unaffected
    expect(normalized.outgoingItems[0]?.label).toBe('downstream_api');
    expect(normalized.outgoingItems[0]?.connectionKind).toBe('api_call');
    
    // Note: In production, backend should filter out registration nodes from incoming.
    // This test verifies frontend is a transparent pass-through layer.
  });
});

describe('mergeFlatItems', () => {
  const makeItem = (label: string, relationType: 'incoming' | 'outgoing'): FlatRelationItem => ({
    id: `${label}:file.c:1`,
    label,
    filePath: 'file.c',
    lineNumber: 1,
    relationType,
  });

  test('returns base unchanged when extra is empty', () => {
    const base = [makeItem('a', 'incoming')];
    expect(mergeFlatItems(base, [])).toBe(base);
  });

  test('appends non-duplicate extra items', () => {
    const base = [makeItem('a', 'incoming')];
    const extra = [makeItem('b', 'outgoing')];
    const result = mergeFlatItems(base, extra);
    expect(result).toHaveLength(2);
    expect(result[0]?.label).toBe('a');
    expect(result[1]?.label).toBe('b');
  });

  test('deduplicates by label|filePath|lineNumber|relationType', () => {
    const base = [makeItem('a', 'incoming')];
    const extra = [makeItem('a', 'incoming'), makeItem('b', 'incoming')];
    const result = mergeFlatItems(base, extra);
    expect(result).toHaveLength(2);
    expect(result.map(i => i.label)).toEqual(['a', 'b']);
  });

  test('both mode: custom incoming and outgoing relations are included via mergeFlatItems', () => {
    // Simulates the mergedItems computation in App.tsx for both mode:
    //   mergedItems = mergeFlatItems(mergedIncomingItems, mergedOutgoingItems)
    // Before fix: mergedItems returned state.items (raw incomingItems), dropping custom relations.
    // After fix: mergedItems combines both merged sets, preserving all custom relations.
    const baseIncoming = [makeItem('caller_a', 'incoming')];
    const customIncoming = [makeItem('custom_caller', 'incoming')];
    const baseOutgoing = [makeItem('callee_b', 'outgoing')];
    const customOutgoing = [makeItem('custom_callee', 'outgoing')];

    const mergedIncoming = mergeFlatItems(baseIncoming, customIncoming);
    const mergedOutgoing = mergeFlatItems(baseOutgoing, customOutgoing);
    const mergedBoth = mergeFlatItems(mergedIncoming, mergedOutgoing);

    expect(mergedBoth).toHaveLength(4);
    const labels = mergedBoth.map(i => i.label);
    expect(labels).toContain('caller_a');
    expect(labels).toContain('custom_caller');
    expect(labels).toContain('callee_b');
    expect(labels).toContain('custom_callee');
  });
});
