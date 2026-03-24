#!/usr/bin/env bun

declare const Bun: any;

type RelationPayload = {
  mode?: 'incoming' | 'outgoing';
  provider?: string;
  result?: Record<string, { calledBy?: Array<{ caller?: string; connectionKind?: string }> }>;
};

type CoverageTarget = {
  family: string;
  label: string;
  file: string;
  line: number;
  character: number;
  expectedCallers?: string[];
  requireNonEmpty?: boolean;
};

const WORKSPACE_ROOT =
  process.env.RW_WORKSPACE_ROOT ||
  '/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1';

const targets: CoverageTarget[] = [
  {
    family: 'registration-dispatch',
    label: 'wlan_bpf_filter_offload_handler',
    file: `${WORKSPACE_ROOT}/wlan_proc/wlan/protocol/src/offloads/src/l2/bpf/bpf_offload.c`,
    line: 83,
    character: 6,
    expectedCallers: ['wlan_bpf_enable_data_path', 'wlan_bpf_offload_test_route_uc_active'],
    requireNonEmpty: true,
  },
  {
    family: 'api-direct-callers',
    label: 'wlan_bpf_enable_data_path',
    file: `${WORKSPACE_ROOT}/wlan_proc/wlan/protocol/src/offloads/src/l2/bpf/bpf_offload_int.c`,
    line: 1080,
    character: 8,
    expectedCallers: ['wlan_bpf_enable_cmd_handler'],
    requireNonEmpty: true,
  },
  {
    family: 'unit-test-control',
    label: 'wlan_bpf_offload_test_route_uc_active',
    file: `${WORKSPACE_ROOT}/wlan_proc/wlan/protocol/src/offloads/src/l2/bpf/bpf_offload_unit_test.c`,
    line: 167,
    character: 6,
    expectedCallers: ['wlan_bpf_offload_unit_test'],
    requireNonEmpty: true,
  },
  {
    family: 'irq-registration',
    label: '_HIF_CE_isr_handler',
    file: `${WORKSPACE_ROOT}/wlan_proc/wlan/syssw_platform/src/hostif/hif/hif_ce/hif_ce.c`,
    line: 731,
    character: 6,
    expectedCallers: ['HIF_CE_module_install'],
    requireNonEmpty: true,
  },
  {
    family: 'completion-callback',
    label: 'tx_frame_send_complete_handle',
    file: `${WORKSPACE_ROOT}/wlan_proc/wlan/protocol/src/offloads/src/l2/bpf/bpf_offload.c`,
    line: 295,
    character: 6,
    expectedCallers: ['apf_transmit_buffer_internal'],
    requireNonEmpty: true,
  },
  {
    family: 'signal-registration',
    label: 'qmi_plat_chipset_log_handler',
    file: `${WORKSPACE_ROOT}/wlan_proc/wlan/syssw_services/src/platform_cmn/src/platform_thread.c`,
    line: 562,
    character: 40,
    expectedCallers: ['platform_thread_register_signals'],
    requireNonEmpty: true,
  },
  {
    family: 'offload-protocol-handler',
    label: '_offldmgr_protocol_data_handler',
    file: `${WORKSPACE_ROOT}/wlan_proc/wlan/protocol/src/cmn_infra/src/offload_mgr/offload_mgr_ext.c`,
    line: 1166,
    character: 30,
    requireNonEmpty: true,
  },
  {
    family: 'wmi-event-handler',
    label: 'wls_fw_scan_result_handler',
    file: `${WORKSPACE_ROOT}/wlan_proc/wlan/wlssvr/src/wls/core/wls_fw.c`,
    line: 2238,
    character: 8,
    requireNonEmpty: true,
  },
];

async function main() {
  console.log('Indirect-caller live scorecard');
  console.log(`workspaceRoot=${WORKSPACE_ROOT}`);
  console.log(`targets=${targets.length}`);

  const rows: Array<{ target: string; family: string; status: 'PASS' | 'FAIL'; detail: string }> = [];

  for (const t of targets) {
    const run = await queryIncoming(t);
    rows.push(run);
  }

  const passCount = rows.filter((r) => r.status === 'PASS').length;
  const failCount = rows.length - passCount;

  console.log('\nScorecard:');
  for (const row of rows) {
    console.log(`- [${row.status}] ${row.family} :: ${row.target} :: ${row.detail}`);
  }

  console.log(`\nSummary: pass=${passCount} fail=${failCount} total=${rows.length}`);
  if (failCount > 0) {
    process.exit(1);
  }
}

async function queryIncoming(t: CoverageTarget): Promise<{ target: string; family: string; status: 'PASS' | 'FAIL'; detail: string }> {
  const args = [
    '--mode',
    'incoming',
    '--file',
    t.file,
    '--line',
    String(t.line),
    '--character',
    String(t.character),
    '--workspace-root',
    WORKSPACE_ROOT,
  ];

  const proc = Bun.spawn({
    cmd: [process.execPath, 'src/backend.ts', ...args],
    cwd: '/local/mnt/workspace/qprojects/tui-relation-window',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0) {
    return { target: t.label, family: t.family, status: 'FAIL', detail: `backend exit ${code}: ${stderr.trim() || 'no stderr'}` };
  }

  let payload: RelationPayload;
  try {
    payload = JSON.parse(stdout.trim()) as RelationPayload;
  } catch {
    return { target: t.label, family: t.family, status: 'FAIL', detail: 'invalid JSON from backend' };
  }

  const rootName = Object.keys(payload.result || {})[0];
  const calledBy = payload.result?.[rootName]?.calledBy || [];
  const names = calledBy.map((x) => x.caller || '').filter(Boolean);

  if (t.requireNonEmpty && names.length === 0) {
    return { target: t.label, family: t.family, status: 'FAIL', detail: 'empty calledBy' };
  }

  for (const expected of t.expectedCallers || []) {
    if (!names.includes(expected)) {
      return {
        target: t.label,
        family: t.family,
        status: 'FAIL',
        detail: `missing expected caller '${expected}', got [${names.join(', ')}]`,
      };
    }
  }

  return {
    target: t.label,
    family: t.family,
    status: 'PASS',
    detail: `root=${rootName} callers=${names.length}`,
  };
}

main().catch((err) => {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
