import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';

const marker = process.argv[2];
const attempt = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) + 1 : 1;
writeFileSync(marker, String(attempt));
if (attempt === 2) process.exit(7);

const server = new McpServer({ name: 'reconnect-fixture', version: '1.0.0' });
if (attempt === 1) {
  server.registerTool('stop', { description: 'Stop the first server process.', inputSchema: {} }, async () => {
    setTimeout(() => process.exit(7), 25);
    return { content: [{ type: 'text', text: 'stopping' }] };
  });
} else {
  server.registerTool('recovered', { description: 'Available after a successful retry.', inputSchema: { value: z.string() } }, async ({ value }) => ({
    content: [{ type: 'text', text: value }],
    structuredContent: { value },
  }));
}
await server.connect(new StdioServerTransport());
