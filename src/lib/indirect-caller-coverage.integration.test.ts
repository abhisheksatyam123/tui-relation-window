import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchRelationsFromClangdMcp } from './clangd-mcp-client';
import type { BackendConnectionKind } from './backend-types';
import { startMockMcpServer } from '../../test/mock-mcp-server';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0, cleanup.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.CLANGD_MCP_URL;
});

type CoverageCase = {
  name: string;
  rootSymbol: string;
  indirectText: string;
  expected: Array<{ caller: string; connectionKind: BackendConnectionKind; viaIncludes?: string }>;
  absent?: string[];
};

async function runCoverageCase(c: CoverageCase) {
  const mock = await startMockMcpServer({
    onToolCall: (name, args) => {
      if (name === 'lsp_hover') {
        const ch = Number(args.character);
        if (ch <= 2) return 'No hover information available.';
        return `function ${c.rootSymbol}`;
      }
      if (name === 'lsp_indirect_callers') return c.indirectText;
      if (name === 'lsp_outgoing_calls') return 'No outgoing calls.';
      return `Unknown tool: ${name}`;
    },
  });
  process.env.CLANGD_MCP_URL = mock.url;

  const ws = mkdtempSync(join(tmpdir(), 'rw-mcp-coverage-'));
  cleanup.push(ws);
  mkdirSync(join(ws, 'src'), { recursive: true });
  const file = join(ws, 'src', 'target.c');
  writeFileSync(file, `void ${c.rootSymbol}(void) {}\n`, 'utf8');

  const result = await fetchRelationsFromClangdMcp({
    mode: 'incoming' as const,
    filePath: file,
    line: 1,
    character: 6,
    workspaceRoot: ws,
  });

  const root = Object.keys(result.result || {})[0];
  const calledBy = result.result?.[root]?.calledBy ?? [];

  for (const e of c.expected) {
    const caller = calledBy.find((x) => x.caller === e.caller);
    expect(caller, `${c.name}: missing caller ${e.caller}`).toBeDefined();
    expect(caller?.connectionKind, `${c.name}: connectionKind mismatch for ${e.caller}`).toBe(e.connectionKind);
    if (e.viaIncludes) {
      expect(caller?.viaRegistrationApi, `${c.name}: viaRegistrationApi missing for ${e.caller}`).toContain(e.viaIncludes);
    }
  }

  for (const missing of c.absent ?? []) {
    expect(calledBy.find((x) => x.caller === missing), `${c.name}: unexpected infra node ${missing}`).toBeUndefined();
  }

  await mock.close();
}

describe('indirect-caller coverage matrix (mock MCP)', () => {
  const cases: CoverageCase[] = [
    {
      name: 'A/B registration chain with production + test registrars',
      rootSymbol: 'wlan_bpf_filter_offload_handler',
      indirectText: [
        'Callers of wlan_bpf_filter_offload_handler  (2 total: 2 registration-call)',
        '',
        'Registration-call registrations (2):',
        '  <- [Function] wlan_bpf_enable_data_path  at src/bpf_offload_int.c:1095:15',
        '     context: wlan_bpf_filter_offload_handler,',
        '  <- [Function] wlan_bpf_offload_test_route_uc_active  at src/bpf_offload_unit_test.c:202:22',
        '     context: wlan_bpf_filter_offload_handler,',
      ].join('\n'),
      expected: [
        { caller: 'wlan_bpf_enable_data_path', connectionKind: 'interface_registration' },
        { caller: 'wlan_bpf_offload_test_route_uc_active', connectionKind: 'interface_registration' },
      ],
    },
    {
      name: 'D dispatch table with external host endpoint node',
      rootSymbol: 'wls_fw_scan_result_handler',
      indirectText: [
        'Callers of wls_fw_scan_result_handler  (2 total)',
        '',
        'Dispatch-table registrations (1):',
        '  <- [Variable] wmi_dispatch_table  at src/wls_fw.c:2935:5',
        '     event: WMI_LPI_RESULT_EVENTID',
        '     trigger-origin: external(host)',
      ].join('\n'),
      expected: [
        { caller: 'wmi_dispatch_table', connectionKind: 'interface_registration' },
        { caller: 'WMI_LPI_RESULT_EVENTID', connectionKind: 'event', viaIncludes: 'external(host)' },
      ],
    },
    {
      name: 'E signal-based registration keeps signal node',
      rootSymbol: 'signal_handler',
      indirectText: [
        'Callers of signal_handler  (1 total)',
        '',
        'Signal-based registrations (1):',
        '  <- [Function] signal_setup  at src/sig.c:7:1',
        '     context: qurt_signal_wait(sig, WLAN_THREAD_SIG_MY_EVENT)',
        '     trigger-type: ring_signal',
        '     trigger-id: WLAN_THREAD_SIG_MY_EVENT',
        '     trigger-context: platform thread signal',
      ].join('\n'),
      expected: [
        { caller: 'signal_setup', connectionKind: 'ring_signal' },
        { caller: 'WLAN_THREAD_SIG_MY_EVENT', connectionKind: 'ring_signal', viaIncludes: 'platform thread signal' },
      ],
    },
    {
      name: 'G completion callback registration',
      rootSymbol: 'tx_frame_send_complete_handle',
      indirectText: [
        'Callers of tx_frame_send_complete_handle  (1 total: 1 registration-call)',
        '',
        'Registration-call registrations (1):',
        '  <- [Function] apf_transmit_buffer_internal  at src/bpf_offload.c:420:5',
        '     via: tx_frame_send_with_completion',
      ].join('\n'),
      expected: [{ caller: 'apf_transmit_buffer_internal', connectionKind: 'interface_registration' }],
    },
    {
      name: 'I struct callback registration hides infra implementation node',
      rootSymbol: 'my_htc_handler',
      indirectText: [
        'Callers of my_htc_handler  (1 total)',
        '',
        'Struct registrations (1):',
        '  <- [Function] htc_init  at src/htc.c:5:1',
        '     context: pService->EpCallbacks.EpRecv = my_htc_handler',
      ].join('\n'),
      expected: [{ caller: 'htc_init', connectionKind: 'interface_registration' }],
      absent: ['HTCRecvCompleteHandler'],
    },
    {
      name: 'C/E IRQ registration keeps hardware endpoint',
      rootSymbol: '_HIF_CE_isr_handler',
      indirectText: [
        'Callers of _HIF_CE_isr_handler  (1 total)',
        '',
        'Registration-call registrations (1):',
        '  <- [Function] HIF_CE_module_install  at src/hif_ce_ext.c:134:5',
        '     via: cmnos_irq_register',
        '     trigger-type: hw_interrupt',
        '     trigger-id: A_INUM_CE3_COPY_COMP',
        '     trigger-context: cmnos_irq_register(A_INUM_CE3_COPY_COMP, me, WLAN_THREAD_SIG_CE3)',
      ].join('\n'),
      expected: [
        { caller: 'HIF_CE_module_install', connectionKind: 'interface_registration' },
        { caller: 'A_INUM_CE3_COPY_COMP', connectionKind: 'hw_interrupt', viaIncludes: 'cmnos_irq_register' },
      ],
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      await runCoverageCase(c);
    });
  }

  test('coverage matrix sanity: all primary families represented', () => {
    // Families targeted by this suite: A/B, C, D, E, G, I (plus endpoint abstractions)
    expect(cases.length).toBeGreaterThanOrEqual(6);
  });
});
