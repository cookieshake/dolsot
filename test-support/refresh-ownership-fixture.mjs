import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { setTimeout as delay } from 'node:timers/promises';

const mode = process.argv[2];
const server = new Server({ name: 'refresh-ownership-fixture', version: '1' }, {
  capabilities: { tools: { listChanged: true } },
});
let generation = 0;
server.setRequestHandler(ListToolsRequestSchema, async (_request, { signal }) => {
  const current = ++generation;
  if (mode === 'startup-timeout') await delay(5_000, undefined, { signal });
  if (current > 1) {
    if (mode === 'continuous' || current === 2) await server.sendToolListChanged();
    await delay(mode === 'cancel' && current === 2 ? 600 : 80, undefined, { signal });
  }
  return { tools: [{ name: `generation_${current}`, description: 'ownership fixture', inputSchema: { type: 'object' } }] };
});
await server.connect(new StdioServerTransport());
