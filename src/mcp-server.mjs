import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod/v4';

function createServer(runtime) {
  const server = new McpServer({ name: 'dolsot', version: '1.0.0-alpha.2' }, {
    capabilities: {},
    instructions: 'Run JavaScript with dolsot_run. Start with help() inside a cell to discover usage and available toolboxes, then <toolbox>.help() for method details. Reuse session to continue state; use dolsot_sessions to list and dolsot_reset to reset sessions.',
  });
  server.registerTool('dolsot_run', {
    description: 'Run JavaScript in a named persistent session. Start with help() for usage and available toolboxes.',
    inputSchema: {
      session: z.string().describe('Session name; reuse it to continue JavaScript state.'),
      code: z.string().describe('JavaScript cell. Await asynchronous toolbox calls; print() or console.log() outputs text, and the trailing expression returns a value.'),
      timeout: z.number().int().min(1).max(1200).optional().describe('Seconds, 1–1200; defaults to the host timeout (20 seconds unless configured). For 10 seconds, pass 10.'),
    },
  }, async ({ session, code, timeout }) => {
    const result = await runtime.run(session, code, timeout === undefined ? {} : { timeoutMs: timeout * 1000 });
    return {
      content: [{ type: 'text', text: result.text }],
      structuredContent: result,
      isError: !result.ok,
    };
  });
  server.registerTool('dolsot_sessions', {
    description: 'List sessions in the current local host store.',
    inputSchema: {},
  }, async () => {
    const result = { sessions: await runtime.sessions() };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  });
  server.registerTool('dolsot_reset', {
    description: 'Reset one session or all sessions in the current local host store.',
    inputSchema: { session: z.string() },
  }, async ({ session }) => {
    const result = { reset: await runtime.reset(session) };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  });
  return server;
}

export async function serveStdio(runtime) {
  const server = createServer(runtime);
  const transport = new StdioServerTransport();
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  transport.onclose = () => resolveClosed();
  await server.connect(transport);
  return {
    closed,
    close: async () => { await server.close(); },
  };
}

export async function serveHttp(runtime, { host = '127.0.0.1', port = 3000 } = {}) {
  if (host !== '127.0.0.1') throw new TypeError('HTTP MCP currently binds only to 127.0.0.1');
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new RangeError('port must be 0–65535');
  const httpServer = http.createServer(async (req, res) => {
    const address = httpServer.address();
    const expectedHost = `127.0.0.1:${address.port}`;
    const allowedOriginHosts = new Set([expectedHost, `localhost:${address.port}`]);
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      res.writeHead(405).end();
      return;
    }
    if (req.headers.host !== expectedHost && req.headers.host !== `localhost:${address.port}`) {
      res.writeHead(403).end();
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let originHost;
      try { originHost = new URL(origin).host; } catch { res.writeHead(403).end(); return; }
      if (!allowedOriginHosts.has(originHost)) {
        res.writeHead(403).end();
        return;
      }
    }
    const server = createServer(runtime);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      const body = await readJsonBody(req, 1024 * 1024);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      process.stderr.write(`MCP HTTP request failed: ${error.message}\n`);
      if (!res.headersSent) res.writeHead(error instanceof RangeError ? 413 : error instanceof TypeError ? 400 : 500).end();
    } finally {
      await server.close().catch(() => {});
    }
  });
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });
  const address = httpServer.address();
  return {
    url: `http://${host}:${address.port}/mcp`,
    close: async () => {
      await new Promise(resolve => httpServer.close(resolve));
    },
  };
}

async function readJsonBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new RangeError('MCP request exceeds 1 MiB');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new TypeError('MCP request body must be valid JSON');
  }
}
