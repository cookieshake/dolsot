import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DolsotRuntime } from '../src/runtime.mjs';
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
  return registry;
}

async function makeRegistry(overrides = {}) {
  return McpRegistry.open({
    servers: [{ id: 'docs', transport: 'stdio', command: process.execPath, args: [fixture] }],
    ...overrides,
  });
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
