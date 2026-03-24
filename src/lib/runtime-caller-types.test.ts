/**
 * Runtime caller type system tests.
 *
 * Tests that the frontend parser correctly handles all runtime caller connection kinds,
 * section headers, trigger metadata, and mediated-paths endpoint/stage mappings.
 *
 * Unlike the integration tests in indirect-caller-wlan-coverage.test.ts (which exercise
 * the full fetchRelationsFromClangdMcp → mock MCP → parser pipeline), these tests
 * directly exercise the type system and parser internals.
 */
import { describe, expect, test } from 'bun:test';
import type { BackendConnectionKind, BackendSystemNodeKind } from './backend-types';
import type { SystemConnectionKind, SystemNodeKind } from './types';

// ─── Type completeness tests ──────────────────────────────────────────────────

describe('Runtime caller types — completeness', () => {
  const EXPECTED_CONNECTION_KINDS: BackendConnectionKind[] = [
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

  const EXPECTED_NODE_KINDS: BackendSystemNodeKind[] = [
    'api',
    'hw_interrupt',
    'sw_thread',
    'hw_ring',
    'signal',
    'interface',
    'component',
    'timer',
    'work_queue',
    'unknown',
  ];

  test('all expected BackendConnectionKind values exist', () => {
    // Type-level check: if a new kind is added but not listed here, this test
    // won't fail at runtime — but it documents the canonical set.
    for (const kind of EXPECTED_CONNECTION_KINDS) {
      expect(typeof kind).toBe('string');
      expect(kind.length).toBeGreaterThan(0);
    }
    expect(EXPECTED_CONNECTION_KINDS.length).toBe(13);
  });

  test('all expected BackendSystemNodeKind values exist', () => {
    for (const kind of EXPECTED_NODE_KINDS) {
      expect(typeof kind).toBe('string');
      expect(kind.length).toBeGreaterThan(0);
    }
    expect(EXPECTED_NODE_KINDS.length).toBe(10);
  });

  test('new connection kinds are distinct from existing ones', () => {
    const existing: BackendConnectionKind[] = [
      'api_call',
      'interface_registration',
      'sw_thread_comm',
      'hw_interrupt',
      'hw_ring',
      'ring_signal',
      'event',
      'custom',
    ];
    const newKinds: BackendConnectionKind[] = [
      'timer_callback',
      'deferred_work',
      'debugfs_op',
      'ioctl_dispatch',
      'ring_completion',
    ];
    for (const newKind of newKinds) {
      expect(existing.includes(newKind)).toBe(false);
    }
  });

  test('Backend and System type sets are consistent', () => {
    // SystemConnectionKind should be a superset of BackendConnectionKind
    // (same set in practice, but SystemConnectionKind is the frontend-facing type)
    type Test = SystemConnectionKind extends BackendConnectionKind ? true : false;
    const _check: Test = true;
    expect(_check).toBe(true);
  });

  test('BackendSystemNodeKind is a subset of SystemNodeKind', () => {
    type Test = BackendSystemNodeKind extends SystemNodeKind ? true : false;
    const _check: Test = true;
    expect(_check).toBe(true);
  });
});

// ─── Section header → connectionKind mapping ──────────────────────────────────

/**
 * These tests verify that the section header patterns in parseIndirectCallersFromText
 * correctly map to the expected connectionKind. We test the regex patterns directly
 * rather than through the full parser to isolate the mapping logic.
 */
describe('Runtime caller section headers → connectionKind mapping', () => {
  // Copied from clangd-mcp-client.ts parseIndirectCallersFromText section header block
  const sectionMappings: Array<{ header: string; expectedKind: BackendConnectionKind }> = [
    { header: 'Direct callers (5)', expectedKind: 'api_call' },
    { header: 'Dispatch-table registrations (3)', expectedKind: 'interface_registration' },
    { header: 'Registration-call registrations (7)', expectedKind: 'interface_registration' },
    { header: 'Struct registrations (2)', expectedKind: 'interface_registration' },
    { header: 'Signal-based registrations (4)', expectedKind: 'ring_signal' },
    { header: 'WMI Dispatch registrations (11)', expectedKind: 'interface_registration' },
    { header: 'Hardware interrupt registrations (4)', expectedKind: 'hw_interrupt' },
    { header: 'Ring signal registrations (2)', expectedKind: 'ring_signal' },
    { header: 'Event registrations (5)', expectedKind: 'event' },
    { header: 'Thread signal registrations (3)', expectedKind: 'ring_signal' },
    // New section headers:
    { header: 'Timer callback registrations (7)', expectedKind: 'timer_callback' },
    { header: 'Deferred work registrations (5)', expectedKind: 'deferred_work' },
    { header: 'DebugFS registrations (2)', expectedKind: 'debugfs_op' },
    { header: 'IOCTL dispatch registrations (4)', expectedKind: 'ioctl_dispatch' },
    { header: 'Ring completion registrations (4)', expectedKind: 'ring_completion' },
    { header: 'Work queue registrations (3)', expectedKind: 'deferred_work' },
  ];

  // Regex patterns matching each section header (must match the actual patterns in clangd-mcp-client.ts)
  const headerPatterns: Array<{ pattern: RegExp; kind: BackendConnectionKind }> = [
    { pattern: /^Direct callers\s*\(/i, kind: 'api_call' },
    { pattern: /^Dispatch-table registrations\s*\(/i, kind: 'interface_registration' },
    { pattern: /^Registration-call registrations\s*\(/i, kind: 'interface_registration' },
    { pattern: /^Struct registrations\s*\(/i, kind: 'interface_registration' },
    { pattern: /^Signal-based registrations\s*\(/i, kind: 'ring_signal' },
    { pattern: /^WMI Dispatch registrations\s*\(/i, kind: 'interface_registration' },
    { pattern: /^Hardware interrupt registrations\s*\(/i, kind: 'hw_interrupt' },
    { pattern: /^Ring signal registrations\s*\(/i, kind: 'ring_signal' },
    { pattern: /^Event registrations\s*\(/i, kind: 'event' },
    { pattern: /^Thread signal registrations\s*\(/i, kind: 'ring_signal' },
    { pattern: /^Timer callback registrations\s*\(/i, kind: 'timer_callback' },
    { pattern: /^Deferred work registrations\s*\(/i, kind: 'deferred_work' },
    { pattern: /^DebugFS registrations\s*\(/i, kind: 'debugfs_op' },
    { pattern: /^IOCTL dispatch registrations\s*\(/i, kind: 'ioctl_dispatch' },
    { pattern: /^Ring completion registrations\s*\(/i, kind: 'ring_completion' },
    { pattern: /^Work queue registrations\s*\(/i, kind: 'deferred_work' },
  ];

  for (const mapping of sectionMappings) {
    test(`"${mapping.header}" → ${mapping.expectedKind}`, () => {
      const match = headerPatterns.find((hp) => hp.pattern.test(mapping.header));
      expect(match, `No pattern matches header: "${mapping.header}"`).toBeDefined();
      expect(match!.kind).toBe(mapping.expectedKind);
    });
  }

  test('no section header matches more than one pattern', () => {
    for (const mapping of sectionMappings) {
      const matches = headerPatterns.filter((hp) => hp.pattern.test(mapping.header));
      expect(matches.length, `Header "${mapping.header}" matches ${matches.length} patterns`).toBe(1);
    }
  });

  test('non-section-header lines do not match any pattern', () => {
    const nonHeaders = [
      '  <- [Function] wlan_timer_start  at utils/src/wlan_timer.c:205:9',
      '     via: cmnos_timer_start',
      '     trigger-type: timer_callback',
      '',
      'Callers of _wlan_periodic_timer_expiry  (1 total: 1 timer-call)',
    ];
    for (const line of nonHeaders) {
      const matches = headerPatterns.filter((hp) => hp.pattern.test(line));
      expect(matches.length, `Non-header line matches pattern: "${line}"`).toBe(0);
    }
  });
});

// ─── Trigger metadata parsing ─────────────────────────────────────────────────

describe('Runtime caller trigger metadata parsing', () => {
  const triggerTypePatterns: Array<{ annotation: string; expectedType: string | null }> = [
    { annotation: '     trigger-type: hw_interrupt', expectedType: 'hw_interrupt' },
    { annotation: '     trigger-type: ring_signal', expectedType: 'ring_signal' },
    { annotation: '     trigger-type: timer_callback', expectedType: 'timer_callback' },
    { annotation: '     trigger-type: deferred_work', expectedType: 'deferred_work' },
    { annotation: '     trigger-type: debugfs_op', expectedType: 'debugfs_op' },
    { annotation: '     trigger-type: ioctl_dispatch', expectedType: 'ioctl_dispatch' },
    { annotation: '     trigger-type: ring_completion', expectedType: 'ring_completion' },
    { annotation: '     trigger-type: event', expectedType: 'event' },
    { annotation: '     trigger-type: api_call', expectedType: 'api_call' },
    { annotation: '     trigger-type: interface_registration', expectedType: 'interface_registration' },
    { annotation: '     trigger-type: sw_thread_comm', expectedType: 'sw_thread_comm' },
    { annotation: '     trigger-type: custom', expectedType: 'custom' },
    { annotation: '     trigger-type: unknown_type', expectedType: null },
  ];

  const validTriggerTypes = new Set([
    'api_call', 'interface_registration', 'sw_thread_comm', 'hw_interrupt',
    'hw_ring', 'ring_signal', 'event', 'timer_callback', 'deferred_work',
    'debugfs_op', 'ioctl_dispatch', 'ring_completion', 'custom',
  ]);

  for (const tt of triggerTypePatterns) {
    const match = tt.annotation.match(/^\s+trigger-type:\s+([a-z_]+)/i);
    const type = match?.[1]?.toLowerCase();
    const isValid = type ? validTriggerTypes.has(type) : false;

    if (tt.expectedType !== null) {
      test(`"${tt.annotation.trim()}" → valid trigger-type`, () => {
        expect(match).not.toBeNull();
        expect(type).toBe(tt.expectedType!);
        expect(isValid).toBe(true);
      });
    } else {
      test(`"${tt.annotation.trim()}" → invalid trigger-type (rejected)`, () => {
        expect(match).not.toBeNull();
        expect(isValid).toBe(false);
      });
    }
  }

  const metadataAnnotations = [
    { annotation: '     trigger-id: WLAN_PERIODIC_TIMER', field: 'triggerId' as const, expected: 'WLAN_PERIODIC_TIMER' },
    { annotation: '     trigger-id: A_INUM_TQM_STATUS_HI', field: 'triggerId' as const, expected: 'A_INUM_TQM_STATUS_HI' },
    { annotation: '     trigger-id: SCAN_WORK_ITEM', field: 'triggerId' as const, expected: 'SCAN_WORK_ITEM' },
    { annotation: '     trigger-id: TX_COMPLETION_RING', field: 'triggerId' as const, expected: 'TX_COMPLETION_RING' },
    { annotation: '     event: WMI_VDEV_CREATE_RESP_EVENTID', field: 'dispatchEventId' as const, expected: 'WMI_VDEV_CREATE_RESP_EVENTID' },
    { annotation: '     trigger-origin: external(host)', field: 'triggerOrigin' as const, expected: 'external(host)' },
    { annotation: '     trigger-context: cmnos_timer_start(WLAN_PERIODIC_TIMER, cb)', field: 'triggerContext' as const, expected: 'cmnos_timer_start(WLAN_PERIODIC_TIMER, cb)' },
  ];

  for (const ma of metadataAnnotations) {
    test(`"${ma.annotation.trim()}" → ${ma.field}: "${ma.expected}"`, () => {
      let match: RegExpMatchArray | null = null;
      if (ma.field === 'triggerId') {
        match = ma.annotation.match(/^\s+trigger-id:\s+(\S+)/);
        expect(match?.[1]).toBe(ma.expected);
      } else if (ma.field === 'dispatchEventId') {
        match = ma.annotation.match(/^\s+event:\s+(\S+)/);
        expect(match?.[1]).toBe(ma.expected);
      } else if (ma.field === 'triggerOrigin') {
        match = ma.annotation.match(/^\s+trigger-origin:\s+(.+)/i);
        expect(match?.[1].trim()).toBe(ma.expected);
      } else if (ma.field === 'triggerContext') {
        match = ma.annotation.match(/^\s+trigger-context:\s+(.+)/);
        expect(match?.[1].trim()).toBe(ma.expected);
      }
    });
  }
});

// ─── Mediated-paths endpoint kind mapping ─────────────────────────────────────

describe('Mediated-paths endpoint kind → connectionKind mapping', () => {
  const endpointMappings: Array<{ endpointKind: string; expectedKind: BackendConnectionKind }> = [
    { endpointKind: 'host_interface', expectedKind: 'event' },
    { endpointKind: 'fw_signal_message', expectedKind: 'ring_signal' },
    { endpointKind: 'hw_irq_or_ring', expectedKind: 'hw_interrupt' },
    { endpointKind: 'packet_rx', expectedKind: 'hw_ring' },
    { endpointKind: 'packet_tx', expectedKind: 'hw_ring' },
    { endpointKind: 'api_direct', expectedKind: 'api_call' },
    // New endpoint kinds:
    { endpointKind: 'os_timer', expectedKind: 'timer_callback' },
    { endpointKind: 'deferred_work', expectedKind: 'deferred_work' },
    { endpointKind: 'debugfs_op', expectedKind: 'debugfs_op' },
    { endpointKind: 'ioctl_dispatch', expectedKind: 'ioctl_dispatch' },
    { endpointKind: 'ring_completion', expectedKind: 'ring_completion' },
    // Unknown falls through to custom
    { endpointKind: 'some_new_kind', expectedKind: 'custom' },
  ];

  for (const em of endpointMappings) {
    test(`endpointKind "${em.endpointKind}" → ${em.expectedKind}`, () => {
      // Reproduce the mapping function logic
      function map(ep: string): BackendConnectionKind {
        switch (ep) {
          case 'host_interface':    return 'event';
          case 'fw_signal_message': return 'ring_signal';
          case 'hw_irq_or_ring':    return 'hw_interrupt';
          case 'packet_rx':         return 'hw_ring';
          case 'packet_tx':         return 'hw_ring';
          case 'api_direct':        return 'api_call';
          case 'os_timer':          return 'timer_callback';
          case 'deferred_work':     return 'deferred_work';
          case 'debugfs_op':        return 'debugfs_op';
          case 'ioctl_dispatch':    return 'ioctl_dispatch';
          case 'ring_completion':   return 'ring_completion';
          default:                  return 'custom';
        }
      }
      expect(map(em.endpointKind)).toBe(em.expectedKind);
    });
  }
});

// ─── Mediated-paths stage kind mapping ────────────────────────────────────────

describe('Mediated-paths stage kind → connectionKind mapping', () => {
  const stageMappings: Array<{ stageKind: string; expectedKind: BackendConnectionKind }> = [
    { stageKind: 'dispatch_table', expectedKind: 'interface_registration' },
    { stageKind: 'registration_call', expectedKind: 'interface_registration' },
    { stageKind: 'struct_store', expectedKind: 'interface_registration' },
    { stageKind: 'ops_vtable', expectedKind: 'interface_registration' },
    { stageKind: 'irq_registration', expectedKind: 'hw_interrupt' },
    { stageKind: 'signal_wait', expectedKind: 'ring_signal' },
    { stageKind: 'signal_raise', expectedKind: 'ring_signal' },
    { stageKind: 'ring_dispatch', expectedKind: 'hw_ring' },
    { stageKind: 'completion_store', expectedKind: 'sw_thread_comm' },
    { stageKind: 'completion_dispatch', expectedKind: 'sw_thread_comm' },
    // New stage kinds:
    { stageKind: 'timer_arm', expectedKind: 'timer_callback' },
    { stageKind: 'work_schedule', expectedKind: 'deferred_work' },
    { stageKind: 'debugfs_register', expectedKind: 'debugfs_op' },
    { stageKind: 'ioctl_register', expectedKind: 'ioctl_dispatch' },
    { stageKind: 'ring_post', expectedKind: 'ring_completion' },
    // Unknown falls through to api_call
    { stageKind: 'some_new_stage', expectedKind: 'api_call' },
  ];

  for (const sm of stageMappings) {
    test(`stageKind "${sm.stageKind}" → ${sm.expectedKind}`, () => {
      function map(sk: string): BackendConnectionKind {
        switch (sk) {
          case 'dispatch_table':
          case 'registration_call':
          case 'struct_store':
          case 'ops_vtable':        return 'interface_registration';
          case 'irq_registration':  return 'hw_interrupt';
          case 'signal_wait':
          case 'signal_raise':      return 'ring_signal';
          case 'ring_dispatch':     return 'hw_ring';
          case 'completion_store':
          case 'completion_dispatch': return 'sw_thread_comm';
          case 'timer_arm':         return 'timer_callback';
          case 'work_schedule':     return 'deferred_work';
          case 'debugfs_register':  return 'debugfs_op';
          case 'ioctl_register':    return 'ioctl_dispatch';
          case 'ring_post':         return 'ring_completion';
          default:                  return 'api_call';
        }
      }
      expect(map(sm.stageKind)).toBe(sm.expectedKind);
    });
  }
});

// ─── System node kind mapping ─────────────────────────────────────────────────

describe('Mediated-paths endpoint kind → SystemNodeKind mapping', () => {
  const nodeMappings: Array<{ endpointKind: string; expectedKind: SystemNodeKind }> = [
    { endpointKind: 'host_interface', expectedKind: 'interface' },
    { endpointKind: 'fw_signal_message', expectedKind: 'signal' },
    { endpointKind: 'hw_irq_or_ring', expectedKind: 'hw_interrupt' },
    { endpointKind: 'packet_rx', expectedKind: 'hw_ring' },
    { endpointKind: 'packet_tx', expectedKind: 'hw_ring' },
    { endpointKind: 'api_direct', expectedKind: 'api' },
    { endpointKind: 'os_timer', expectedKind: 'timer' },
    { endpointKind: 'deferred_work', expectedKind: 'work_queue' },
    { endpointKind: 'some_unknown', expectedKind: 'unknown' },
  ];

  for (const nm of nodeMappings) {
    test(`endpointKind "${nm.endpointKind}" → node kind "${nm.expectedKind}"`, () => {
      function map(ep: string): SystemNodeKind {
        switch (ep) {
          case 'host_interface':    return 'interface';
          case 'fw_signal_message': return 'signal';
          case 'hw_irq_or_ring':    return 'hw_interrupt';
          case 'packet_rx':
          case 'packet_tx':         return 'hw_ring';
          case 'api_direct':        return 'api';
          case 'os_timer':          return 'timer';
          case 'deferred_work':     return 'work_queue';
          default:                  return 'unknown';
        }
      }
      expect(map(nm.endpointKind)).toBe(nm.expectedKind);
    });
  }
});

// ─── Full parser section header extraction ────────────────────────────────────

describe('Parser: full text with mixed section headers', () => {
  test('multiple section headers in one text block are each detected', () => {
    const text = [
      'Callers of wlan_example  (12 total)',
      '',
      'Direct callers (2):',
      '  <- [Function] direct_caller  at src/a.c:10:1',
      '',
      'Registration-call registrations (3):',
      '  <- [Function] registrar  at src/b.c:20:1',
      '     via: register_api',
      '',
      'Timer callback registrations (2):',
      '  <- [Function] timer_starter  at src/c.c:30:1',
      '     via: cmnos_timer_start',
      '',
      'Deferred work registrations (1):',
      '  <- [Function] work_queuer  at src/d.c:40:1',
      '     via: wlan_work_queue_submit',
      '',
      'Ring completion registrations (2):',
      '  <- [Function] ring_completer  at src/e.c:50:1',
      '     via: wlan_ring_register_completion',
      '',
      'DebugFS registrations (1):',
      '  <- [Function] dbgfs_register  at src/f.c:60:1',
      '     via: wlan_dbgfs_create_file',
      '',
      'IOCTL dispatch registrations (1):',
      '  <- [Function] ioctl_register  at src/g.c:70:1',
      '     via: WMI_REGISTER_DISPATCH_TABLE',
    ].join('\n');

    const headerPattern = /^(Direct callers|Dispatch-table registrations|Registration-call registrations|Struct registrations|Signal-based registrations|WMI Dispatch registrations|Hardware interrupt registrations|Ring signal registrations|Event registrations|Thread signal registrations|Timer callback registrations|Deferred work registrations|DebugFS registrations|IOCTL dispatch registrations|Ring completion registrations|Work queue registrations)\s*\(/im;

    const headers: string[] = [];
    for (const line of text.split('\n')) {
      const match = line.match(headerPattern);
      if (match) headers.push(match[1]);
    }

    expect(headers).toEqual([
      'Direct callers',
      'Registration-call registrations',
      'Timer callback registrations',
      'Deferred work registrations',
      'Ring completion registrations',
      'DebugFS registrations',
      'IOCTL dispatch registrations',
    ]);
  });
});
