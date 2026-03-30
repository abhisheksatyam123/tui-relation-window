/**
 * Exhaustiveness tests for edgeKindToConnectionKind adapter.
 *
 * Close signal: all known EdgeKind (= SystemConnectionKind) variants map to
 * expected BackendConnectionKind values, and unknown strings fall back to a
 * safe default without throwing.
 *
 * Fail-before: function does not exist yet (task 4.1.2 pending).
 * Pass-after:  coder implements edgeKindToConnectionKind in edge-kind-adapter.ts.
 */
import { describe, expect, test } from 'bun:test';
import { edgeKindToConnectionKind } from './edge-kind-adapter';
import type { SystemConnectionKind } from './types';
import type { BackendConnectionKind } from './backend-types';

// All known EdgeKind variants (EdgeKind = SystemConnectionKind)
const ALL_EDGE_KINDS: SystemConnectionKind[] = [
  'api_call',
  'interface_registration',
  'sw_thread_comm',
  'hw_interrupt',
  'hw_ring',
  'ring_signal',
  'event',
  'timer_callback',
  'deferred_work',
  'debugfs_op',
  'ioctl_dispatch',
  'ring_completion',
  'custom',
];

// All known BackendConnectionKind values (for type-safety assertions)
const VALID_BACKEND_KINDS = new Set<BackendConnectionKind>([
  'api_call',
  'interface_registration',
  'sw_thread_comm',
  'hw_interrupt',
  'hw_ring',
  'ring_signal',
  'event',
  'timer_callback',
  'deferred_work',
  'debugfs_op',
  'ioctl_dispatch',
  'ring_completion',
  'custom',
]);

describe('edgeKindToConnectionKind', () => {
  test('maps api_call → api_call', () => {
    expect(edgeKindToConnectionKind('api_call')).toBe('api_call');
  });

  test('maps interface_registration → interface_registration', () => {
    expect(edgeKindToConnectionKind('interface_registration')).toBe('interface_registration');
  });

  test('maps sw_thread_comm → sw_thread_comm', () => {
    expect(edgeKindToConnectionKind('sw_thread_comm')).toBe('sw_thread_comm');
  });

  test('maps hw_interrupt → hw_interrupt', () => {
    expect(edgeKindToConnectionKind('hw_interrupt')).toBe('hw_interrupt');
  });

  test('maps hw_ring → hw_ring', () => {
    expect(edgeKindToConnectionKind('hw_ring')).toBe('hw_ring');
  });

  test('maps ring_signal → ring_signal', () => {
    expect(edgeKindToConnectionKind('ring_signal')).toBe('ring_signal');
  });

  test('maps event → event', () => {
    expect(edgeKindToConnectionKind('event')).toBe('event');
  });

  test('maps timer_callback → timer_callback', () => {
    expect(edgeKindToConnectionKind('timer_callback')).toBe('timer_callback');
  });

  test('maps deferred_work → deferred_work', () => {
    expect(edgeKindToConnectionKind('deferred_work')).toBe('deferred_work');
  });

  test('maps debugfs_op → debugfs_op', () => {
    expect(edgeKindToConnectionKind('debugfs_op')).toBe('debugfs_op');
  });

  test('maps ioctl_dispatch → ioctl_dispatch', () => {
    expect(edgeKindToConnectionKind('ioctl_dispatch')).toBe('ioctl_dispatch');
  });

  test('maps ring_completion → ring_completion', () => {
    expect(edgeKindToConnectionKind('ring_completion')).toBe('ring_completion');
  });

  test('maps custom → custom', () => {
    expect(edgeKindToConnectionKind('custom')).toBe('custom');
  });

  test('all known EdgeKind variants produce valid BackendConnectionKind output', () => {
    for (const kind of ALL_EDGE_KINDS) {
      const result = edgeKindToConnectionKind(kind);
      expect(VALID_BACKEND_KINDS.has(result)).toBe(true);
    }
  });

  test('all known EdgeKind variants are covered (exhaustiveness)', () => {
    // Ensures no variant is silently missing from the mapping
    const results = ALL_EDGE_KINDS.map((k) => edgeKindToConnectionKind(k));
    expect(results.length).toBe(ALL_EDGE_KINDS.length);
    for (const r of results) {
      expect(typeof r).toBe('string');
      expect(r.length).toBeGreaterThan(0);
    }
  });

  test('unknown string falls back to safe default (no throw)', () => {
    // Unknown EdgeKind values must not throw — they should return a safe default
    const result = edgeKindToConnectionKind('totally_unknown_kind' as SystemConnectionKind);
    expect(VALID_BACKEND_KINDS.has(result)).toBe(true);
  });

  test('empty string falls back to safe default (no throw)', () => {
    const result = edgeKindToConnectionKind('' as SystemConnectionKind);
    expect(VALID_BACKEND_KINDS.has(result)).toBe(true);
  });
});
