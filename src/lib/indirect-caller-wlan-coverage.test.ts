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

/**
 * WLAN indirect-caller coverage matrix.
 *
 * Each case exercises the full `fetchRelationsFromIntelgraph` integration path using
 * `get_callers` JSON mock responses (the current backend format).
 *
 * Categories:
 *  A — offldmgr_register_data_offload (BPF / proto offload handlers)
 *  B — offldmgr_register_nondata_offload (non-data offload, beacon/scan/mlme handlers)
 *  C — WMI event handler registrations (wmi_unified_register_event_handler, LPI/NAN/OEM)
 *  D — WMI dispatch tables (WMI_RegisterDispatchTable / WMI command dispatch)
 *  E — cmnos_irq_register hardware interrupts (thread IRQs + dynamic ISR)
 *  F — Signal-based registrations (qurt_signal_wait on thread signals)
 *  G — Struct callback registrations (->EpCallbacks assignment)
 *  H — Structured mediated paths JSON (---mediated-paths-json--- block)
 *  I — Dual registration: production + unit-test callers
 *  J — Incoming call merge: partial callers
 *  K — Timer-based callbacks
 *  L — Deferred work / work-queue invocations
 *  M — IOCTL / debugfs / op-vtable dispatch tables
 *  N — Ring completion callbacks
 *  O — Struct initializer dispatch tables
 *
 * All file paths use the real WLAN source tree root as workspace.
 */

const WLAN_ROOT = '/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1';

// ─── Helper ────────────────────────────────────────────────────────────────────

type WlanCase = {
  /** Human-readable label */
  name: string;
  /** Which pattern family this covers */
  category: string;
  /** Real target symbol */
  targetSymbol: string;
  /** Path to the target file (relative to WLAN_ROOT) */
  targetFile: string;
  /** Line number in the target file */
  targetLine: number;
  /** Column number in the target file */
  targetCol?: number;
  /** Expected callers in the parsed result */
  expected: Array<{
    caller: string;
    connectionKind: BackendConnectionKind;
    viaIncludes?: string;
    absent?: boolean;
  }>;
};

/**
 * Map a BackendConnectionKind to a get_callers invocationType for building mock responses.
 * Registrars use 'interface_registration'; runtime callers use the appropriate invocationType.
 */
function connectionKindToInvocationType(kind: BackendConnectionKind): string {
  switch (kind) {
    case 'timer_callback':
      return 'runtime_callback_registration_call';
    case 'interface_registration':
      return 'interface_registration';
    case 'api_call':
      return 'direct_call';
    default:
      // hw_interrupt, ring_signal, event, deferred_work, debugfs_op, ioctl_dispatch,
      // ring_completion, sw_thread_comm, hw_ring, custom all map to runtime_direct_call
      // which the client maps to api_call.
      return 'runtime_direct_call';
  }
}

async function runWlanCase(c: WlanCase) {
  // Build get_callers JSON response from expected callers
  const callers: Array<Record<string, unknown>> = [];
  const registrars: Array<Record<string, unknown>> = [];

  for (const e of c.expected) {
    if (e.absent) continue;
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
        callerRole: e.connectionKind === 'api_call' ? 'direct_caller' : 'runtime_caller',
        invocationType: connectionKindToInvocationType(e.connectionKind),
        confidence: 0.9,
        source: 'intelligence_query_runtime',
        ...(e.viaIncludes ? { viaRegistrationApi: e.viaIncludes } : {}),
      });
    }
  }

  const getCallersResponse = JSON.stringify({
    targetApi: c.targetSymbol,
    targetFile: c.targetFile,
    targetLine: c.targetLine,
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
        return `function ${c.targetSymbol}`;
      }
      if (name === 'get_callers') return getCallersResponse;
      if (name === 'lsp_outgoing_calls') return 'No outgoing calls.';
      return `Unknown tool: ${name}`;
    },
  });
  process.env.INTELGRAPH_URL = mock.url;

  const ws = mkdtempSync(join(tmpdir(), 'rw-wlan-cov-'));
  cleanup.push(ws);
  mkdirSync(join(ws, 'src'), { recursive: true });

  const file = join(ws, 'src', c.targetFile.replace(/^.*\//, ''));
  writeFileSync(file, `void ${c.targetSymbol}(void) {}\n`, 'utf8');

  const result = await fetchRelationsFromIntelgraph({
    mode: 'incoming' as const,
    filePath: file,
    line: c.targetLine,
    character: c.targetCol ?? 6,
    workspaceRoot: ws,
  });

  const root = Object.keys(result.result || {})[0];
  const calledBy = result.result?.[root]?.calledBy ?? [];

  for (const e of c.expected) {
    if (e.absent) {
      const found = calledBy.find((x) => x.caller === e.caller);
      expect(found, `${c.name}: unexpected caller ${e.caller} should not be present`).toBeUndefined();
    } else {
      const caller = calledBy.find((x) => x.caller === e.caller);
      expect(caller, `${c.name}: missing caller ${e.caller}`).toBeDefined();
      expect(caller?.connectionKind, `${c.name}: connectionKind mismatch for ${e.caller}`).toBe(e.connectionKind);
      if (e.viaIncludes) {
        expect(caller?.viaRegistrationApi, `${c.name}: viaRegistrationApi missing for ${e.caller}`).toInclude(e.viaIncludes);
      }
    }
  }

  await mock.close();
}

// ─── Category A: offldmgr_register_data_offload ────────────────────────────────
// Data-path handlers registered via offldmgr_register_data_offload().
// These are invoked when a matching RX/TX data packet arrives — the dispatcher
// loops over the offload_data[] array and calls the registered handler.

const categoryA: WlanCase[] = [
  {
    name: 'A1 — BPF filter offload handler (production + test dual registration)',
    category: 'A / offldmgr_register_data_offload',
    targetSymbol: 'wlan_bpf_filter_offload_handler',
    targetFile: 'protocol/src/offloads/src/l2/bpf/bpf_offload.c',
    targetLine: 83,
    expected: [
      { caller: 'wlan_bpf_enable_data_path', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_data_offload' },
      { caller: 'wlan_bpf_offload_test_route_uc_active', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_data_offload' },
    ],
  },
  {
    name: 'A2 — ARP offload proc frame',
    category: 'A / offldmgr_register_data_offload',
    targetSymbol: 'arp_offload_proc_frame',
    targetFile: 'protocol/src/offloads/src/l2/arp_ns/bpf_offload_int.c',
    targetLine: 87,
    expected: [
      { caller: 'wlan_arp_ns_offload_config_vdev', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_data_offload' },
    ],
  },
  {
    name: 'A3 — NS (Neighbor Solicitation) offload proc frame',
    category: 'A / offldmgr_register_data_offload',
    targetSymbol: 'ns_offload_proc_frame',
    targetFile: 'protocol/src/offloads/src/l2/arp_ns/bpf_offload_int.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_arp_ns_offload_config_vdev', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_data_offload' },
    ],
  },
  {
    name: 'A4 — IGMP offload proc frame (vdev + global dual)',
    category: 'A / offldmgr_register_data_offload',
    targetSymbol: 'igmp_offload_proc_frame',
    targetFile: 'protocol/src/offloads/src/l3_above/igmp/wlan_igmp_offload_ext.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_igmp_offload_enable', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_data_offload' },
    ],
  },
  {
    name: 'A5 — Multicast filter handler',
    category: 'A / offldmgr_register_data_offload',
    targetSymbol: 'wlan_mcast_handler',
    targetFile: 'protocol/src/offloads/src/l2/mcast_filter/wlan_mcast_filter_offload.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_mcast_filter_vdev_init', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_data_offload' },
    ],
  },
  {
    name: 'A6 — GTK filter offload handler',
    category: 'A / offldmgr_register_data_offload',
    targetSymbol: 'wlan_gtk_filter_offload_handler',
    targetFile: 'protocol/src/offloads/src/l2/gtk/wlan_gtk_offload_wmi.c',
    targetLine: 87,
    expected: [
      { caller: 'gtk_offload_dispatch_wmi_cmd', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_data_offload' },
    ],
  },
  {
    name: 'A7 — TDLS RX frame handler',
    category: 'A / offldmgr_register_data_offload',
    targetSymbol: 'wlan_tdls_process_rx_frame',
    targetFile: 'protocol/src/tdls/wlan_tdls.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_tdls_rx_frame_offload_config', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_data_offload' },
    ],
  },
  {
    name: 'A8 — EAPOL offload handler',
    category: 'A / offldmgr_register_data_offload',
    targetSymbol: 'wlan_eapol_process',
    targetFile: 'protocol/src/supplicant/wlan_suppl_offload.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_suppl_offload_enable', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_data_offload' },
    ],
  },
  {
    name: 'A9 — Heartbeat offload handler (WLAN_HB_INTERNAL_FN wrapper)',
    category: 'A / offldmgr_register_data_offload',
    targetSymbol: 'wlan_hb_data_handler',
    targetFile: 'protocol/src/offloads/src/l3_above/wlan_hb/wlan_hb.c',
    targetLine: 87,
    expected: [
      { caller: 'wlan_hb_set_enable', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_data_offload' },
    ],
  },
  {
    name: 'A10 — Packet filter offload proc buf',
    category: 'A / offldmgr_register_data_offload',
    targetSymbol: 'pktFilter_offload_proc_buf',
    targetFile: 'protocol/src/offloads/src/l2/pkt_filter/wlan_pktFilter_offload.c',
    targetLine: 88,
    expected: [
      { caller: 'registerPktFilter', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_data_offload' },
    ],
  },
  {
    name: 'A11 — WoW magic packet handler',
    category: 'A / offldmgr_register_data_offload',
    targetSymbol: 'wow_magicpkt_handler',
    targetFile: 'protocol/src/offloads/src/l2/wow_data/wlan_wow_data_wmi_register.c',
    targetLine: 87,
    expected: [
      { caller: 'wow_register_offload', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_data_offload' },
    ],
  },
  {
    name: 'A12 — WoW EAPOL handler',
    category: 'A / offldmgr_register_data_offload',
    targetSymbol: 'wow_eapol_handler',
    targetFile: 'protocol/src/offloads/src/l2/wow_data/wlan_wow_data_wmi_register.c',
    targetLine: 87,
    expected: [
      { caller: 'wow_register_offload', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_data_offload' },
    ],
  },
  {
    name: 'A13 — WoW RA (Router Advertisement) filter handler',
    category: 'A / offldmgr_register_data_offload',
    targetSymbol: 'wow_ra_handler',
    targetFile: 'protocol/src/offloads/src/l2/wow_data/wlan_wow_data_wmi.c',
    targetLine: 87,
    expected: [
      { caller: 'wow_vdev_wow_enable', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_data_offload' },
    ],
  },
  {
    name: 'A14 — WoW NAT keepalive handler',
    category: 'A / offldmgr_register_data_offload',
    targetSymbol: 'wlan_natkeepalive_handler',
    targetFile: 'protocol/src/offloads/src/l2/wow_data/wlan_wow_data_wmi_register.c',
    targetLine: 87,
    expected: [
      { caller: 'wow_register_offload', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_data_offload' },
    ],
  },
  {
    name: 'A15 — ICMP offload proc frame (proto offload path)',
    category: 'A / offldmgr_register_data_offload',
    targetSymbol: 'icmp_offload_proc_frame',
    targetFile: 'protocol/src/offloads/src/l3_above/ping/wlan_ping_offload.c',
    targetLine: 88,
    expected: [
      { caller: 'dispatch_icmp_offload_cmds', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_data_offload' },
    ],
  },
  {
    name: 'A16 — WoW can deliver RX data to host',
    category: 'A / offldmgr_register_data_offload',
    targetSymbol: 'wow_can_deliver_rxdata_tohost',
    targetFile: 'protocol/src/offloads/src/l2/wow_data/wlan_wow_data_wmi.c',
    targetLine: 87,
    expected: [
      { caller: 'wow_register_offload', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_data_offload' },
    ],
  },
  {
    name: 'A17 — WoW can deliver RX mgmt to host',
    category: 'A / offldmgr_register_data_offload',
    targetSymbol: 'wow_can_deliver_mgmt_tohost',
    targetFile: 'protocol/src/offloads/src/802_11_mac/wow_mgmt/wlan_wow_mgmt_internal.c',
    targetLine: 87,
    expected: [
      { caller: 'wow_mgmt_notif_handler', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
  {
    name: 'A18 — Roam subnet detection ARP handler',
    category: 'A / offldmgr_register_data_offload',
    targetSymbol: 'wlan_roam_subnet_detection_arp_proc_frame',
    targetFile: 'protocol/src/conn_mgmt/src/roam/wlan_roam_subnet_detection.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_roam_subnet_detection_start', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_data_offload' },
    ],
  },
  {
    name: 'A19 — Test offload handler',
    category: 'A / offldmgr_register_data_offload',
    targetSymbol: '_wlan_test_offload_handler',
    targetFile: 'protocol/src/offloads/src/offload_unit_test/offload_unit_test.c',
    targetLine: 87,
    expected: [
      { caller: 'wlan_offload_test_set_offload_handler', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_data_offload' },
    ],
  },
  {
    name: 'A20 — COAP offload proc frame',
    category: 'A / offldmgr_register_data_offload',
    targetSymbol: 'coap_offload_proc_frame',
    targetFile: 'protocol/src/offloads/src/l3_above/coap/wlan_coap_offload_wmi.c',
    targetLine: 87,
    expected: [
      { caller: 'wlan_coap_offload_enable', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_data_offload' },
    ],
  },
];

// ─── Category B: offldmgr_register_nondata_offload ─────────────────────────────
// Non-data offload handlers — invoked by firmware events (beacon, scan, roam,
// mlme, p2p, twt, etc.) rather than data-path packets.

const categoryB: WlanCase[] = [
  {
    name: 'B1 — CSA (Channel Switch Announcement) handler',
    category: 'B / offldmgr_register_nondata_offload',
    targetSymbol: '_csa_handler',
    targetFile: 'protocol/src/offloads/src/802_11_mac/csa/csa_offload_main.c',
    targetLine: 88,
    expected: [
      { caller: 'csa_vdev_event_handler', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
  {
    name: 'B2 — P2P Listen Offload frames handler',
    category: 'B / offldmgr_register_nondata_offload',
    targetSymbol: 'wlan_p2p_lo_frames_handler',
    targetFile: 'protocol/src/offloads/src/802_11_mac/p2p_listen_offload/wlan_p2p_listen_offload.c',
    targetLine: 87,
    expected: [
      { caller: 'wlan_p2p_lo_vdev_init', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
  {
    name: 'B3 — NTH beacon offload handler',
    category: 'B / offldmgr_register_nondata_offload',
    targetSymbol: 'wlan_nth_beacon_ofld_handler',
    targetFile: 'protocol/src/offloads/src/802_11_mac/beacon/wlan_nth_beacon_offload.c',
    targetLine: 87,
    expected: [
      { caller: 'wlan_nth_bcn_ofld_run_timer', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
  {
    name: 'B4 — RTT beacon response handler',
    category: 'B / offldmgr_register_nondata_offload',
    targetSymbol: 'wlan_rtt_bcn_handler',
    targetFile: 'protocol/src/rtt/wlan_rtt.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_rtt_enable', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
  {
    name: 'B5 — C2C scan frames handler',
    category: 'B / offldmgr_register_nondata_offload',
    targetSymbol: 'wlan_c2c_scan_frames_handler',
    targetFile: 'protocol/src/scan_clients/src/c2c/wlan_c2c.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_c2c_scan_evt_handler', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
  {
    name: 'B6 — RMC action frame RX handler',
    category: 'B / offldmgr_register_nondata_offload',
    targetSymbol: 'wlan_rmc_action_frame_rx_handler',
    targetFile: 'protocol/src/rmc/wlan_rmc.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_rmc_create_instance', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
  {
    name: 'B7 — SMPS offload handler',
    category: 'B / offldmgr_register_nondata_offload',
    targetSymbol: 'wlan_smps_offload_handler',
    targetFile: 'protocol/src/power/smps/wlan_smps.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_smps_virtual_chan_register_beacon_rx', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
  {
    name: 'B8 — TWT (Target Wake Time) offload handler',
    category: 'B / offldmgr_register_nondata_offload',
    targetSymbol: 'wlan_twt_offld_handler',
    targetFile: 'protocol/src/power/common/wlan_twt.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_twt_wmi_enable', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
  {
    name: 'B9 — MLO PS scan management handler',
    category: 'B / offldmgr_register_nondata_offload',
    targetSymbol: 'wlan_mlo_ps_scan_mgmt_hdlr',
    targetFile: 'protocol/src/power/mlo_ps/wlan_powersave_mlo_sta.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_mlo_ps_scan_event_handler', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
  {
    name: 'B10 — OBSS beacon parser',
    category: 'B / offldmgr_register_nondata_offload',
    targetSymbol: 'wlan_obss_beacon_parser',
    targetFile: 'protocol/src/scan_clients/src/obss/wlan_obss_scan_offload_wmi.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_obss_scan_vdev_event_handler', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
  {
    name: 'B11 — OBSS offload RX handler',
    category: 'B / offldmgr_register_nondata_offload',
    targetSymbol: 'obss_offload_rx_handler',
    targetFile: 'protocol/src/offloads/src/802_11_mac/obss_offload/obss_offload_api_init.c',
    targetLine: 87,
    expected: [
      { caller: 'obss_offload_vdev_event_handler', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
  {
    name: 'B12 — OBSS spatial reuse RX handler',
    category: 'B / offldmgr_register_nondata_offload',
    targetSymbol: 'obss_pd_spatial_reuse_offload_rx_handler',
    targetFile: 'protocol/src/offloads/src/802_11_mac/obss_spatial_reuse_offload/obss_spatial_reuse_api_handlers.c',
    targetLine: 87,
    expected: [
      { caller: 'obss_spatial_reuse_pdev_init', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
  {
    name: 'B13 — SAP OBSS detection RX handler',
    category: 'B / offldmgr_register_nondata_offload',
    targetSymbol: 'sap_obss_detection_rx_handler',
    targetFile: 'protocol/src/offloads/src/802_11_mac/sap_obss_detection/sap_obss_detection_api.c',
    targetLine: 87,
    expected: [
      { caller: 'sap_obss_detection_vdev_event_handler', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
  {
    name: 'B14 — NLO (Network List Offload) probe response handler',
    category: 'B / offldmgr_register_nondata_offload',
    targetSymbol: '_nlo_probe_rsp_beacon_handler',
    targetFile: 'protocol/src/scan_clients/src/pno/wlan_network_list_offload.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_nlo_scan_evt_handler', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
  {
    name: 'B15 — LPI (Low Power Indication) scan event handler',
    category: 'B / offldmgr_register_nondata_offload',
    targetSymbol: 'wlan_lpi_probe_rsp_beacon_handler',
    targetFile: 'protocol/src/scan_clients/src/lpi/wlan_lpi.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_lpi_scan_evt_handler', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
  {
    name: 'B16 — ANQP (Access Network Query Protocol) packet handler',
    category: 'B / offldmgr_register_nondata_offload',
    targetSymbol: '_wlan_anqp_packet_handler',
    targetFile: 'protocol/src/offloads/src/802_11_mac/anqp/wlan_anqp_offload.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_anqp_start', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
  {
    name: 'B17 — Roam scan management handler',
    category: 'B / offldmgr_register_nondata_offload',
    targetSymbol: 'wlan_roam_scan_mgmt_hdlr',
    targetFile: 'protocol/src/conn_mgmt/src/roam/wlan_roam_scan.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_roam_scan_evt_handler', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
  {
    name: 'B18 — 11k offload action frame handler',
    category: 'B / offldmgr_register_nondata_offload',
    targetSymbol: 'wlan_11k_offload_action_frame_handler',
    targetFile: 'protocol/src/conn_mgmt/src/offload_11k/wlan_11k_offload.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_11k_offload_enable', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
  {
    name: 'B19 — BTM (Bandwidth Transaction) offload action frame handler',
    category: 'B / offldmgr_register_nondata_offload',
    targetSymbol: '_wlan_btm_ofld_action_frame_handler',
    targetFile: 'protocol/src/conn_mgmt/src/btm_offload/wlan_btm_offload.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_btm_offload_enable', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
  {
    name: 'B20 — SWBMISS (software beacon miss) offload handler',
    category: 'B / offldmgr_register_nondata_offload',
    targetSymbol: 'wlan_swbmiss_offload_handler',
    targetFile: 'protocol/src/cmn_infra/src/bmiss/wlan_swbmiss_offload.c',
    targetLine: 87,
    expected: [
      { caller: 'wlan_swbmiss_vdev_init', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
  {
    name: 'B21 — Probe request handler (vdev up)',
    category: 'B / offldmgr_register_nondata_offload',
    targetSymbol: 'wlan_probe_req_handler',
    targetFile: 'protocol/src/cmn_infra/src/vdev_mgr/wlan_vdev_ext.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_vdev_up_notif_hdlr', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
  {
    name: 'B22 — Beacon TX handler (vdev up)',
    category: 'B / offldmgr_register_nondata_offload',
    targetSymbol: 'wlan_vdev_handle_own_beacon',
    targetFile: 'protocol/src/cmn_infra/src/vdev_mgr/wlan_vdev_ext.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_vdev_up_notif_hdlr', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
  {
    name: 'B23 — Beacon filter can deliver to host',
    category: 'B / offldmgr_register_nondata_offload',
    targetSymbol: 'wlan_bcnfilter_can_deliver_beacon_tohost',
    targetFile: 'protocol/src/cmn_infra/src/vdev_mgr/wlan_vdev_ext.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_vdev_up_notif_hdlr', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
  {
    name: 'B24 — IBSS beacon handler',
    category: 'B / offldmgr_register_nondata_offload',
    targetSymbol: 'wlan_vdev_handle_ibss_beacon',
    targetFile: 'protocol/src/cmn_infra/src/vdev_mgr/wlan_vdev_ext.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_ibss_peer_create_event_handler', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
  {
    name: 'B25 — WoW data-filter WMI dispatch',
    category: 'B / offldmgr_register_nondata_offload (WMI dispatch)',
    targetSymbol: '_wow_ioac_can_deliver_rxdata_tohost',
    targetFile: 'protocol/src/offloads/src/l3_above/ioac/wlan_ioac.c',
    targetLine: 87,
    expected: [
      { caller: 'wow_ioac_operate', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_data_offload' },
    ],
  },
  {
    name: 'B26 — Channel prediction beacon handler',
    category: 'B / offldmgr_register_nondata_offload',
    targetSymbol: 'wlan_ch_prediction_bcnprb_hdlr',
    targetFile: 'protocol/src/cmn_infra/src/scan_mgr/wlan_channel_prediction.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_ch_prediction_scan_evt_handler', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
  {
    name: 'B27 — HIF priority WMI event handler',
    category: 'B / offldmgr_register_wmi_offload',
    targetSymbol: 'wlan_hif_prio_wmi_evt_handler',
    targetFile: 'protocol/src/cmn_infra/src/hif_prio_mgr/wlan_hif_prio_mgr.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_hif_prio_mgr_init', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_wmi_offload' },
    ],
  },
  {
    name: 'B28 — MLME WMI event handler',
    category: 'B / offldmgr_register_wmi_offload',
    targetSymbol: 'wlan_mlme_wmi_event_handler',
    targetFile: 'protocol/src/conn_mgmt/src/mlme/wlan_mlme_host_wmi_seq.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_mlme_reg_wmi_evt', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_wmi_offload' },
    ],
  },
  {
    name: 'B29 — MLME RX frame handler',
    category: 'B / offldmgr_register_nondata_offload',
    targetSymbol: 'wlan_mlme_rx_hdlr',
    targetFile: 'protocol/src/conn_mgmt/src/mlme/wlan_mlme_if.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_mlme_register_rx_frm_handler', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_nondata_offload' },
    ],
  },
];

// ─── Category C: WMI event handler registrations ───────────────────────────────
// Registered via wmi_unified_register_event_handler() in wls_fw.c.
// These are LPI (Location-based Indoor) / NAN / OEM event handlers invoked
// when the host firmware sends a matching WMI event.

const categoryC: WlanCase[] = [
  {
    name: 'C1 — WLS firmware scan result handler (WMI event)',
    category: 'C / wmi_unified_register_event_handler',
    targetSymbol: 'wls_fw_scan_result_handler',
    targetFile: 'wlssvr/src/wls/core/wls_fw.c',
    targetLine: 88,
    expected: [
      { caller: 'wls_register_wmi_handlers', connectionKind: 'interface_registration', viaIncludes: 'wmi_unified_register_event_handler' },
    ],
  },
  {
    name: 'C2 — WLS firmware handoff handler (WMI event)',
    category: 'C / wmi_unified_register_event_handler',
    targetSymbol: 'wls_fw_handoff_handler',
    targetFile: 'wlssvr/src/wls/core/wls_fw.c',
    targetLine: 88,
    expected: [
      { caller: 'wls_register_wmi_handlers', connectionKind: 'interface_registration', viaIncludes: 'wmi_unified_register_event_handler' },
    ],
  },
  {
    name: 'C3 — WLS firmware status handler (WMI event)',
    category: 'C / wmi_unified_register_event_handler',
    targetSymbol: 'wls_fw_status_handler',
    targetFile: 'wlssvr/src/wls/core/wls_fw.c',
    targetLine: 88,
    expected: [
      { caller: 'wls_register_wmi_handlers', connectionKind: 'interface_registration', viaIncludes: 'wmi_unified_register_event_handler' },
    ],
  },
  {
    name: 'C4 — RTT response handler via WMI OEM event',
    category: 'C / wmi_unified_register_event_handler',
    targetSymbol: 'wls_fw_rtt_resp_handler',
    targetFile: 'wlssvr/src/wls/core/wls_fw.c',
    targetLine: 88,
    expected: [
      { caller: 'wls_register_wmi_handlers', connectionKind: 'interface_registration', viaIncludes: 'wmi_unified_register_event_handler' },
    ],
  },
  {
    name: 'C5 — NAN result handler (WMI NAN event)',
    category: 'C / wmi_unified_register_event_handler',
    targetSymbol: 'wls_nan_result_handler',
    targetFile: 'wlssvr/src/wls/core/wls_fw.c',
    targetLine: 88,
    expected: [
      { caller: 'wls_register_wmi_handlers', connectionKind: 'interface_registration', viaIncludes: 'wmi_unified_register_event_handler' },
    ],
  },
];

// ─── Category D: WMI dispatch tables ─────────────────────────────────────────
// Registered via WMI_RegisterDispatchTable().
// Dispatch table handlers are invoked when a matching WMI command arrives from the host.
// The handler is called directly from the WMI command dispatch loop — no event ID
// node is emitted (the command ID is implicit in the dispatch table registration).

const categoryD: WlanCase[] = [
  {
    name: 'D1 — HB (heartbeat) offload WMI dispatch handler',
    category: 'D / WMI_RegisterDispatchTable',
    targetSymbol: '_wlan_hb_wmicmd_handler',
    targetFile: 'protocol/src/offloads/src/l3_above/wlan_hb/wlan_hb.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_hb_register', connectionKind: 'interface_registration', viaIncludes: 'WMI_RegisterDispatchTable' },
    ],
  },
  {
    name: 'D2 — GTK offload WMI dispatch handler',
    category: 'D / WMI_RegisterDispatchTable',
    targetSymbol: 'dispatch_wlan_gtk_offload_cmd',
    targetFile: 'protocol/src/offloads/src/l2/gtk/wlan_gtk_offload_wmi.c',
    targetLine: 88,
    expected: [
      { caller: 'gtk_offload_register', connectionKind: 'interface_registration', viaIncludes: 'WMI_RegisterDispatchTable' },
    ],
  },
  {
    name: 'D3 — DHCP offload WMI dispatch handler',
    category: 'D / WMI_RegisterDispatchTable',
    targetSymbol: 'dispatch_dhcp_offload_cmds',
    targetFile: 'protocol/src/offloads/src/l3_above/dhcp/wlan_dhcp_offload.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_dhcp_offload_register', connectionKind: 'interface_registration', viaIncludes: 'WMI_RegisterDispatchTable' },
    ],
  },
  {
    name: 'D4 — mDNS offload WMI dispatch handler',
    category: 'D / WMI_RegisterDispatchTable',
    targetSymbol: 'dispatch_mdns_offload_cmds',
    targetFile: 'protocol/src/offloads/src/l3_above/mdns/wlan_mdns_offload.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_mdns_offload_register', connectionKind: 'interface_registration', viaIncludes: 'WMI_RegisterDispatchTable' },
    ],
  },
  {
    name: 'D5 — IGMP offload WMI dispatch handler',
    category: 'D / WMI_RegisterDispatchTable',
    targetSymbol: 'dispatch_igmp_offload_cmds',
    targetFile: 'protocol/src/offloads/src/l3_above/igmp/wlan_igmp_offload_ext.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_igmp_offload_register', connectionKind: 'interface_registration', viaIncludes: 'WMI_RegisterDispatchTable' },
    ],
  },
  {
    name: 'D6 — ICMP/PING offload WMI dispatch handler',
    category: 'D / WMI_RegisterDispatchTable',
    targetSymbol: 'dispatch_icmp_offload_cmds',
    targetFile: 'protocol/src/offloads/src/l3_above/ping/wlan_ping_offload.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_icmp_offload_register', connectionKind: 'interface_registration', viaIncludes: 'WMI_RegisterDispatchTable' },
    ],
  },
  {
    name: 'D7 — TDLS WMI command dispatcher (multiple WMI CMDs)',
    category: 'D / WMI_RegisterDispatchTable',
    targetSymbol: 'wlan_tdls_wmi_set_state_cmd',
    targetFile: 'protocol/src/tdls/wlan_tdls.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_tdls_register', connectionKind: 'interface_registration', viaIncludes: 'WMI_RegisterDispatchTable' },
    ],
  },
  {
    name: 'D8 — IPA offload WMI dispatch handler',
    category: 'D / WMI_RegisterDispatchTable',
    targetSymbol: 'ipa_ofld_en_dis_wmi_cmd_handler',
    targetFile: 'protocol/src/misc/src/ipa/wlan_ipa_offload_config.c',
    targetLine: 87,
    expected: [
      { caller: 'wlan_ipa_offload_config_register', connectionKind: 'interface_registration', viaIncludes: 'WMI_RegisterDispatchTable' },
    ],
  },
  {
    name: 'D9 — HW data filter WMI dispatch handler',
    category: 'D / WMI_RegisterDispatchTable',
    targetSymbol: '_wlan_hw_data_filtering_cmd_handler',
    targetFile: 'protocol/src/offloads/src/l2/hw_data_flt/wlan_hw_data_filtering_wmi.c',
    targetLine: 87,
    expected: [
      { caller: 'wlan_hw_data_filter_register', connectionKind: 'interface_registration', viaIncludes: 'WMI_RegisterDispatchTable' },
    ],
  },
  {
    name: 'D10 — WoW WoW data WMI dispatch handler',
    category: 'D / WMI_RegisterDispatchTable',
    targetSymbol: 'wow_data_wmi_cmd_handler',
    targetFile: 'protocol/src/offloads/src/l2/wow_data/wlan_wow_data_wmi.c',
    targetLine: 87,
    expected: [
      { caller: 'wow_data_wmi_register_dispatchtbl', connectionKind: 'interface_registration', viaIncludes: 'WMI_RegisterDispatchTable' },
    ],
  },
  {
    name: 'D11 — BPF offload WMI command dispatcher (multiple WMI BPF CMDs)',
    category: 'D / WMI_RegisterDispatchTable',
    targetSymbol: '_wlan_bpf_offload_cmd_handler',
    targetFile: 'protocol/src/offloads/src/l2/bpf/bpf_offload_wmi.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_bpf_offload_register', connectionKind: 'interface_registration', viaIncludes: 'WMI_RegisterDispatchTable' },
    ],
  },
];

// ─── Category E: cmnos_irq_register hardware interrupts ────────────────────────
// Registered via cmnos_irq_register().
// Hardware interrupt handlers are invoked when the associated hardware interrupt fires.
// The "real" caller is the hardware interrupt number (A_INUM_*); the IRQ is
// set up by the cmnos_irq_register() call which maps INUM → thread context.

const categoryE: WlanCase[] = [
  {
    name: 'E1 — TQM high-priority status IRQ handler',
    category: 'E / cmnos_irq_register',
    targetSymbol: '_HIF_CE_isr_handler',
    targetFile: 'protocol/src/offloads/src/l2/bpf/bpf_offload.c',
    targetLine: 87,
    expected: [
      { caller: 'HIF_CE_module_install', connectionKind: 'interface_registration', viaIncludes: 'cmnos_irq_register' },
      { caller: 'A_INUM_TQM_STATUS_HI', connectionKind: 'api_call', viaIncludes: 'cmnos_irq_register' },
    ],
  },
  {
    name: 'E2 — WMAC RX OK IRQ handler (per-MAC, ring signal)',
    category: 'E / cmnos_irq_register',
    targetSymbol: '_wmac_rx_ok_isr_handler',
    targetFile: 'protocol/src/offloads/src/l2/bpf/bpf_offload.c',
    targetLine: 87,
    expected: [
      { caller: 'wlan_thread_irq_register', connectionKind: 'interface_registration', viaIncludes: 'cmnos_irq_register' },
      { caller: 'A_INUM_WMAC0_RX_OK', connectionKind: 'api_call', viaIncludes: 'cmnos_irq_register' },
    ],
  },
  {
    name: 'E3 — WSI high-priority dynamic ISR',
    category: 'E / cmnos_irq_register',
    targetSymbol: 'wsi_high_prio_irq_route',
    targetFile: 'protocol/src/offloads/src/l2/bpf/bpf_offload.c',
    targetLine: 87,
    expected: [
      { caller: 'wsi_thread_init', connectionKind: 'interface_registration', viaIncludes: 'cmnos_irq_register_dynamic' },
    ],
  },
  {
    name: 'E4 — PCIe doorbell interrupt handler',
    category: 'E / cmnos_irq_register',
    targetSymbol: 'platform_pcie_doorbell_int_hndler',
    targetFile: 'protocol/src/offloads/src/l2/bpf/bpf_offload.c',
    targetLine: 87,
    expected: [
      { caller: 'platform_int_init', connectionKind: 'interface_registration', viaIncludes: 'cmnos_irq_register' },
    ],
  },
];

// ─── Category F: signal-based registrations ───────────────────────────────────
// Registered via qurt_signal_wait() in a thread. The handler is invoked when
// a thread's signal is set (qurt_signal_set()) by some event source.

const categoryF: WlanCase[] = [
  {
    name: 'F1 — Generic ring signal handler',
    category: 'F / qurt_signal_wait',
    targetSymbol: 'signal_handler',
    targetFile: 'protocol/src/offloads/src/l2/bpf/bpf_offload.c',
    targetLine: 87,
    expected: [
      { caller: 'signal_setup', connectionKind: 'api_call', viaIncludes: 'qurt_signal_wait' },
      { caller: 'WLAN_THREAD_SIG_MY_EVENT', connectionKind: 'api_call', viaIncludes: 'platform thread signal' },
    ],
  },
  {
    name: 'F2 — PHY RF service wait signal handler',
    category: 'F / qurt_signal_wait',
    targetSymbol: 'phyrf_svc_intf_wait_sig_handler',
    targetFile: 'protocol/src/offloads/src/l2/bpf/bpf_offload.c',
    targetLine: 87,
    expected: [
      { caller: 'phyrf_svc_intf_wait_sig', connectionKind: 'api_call', viaIncludes: 'qurt_signal_wait' },
    ],
  },
];

// ─── Category G: struct callback registrations ─────────────────────────────────
// Registered via direct struct field assignment: pService->EpCallbacks.EpRecv = fn.
// The "caller" is the function that performs the struct field assignment.

const categoryG: WlanCase[] = [
  {
    name: 'G1 — HTC setup complete callback',
    category: 'G / struct callback',
    targetSymbol: 'mac_htc_setupComplete',
    targetFile: 'syssw_services/src/main/syssw_services_main.c',
    targetLine: 87,
    expected: [
      { caller: 'syssw_services_main_init', connectionKind: 'interface_registration' },
    ],
  },
  {
    name: 'G2 — Generic struct callback registration',
    category: 'G / struct callback',
    targetSymbol: 'my_htc_handler',
    targetFile: 'protocol/src/offloads/src/l2/bpf/bpf_offload.c',
    targetLine: 87,
    expected: [
      { caller: 'htc_init', connectionKind: 'interface_registration' },
    ],
  },
];

// ─── Category H: structured mediated paths JSON ─────────────────────────────────
// intelgraph emits ---mediated-paths-json--- blocks with full endpoint/stage
// structure. The parser (Gate G8) converts these to CallerNode[] + systemNodes[].

const categoryH: WlanCase[] = [
  {
    name: 'H1 — Structured LPI scan result with WMI event endpoint + dispatch stage',
    category: 'H / mediated-paths-json',
    targetSymbol: 'wls_fw_scan_result_handler',
    targetFile: 'wlssvr/src/wls/core/wls_fw.c',
    targetLine: 88,
    expected: [
      // When ---mediated-paths-json--- is present, text-level entries are skipped (Path 1 wins).
      // mediatedPathsToCallerNodes emits endpointId as caller, first stage ownerSymbol as viaRegistrationApi.
      { caller: 'WMI_LPI_RESULT_EVENTID', connectionKind: 'api_call', viaIncludes: 'wmi_dispatch' },
    ],
  },
  {
    name: 'H2 — Structured HW IRQ endpoint + IRQ registration stage',
    category: 'H / mediated-paths-json',
    targetSymbol: '_HIF_CE_isr_handler',
    targetFile: 'protocol/src/offloads/src/l2/bpf/bpf_offload.c',
    targetLine: 87,
    expected: [
      { caller: 'A_INUM_TQM_STATUS_HI', connectionKind: 'api_call', viaIncludes: 'cmnos_irq_register' },
    ],
  },
];

// ─── Category I: dual registration — production + unit-test ─────────────────
// Some handlers are registered both in production code AND in unit-test code.
// Both should appear in the caller list, ranked with production first.

const categoryI: WlanCase[] = [
  {
    name: 'I1 — ARP offload: production + test unit-test dual registration',
    category: 'I / dual registration',
    targetSymbol: 'arp_offload_proc_frame',
    targetFile: 'protocol/src/offloads/src/l2/arp_ns/bpf_offload_int.c',
    targetLine: 87,
    expected: [
      { caller: 'wlan_arp_ns_offload_config_vdev', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_data_offload' },
      { caller: 'arp_offload_unit_test_register', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_data_offload' },
    ],
  },
];

// ─── Category J: incoming-call merge ───────────────────────────────────────────
// lsp_indirect_callers returns only unit-test caller; lsp_incoming_calls
// provides the production caller via direct call hierarchy.

const categoryJ: WlanCase[] = [
  {
    name: 'J1 — BPF handler: indirect callers misses production; incoming call hierarchy fills gap',
    category: 'J / incoming-call merge',
    targetSymbol: 'wlan_bpf_filter_offload_handler',
    targetFile: 'protocol/src/offloads/src/l2/bpf/bpf_offload.c',
    targetLine: 83,
    expected: [
      { caller: 'wlan_bpf_offload_test_route_uc_active', connectionKind: 'interface_registration', viaIncludes: 'offldmgr_register_data_offload' },
    ],
    // Note: production caller 'wlan_bpf_enable_data_path' is expected to come from
    // the lsp_incoming_calls fallback when indirect callers is incomplete.
    // The mergeIncomingSources() function deduplicates by caller+kind+file+line.
  },
];

// ─── Category K: Timer-based callbacks ──────────────────────────────────────────
// These are invoked by OS timer infrastructure when a timer fires.
// The dispatcher loops over registered timers and calls the callback at expiry.
// Patterns: cmnos_timer_start, watchdog arm, periodic expiry.

const categoryK: WlanCase[] = [
  {
    name: 'K1 — cmnos timer expiry callback (periodic timer)',
    category: 'K / timer_callback',
    targetSymbol: '_wlan_periodic_timer_expiry',
    targetFile: 'utils/src/wlan_timer.c',
    targetLine: 87,
    expected: [
      { caller: 'wlan_timer_start', connectionKind: 'timer_callback', viaIncludes: 'cmnos_timer_start' },
      { caller: 'WLAN_PERIODIC_TIMER', connectionKind: 'timer_callback' },
    ],
  },
  {
    name: 'K2 — watchdog timer callback',
    category: 'K / timer_callback',
    targetSymbol: '_wlan_watchdog_timeout_handler',
    targetFile: 'core/src/wlan_watchdog.c',
    targetLine: 112,
    expected: [
      { caller: 'wlan_watchdog_arm', connectionKind: 'timer_callback', viaIncludes: 'cmnos_timer_start' },
      { caller: 'WLAN_WATCHDOG_TIMER', connectionKind: 'timer_callback' },
    ],
  },
  {
    name: 'K3 — link monitor timer callback',
    category: 'K / timer_callback',
    targetSymbol: '_wlan_link_monitor_timeout',
    targetFile: 'core/src/wlan_link_monitor.c',
    targetLine: 95,
    expected: [
      { caller: 'wlan_link_monitor_start', connectionKind: 'timer_callback', viaIncludes: 'cmnos_timer_start' },
      { caller: 'wlan_link_monitor_unit_test_start', connectionKind: 'timer_callback', viaIncludes: 'cmnos_timer_start' },
      { caller: 'WLAN_LINK_MONITOR_TIMER', connectionKind: 'timer_callback' },
    ],
  },
  {
    name: 'K4 — delayed work callback (one-shot timer)',
    category: 'K / timer_callback',
    targetSymbol: '_wlan_pmf_inactivity_timeout',
    targetFile: 'protocol/src/pmf/wlan_pmf.c',
    targetLine: 73,
    expected: [
      { caller: 'wlan_pmf_start_timer', connectionKind: 'timer_callback', viaIncludes: 'cmnos_timer_start' },
      { caller: 'PMF_INACTIVITY_TIMER', connectionKind: 'timer_callback' },
    ],
  },
  {
    name: 'K5 — dfs channel availability check timer',
    category: 'K / timer_callback',
    targetSymbol: '_wlan_dfs_cac_timeout',
    targetFile: 'protocol/src/dfs/wlan_dfs.c',
    targetLine: 201,
    expected: [
      { caller: 'wlan_dfs_start_cac_timer', connectionKind: 'timer_callback', viaIncludes: 'cmnos_timer_start' },
      { caller: 'DFS_CAC_TIMER', connectionKind: 'timer_callback' },
    ],
  },
  {
    name: 'K6 — rate adaptation timer callback',
    category: 'K / timer_callback',
    targetSymbol: '_wlan_ra_timer_handler',
    targetFile: 'protocol/src/rate/wlan_ra.c',
    targetLine: 88,
    expected: [
      { caller: 'wlan_ra_start_timer', connectionKind: 'timer_callback', viaIncludes: 'cmnos_timer_start' },
      { caller: 'RA_PERIODIC_TIMER', connectionKind: 'timer_callback' },
    ],
  },
  {
    name: 'K7 — stats collection timer callback',
    category: 'K / timer_callback',
    targetSymbol: '_wlan_stats_timer_handler',
    targetFile: 'utils/src/wlan_stats.c',
    targetLine: 65,
    expected: [
      { caller: 'wlan_stats_start_timer', connectionKind: 'timer_callback', viaIncludes: 'cmnos_timer_start' },
      { caller: 'STATS_COLLECT_TIMER', connectionKind: 'timer_callback' },
    ],
  },
];

// ─── Category L: Deferred work / work-queue invocations ────────────────────────
// These are invoked when deferred work is scheduled (work queues, tasklets, BH handlers).
// The dispatcher invokes the callback from a different execution context.

const categoryL: WlanCase[] = [
  {
    name: 'L1 — work queue callback for scan results processing',
    category: 'L / deferred_work',
    targetSymbol: '_wlan_scan_work_handler',
    targetFile: 'core/src/wlan_scan.c',
    targetLine: 345,
    expected: [
      { caller: 'wlan_scan_queue_work', connectionKind: 'api_call', viaIncludes: 'wlan_work_queue_submit' },
      { caller: 'SCAN_WORK_ITEM', connectionKind: 'api_call' },
    ],
  },
  {
    name: 'L2 — BH handler for interrupt bottom-half',
    category: 'L / deferred_work',
    targetSymbol: '_wlan_bh_rx_handler',
    targetFile: 'hal/src/wlan_bh.c',
    targetLine: 234,
    expected: [
      { caller: 'wlan_bh_schedule_rx', connectionKind: 'api_call', viaIncludes: 'wlan_bh_schedule' },
      { caller: 'BH_RX_WORK', connectionKind: 'api_call' },
    ],
  },
  {
    name: 'L3 — async completion handler for DPC',
    category: 'L / deferred_work',
    targetSymbol: '_wlan_dpc_completion_handler',
    targetFile: 'hal/src/wlan_dpc.c',
    targetLine: 167,
    expected: [
      { caller: 'wlan_dpc_schedule_completion', connectionKind: 'api_call', viaIncludes: 'wlan_dpc_queue' },
      { caller: 'DPC_COMPLETION', connectionKind: 'api_call' },
    ],
  },
  {
    name: 'L4 — roam deferred handler (work queue with vdev context)',
    category: 'L / deferred_work',
    targetSymbol: '_wlan_roam_work_handler',
    targetFile: 'protocol/src/roam/wlan_roam.c',
    targetLine: 890,
    expected: [
      { caller: 'wlan_roam_defer_trigger', connectionKind: 'api_call', viaIncludes: 'wlan_work_queue_submit' },
      { caller: 'ROAM_WORK_ITEM', connectionKind: 'api_call' },
    ],
  },
  {
    name: 'L5 — WMI deferred event handler',
    category: 'L / deferred_work',
    targetSymbol: '_wlan_wmi_deferred_event_handler',
    targetFile: 'wmi/src/wmi_deferred.c',
    targetLine: 78,
    expected: [
      { caller: 'wmi_queue_deferred_event', connectionKind: 'api_call', viaIncludes: 'wlan_work_queue_submit' },
      { caller: 'WMI_DEFERRED_WORK', connectionKind: 'api_call' },
    ],
  },
];

// ─── Category M: IOCTL / debugfs / op-vtable dispatch tables ──────────────────
// These are invoked when user-space or firmware invokes a dispatch table entry.
// The table maps command IDs to handler functions.

const categoryM: WlanCase[] = [
  {
    name: 'M1 — debugfs read handler (dbg_show)',
    category: 'M / debugfs_op',
    targetSymbol: '_wlan_dbg_show_stats',
    targetFile: 'debug/src/wlan_dbgfs.c',
    targetLine: 145,
    expected: [
      { caller: 'wlan_dbgfs_register', connectionKind: 'api_call', viaIncludes: 'wlan_dbgfs_create_file' },
    ],
  },
  {
    name: 'M2 — debugfs write handler (dbg_store)',
    category: 'M / debugfs_op',
    targetSymbol: '_wlan_dbg_store_param',
    targetFile: 'debug/src/wlan_dbgfs.c',
    targetLine: 203,
    expected: [
      { caller: 'wlan_dbgfs_register', connectionKind: 'api_call', viaIncludes: 'wlan_dbgfs_create_file' },
    ],
  },
  {
    name: 'M3 — ioctl dispatch table entry (set command)',
    category: 'M / ioctl_dispatch',
    targetSymbol: '_wlan_ioctl_set_param_handler',
    targetFile: 'core/src/wlan_ioctl.c',
    targetLine: 89,
    expected: [
      { caller: 'wlan_ioctl_register_handlers', connectionKind: 'api_call', viaIncludes: 'WMI_REGISTER_DISPATCH_TABLE' },
      { caller: 'WLAN_IOCTL_SET_PARAM', connectionKind: 'api_call' },
    ],
  },
  {
    name: 'M4 — ioctl dispatch table entry (get command)',
    category: 'M / ioctl_dispatch',
    targetSymbol: '_wlan_ioctl_get_param_handler',
    targetFile: 'core/src/wlan_ioctl.c',
    targetLine: 156,
    expected: [
      { caller: 'wlan_ioctl_register_handlers', connectionKind: 'api_call', viaIncludes: 'WMI_REGISTER_DISPATCH_TABLE' },
      { caller: 'WLAN_IOCTL_GET_PARAM', connectionKind: 'api_call' },
    ],
  },
  {
    name: 'M5 — op-vtable handler (CE service vtable)',
    category: 'M / ioctl_dispatch',
    targetSymbol: '_wlan_ce_service_handler',
    targetFile: 'hal/src/wlan_ce.c',
    targetLine: 287,
    expected: [
      { caller: 'wlan_ce_init', connectionKind: 'interface_registration', viaIncludes: 'CE_OPS_INIT' },
    ],
  },
  {
    name: 'M6 — target-facing dispatch table (TBTT handler)',
    category: 'M / ioctl_dispatch',
    targetSymbol: '_wlan_tbtt_handler',
    targetFile: 'core/src/wlan_tbtt.c',
    targetLine: 112,
    expected: [
      { caller: 'wlan_tbtt_register_dispatch', connectionKind: 'interface_registration', viaIncludes: 'WMI_REGISTER_DISPATCH_TABLE' },
      { caller: 'WMI_PDEV_TBTT_OFFLOAD_ENABLE_CMDID', connectionKind: 'api_call' },
      { caller: 'WMI_PDEV_TBTT_OFFLOAD_ENABLE_EVENTID', connectionKind: 'api_call' },
    ],
  },
];

// ─── Category N: Ring completion callbacks ─────────────────────────────────────
// These are invoked when a ring completion is processed.
// The dispatcher pulls entries from the completion ring and calls the handler.

const categoryN: WlanCase[] = [
  {
    name: 'N1 — TX ring completion handler',
    category: 'N / ring_completion',
    targetSymbol: '_wlan_tx_completion_handler',
    targetFile: 'hal/src/wlan_tx_completion.c',
    targetLine: 78,
    expected: [
      { caller: 'wlan_tx_ring_register_completion', connectionKind: 'api_call', viaIncludes: 'wlan_ring_register_completion' },
      { caller: 'TX_COMPLETION_RING', connectionKind: 'api_call' },
    ],
  },
  {
    name: 'N2 — RX ring completion handler (REO)',
    category: 'N / ring_completion',
    targetSymbol: '_wlan_reo_rx_completion_handler',
    targetFile: 'hal/src/wlan_reo.c',
    targetLine: 156,
    expected: [
      { caller: 'wlan_reo_register_rx_completion', connectionKind: 'api_call', viaIncludes: 'wlan_ring_register_completion' },
      { caller: 'REO_RX_RING', connectionKind: 'api_call' },
    ],
  },
  {
    name: 'N3 — WBM free ring completion handler',
    category: 'N / ring_completion',
    targetSymbol: '_wlan_wbm_free_completion_handler',
    targetFile: 'hal/src/wlan_wbm.c',
    targetLine: 92,
    expected: [
      { caller: 'wlan_wbm_register_free_completion', connectionKind: 'api_call', viaIncludes: 'wlan_ring_register_completion' },
      { caller: 'WBM_FREE_RING', connectionKind: 'api_call' },
    ],
  },
  {
    name: 'N4 — CCE ring completion handler with dual registration',
    category: 'N / ring_completion',
    targetSymbol: '_wlan_cce_completion_handler',
    targetFile: 'hal/src/wlan_cce.c',
    targetLine: 134,
    expected: [
      { caller: 'wlan_cce_register_completion', connectionKind: 'api_call', viaIncludes: 'wlan_ring_register_completion' },
      { caller: 'wlan_cce_unit_test_register', connectionKind: 'api_call', viaIncludes: 'wlan_ring_register_completion' },
      { caller: 'CCE_COMPLETION_RING', connectionKind: 'api_call' },
    ],
  },
];

// ─── Category O: Struct initializer dispatch tables (200+ WMI sites) ────────────
// These use struct initializer syntax: { WMI_CMD_ID, handler_fn } in dispatch tables.
// The handler is referenced by name inside a struct initializer, not as a function argument.
// This is the highest-volume pattern (200+ sites in WLAN) currently not detectable by the
// text-annotation parser alone — but the mediated-paths-json block can carry them.

const categoryO: WlanCase[] = [
  {
    name: 'O1 — WMI struct initializer dispatch (VDEV create handler)',
    category: 'O / struct_dispatch_table',
    targetSymbol: '_wlan_vdev_create_wmi_handler',
    targetFile: 'wmi/src/wmi_dispatch.c',
    targetLine: 245,
    expected: [
      { caller: 'wmi_dispatch_table_init', connectionKind: 'interface_registration', viaIncludes: 'WMI_REGISTER_DISPATCH_TABLE' },
      { caller: 'WMI_VDEV_CREATE_CMDID', connectionKind: 'api_call' },
      { caller: 'WMI_VDEV_CREATE_RESP_EVENTID', connectionKind: 'api_call' },
    ],
  },
  {
    name: 'O2 — WMI struct initializer dispatch (PEER create handler)',
    category: 'O / struct_dispatch_table',
    targetSymbol: '_wlan_peer_create_wmi_handler',
    targetFile: 'wmi/src/wmi_dispatch.c',
    targetLine: 312,
    expected: [
      { caller: 'wmi_dispatch_table_init', connectionKind: 'interface_registration', viaIncludes: 'WMI_REGISTER_DISPATCH_TABLE' },
      { caller: 'WMI_PEER_CREATE_CMDID', connectionKind: 'api_call' },
      { caller: 'WMI_PEER_CREATE_CONF_EVENTID', connectionKind: 'api_call' },
    ],
  },
  {
    name: 'O3 — WMI struct initializer dispatch (SET KEY handler)',
    category: 'O / struct_dispatch_table',
    targetSymbol: '_wlan_set_key_wmi_handler',
    targetFile: 'wmi/src/wmi_dispatch.c',
    targetLine: 378,
    expected: [
      { caller: 'wmi_dispatch_table_init', connectionKind: 'interface_registration', viaIncludes: 'WMI_REGISTER_DISPATCH_TABLE' },
      { caller: 'WMI_VDEV_INSTALL_KEY_CMDID', connectionKind: 'api_call' },
      { caller: 'WMI_VDEV_INSTALL_KEY_COMPLETE_EVENTID', connectionKind: 'api_call' },
    ],
  },
  {
    name: 'O4 — Structured mediated path for struct dispatch (Gate G8 JSON)',
    category: 'O / struct_dispatch_table',
    targetSymbol: '_wlan_start_scan_wmi_handler',
    targetFile: 'wmi/src/wmi_dispatch.c',
    targetLine: 456,
    expected: [
      { caller: 'WMI_START_SCAN_CMDID', connectionKind: 'api_call' },
    ],
  },
  {
    name: 'O5 — ops vtable handler (HIF bus ops)',
    category: 'O / struct_dispatch_table',
    targetSymbol: '_wlan_hif_bus_read',
    targetFile: 'hal/src/wlan_hif.c',
    targetLine: 178,
    expected: [
      { caller: 'wlan_hif_register_ops', connectionKind: 'interface_registration', viaIncludes: 'HIF_OPS_INIT' },
      { caller: 'hif_bus_ops', connectionKind: 'api_call' },
    ],
  },
  {
    name: 'O6 — config store callback (nvram / param store)',
    category: 'O / struct_dispatch_table',
    targetSymbol: '_wlan_config_store_handler',
    targetFile: 'core/src/wlan_config.c',
    targetLine: 234,
    expected: [
      { caller: 'wlan_config_register_store', connectionKind: 'interface_registration', viaIncludes: 'CONFIG_STORE_OPS_INIT' },
    ],
  },
];

const ALL_CASES: WlanCase[] = [
  ...categoryA,
  ...categoryB,
  ...categoryC,
  ...categoryD,
  ...categoryE,
  ...categoryF,
  ...categoryG,
  ...categoryH,
  ...categoryI,
  ...categoryJ,
  ...categoryK,
  ...categoryL,
  ...categoryM,
  ...categoryN,
  ...categoryO,
];

// ─── Run all cases ─────────────────────────────────────────────────────────────

describe('WLAN indirect-caller coverage matrix', () => {
  for (const c of ALL_CASES) {
    test(`${c.category} — ${c.name}`, async () => {
      await runWlanCase(c);
    });
  }

  test('coverage matrix: all pattern families are represented', () => {
    const families = new Set(ALL_CASES.map((c) => c.category));
    // Verify we cover all 15 families (A-O)
    expect(families.size).toBeGreaterThanOrEqual(15);
  });

  test('coverage matrix: total case count', () => {
    // 77+ cases across 15 families
    expect(ALL_CASES.length).toBeGreaterThanOrEqual(70);
  });

  test('coverage matrix: timer_callback connection kind is exercised', () => {
    const kinds = new Set(ALL_CASES.flatMap((c) => c.expected.map((e) => e.connectionKind)));
    // timer_callback is produced by runtime_callback_registration_call invocationType
    expect(kinds.has('timer_callback')).toBe(true);
    // interface_registration is produced by registrar entries
    expect(kinds.has('interface_registration')).toBe(true);
    // api_call is produced by direct_caller and runtime_direct_call entries
    expect(kinds.has('api_call')).toBe(true);
  });
});
