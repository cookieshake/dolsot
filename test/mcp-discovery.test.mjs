import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpRegistry } from '../src/mcp-registry.mjs';
import { DolsotRuntime } from '../src/runtime.mjs';
import { serveHttp } from '../src/mcp-server.mjs';

function fixture() {
  const registry = new McpRegistry(300_000);
  let calls = 0;
  const state = {
    spec: { id: 'docs' }, allowedTools: null, tools: new Map(), state: 'ready',
    client: {
      listTools: async () => ({ tools: Array.from({ length: 65 }, (_, i) => ({
        name: `tool_${String(i).padStart(2, '0')}`, description: 'Read fixture status. '.repeat(30),
        inputSchema: { type: 'object', properties: { password: { type: 'string' } }, additionalProperties: false },
      })) }),
      callTool: async () => { calls += 1; return { structuredContent: { status: 'ready' } }; },
      close: async () => {},
    },
  };
  registry.servers.set('docs', state);
  return { registry, state, calls: () => calls };
}

test('list paginates all allowed tools and filters full schema detail with the same envelope', async () => {
  const { registry, state } = fixture();
  try {
    await registry.refresh();
    const first = await registry.list();
    assert.equal(first.tools.length, 50);
    assert(first.nextCursor);
    assert.equal('inputSchema' in first.tools[0], false);
    assert.equal(first.tools[0].description.length, 240);
    const last = await registry.list({ cursor: first.nextCursor });
    assert.equal(last.tools.length, 15);
    assert.equal(last.nextCursor, null);
    assert.equal(new Set([...first.tools, ...last.tools].map(t => t.toolName)).size, 65);
    const full = await registry.list({ serverId: 'docs', toolName: 'tool_00', detail: 'full' });
    assert.equal(full.tools.length, 1);
    assert.equal(full.nextCursor, null);
    assert(full.tools[0].inputSchema.properties.password);
    assert(full.tools[0].description.length > 240);
    assert.equal(full.tools[0].toolRevision, first.tools[0].toolRevision);
    for (const change of [{ detail: 'full' }, { toolName: 'tool_00' }, { serverId: 'docs' }, { limit: 1 }]) {
      await assert.rejects(registry.list({ ...change, cursor: first.nextCursor }), /CURSOR_STALE/);
    }
    state.allowedTools = new Set(['tool_00']);
    assert.deepEqual((await registry.list()).tools.map(t => t.toolName), ['tool_00']);
    await assert.rejects(registry.list({ cursor: first.nextCursor }), /CURSOR_STALE/);
    await assert.rejects(registry.call({ serverId: 'docs', toolName: 'tool_01' }), { code: 'MCP_TOOL_DENIED' });
    await assert.rejects(registry.list({ limit: 51 }), /limit/);
    await assert.rejects(registry.list({ detail: 'invalid' }), /detail/);
    await assert.rejects(registry.list({ cursor: `${first.nextCursor}invalid` }), /CURSOR_STALE/);
    state.allowedTools = null;
    const beforeRefresh = await registry.list();
    await registry.refresh();
    await assert.rejects(registry.list({ cursor: beforeRefresh.nextCursor }), /CURSOR_STALE/);
  } finally { await registry.close(); }
});

test('help discovers only available toolboxes and supports list, schema inspection, and calls across restored cells', async () => {
  const { registry, calls } = fixture();
  const runtime = new DolsotRuntime({ toolboxes: registry.toolboxes() });
  try {
    await registry.refresh();
    const intro = await runtime.run('help', 'help()');
    assert.deepEqual(JSON.parse(intro.value).toolboxes, [{ name: 'mcp', help: 'mcp.help()' }]);
    const methods = JSON.parse((await runtime.run('help', 'mcp.help()')).value);
    assert.deepEqual(methods.map(m => m.name).sort(), ['call', 'list', 'refresh', 'search']);
    assert(methods.every(m => m.inputSchema && m.examples.length));
    assert.equal((await runtime.run('help', 'typeof mcp.catalog')).value, 'undefined');
    const listed = await runtime.run('help', 'var page = await mcp.list({limit: 1}); var selected = page.tools[0]; selected');
    assert.equal(JSON.parse(listed.value).toolName, 'tool_00');
    const details = await runtime.run('help', methods.find(m => m.name === 'list').examples[1]);
    assert(JSON.parse(details.value).tools[0].inputSchema);
    const result = await runtime.run('help', methods.find(m => m.name === 'call').examples[0]);
    assert.equal(result.ok, true, result.error);
    assert.equal(JSON.parse(result.value).status, 'ready');
    for (const bad of ['"tool_00", {}', 'null', '[]', '42']) {
      const result = await runtime.run('help', `await mcp.call(${bad})`);
      assert.equal(result.ok, false);
      assert.match(result.error, /MCP_INVALID_CALL.*mcp\.call\(\{/);
    }
    const invalid = await runtime.run('help', 'await mcp.call({serverId:"docs"})');
    assert.match(invalid.error, /MCP_INVALID_ARGUMENTS/);
    assert.equal(calls(), 1);
    runtime.addToolbox('math', { add: { handler: ({ a, b }) => a + b } });
    assert.equal((await runtime.run('help', 'await math.call("add", {a: 2, b: 3})')).value, '5');
    assert.deepEqual(JSON.parse((await runtime.run('help', 'help()')).value).toolboxes.map(t => t.name), ['mcp', 'math']);
    const localMissing = await runtime.run('help', 'await math.call("missing", {})');
    assert.match(localMissing.error, /TOOLBOX_TOOL_UNAVAILABLE/);
    assert.throws(() => runtime.addToolbox('help', {}), /reserved/);
    const empty = new DolsotRuntime();
    assert.deepEqual(JSON.parse((await empty.run('empty', 'help()')).value).toolboxes, []);
  } finally { await registry.close(); }
});

test('call distinguishes invalid, missing, denied, changed, and redacted upstream failures without retrying', async () => {
  const { registry, state, calls } = fixture();
  const prior = process.env.DOLSOT_FIXTURE_SECRET;
  process.env.DOLSOT_FIXTURE_SECRET = 'Bearer fixture-private-value';
  state.spec.headerEnv = { Authorization: 'DOLSOT_FIXTURE_SECRET' };
  try {
    await registry.refresh();
    await assert.rejects(registry.call('tool_00'), { code: 'MCP_INVALID_CALL' });
    await assert.rejects(registry.call({ serverId: 'docs' }), { code: 'MCP_INVALID_ARGUMENTS' });
    await assert.rejects(registry.call({ serverId: 'missing', toolName: 'tool_00' }), { code: 'MCP_SERVER_UNAVAILABLE' });
    await assert.rejects(registry.call({ serverId: 'docs', toolName: 'missing' }), { code: 'MCP_TOOL_UNAVAILABLE' });
    await assert.rejects(registry.call({ serverId: 'docs', toolName: 'tool_00', expectedToolRevision: 'old' }), /TOOL_CHANGED/);
    assert.equal(calls(), 0);
    state.client.callTool = async () => ({
      isError: true,
      content: [{ type: 'text', text: 'E_FIXTURE: permission denied; fixture-private-value; password=argument-private-value; api_key=other-private-value' }],
      structuredContent: { code: 'E_FIXTURE', token: 'structured-private-value', padding: 'x'.repeat(5000) },
    });
    const runtime = new DolsotRuntime({ toolboxes: registry.toolboxes() });
    const failure = await runtime.run('upstream', 'await mcp.call({serverId:"docs",toolName:"tool_00",arguments:{password:"argument-private-value"}})');
    assert.equal(failure.ok, false);
    assert.match(failure.error, /MCP_UPSTREAM_ERROR.*docs.*tool_00.*E_FIXTURE.*permission denied/);
    assert.doesNotMatch(failure.error, /fixture-private-value|argument-private-value|other-private-value|structured-private-value/);
    assert.match(failure.error, /truncated/);
    assert(Buffer.byteLength(failure.error) < 3000);
    state.client.callTool = async () => { throw new Error('503 temporary outage; Bearer fixture-private-value'); };
    await assert.rejects(registry.call({ serverId: 'docs', toolName: 'tool_00' }), error => {
      assert.equal(error.code, 'MCP_UPSTREAM_TRANSPORT_ERROR');
      assert.match(error.message, /503 temporary outage/);
      assert.doesNotMatch(error.message, /fixture-private-value/);
      return true;
    });
  } finally {
    await registry.close();
    if (prior === undefined) delete process.env.DOLSOT_FIXTURE_SECRET;
    else process.env.DOLSOT_FIXTURE_SECRET = prior;
  }
});

test('MCP advertises the help entry point and rejects invalid seconds before invoking the runtime', async () => {
  const calls = [];
  const runtime = { run: async (...args) => { calls.push(args); return { ok: true, text: '42', value: '42' }; } };
  const service = await serveHttp(runtime, { port: 0 });
  const client = new Client({ name: 'discovery-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url)));
    assert.match(client.getInstructions(), /help\(\)/);
    const tools = await client.listTools();
    const run = tools.tools.find(t => t.name === 'dolsot_run');
    assert(run.description.length < 160);
    assert.match(run.description, /help\(\)/);
    assert.equal(run.inputSchema.properties.timeout.minimum, 1);
    assert.equal(run.inputSchema.properties.timeout.maximum, 1200);
    assert.match(run.inputSchema.properties.timeout.description, /Seconds/);
    for (const timeout of [0, -1, 1.5, 10000]) {
      const result = await client.callTool({ name: 'dolsot_run', arguments: { session: 'test', code: '42', timeout } });
      assert.equal(result.isError, true);
    }
    assert.equal(calls.length, 0);
    for (const timeout of [1, 10, 1200]) {
      await client.callTool({ name: 'dolsot_run', arguments: { session: 'test', code: '42', timeout } });
      assert.deepEqual(calls.at(-1)[2], { timeoutMs: timeout * 1000 });
    }
    await client.callTool({ name: 'dolsot_run', arguments: { session: 'test', code: '42' } });
    assert.deepEqual(calls.at(-1)[2], {});
  } finally {
    await client.close();
    await service.close();
  }
});
