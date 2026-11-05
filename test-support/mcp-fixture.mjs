import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';

const server = new McpServer({ name: 'dolsot-test-fixture', version: '1.0.0' }, {
  capabilities: { tools: { listChanged: true } },
});

const addTool = server.registerTool('add', {
  description: 'Add two numbers',
  inputSchema: { a: z.number(), b: z.number() },
}, async ({ a, b }) => ({
  content: [{ type: 'text', text: String(a + b) }],
  structuredContent: { sum: a + b },
}));

let changed = false;
server.registerTool('search_documents', {
  description: 'Search Korean meeting documents and notes',
  inputSchema: { query: z.string() },
}, async ({ query }) => ({
  content: [{ type: 'text', text: query }],
  structuredContent: { query, source: 'fixture' },
}));

server.registerTool('change_catalog', {
  description: 'Change the fixture tool list and notify the client.',
  inputSchema: {},
}, async () => {
  if (!changed) {
    changed = true;
    addTool.remove();
    server.registerTool('get_notes', {
      description: 'Get meeting notes and documents',
      inputSchema: { query: z.string() },
    }, async ({ query }) => ({
      content: [{ type: 'text', text: query }],
      structuredContent: { query, source: 'fixture' },
    }));
    server.server.sendToolListChanged();
  }
  return { content: [{ type: 'text', text: 'changed' }] };
});

server.registerTool('change_without_notification', {
  description: 'Change the fixture list without sending a notification.',
  inputSchema: {},
}, async () => {
  if (!changed) {
    changed = true;
    addTool.remove();
    server.registerTool('get_notes', {
      description: 'Get meeting notes and documents',
      inputSchema: { query: z.string() },
    }, async ({ query }) => ({
      content: [{ type: 'text', text: query }],
      structuredContent: { query, source: 'fixture' },
    }));
  }
  return { content: [{ type: 'text', text: 'changed' }] };
});

await server.connect(new StdioServerTransport());
