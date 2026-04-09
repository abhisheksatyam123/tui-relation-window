import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

type RpcRequest = {
  id?: number;
  method?: string;
  params?: any;
};

type MockMcpOptions = {
  onToolCall?: (name: string, args: Record<string, unknown>) => string;
};

type MockMcpHandle = {
  url: string;
  close: () => Promise<void>;
};

export async function startMockMcpServer(options: MockMcpOptions = {}): Promise<MockMcpHandle> {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: { message: 'Method not allowed' } });
      return;
    }

    const request = await readBody(req);
    const rpc = parseJson<RpcRequest>(request);
    if (!rpc) {
      sendJson(res, 400, { error: { message: 'Invalid JSON' } });
      return;
    }

    if (rpc.method === 'initialize') {
      res.setHeader('mcp-session-id', 'mock-session');
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: rpc.id ?? 1,
        result: { protocolVersion: '2024-11-05', serverInfo: { name: 'mock-mcp', version: '0.0.1' } },
      });
      return;
    }

    if (rpc.method === 'tools/call') {
      const name = rpc.params?.name as string;
      const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>;
      const text = options.onToolCall ? options.onToolCall(name, args) : defaultToolCall(name, args);
      // If the custom handler returned an "Unknown tool" response, fall back to defaultToolCall
      // ONLY for infrastructure tools (snapshot, ingest, index status, runtime flow, hover).
      // Data tools (incoming_calls, outgoing_calls, intelligence_query) are NOT auto-fallback
      // so custom mocks can control exactly what data is returned.
      const INFRASTRUCTURE_TOOLS = new Set([
        'intelligence_snapshot', 'intelligence_ingest',
        'lsp_index_status', 'lsp_runtime_flow', 'lsp_hover',
      ]);
      const finalText = (text && !text.startsWith('Unknown tool:'))
        ? text
        : INFRASTRUCTURE_TOOLS.has(name) ? defaultToolCall(name, args) : text;
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: rpc.id ?? 1,
        result: {
          content: [{ type: 'text', text: finalText }],
        },
      });
      return;
    }

    sendJson(res, 404, { jsonrpc: '2.0', id: rpc.id ?? 1, error: { code: -32601, message: 'Method not found' } });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind mock MCP server');
  }

  const url = `http://127.0.0.1:${addr.port}/mcp`;
  return {
    url,
    close: () => closeServer(server),
  };
}

function defaultToolCall(name: string, args: Record<string, unknown>): string {
  if (name === 'lsp_runtime_flow') {
    // Return empty runtime flow so the fallback to intelligence_query is triggered
    return JSON.stringify({ targetApi: '', runtimeFlows: [] });
  }

  if (name === 'get_callers') {
    // Return a well-formed GetCallersResponse so parseGetCallersResponse succeeds.
    // The mock always returns alpha_caller as a direct caller of resolve_check,
    // and setup_handlers as a registrar via register_check_handler.
    return JSON.stringify({
      targetApi: 'resolve_check',
      targetFile: '/src/check.c',
      targetLine: 1,
      callers: [
        {
          name: 'alpha_caller',
          filePath: 'src/alpha.c',
          lineNumber: 11,
          callerRole: 'direct_caller',
          invocationType: 'direct_call',
          confidence: 1.0,
          source: 'lsp_incoming_calls',
        },
      ],
      registrars: [
        {
          name: 'setup_handlers',
          filePath: 'src/registrar.c',
          lineNumber: 3,
          callerRole: 'registrar',
          invocationType: 'interface_registration',
          confidence: 0.9,
          viaRegistrationApi: 'register_check_handler',
          source: 'lsp_indirect_callers',
        },
      ],
      source: 'lsp_incoming_calls',
      provenance: { stepsAttempted: ['lsp_incoming_calls'], stepUsed: 'lsp_incoming_calls' },
    });
  }

  if (name === 'lsp_hover') {
    const ch = Number(args.character);
    if (ch <= 2) {
      return 'No hover information available.';
    }
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

  if (name === 'lsp_incoming_calls') {
    return [
      'Incoming calls:',
      '  <- [Function] alpha_caller  at src/alpha.c:11:2',
      '  <- [Function] beta_caller  at src/beta.c:22:3',
    ].join('\n');
  }

  if (name === 'lsp_references') {
    return [
      'References:',
      '  - at src/registrar.c:4:32',
      '  - at src/thread_worker.c:3:10',
    ].join('\n');
  }

  if (name === 'lsp_outgoing_calls') {
    return [
      'Outgoing calls:',
      '  -> [Function] x_callee  at src/x.c:31:7',
      '  -> [Function] y_callee  at src/y.c:44:1',
    ].join('\n');
  }

  if (name === 'intelligence_snapshot') {
    const action = String(args.action || '');
    if (action === 'check') {
      return 'snapshotId: 1\nstatus: ready';
    }
    if (action === 'begin') {
      return 'snapshotId: 1\nstatus: building\ncreatedAt: 2026-03-28T00:00:00Z';
    }
    if (action === 'commit') {
      return 'snapshotId: 1\nstatus: ready\ncommitted';
    }
    return 'snapshotId: 1\nstatus: ready';
  }

  if (name === 'intelligence_ingest') {
    return [
      'Snapshot started: id=1',
      'Extracted: symbols=2 types=1 edges=2',
      'Persisted: symbols=2 types=1 edges=2',
      'Snapshot committed: id=1 status=ready',
    ].join('\n');
  }

  if (name === 'intelligence_query') {
    const intent = String(args.intent || '');

    // Helper: wrap a flat payload in LegacyFlatResponse envelope
    // (matches what the real intelgraph backend now emits)
    const legacyWrap = (status: string, nodes: unknown[], edges: unknown[]) =>
      JSON.stringify({
        status,
        data: { nodes, edges },
        provenance: { trace_id: `${intent}:1`, intent },
        // nodeProtocol stub — real backend embeds the full NodeProtocolResponse here
        nodeProtocol: {
          protocol_version: '1.1',
          schema_capabilities: ['node-centric', 'relation-taxonomy-v1'],
          trace_id: `${intent}:1`,
          intent,
          status,
          data: { items: [] },
          meta: { snapshot_id: 1, workspace_root: 'unknown', total_estimate: nodes.length, cursor: null, sort: 'confidence_desc_name_asc' },
          errors: [],
        },
      });

    if (intent === 'who_calls_api_at_runtime') {
      // Runtime callers: nodes are the CALLER nodes (not the target).
      // runtime_caller_api_name must be the caller's name; also emit invocation type.
      return legacyWrap('hit', [
        {
          id: 'fn:resolve_check', kind: 'api', symbol: 'resolve_check',
          filePath: '/src/check.c', lineNumber: 1,
        },
        {
          id: 'fn:isr_handler', kind: 'interrupt', symbol: 'isr_handler',
          filePath: 'src/irq.c', lineNumber: 5,
          runtime_caller_api_name: 'isr_handler',
          runtime_caller_invocation_type_classification: 'runtime_direct_call',
        },
        {
          id: 'fn:timer_cb', kind: 'timer', symbol: 'timer_cb',
          filePath: 'src/timer.c', lineNumber: 20,
          runtime_caller_api_name: 'timer_cb',
          runtime_caller_invocation_type_classification: 'runtime_callback_registration_call',
        },
      ], [
        { from: 'fn:isr_handler',  to: 'fn:resolve_check', kind: 'indirect_calls', confidence: 0.9 },
        { from: 'fn:timer_cb',     to: 'fn:resolve_check', kind: 'indirect_calls', confidence: 0.8 },
      ]);
    }
    if (intent === 'who_calls_api') {
      return legacyWrap('hit', [
        { id: 'fn:resolve_check', kind: 'api', symbol: 'resolve_check', filePath: '/src/check.c', lineNumber: 1 },
        { id: 'fn:alpha_caller', kind: 'api', symbol: 'alpha_caller', filePath: 'src/alpha.c', lineNumber: 11 },
        { id: 'fn:setup_handlers', kind: 'api', symbol: 'setup_handlers', filePath: 'src/registrar.c', lineNumber: 3 },
      ], [
        { from: 'fn:alpha_caller', to: 'fn:resolve_check', kind: 'calls' },
        { from: 'fn:setup_handlers', to: 'fn:resolve_check', kind: 'registers_callback', viaRegistrationApi: 'register_check_handler' },
      ]);
    }
    if (intent === 'what_api_calls' || intent === 'what_does_api_call') {
      return legacyWrap('hit', [
        { id: 'fn:resolve_check', kind: 'api', symbol: 'resolve_check', filePath: '/src/check.c', lineNumber: 1 },
        { id: 'fn:x_callee', kind: 'api', symbol: 'x_callee', filePath: 'src/x.c', lineNumber: 31 },
        { id: 'fn:y_callee', kind: 'api', symbol: 'y_callee', filePath: 'src/y.c', lineNumber: 44 },
      ], [
        { from: 'fn:resolve_check', to: 'fn:x_callee', kind: 'calls' },
        { from: 'fn:resolve_check', to: 'fn:y_callee', kind: 'calls' },
      ]);
    }
    if (intent === 'find_api_logs' || intent === 'find_api_logs_by_level') {
      return legacyWrap('hit', [
        {
          id: 'log:resolve_check:42', kind: 'log_point',
          symbol: 'resolve_check log:42',
          filePath: '/src/check.c', lineNumber: 42,
          file_path: '/src/check.c', line: 42,
          api_name: 'resolve_check',
          template: 'check failed: %d', level: 'ERROR', subsystem: 'WLAN_BPF',
          confidence: 0.95,
        },
        {
          id: 'log:resolve_check:57', kind: 'log_point',
          symbol: 'resolve_check log:57',
          filePath: '/src/check.c', lineNumber: 57,
          file_path: '/src/check.c', line: 57,
          api_name: 'resolve_check',
          template: 'check passed', level: 'DEBUG', subsystem: 'WLAN_BPF',
          confidence: 0.9,
        },
      ], []);
    }
    if (intent === 'find_struct_writers' || intent === 'find_api_struct_writes') {
      return legacyWrap('hit', [
        {
          id: 'fn:update_stats', kind: 'api',
          symbol: 'update_stats', filePath: '/src/stats.c', lineNumber: 88,
          writer: 'update_stats', target: 'wlan_stats_t',
          edge_kind: 'writes_field', derivation: 'runtime', confidence: 0.9,
          current_structure_runtime_writer_api_name: 'update_stats',
          current_structure_runtime_target_structure_name: 'wlan_stats_t',
          current_structure_runtime_structure_operation_type_classification: 'writes_field',
          current_structure_runtime_relation_derivation_source: 'runtime',
          current_api_runtime_structure_access_path_expression: 'stats->rx_count',
        },
      ], [
        { from: 'fn:update_stats', to: 'struct:wlan_stats_t', kind: 'writes_field', confidence: 0.9 },
      ]);
    }
    return legacyWrap('not_found', [], []);
  }

  return `Unknown tool: ${name}`;
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => resolve(body));
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
