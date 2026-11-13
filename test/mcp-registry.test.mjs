import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DolsotRuntime } from '../src/runtime.mjs';
import { EmbeddingSearch, reciprocalRankFusion } from '../src/embedding-search.mjs';
import { McpRegistry, openMcpRegistry } from '../src/mcp-registry.mjs';
import { serveHttp } from '../src/mcp-server.mjs';

const fixture = fileURLToPath(new URL('../test-support/mcp-fixture.mjs', import.meta.url));
const tool = (name, description = '') => ({ name, description, inputSchema: { type: 'object' } });

function registryWithLists(lists) {
  const registry = new McpRegistry(300_000);
  for (const [id, listTools] of Object.entries(lists)) {
    const state = {
      spec: { id }, allowedTools: null, client: { listTools, close: async () => {}, callTool: async () => ({ structuredContent: { ok: true } }) },
      transport: null, tools: new Map(), state: 'ready', retryAttempt: 0, retryTimer: null, reconnectTimer: null,
    };
    registry.servers.set(id, state);
    registry.status.set(id, { serverId: id, state: 'ready', stale: false });
  }
  registry.embeddingSearch = {
    syncCatalog() {},
    async rank() { throw new Error('embedding disabled in BM25 fixture'); },
    clear() {},
  };
  return registry;
}

async function makeRegistry(overrides = {}) {
  const registry = await McpRegistry.open({
    servers: [{ id: 'docs', transport: 'stdio', command: process.execPath, args: [fixture] }],
    ...overrides,
  });
  registry.embeddingSearch = {
    syncCatalog() {},
    async rank() { throw new Error('embedding disabled in BM25 fixture'); },
    clear() {},
  };
  return registry;
}

function embeddingSearch(vectorFor, onEmbed = () => {}) {
  return new EmbeddingSearch({
    modelLoader: async () => async texts => {
      await onEmbed(texts);
      return texts.map(vectorFor);
    },
  });
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('stdio external MCP tools are discovered, BM25-ranked, called, and refreshed on list change', async () => {
  const registry = await makeRegistry();
  try {
    const initial = (await registry.list({ serverId: 'docs' })).tools;
    assert(initial.some(tool => tool.toolName === 'add'));
    const search = await registry.search({ query: 'meeting document', serverId: 'docs' });
    assert.equal(search.tools.length > 0, true);
    assert.equal(search.tools[0].toolName, 'search_documents');

    const add = await registry.call({ serverId: 'docs', toolName: 'add', arguments: { a: 2, b: 3 } });
    assert.deepEqual(add, { sum: 5 });
    await registry.call({ serverId: 'docs', toolName: 'change_catalog', arguments: {} });
    await waitUntil(async () => ((await registry.list({ serverId: 'docs' })).tools).some(tool => tool.toolName === 'get_notes'));
    const cursorPage = await registry.search({ query: 'meeting', serverId: 'docs', limit: 1 });
    const oldRevision = cursorPage.catalogRevision;
    await registry.refresh('docs');
    assert.equal(registry.catalogRevision > oldRevision, true);
    if (cursorPage.nextCursor) {
      await assert.rejects(registry.search({ query: 'meeting', serverId: 'docs', limit: 1, cursor: cursorPage.nextCursor }), /CURSOR_STALE/);
    }
    const revision = (await registry.search({ query: 'documents', serverId: 'docs' })).tools[0].toolRevision;
    await assert.rejects(registry.call({ serverId: 'docs', toolName: 'search_documents', arguments: { query: 'notes' }, expectedToolRevision: 'old' }), /TOOL_CHANGED/);
    assert.equal(typeof revision, 'string');
  } finally {
    await registry.close();
  }
});

test('registry tools run inside persistent QuickJS sessions through the host bridge', async () => {
  const registry = await makeRegistry();
  const runtime = new DolsotRuntime({ toolboxes: registry.toolboxes() });
  try {
    const result = await runtime.run('bridge', "var hits = await mcp.search({query:'add numbers',serverId:'docs'}); await mcp.call({serverId:hits.tools[0].serverId,toolName:hits.tools[0].toolName,arguments:{a:20,b:22},expectedToolRevision:hits.tools[0].toolRevision})");
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.value, /42/);
  } finally {
    await registry.close();
  }
});

test('external MCP HTTP connection can list and call tools through Streamable HTTP', async () => {
  const upstream = await serveHttp(new DolsotRuntime(), { port: 0 });
  const registry = await McpRegistry.open({
    servers: [{ id: 'upstream', transport: 'http', url: upstream.url }],
  });
  try {
    const tools = (await registry.list({ serverId: 'upstream' })).tools;
    assert(tools.some(tool => tool.toolName === 'dolsot_run'));
    const result = await registry.call({
      serverId: 'upstream',
      toolName: 'dolsot_run',
      arguments: { session: 'external', code: '20 + 22' },
    });
    assert.equal(result.value, '42');
  } finally {
    await registry.close();
    await upstream.close();
  }
});

test('configured MCP backends stay available in cells without adding external MCP tools', async () => {
  const registry = await makeRegistry();
  const withoutRegistry = await serveHttp(new DolsotRuntime(), { port: 0 });
  const runtime = new DolsotRuntime({ toolboxes: registry.toolboxes() });
  const withRegistry = await serveHttp(runtime, { port: 0 });
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const clients = [withoutRegistry, withRegistry].map(service => new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} }));
  const transports = [withoutRegistry, withRegistry].map(service => new StreamableHTTPClientTransport(new URL(service.url)));
  try {
    await Promise.all(clients.map((client, index) => client.connect(transports[index])));
    const before = await clients[0].listTools();
    const after = await clients[1].listTools();
    const expectedNames = ['dolsot_reset', 'dolsot_run', 'dolsot_sessions'];
    assert.deepEqual(before.tools.map(item => item.name).sort(), expectedNames);
    assert.deepEqual(after.tools.map(item => item.name).sort(), expectedNames);

    const result = await clients[1].callTool({
      name: 'dolsot_run',
      arguments: {
        session: 'configured-mcp',
        code: "var hits = await mcp.search({query:'add numbers',serverId:'docs'}); var catalog = await mcp.list({serverId:'docs'}); var sum = await mcp.call({serverId:'docs',toolName:hits.tools[0].toolName,arguments:{a:20,b:22}}); ({hit:hits.tools[0].toolName,catalog:catalog.tools.map(item=>item.toolName),sum:sum.sum})",
      },
    });
    const cellValue = JSON.parse(result.structuredContent.value);
    assert.equal(cellValue.hit, 'add');
    assert(cellValue.catalog.includes('add'));
    assert.equal(cellValue.sum, 42);
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await Promise.all([withoutRegistry.close(), withRegistry.close(), registry.close()]);
  }
});

test('periodic refresh discovers changes when the upstream sends no list-changed notification', async () => {
  const oldInterval = process.env.DOLSOT_MCP_REFRESH_INTERVAL_MS;
  process.env.DOLSOT_MCP_REFRESH_INTERVAL_MS = '1000';
  const registry = await makeRegistry();
  try {
    await registry.call({ serverId: 'docs', toolName: 'change_without_notification', arguments: {} });
    await waitUntil(async () => ((await registry.list({ serverId: 'docs' })).tools).some(tool => tool.toolName === 'get_notes'), 4_000);
  } finally {
    await registry.close();
    if (oldInterval === undefined) delete process.env.DOLSOT_MCP_REFRESH_INTERVAL_MS;
    else process.env.DOLSOT_MCP_REFRESH_INTERVAL_MS = oldInterval;
  }
});

test('HTTP MCP exposes run/session/reset tools over loopback Streamable HTTP', async () => {
  const runtime = new DolsotRuntime();
  const service = await serveHttp(runtime, { port: 0 });
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(service.url));
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['dolsot_reset', 'dolsot_run', 'dolsot_sessions']);
    const first = await client.callTool({ name: 'dolsot_run', arguments: { session: 'http', code: 'var n = 40; n + 2' } });
    assert.equal(first.structuredContent.value, '42');
    const second = await client.callTool({ name: 'dolsot_run', arguments: { session: 'http', code: 'n + 1' } });
    assert.equal(second.structuredContent.value, '41');
    const overflow = await client.callTool({ name: 'dolsot_run', arguments: { session: 'http', code: "var saved = 'x'.repeat(32769); saved" } });
    assert.equal(overflow.isError, true);
    assert.match(overflow.content[0].text, /32769 bytes.*32768 bytes/);
    assert.equal(overflow.structuredContent.value, null);
    const recovered = await client.callTool({ name: 'dolsot_run', arguments: { session: 'http', code: 'saved.slice(0, 3)' } });
    assert.equal(recovered.structuredContent.value, 'xxx');
    const sessions = await client.callTool({ name: 'dolsot_sessions', arguments: {} });
    assert(sessions.structuredContent.sessions.some(session => session.id === 'http'));
    const reset = await client.callTool({ name: 'dolsot_reset', arguments: { session: 'http' } });
    assert.equal(reset.structuredContent.reset, 1);
    const afterReset = await client.callTool({ name: 'dolsot_sessions', arguments: {} });
    assert.equal(afterReset.structuredContent.sessions.some(session => session.id === 'http'), false);
    const denied = await fetch(service.url, { method: 'POST', headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 403);
    const get = await fetch(service.url, { method: 'GET', headers: { Accept: 'text/event-stream' } });
    assert.equal(get.status, 405);
  } finally {
    await client.close();
    await service.close();
  }
});

test('stdio MCP exposes execution tools and closes with its client process', async () => {
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const client = new Client({ name: 'test-stdio-client', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--transport', 'stdio'] });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: 'dolsot_run', arguments: { session: 'stdio', code: '20 + 22' } });
    assert.equal(result.structuredContent.value, '42');
  } finally {
    await client.close();
  }
});

test('failed initial MCP discovery is reported as unavailable and partial', async () => {
  const registry = await McpRegistry.open({
    servers: [{ id: 'missing', transport: 'stdio', command: process.execPath, args: ['-e', 'process.exit(7)'] }],
  });
  try {
    const result = await registry.search({ query: 'anything' });
    assert.equal(result.partial, true);
    assert.equal(result.serverStatuses[0].state, 'failed');
    await assert.rejects(registry.call({ serverId: 'missing', toolName: 'nope' }), /MCP_TOOL_UNAVAILABLE|CATALOG_UNAVAILABLE/);
  } finally {
    await registry.close();
  }
});

test('failed initial connection is retried and republishes tools after reconnect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dolsot-mcp-retry-'));
  const marker = join(dir, 'first-attempt');
  const retryFixture = fileURLToPath(new URL('../test-support/retry-mcp-fixture.mjs', import.meta.url));
  const registry = await McpRegistry.open({
    servers: [{ id: 'retry', transport: 'stdio', command: process.execPath, args: [retryFixture, marker] }],
  });
  try {
    assert.equal((await registry.search({ query: 'recovered' })).partial, true);
    await waitUntil(async () => ((await registry.list({ serverId: 'retry' })).tools).some(tool => tool.toolName === 'recovered'), 20_000);
    assert.equal((await registry.search({ query: 'recovered' })).partial, false);
  } finally {
    await registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('host MCP config loads stdio connections and filters tools through its allowlist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dolsot-mcp-config-'));
  const configPath = join(dir, 'mcp.json');
  const previous = process.env.DOLSOT_MCP_CONFIG;
  await writeFile(configPath, JSON.stringify({
    servers: [{
      id: 'docs',
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      allowedTools: ['search_documents'],
    }],
  }), { mode: 0o600 });
  process.env.DOLSOT_MCP_CONFIG = configPath;
  const registry = await openMcpRegistry();
  try {
    const tools = (await registry.list({ serverId: 'docs' })).tools;
    assert.deepEqual(tools.map(tool => tool.toolName), ['search_documents']);
    await assert.rejects(registry.call({ serverId: 'docs', toolName: 'add', arguments: { a: 1, b: 2 } }), /MCP_TOOL_DENIED/);
  } finally {
    await registry.close();
    if (previous === undefined) delete process.env.DOLSOT_MCP_CONFIG;
    else process.env.DOLSOT_MCP_CONFIG = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed reconnect drops the closed client and retries a fresh connection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dolsot-mcp-reconnect-'));
  const marker = join(dir, 'attempt-count');
  const reconnectFixture = fileURLToPath(new URL('../test-support/reconnect-mcp-fixture.mjs', import.meta.url));
  const registry = await McpRegistry.open({
    servers: [{ id: 'reconnect', transport: 'stdio', command: process.execPath, args: [reconnectFixture, marker] }],
  });
  try {
    await registry.call({ serverId: 'reconnect', toolName: 'stop', arguments: {} });
    await waitUntil(async () => ((await registry.list({ serverId: 'reconnect' })).tools).some(item => item.toolName === 'recovered'), 20_000);
    const attempts = Number(await (await import('node:fs/promises')).readFile(marker, 'utf8'));
    assert(attempts >= 3);
    assert.equal(registry.servers.get('reconnect').state, 'ready');
  } finally {
    await registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('permission revocation removes search/catalog entries and invalidates cursors', async () => {
  const registry = registryWithLists({ docs: async () => ({ tools: [tool('a', 'needle'), tool('b', 'needle needle needle')] }) });
  try {
    await registry.refresh();
    const first = await registry.search({ query: 'needle', limit: 1 });
    assert(first.nextCursor);
    registry.servers.get('docs').allowedTools = new Set(['a']);
    assert.deepEqual(((await registry.list({ serverId: 'docs' })).tools).map(item => item.toolName), ['a']);
    assert.deepEqual((await registry.search({ query: 'needle' })).tools.map(item => item.toolName), ['a']);
    await assert.rejects(registry.search({ query: 'needle', limit: 1, cursor: first.nextCursor }), /CURSOR_STALE/);
    await assert.rejects(registry.call({ serverId: 'docs', toolName: 'b' }), /MCP_TOOL_DENIED/);
  } finally {
    await registry.close();
  }
});

test('BM25 retains term frequency in document text', async () => {
  const registry = registryWithLists({ docs: async () => ({ tools: [tool('once', 'needle'), tool('repeated', 'needle needle needle')] }) });
  try {
    await registry.refresh();
    const result = await registry.search({ query: 'needle' });
    assert.equal(result.tools[0].toolName, 'repeated');
    assert(result.tools[0].score > result.tools[1].score);
  } finally {
    await registry.close();
  }
});

test('DOLSOT_SEARCH_MODE supplies the process default and call mode overrides it', async () => {
  const previous = process.env.DOLSOT_SEARCH_MODE;
  process.env.DOLSOT_SEARCH_MODE = 'bm25';
  const registry = registryWithLists({ docs: async () => ({ tools: [tool('lexical', 'needle'), tool('semantic', 'different')] }) });
  let embedCalls = 0;
  registry.embeddingSearch = {
    syncCatalog() {},
    async rank() { embedCalls += 1; return [{ tool: registry.catalog.get('docs').get('semantic'), score: 1 }, { tool: registry.catalog.get('docs').get('lexical'), score: 0 }]; },
    clear() {},
  };
  try {
    assert.equal(registry.searchMode, 'bm25');
    await registry.refresh();
    assert.equal((await registry.search({ query: 'needle' })).tools[0].toolName, 'lexical');
    assert.equal(embedCalls, 0);
    assert.equal((await registry.search({ query: 'needle', mode: 'vector' })).tools[0].toolName, 'semantic');
    assert.equal(embedCalls, 1);
  } finally {
    await registry.close();
    if (previous === undefined) delete process.env.DOLSOT_SEARCH_MODE;
    else process.env.DOLSOT_SEARCH_MODE = previous;
  }
});

test('search rejects invalid process defaults and call modes', async () => {
  const previous = process.env.DOLSOT_SEARCH_MODE;
  process.env.DOLSOT_SEARCH_MODE = 'unknown';
  try {
    assert.throws(() => new McpRegistry(300_000), /DOLSOT_SEARCH_MODE must be one of: bm25, vector, hybrid/);
  } finally {
    if (previous === undefined) delete process.env.DOLSOT_SEARCH_MODE;
    else process.env.DOLSOT_SEARCH_MODE = previous;
  }
  const registry = registryWithLists({ docs: async () => ({ tools: [tool('a', 'alpha')] }) });
  try {
    await assert.rejects(registry.search({ query: 'alpha', mode: 'unknown' }), /mode must be one of: bm25, vector, hybrid/);
  } finally {
    await registry.close();
  }
});

test('vector mode ranks only by cosine and exposes all search modes in toolbox help', async () => {
  const registry = registryWithLists({ docs: async () => ({ tools: [tool('lexical', 'needle'), tool('semantic', 'different')] }) });
  registry.embeddingSearch = embeddingSearch(text => text === 'needle' || text.startsWith('semantic') ? [1, 0] : [0, 1]);
  try {
    await registry.refresh();
    const result = await registry.search({ query: 'needle', mode: 'vector' });
    assert.deepEqual(result.tools.map(item => item.toolName), ['semantic', 'lexical']);
    assert.deepEqual(registry.toolboxes().mcp.search.inputSchema.properties.mode.enum, ['bm25', 'vector', 'hybrid']);
  } finally {
    await registry.close();
  }
});

test('RRF combines independent rankings and uses one-based reciprocal ranks', () => {
  const tools = ['a', 'b', 'c', 'd'].map(name => ({ serverId: 'docs', name }));
  const fused = reciprocalRankFusion(
    [tools[0], tools[1], tools[2], tools[3]].map(tool => ({ tool })),
    [tools[1], tools[2], tools[0], tools[3]].map(tool => ({ tool })),
  );
  assert.equal(fused[0].tool.name, 'b');
  assert(fused[0].score > fused[1].score);
});

test('hybrid search keeps allowlist filtering and applies limit after RRF', async () => {
  const embedded = [];
  const registry = registryWithLists({ docs: async () => ({ tools: [
    tool('lexical-hit', 'alpha phrase'),
    tool('semantic-hit', 'conceptually related'),
    tool('other', 'unrelated material'),
    tool('denied', 'alpha hidden tool'),
  ] }) });
  registry.servers.get('docs').allowedTools = new Set(['lexical-hit', 'semantic-hit', 'other']);
  registry.embeddingSearch = embeddingSearch(text => {
    if (text === 'alpha' || text.startsWith('semantic-hit\n')) return [1, 0];
    if (text.startsWith('lexical-hit\n')) return [0, 1];
    return [-1, 0];
  }, texts => embedded.push(...texts));
  try {
    await registry.refresh();
    const result = await registry.search({ query: 'alpha', limit: 2 });
    assert.deepEqual(result.tools.map(item => item.toolName), ['lexical-hit', 'semantic-hit']);
    assert.equal(result.tools.length, 2);
    assert(!embedded.some(text => text.startsWith('denied\n')));
  } finally {
    await registry.close();
  }
});

test('tool embeddings are cached and refreshed when name or description changes', async () => {
  let name = 'lookup';
  let description = 'old description';
  const embedded = [];
  const registry = registryWithLists({ docs: async () => ({ tools: [tool(name, description)] }) });
  registry.embeddingSearch = embeddingSearch(() => [1, 0], texts => embedded.push(...texts));
  try {
    await registry.refresh();
    await registry.search({ query: 'first query' });
    await registry.search({ query: 'second query' });
    description = 'updated description';
    await registry.refresh();
    await registry.search({ query: 'third query' });
    name = 'find_lookup';
    await registry.refresh();
    await registry.search({ query: 'fourth query' });
    assert.equal(embedded.filter(text => text === 'lookup\nold description').length, 1);
    assert.equal(embedded.filter(text => text === 'lookup\nupdated description').length, 1);
    assert.equal(embedded.filter(text => text === 'find_lookup\nupdated description').length, 1);
  } finally {
    await registry.close();
  }
});

test('search rejects a removed tool after delayed inference and reconciles the embedding cache', async () => {
  let currentTools = [tool('a', 'needle'), tool('b', 'needle')];
  const entered = deferred();
  const release = deferred();
  const registry = registryWithLists({ docs: async () => ({ tools: currentTools }) });
  registry.embeddingSearch = embeddingSearch(() => [1, 0], async texts => {
    if (texts.some(text => text.startsWith('a\n'))) {
      entered.resolve();
      await release.promise;
    }
  });
  try {
    await registry.refresh();
    const pending = registry.search({ query: 'needle', mode: 'vector' });
    await entered.promise;
    currentTools = [tool('b', 'needle')];
    await registry.refresh();
    release.resolve();
    await assert.rejects(pending, /CURSOR_STALE/);
    assert.equal(registry.embeddingSearch.cache.has('docs\0a'), false);
    assert.equal(registry.embeddingSearch.cache.has('docs\0b'), true);
  } finally {
    release.resolve();
    await registry.close();
  }
});

test('search rejects results and removes cached embeddings when permission is revoked during inference', async () => {
  const entered = deferred();
  const release = deferred();
  const registry = registryWithLists({ docs: async () => ({ tools: [tool('a', 'needle'), tool('b', 'needle')] }) });
  registry.servers.get('docs').allowedTools = new Set(['a', 'b']);
  registry.embeddingSearch = embeddingSearch(() => [1, 0], async texts => {
    if (texts.some(text => text.startsWith('a\n'))) {
      entered.resolve();
      await release.promise;
    }
  });
  try {
    await registry.refresh();
    const pending = registry.search({ query: 'needle', mode: 'vector' });
    await entered.promise;
    registry.servers.get('docs').allowedTools = new Set(['b']);
    release.resolve();
    await assert.rejects(pending, /CURSOR_STALE/);
    assert.equal(registry.embeddingSearch.cache.has('docs\0a'), false);
    assert.equal(registry.embeddingSearch.cache.has('docs\0b'), true);
  } finally {
    release.resolve();
    await registry.close();
  }
});

test('BM25 fallback cannot return a stale catalog after inference fails during refresh', async () => {
  let currentTools = [tool('a', 'needle'), tool('b', 'needle')];
  const entered = deferred();
  const release = deferred();
  const registry = registryWithLists({ docs: async () => ({ tools: currentTools }) });
  registry.embeddingSearch = {
    syncCatalog() {},
    async rank() {
      entered.resolve();
      await release.promise;
      throw new Error('synthetic inference failure');
    },
    clear() {},
  };
  try {
    await registry.refresh();
    const pending = registry.search({ query: 'needle', mode: 'hybrid' });
    await entered.promise;
    currentTools = [tool('b', 'needle')];
    await registry.refresh();
    release.resolve();
    await assert.rejects(pending, /CURSOR_STALE/);
  } finally {
    release.resolve();
    await registry.close();
  }
});

test('page search revalidates its existing cursor after delayed inference and refresh', async () => {
  let currentTools = [tool('a', 'needle'), tool('b', 'needle')];
  const entered = deferred();
  const release = deferred();
  const registry = registryWithLists({ docs: async () => ({ tools: currentTools }) });
  let delayNextRank = false;
  registry.embeddingSearch = {
    syncCatalog() {},
    async rank(query, docs) {
      if (delayNextRank) {
        entered.resolve();
        await release.promise;
      }
      return docs.map(tool => ({ tool, score: 1 }));
    },
    clear() {},
  };
  try {
    await registry.refresh();
    const first = await registry.search({ query: 'needle', limit: 1, mode: 'vector' });
    assert(first.nextCursor);
    delayNextRank = true;
    const pending = registry.search({ query: 'needle', limit: 1, cursor: first.nextCursor, mode: 'vector' });
    await entered.promise;
    currentTools = [tool('b', 'needle')];
    await registry.refresh();
    release.resolve();
    await assert.rejects(pending, /CURSOR_STALE/);
  } finally {
    release.resolve();
    await registry.close();
  }
});

test('search pagination rejects a cursor if model failure changes the ranking mode', async () => {
  const registry = registryWithLists({ docs: async () => ({ tools: [tool('needle', 'matches query'), tool('semantic', 'different wording')] }) });
  registry.embeddingSearch = embeddingSearch(text => text.startsWith('needle\n') ? [1, 0] : [0, 1]);
  try {
    await registry.refresh();
    const first = await registry.search({ query: 'needle', limit: 1 });
    assert(first.nextCursor);
    registry.embeddingSearch.rank = async () => { throw new Error('inference failed'); };
    await assert.rejects(registry.search({ query: 'needle', limit: 1, cursor: first.nextCursor }), /CURSOR_STALE/);
    assert.equal((await registry.search({ query: 'needle', limit: 1 })).tools[0].toolName, 'needle');
  } finally {
    await registry.close();
  }
});

test('model load or inference failure in vector and hybrid modes falls back to BM25 search', async () => {
  for (const mode of ['vector', 'hybrid']) for (const modelLoader of [
    async () => { throw new Error('model unavailable'); },
    async () => async () => { throw new Error('inference failed'); },
  ]) {
    const registry = registryWithLists({ docs: async () => ({ tools: [tool('other', 'unrelated'), tool('match', 'find alpha')] }) });
    registry.embeddingSearch = new EmbeddingSearch({ modelLoader });
    try {
      await registry.refresh();
      const result = await registry.search({ query: 'alpha', mode });
      assert.equal(result.tools[0].toolName, 'match');
      assert(result.tools[0].score > 0);
    } finally {
      await registry.close();
    }
  }
});

test('mcp.list invokes the external catalog tool instead of static toolbox metadata', async () => {
  const registry = registryWithLists({ docs: async () => ({ tools: [tool('search_documents', 'Find docs')] }) });
  const runtime = new DolsotRuntime({ toolboxes: registry.toolboxes() });
  try {
    await registry.refresh();
    const result = await runtime.run('catalog', "await mcp.list({serverId:'docs'})");
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.value, /search_documents/);
    assert.doesNotMatch(result.value, /currently allowed external MCP tools/);
  } finally {
    await registry.close();
  }
});

test('concurrent refresh callers receive results for their requested server scope', async () => {
  let failA = false;
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const release = new Promise(resolve => { releaseResolve = resolve; });
  const registry = registryWithLists({
    a: async () => { if (failA) { enteredResolve(); await release; throw new Error('synthetic failure'); } return { tools: [tool('a')] }; },
    b: async () => ({ tools: [tool('b')] }),
  });
  try {
    await registry.refresh();
    failA = true;
    const all = registry.refresh();
    await entered;
    const onlyB = registry.refresh('b');
    releaseResolve();
    const [allResult, bResult] = await Promise.all([all, onlyB]);
    assert.equal(allResult.ok, false);
    assert.deepEqual(bResult.servers.map(item => item.serverId), ['b']);
    assert.equal(bResult.ok, true);
  } finally {
    releaseResolve?.();
    await registry.close();
  }
});

test('any completed refresh invalidates old search cursors, even on total failure', async () => {
  let fail = false;
  const registry = registryWithLists({ docs: async () => { if (fail) throw new Error('offline'); return { tools: [tool('a', 'needle'), tool('b', 'needle')] }; } });
  try {
    await registry.refresh();
    const first = await registry.search({ query: 'needle', limit: 1 });
    assert(first.nextCursor);
    fail = true;
    assert.equal((await registry.refresh()).ok, false);
    await assert.rejects(registry.search({ query: 'needle', limit: 1, cursor: first.nextCursor }), /CURSOR_STALE/);
  } finally {
    await registry.close();
  }
});

test('catalog collection has an end-to-end deadline and close aborts it', async () => {
  const registry = registryWithLists({ docs: async () => ({ tools: [tool('a')] }) });
  try {
    await registry.refresh();
    registry.refreshTimeoutMs = 1_000;
    let receivedSignal;
    registry.servers.get('docs').client.listTools = (_params, { signal }) => new Promise((_resolve, reject) => {
      receivedSignal = signal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const started = Date.now();
    await assert.rejects(registry.refresh('docs'), { code: 'REFRESH_TIMEOUT' });
    assert(Date.now() - started < 2_000);
    assert.equal(receivedSignal.aborted, true);

    let closeSignal;
    registry.servers.get('docs').client.listTools = (_params, { signal }) => new Promise((_resolve, reject) => {
      closeSignal = signal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const active = registry.refresh('docs');
    const rejected = assert.rejects(active, /MCP registry closed/);
    await waitUntil(() => closeSignal !== undefined);
    await registry.close();
    assert.equal(closeSignal.aborted, true);
    await rejected;
  } finally {
    await registry.close();
  }
});

test('registry shutdown aborts and drains active external tool calls', async () => {
  const registry = registryWithLists({ docs: async () => ({ tools: [tool('slow', 'wait')] }) });
  await registry.refresh();
  let receivedSignal;
  registry.servers.get('docs').client.callTool = (_params, _schema, { signal }) => new Promise((_resolve, reject) => {
    receivedSignal = signal;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const active = registry.call({ serverId: 'docs', toolName: 'slow' }).catch(error => error);
  await waitUntil(() => receivedSignal !== undefined);
  await registry.close();
  const result = await active;
  assert.equal(receivedSignal.aborted, true);
  assert.match(result.message, /MCP registry closed/);
  assert.equal(registry.inflightCalls.size, 0);
});

async function waitUntil(predicate, timeoutMs = 3_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('condition did not become true before timeout');
}
