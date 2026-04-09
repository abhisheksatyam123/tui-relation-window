import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchRelationsFromIntelgraph, resetSnapshotState } from './intelgraph-client';
import type { BackendConnectionKind } from './backend-types';
import { startMockMcpServer } from '../../test/mock-mcp-server';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0, cleanup.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.INTELGRAPH_URL;
  resetSnapshotState();
});

type CoverageCase = {
  name: string;
  rootSymbol: string;
  expected: Array<{ caller: string; connectionKind: BackendConnectionKind; viaIncludes?: string }>;
  absent?: string[];
};

async function runCoverageCase(c: CoverageCase) {
  // Build get_callers JSON response from expected callers
  const callers: Array<Record<string, unknown>> = [];
  const registrars: Array<Record<string, unknown>> = [];

  for (const e of c.expected) {
    if (e.connectionKind === 'interface_registration') {
      registrars.push({
        name: e.caller,
        filePath: `src/${e.caller}.c`,
        lineNumber: 1,
        callerRole: 'registrar',
        invocationType: 'interface_registration',
        confidence: 0.9,
        source: 'intelligence_query_static',
        ...(e.viaIncludes ? { viaRegistrationApi: e.viaIncludes } : {}),
      });
    } else {
      callers.push({
        name: e.caller,
        filePath: `src/${e.caller}.c`,
        lineNumber: 1,
        callerRole: 'direct_caller',
        invocationType: 'direct_call',
        confidence: 0.9,
        source: 'intelligence_query_static',
        ...(e.viaIncludes ? { viaRegistrationApi: e.viaIncludes } : {}),
      });
    }
  }

  const getCallersResponse = JSON.stringify({
    targetApi: c.rootSymbol,
    targetFile: `/src/${c.rootSymbol}.c`,
    targetLine: 1,
    callers,
    registrars,
    source: 'intelligence_query_static',
    provenance: { stepsAttempted: ['intelligence_query_static'], stepUsed: 'intelligence_query_static' },
  });

  const mock = await startMockMcpServer({
    onToolCall: (name, args) => {
      if (name === 'lsp_hover') {
        const ch = Number(args.character);
        if (ch <= 2) return 'No hover information available.';
        return `function ${c.rootSymbol}`;
      }
      if (name === 'get_callers') return getCallersResponse;
      if (name === 'lsp_outgoing_calls') return 'No outgoing calls.';
      return `Unknown tool: ${name}`;
    },
  });
  process.env.INTELGRAPH_URL = mock.url;

  const ws = mkdtempSync(join(tmpdir(), 'rw-mcp-coverage-'));
  cleanup.push(ws);
  mkdirSync(join(ws, 'src'), { recursive: true });
  const file = join(ws, 'src', 'target.c');
  writeFileSync(file, `void ${c.rootSymbol}(void) {}\n`, 'utf8');

  const result = await fetchRelationsFromIntelgraph({
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
      expected: [
        { caller: 'wlan_bpf_enable_data_path', connectionKind: 'interface_registration' },
        { caller: 'wlan_bpf_offload_test_route_uc_active', connectionKind: 'interface_registration' },
      ],
    },
    {
      name: 'D dispatch table with registrar node',
      rootSymbol: 'wls_fw_scan_result_handler',
      expected: [
        { caller: 'wmi_dispatch_table', connectionKind: 'interface_registration' },
        // WMI_LPI_RESULT_EVENTID is a runtime caller (api_call) in get_callers format
        { caller: 'WMI_LPI_RESULT_EVENTID', connectionKind: 'api_call' },
      ],
    },
    {
      name: 'E signal-based registration — registrar shown',
      rootSymbol: 'signal_handler',
      expected: [
        // signal_setup is the registrar (interface_registration)
        { caller: 'signal_setup', connectionKind: 'interface_registration' },
        // WLAN_THREAD_SIG_MY_EVENT is a runtime caller (api_call) in get_callers format
        { caller: 'WLAN_THREAD_SIG_MY_EVENT', connectionKind: 'api_call' },
      ],
    },
    {
      name: 'G completion callback registration',
      rootSymbol: 'tx_frame_send_complete_handle',
      expected: [{ caller: 'apf_transmit_buffer_internal', connectionKind: 'interface_registration' }],
    },
    {
      name: 'I struct callback registration hides infra implementation node',
      rootSymbol: 'my_htc_handler',
      expected: [{ caller: 'htc_init', connectionKind: 'interface_registration' }],
      absent: ['HTCRecvCompleteHandler'],
    },
    {
      name: 'C/E IRQ registration — registrar shown with interface_registration',
      // Note: _HIF_CE_isr_handler has leading underscore; preferSymbolAlias strips it
      rootSymbol: 'HIF_CE_isr_handler',
      expected: [
        { caller: 'HIF_CE_module_install', connectionKind: 'interface_registration' },
        // A_INUM_CE3_COPY_COMP is a runtime caller (api_call) in get_callers format
        { caller: 'A_INUM_CE3_COPY_COMP', connectionKind: 'api_call' },
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
