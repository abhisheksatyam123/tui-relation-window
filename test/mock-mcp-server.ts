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
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: rpc.id ?? 1,
        result: {
          content: [{ type: 'text', text }],
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
