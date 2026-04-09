#!/usr/bin/env bun

/**
 * End-to-end verification of runtime-only incoming caller contract.
 * 
 * Test strategy:
 * 1. Clear the indirect-caller cache
 * 2. Query wlan_bpf_filter_offload_handler (known registration-dispatch pattern)
 * 3. Verify result contains ONLY runtime callers (e.g., _offldmgr_enhanced_data_handler)
 * 4. Verify result does NOT contain registration nodes (e.g., wlan_bpf_enable_data_path)
 * 
 * Expected behavior (runtime-only contract):
 * - Backend should return runtime invokers from lsp_runtime_flow
 * - Registration wiring should be filtered out
 * - Frontend should transparently pass through backend results
 * 
 * CURRENT STATUS (2026-03-29):
 * This test FAILS because the intelgraph backend is not yet returning runtime callers.
 * The frontend implementation is correct (filters interface_registration nodes),
 * but the backend is not providing that information:
 * 
 * 1. lsp_runtime_flow is not returning runtime flows (reason engine not working)
 * 2. lsp_incoming_calls fallback does not tag registration callers with [reg-call]
 * 3. Therefore, all callers appear as api_call and cannot be filtered
 * 
 * This is a BACKEND ISSUE that needs to be fixed in intelgraph, not in tui-relation-window.
 * 
 * TODO: Once intelgraph backend is fixed, this test should pass.
 */

declare const Bun: any;

import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

type RelationPayload = {
  mode?: 'incoming' | 'outgoing';
  provider?: string;
  result?: Record<string, { calledBy?: Array<{ caller?: string; connectionKind?: string }> }>;
};

const WORKSPACE_ROOT =
  process.env.RW_WORKSPACE_ROOT ||
  '/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1';

const CACHE_DIR = '/local/mnt/workspace/qprojects/tui-relation-window/.intelgraph-indirect-caller-cache';

// Test target: wlan_bpf_filter_offload_handler
// This is a registration-dispatch pattern where:
// - Registration: wlan_bpf_enable_data_path registers the handler
// - Runtime: _offldmgr_enhanced_data_handler invokes it
const TARGET = {
  label: 'wlan_bpf_filter_offload_handler',
  file: `${WORKSPACE_ROOT}/wlan_proc/wlan/protocol/src/offloads/src/l2/bpf/bpf_offload.c`,
  line: 83,
  character: 6,
  expectedRuntimeCallers: ['offldmgr_enhanced_data_handler'], // canonicalized (underscore removed)
  forbiddenRegistrationCallers: ['wlan_bpf_enable_data_path', 'wlan_bpf_offload_test_route_uc_active'],
};

async function main() {
  console.log('=== E2E Runtime-Only Incoming Caller Verification ===\n');
  console.log(`Target: ${TARGET.label}`);
  console.log(`Workspace: ${WORKSPACE_ROOT}`);
  console.log(`Cache dir: ${CACHE_DIR}\n`);

  // Step 1: Clear cache
  console.log('[1/3] Clearing indirect-caller cache...');
  if (existsSync(CACHE_DIR)) {
    rmSync(CACHE_DIR, { recursive: true, force: true });
    console.log('  ✓ Cache cleared\n');
  } else {
    console.log('  ℹ Cache directory does not exist (already clean)\n');
  }

  // Step 2: Query incoming callers
  console.log('[2/3] Querying incoming callers (fresh, no cache)...');
  const payload = await queryIncoming();
  console.log(`  ✓ Backend returned ${payload.provider} results\n`);

  // Step 3: Verify runtime-only contract
  console.log('[3/3] Verifying runtime-only contract...');
  const rootName = Object.keys(payload.result || {})[0];
  const calledBy = payload.result?.[rootName]?.calledBy || [];
  const callerNames = calledBy.map((x) => x.caller || '').filter(Boolean);

  console.log(`  Root: ${rootName}`);
  console.log(`  Callers found: ${callerNames.length}`);
  console.log(`  Caller list: [${callerNames.join(', ')}]\n`);

  // Verify expected runtime callers are present
  const missingRuntimeCallers = TARGET.expectedRuntimeCallers.filter(
    (expected) => !callerNames.includes(expected)
  );

  // Verify forbidden registration callers are absent
  const foundRegistrationCallers = TARGET.forbiddenRegistrationCallers.filter(
    (forbidden) => callerNames.includes(forbidden)
  );

  // Report results
  let passed = true;

  if (missingRuntimeCallers.length > 0) {
    console.log(`  ✗ FAIL: Missing expected runtime callers: [${missingRuntimeCallers.join(', ')}]`);
    passed = false;
  } else {
    console.log(`  ✓ PASS: All expected runtime callers present`);
  }

  if (foundRegistrationCallers.length > 0) {
    console.log(`  ✗ FAIL: Found forbidden registration callers: [${foundRegistrationCallers.join(', ')}]`);
    console.log(`         Runtime-only contract violated!`);
    passed = false;
  } else {
    console.log(`  ✓ PASS: No registration callers found (runtime-only contract upheld)`);
  }

  // Verify connectionKind values
  const connectionKinds = calledBy.map((x) => x.connectionKind || '').filter(Boolean);
  const hasRegistrationKind = connectionKinds.some(
    (kind) => kind === 'interface_registration' || kind === 'callback_registration'
  );

  if (hasRegistrationKind) {
    console.log(`  ✗ FAIL: Found registration connectionKind values: [${connectionKinds.join(', ')}]`);
    passed = false;
  } else {
    console.log(`  ✓ PASS: No registration connectionKind values found`);
  }

  console.log('\n=== Summary ===');
  if (passed) {
    console.log('✓ All checks passed: Runtime-only contract verified');
    process.exit(0);
  } else {
    console.log('✗ Some checks failed: Runtime-only contract violated');
    process.exit(1);
  }
}

async function queryIncoming(): Promise<RelationPayload> {
  const args = [
    '--mode',
    'incoming',
    '--file',
    TARGET.file,
    '--line',
    String(TARGET.line),
    '--character',
    String(TARGET.character),
    '--workspace-root',
    WORKSPACE_ROOT,
  ];

  // Use the running intelgraph server for WLAN workspace (port 44077)
  const env = {
    ...process.env,
    INTELGRAPH_URL: 'http://127.0.0.1:44077/mcp',
  };

  const proc = Bun.spawn({
    cmd: [process.execPath, 'src/backend.ts', ...args],
    cwd: '/local/mnt/workspace/qprojects/tui-relation-window',
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Backend failed (exit ${code}): ${stderr.trim() || stdout.trim()}`);
  }

  try {
    return JSON.parse(stdout.trim()) as RelationPayload;
  } catch (err) {
    throw new Error(`Invalid JSON from backend: ${err instanceof Error ? err.message : String(err)}`);
  }
}

main().catch((err) => {
  console.error(`\n✗ FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
