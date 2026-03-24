import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { doctorClangdMcp, fetchRelationsFromClangdMcp } from './clangd-mcp-client';
import { startMockMcpServer } from '../../test/mock-mcp-server';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0, cleanup.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.CLANGD_MCP_URL;
});

describe('clangd-mcp client integration (mock server)', () => {
  test('function-pointer registration callers include real registration site when test registration also exists', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'lsp_hover') {
          const ch = Number(args.character);
          if (ch <= 2) return 'No hover information available.';
          return 'function wlan_bpf_filter_offload_handler';
        }
        if (name === 'lsp_indirect_callers') {
          return [
            'Callers of wlan_bpf_filter_offload_handler  (2 total: 2 registration-call)',
            '',
            'Registration-call registrations (2):',
            '  <- [Function] wlan_bpf_enable_data_path  at wlan_proc/wlan/protocol/src/offloads/src/l2/bpf/bpf_offload_int.c:1095:15',
            '     context: wlan_bpf_filter_offload_handler,',
            '  <- [Function] wlan_bpf_offload_test_route_uc_active  at wlan_proc/wlan/protocol/src/offloads/src/l2/bpf/bpf_offload_unit_test.c:202:22',
            '     context: wlan_bpf_filter_offload_handler,',
          ].join('\n');
        }
        if (name === 'lsp_outgoing_calls') {
          return 'No outgoing calls.';
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.CLANGD_MCP_URL = mock.url;

    const ws = mkdtempSync(join(tmpdir(), 'rw-mcp-reg-'));
    cleanup.push(ws);
    mkdirSync(join(ws, 'src'), { recursive: true });

    const file = join(ws, 'src', 'bpf_offload.c');
    writeFileSync(file, 'void wlan_bpf_filter_offload_handler(void) {}\n', 'utf8');

    const incoming = await fetchRelationsFromClangdMcp({
      mode: 'incoming' as const,
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });

    const root = Object.keys(incoming.result || {})[0];
    const calledBy = incoming.result?.[root]?.calledBy ?? [];

    const prodReg = calledBy.find((x) => x.caller === 'wlan_bpf_enable_data_path');
    expect(prodReg).toBeDefined();
    expect(prodReg?.connectionKind).toBe('interface_registration');
    expect(prodReg?.filePath).toContain('bpf_offload_int.c');
    expect(prodReg?.lineNumber).toBe(1095);

    // Production registration should be ranked before unit-test registration.
    expect(calledBy[0]?.caller).toBe('wlan_bpf_enable_data_path');

    const testReg = calledBy.find((x) => x.caller === 'wlan_bpf_offload_test_route_uc_active');
    expect(testReg).toBeDefined();
    expect(testReg?.connectionKind).toBe('interface_registration');

    await mock.close();
  });

  test('incoming fallback merges lsp_incoming_calls when lsp_indirect_callers is incomplete', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'lsp_hover') {
          const ch = Number(args.character);
          if (ch <= 2) return 'No hover information available.';
          return 'function wlan_bpf_filter_offload_handler';
        }
        if (name === 'lsp_indirect_callers') {
          // Simulate unstable daemon snapshot missing production registration.
          return [
            'Callers of wlan_bpf_filter_offload_handler  (1 total: 1 registration-call)',
            '',
            'Registration-call registrations (1):',
            '  <- [Function] wlan_bpf_offload_test_route_uc_active  at wlan_proc/wlan/protocol/src/offloads/src/l2/bpf/bpf_offload_unit_test.c:202:22',
            '     context: wlan_bpf_filter_offload_handler,',
          ].join('\n');
        }
        if (name === 'lsp_incoming_calls') {
          // Direct call hierarchy still contains the true registration owner.
          return [
            '  <- [Function] [reg-call,function] wlan_bpf_enable_data_path  at wlan_proc/wlan/protocol/src/offloads/src/l2/bpf/bpf_offload_int.c:1080:6',
            '  <- [Function] [reg-call,function] wlan_bpf_offload_test_route_uc_active  at wlan_proc/wlan/protocol/src/offloads/src/l2/bpf/bpf_offload_unit_test.c:167:6',
          ].join('\n');
        }
        if (name === 'lsp_outgoing_calls') {
          return 'No outgoing calls.';
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.CLANGD_MCP_URL = mock.url;

    const ws = mkdtempSync(join(tmpdir(), 'rw-mcp-fallback-'));
    cleanup.push(ws);
    mkdirSync(join(ws, 'src'), { recursive: true });

    const file = join(ws, 'src', 'bpf_offload.c');
    writeFileSync(file, 'void wlan_bpf_filter_offload_handler(void) {}\n', 'utf8');

    const incoming = await fetchRelationsFromClangdMcp({
      mode: 'incoming' as const,
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });

    const root = Object.keys(incoming.result || {})[0];
    const calledBy = incoming.result?.[root]?.calledBy ?? [];
    const prod = calledBy.find((x) => x.caller === 'wlan_bpf_enable_data_path');
    expect(prod).toBeDefined();
    expect(prod?.connectionKind).toBe('interface_registration');
    expect(prod?.filePath).toContain('bpf_offload_int.c');

    await mock.close();
  });

  test('doctor + incoming/outgoing queries return compatible payloads', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'lsp_hover') {
          const ch = Number(args.character);
          if (ch <= 2) return 'No hover information available.';
          return 'function resolve_check';
        }
        if (name === 'lsp_indirect_callers') {
          return [
            'Callers of resolve_check  (2 total: 1 direct, 1 registration-call)',
            '',
            'Direct callers (1):',
            '  <- [Function] alpha_caller  at src/alpha.c:11:2',
            '',
            'Registration-call registrations (1):',
            '  <- [Function] setup_handlers  at src/registrar.c:3:1',
            '     via: register_check_handler',
          ].join('\n');
        }
        if (name === 'lsp_outgoing_calls') {
          return [
            'Outgoing calls:',
            '  -> [Function] x_callee  at src/x.c:31:7',
            '  -> [Function] y_callee  at src/y.c:44:1',
          ].join('\n');
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.CLANGD_MCP_URL = mock.url;

    const ws = mkdtempSync(join(tmpdir(), 'rw-mcp-'));
    cleanup.push(ws);
    mkdirSync(join(ws, 'src'), { recursive: true });

    const file = join(ws, 'src', 'demo.cpp');
    writeFileSync(
      file,
      [
        '#include <stdio.h>',
        'int resolve_check() { return 0; }',
        'int main() {',
        '  resolve_check();',
        '  return 0;',
        '}',
      ].join('\n'),
      'utf8'
    );

    const query = {
      mode: 'incoming' as const,
      filePath: file,
      line: 4,
      character: 1,
      workspaceRoot: ws,
    };

    const diag = await doctorClangdMcp(query);
    expect(diag.connected).toBe(true);
    expect(diag.mcpUrl).toContain('/mcp');
    expect(diag.hoverFirstLine.length).toBeGreaterThan(0);

    const incoming = await fetchRelationsFromClangdMcp(query);
    expect(incoming.mode).toBe('incoming');
    expect(incoming.provider).toBe('clangd-mcp');
    const inRoot = Object.keys(incoming.result || {})[0];
    expect(inRoot).toBeString();

    const calledBy = incoming.result?.[inRoot]?.calledBy ?? [];
    expect(calledBy.length).toBeGreaterThan(0);

    // Direct caller → api_call
    const directCaller = calledBy.find((x) => x.caller === 'alpha_caller');
    expect(directCaller).toBeDefined();
    expect(directCaller?.connectionKind).toBe('api_call');

    // Registrar → interface_registration with viaRegistrationApi
    const regCaller = calledBy.find((x) => x.caller === 'setup_handlers');
    expect(regCaller).toBeDefined();
    expect(regCaller?.connectionKind).toBe('interface_registration');
    expect(regCaller?.viaRegistrationApi).toBe('register_check_handler');

    const outgoing = await fetchRelationsFromClangdMcp({ ...query, mode: 'outgoing' });
    expect(outgoing.mode).toBe('outgoing');
    const outRoot = Object.keys(outgoing.result || {})[0];
    expect((outgoing.result?.[outRoot]?.calls?.length ?? 0)).toBeGreaterThan(0);

    await mock.close();
  });

  test('parseIndirectCallers emits correct event-source nodes for signals and interrupts', async () => {
    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'lsp_hover') {
          const ch = Number(args.character);
          if (ch <= 2) return 'No hover information available.';
          return 'function my_handler';
        }
        if (name === 'lsp_indirect_callers') {
          return [
            'Callers of my_handler  (5 total)',
            '',
            // Dispatch-table: single registrar node, no event source node
            'Dispatch-table registrations (1):',
            '  <- [Variable] wmi_dispatch_table  at src/wmi.c:42:5',
            '     event: WMI_MY_CMDID',
            '     trigger-origin: external(host)',
            '',
            // Registration-call: single registrar node, no event source node
            // (dispatch infra is not a meaningful caller identity)
            'Registration-call registrations (1):',
            '  <- [Function] setup_handlers  at src/offload.c:10:1',
            '     via: offldmgr_register_nondata_offload',
            '',
            // Ring-triggered: registrar=interface_registration + explicit hw_interrupt event source node
            'Registration-call registrations (1):',
            '  <- [Function] ring_setup  at src/ring.c:10:1',
            '     via: wlan_thread_register_signal_wrapper_internal',
            '     trigger-type: hw_interrupt',
            '     trigger-id: A_INUM_TQM_STATUS_HI',
            '     trigger-context: cmnos_irq_register(A_INUM_TQM_STATUS_HI, me, WLAN_THREAD_SIG_TQM_HIPRI_STATUS_HW_INTR)',
            '',
            // Signal-based: registrar=ring_signal + ring_signal event source node
            'Signal-based registrations (1):',
            '  <- [Function] signal_setup  at src/sig.c:7:1',
            '     context: qurt_signal_wait(sig, WLAN_THREAD_SIG_MY_EVENT)',
            '     trigger-type: ring_signal',
            '     trigger-id: WLAN_THREAD_SIG_MY_EVENT',
            '     trigger-context: unknown thread / signal',
            '',
            // Struct registration: single registrar node, no event source node
            'Struct registrations (1):',
            '  <- [Function] htc_init  at src/htc.c:5:1',
            '     context: pService->EpCallbacks.EpRecv = my_handler',
          ].join('\n');
        }
        if (name === 'lsp_outgoing_calls') {
          return 'No outgoing calls.';
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.CLANGD_MCP_URL = mock.url;

    const ws = mkdtempSync(join(tmpdir(), 'rw-mcp-all-'));
    cleanup.push(ws);
    mkdirSync(join(ws, 'src'), { recursive: true });
    const file = join(ws, 'src', 'handler.c');
    writeFileSync(file, 'void my_handler(void) {}\n', 'utf8');

    const result = await fetchRelationsFromClangdMcp({
      mode: 'incoming' as const,
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });

    const calledBy = result.result?.[Object.keys(result.result ?? {})[0]]?.calledBy ?? [];

    // ── Dispatch-table: registrar + event endpoint source ─────────────────────
    const dispTableReg = calledBy.find((x) => x.caller === 'wmi_dispatch_table');
    expect(dispTableReg?.connectionKind).toBe('interface_registration');
    const wmiEvent = calledBy.find((x) => x.caller === 'WMI_MY_CMDID');
    expect(wmiEvent?.connectionKind).toBe('event');
    expect(wmiEvent?.viaRegistrationApi).toBe('external(host)');
    // No dispatch infra function node emitted
    expect(calledBy.find((x) => x.caller === 'WMI_ProcessEvent')).toBeUndefined();

    // ── Registration-call: single registrar node only ─────────────────────────
    const regReg = calledBy.find((x) => x.caller === 'setup_handlers');
    expect(regReg?.connectionKind).toBe('interface_registration');
    expect(regReg?.viaRegistrationApi).toBe('offldmgr_register_nondata_offload');
    // No dispatch infra node emitted
    expect(calledBy.find((x) => x.caller === '_offldmgr_non_data_handler')).toBeUndefined();

    // ── Ring-triggered: registrar + explicit hw_interrupt event source ─────────
    const ringReg = calledBy.find((x) => x.caller === 'ring_setup');
    expect(ringReg?.connectionKind).toBe('interface_registration');
    // HW interrupt IS the real event source — emitted with trigger-context as viaRegistrationApi
    const ringInterrupt = calledBy.find((x) => x.caller === 'A_INUM_TQM_STATUS_HI');
    expect(ringInterrupt?.connectionKind).toBe('hw_interrupt');
    // trigger-context carries the full cmnos_irq_register(...) call so user can find the trigger site
    expect(ringInterrupt?.viaRegistrationApi).toContain('cmnos_irq_register');
    expect(ringInterrupt?.viaRegistrationApi).toContain('A_INUM_TQM_STATUS_HI');

    // ── Signal-based: registrar=ring_signal + ring_signal event source ────────
    const sigReg = calledBy.find((x) => x.caller === 'signal_setup');
    expect(sigReg?.connectionKind).toBe('ring_signal');
    // Signal ID IS the real event source — emitted with trigger-context as viaRegistrationApi
    const sigReal = calledBy.find((x) => x.caller === 'WLAN_THREAD_SIG_MY_EVENT');
    expect(sigReal?.connectionKind).toBe('ring_signal');
    // trigger-context carries the human-readable classification
    expect(sigReal?.viaRegistrationApi).toBe('unknown thread / signal');

    // ── Struct registration: single registrar node only ───────────────────────
    const structReg = calledBy.find((x) => x.caller === 'htc_init');
    expect(structReg?.connectionKind).toBe('interface_registration');
    // No dispatch infra node emitted
    expect(calledBy.find((x) => x.caller === 'HTCRecvCompleteHandler')).toBeUndefined();

    await mock.close();
  });

  test('parseIndirectCallers consumes structured mediatedPaths JSON block (Gate G8)', async () => {
    // Simulate a clangd-mcp response that includes the ---mediated-paths-json--- block
    // This is the new structured output format from the trace infrastructure.
    const mediatedPaths = [
      {
        pathId: 'path-wls_fw_scan_result_handler-WMI_LPI_RESULT_EVENTID-1',
        endpoint: {
          endpointKind: 'host_interface',
          endpointId: 'WMI_LPI_RESULT_EVENTID',
          endpointLabel: 'WMI LPI Result Event',
          origin: 'external(host)',
          filePath: '/workspace/src/wls_fw.c',
          lineNumber: 2935,
        },
        stages: [
          {
            stageKind: 'dispatch_table',
            ownerSymbol: 'wmi_unified_register_event_handler',
            filePath: '/workspace/src/wls_fw.c',
            lineNumber: 2935,
            ids: { eventId: 'WMI_LPI_RESULT_EVENTID' },
          },
        ],
        confidence: { score: 0.9, reasons: ['explicit-endpoint-id', 'dispatch-site-evidence'] },
        evidence: [{ role: 'registration-site', filePath: '/workspace/src/wls_fw.c', lineNumber: 2935 }],
      },
      {
        pathId: 'path-wls_fw_scan_result_handler-A_INUM_TQM_STATUS_HI-2',
        endpoint: {
          endpointKind: 'hw_irq_or_ring',
          endpointId: 'A_INUM_TQM_STATUS_HI',
          endpointLabel: 'A_INUM_TQM_STATUS_HI',
          origin: 'external(hw)',
          filePath: '/workspace/src/tqm_thread.c',
          lineNumber: 310,
        },
        stages: [
          {
            stageKind: 'irq_registration',
            ownerSymbol: 'cmnos_irq_register',
            filePath: '/workspace/src/tqm_thread.c',
            lineNumber: 310,
            ids: { irqId: 'A_INUM_TQM_STATUS_HI' },
          },
        ],
        confidence: { score: 0.8, reasons: ['explicit-endpoint-id'] },
        evidence: [{ role: 'trigger-site', filePath: '/workspace/src/tqm_thread.c', lineNumber: 310 }],
      },
    ];

    const mock = await startMockMcpServer({
      onToolCall: (name, args) => {
        if (name === 'lsp_hover') {
          const ch = Number(args.character);
          if (ch <= 2) return 'No hover information available.';
          return 'function wls_fw_scan_result_handler';
        }
        if (name === 'lsp_indirect_callers') {
          // Return text with embedded JSON block (new format)
          return [
            'Callers of wls_fw_scan_result_handler  (2 total)',
            '',
            'Registration-call registrations (2):',
            '  <- [Function] wls_register_wmi_handlers  at src/wls_fw.c:2935:5',
            '     via: wmi_unified_register_event_handler',
            '     trigger-type: WMI_EVENT',
            '     trigger-id: WMI_LPI_RESULT_EVENTID',
            '',
            '---mediated-paths-json---',
            JSON.stringify(mediatedPaths, null, 2),
            '---end-mediated-paths-json---',
          ].join('\n');
        }
        if (name === 'lsp_outgoing_calls') {
          return 'No outgoing calls.';
        }
        return `Unknown tool: ${name}`;
      },
    });
    process.env.CLANGD_MCP_URL = mock.url;

    const ws = mkdtempSync(join(tmpdir(), 'rw-mcp-g8-'));
    cleanup.push(ws);
    mkdirSync(join(ws, 'src'), { recursive: true });
    const file = join(ws, 'src', 'wls_fw.c');
    writeFileSync(file, 'int wls_fw_scan_result_handler(void) { return 0; }\n', 'utf8');

    const result = await fetchRelationsFromClangdMcp({
      mode: 'incoming' as const,
      filePath: file,
      line: 1,
      character: 6,
      workspaceRoot: ws,
    });

    const rootKey = Object.keys(result.result ?? {})[0];
    const rootNode = result.result?.[rootKey];
    const calledBy = rootNode?.calledBy ?? [];

    // ── Structured path: WMI endpoint ────────────────────────────────────────
    const wmiCaller = calledBy.find((x) => x.caller === 'WMI_LPI_RESULT_EVENTID');
    expect(wmiCaller).toBeDefined();
    expect(wmiCaller?.connectionKind).toBe('event'); // host_interface -> event
    expect(wmiCaller?.viaRegistrationApi).toBe('wmi_unified_register_event_handler');

    // ── Structured path: IRQ endpoint ─────────────────────────────────────────
    const irqCaller = calledBy.find((x) => x.caller === 'A_INUM_TQM_STATUS_HI');
    expect(irqCaller).toBeDefined();
    expect(irqCaller?.connectionKind).toBe('hw_interrupt'); // hw_irq_or_ring -> hw_interrupt
    expect(irqCaller?.viaRegistrationApi).toBe('cmnos_irq_register');

    // ── systemNodes are populated from structured paths ───────────────────────
    const systemNodes = rootNode?.systemNodes ?? [];
    expect(systemNodes.length).toBeGreaterThan(0);

    // Endpoint nodes should be present
    const wmiNode = systemNodes.find((n) => n.name === 'WMI LPI Result Event' || n.name === 'WMI_LPI_RESULT_EVENTID');
    expect(wmiNode).toBeDefined();
    expect(wmiNode?.kind).toBe('interface'); // host_interface -> interface

    const irqNode = systemNodes.find((n) => n.name === 'A_INUM_TQM_STATUS_HI');
    expect(irqNode).toBeDefined();
    expect(irqNode?.kind).toBe('hw_interrupt');

    // API callback node should be present
    const apiNode = systemNodes.find((n) => n.kind === 'api');
    expect(apiNode).toBeDefined();

    // ── systemLinks are populated ─────────────────────────────────────────────
    const systemLinks = rootNode?.systemLinks ?? [];
    expect(systemLinks.length).toBeGreaterThan(0);

    await mock.close();
  });
});
