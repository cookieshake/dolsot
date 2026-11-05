import { existsSync, writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';

const marker = process.argv[2];
if (!existsSync(marker)) {
  writeFileSync(marker, 'first connection failed');
  process.exit(7);
}

const server = new McpServer({ name: 'retry-fixture', version: '1.0.0' });
server.registerTool('recovered', {
  description: 'A tool available after reconnect.',
  inputSchema: { value: z.string() },
}, async ({ value }) => ({
  content: [{ type: 'text', text: value }],
  structuredContent: { value },
}));
await server.connect(new StdioServerTransport());
