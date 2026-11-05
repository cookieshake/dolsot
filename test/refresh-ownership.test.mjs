import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { McpRegistry } from '../src/mcp-registry.mjs';
import { DolsotRuntime } from '../src/runtime.mjs';

const tool = name => ({ name, inputSchema: { type: 'object' } });
function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function registryWithLists(lists, timeout = 2_000) {
  const registry = new McpRegistry(300_000, timeout);
  for (const [id, listTools] of Object.entries(lists)) {
    registry.servers.set(id, {
      spec: { id }, allowedTools: null, client: { listTools, close: async () => {} },
      tools: new Map(), state: 'ready', retryAttempt: 0,
    });
    registry.status.set(id, { serverId: id, state: 'ready', stale: false });
  }
  return registry;
}
async function until(predicate, timeout = 3_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('condition did not become true');
    await delay(5);
  }
}
function blockedList(entered) {
  return (_params, { signal }) => new Promise((_resolve, reject) => {
    entered.resolve(signal);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

test('continuous list-change notifications do not extend a manual refresh batch', async () => {
  const fixture = fileURLToPath(new URL('../test-support/refresh-ownership-fixture.mjs', import.meta.url));
  const registry = await McpRegistry.open({ servers: [{ id: 'docs', transport: 'stdio', command: process.execPath, args: [fixture, 'continuous'] }] });
  try {
    const result = await registry.refresh('docs', { deadline: Date.now() + 1_000 });
    assert.equal(result.ok, true);
    assert.equal(registry.catalog.get('docs').has('generation_2'), true);
    await until(() => registry.catalog.get('docs').has('generation_3'));
  } finally { await registry.close(); }
});

test('refresh deadline includes queue time and cancelled queued work never starts', async () => {
  const entered = gate(); let bCalls = 0;
  const registry = registryWithLists({ a: blockedList(entered), b: async () => { bCalls++; return { tools: [] }; } });
  const owner = new AbortController();
  const active = registry.refresh('a', { signal: owner.signal }).catch(error => error);
  try {
    await entered.promise;
    await assert.rejects(registry.refresh('b', { deadline: Date.now() + 50 }), { code: 'REFRESH_TIMEOUT' });
    assert.equal(bCalls, 0);
    assert.equal(registry.refreshQueue.length, 0);
  } finally { owner.abort(); await active; await registry.close(); }
});

test('only subscriber cancellation aborts collection and leaves the old catalog unpublished', async () => {
  const entered = gate();
  const registry = registryWithLists({ docs: blockedList(entered) });
  const owner = new AbortController();
  const result = registry.refresh('docs', { signal: owner.signal }).catch(error => error);
  try {
    const signal = await entered.promise;
    owner.abort(new Error('owner cancelled'));
    assert.match((await result).message, /owner cancelled/);
    await until(() => registry.refreshPromise === null);
    assert.equal(signal.aborted, true);
    assert.equal(registry.catalogRevision, 0);
    assert.equal(registry.status.get('docs').refreshing, false);
  } finally { await registry.close(); }
});

test('one shared caller cancellation preserves collection for the other caller', async () => {
  const entered = gate(), release = gate(); let calls = 0;
  const registry = registryWithLists({ docs: async (_params, { signal }) => {
    calls++; entered.resolve(signal); await release.promise; return { tools: [tool('kept')] };
  } });
  const owner = new AbortController();
  const first = registry.refresh('docs', { signal: owner.signal }).catch(error => error);
  try {
    const signal = await entered.promise;
    const second = registry.refresh('docs');
    owner.abort(new Error('first cancelled'));
    assert.match((await first).message, /first cancelled/);
    assert.equal(signal.aborted, false);
    release.resolve();
    assert.equal((await second).ok, true);
    assert.equal(calls, 1);
    assert.equal(registry.catalog.get('docs').has('kept'), true);
  } finally { release.resolve(); await registry.close(); }
});

test('a later shared caller survives an earlier caller deadline', async () => {
  const entered = gate(), release = gate();
  const registry = registryWithLists({ docs: async (_params, { signal }) => {
    entered.resolve(signal); await release.promise; return { tools: [tool('kept')] };
  } });
  const first = registry.refresh('docs', { deadline: Date.now() + 60 });
  const rejected = assert.rejects(first, { code: 'REFRESH_TIMEOUT' });
  try {
    const signal = await entered.promise;
    const second = registry.refresh('docs');
    await rejected;
    assert.equal(signal.aborted, false);
    release.resolve();
    assert.equal((await second).ok, true);
  } finally { release.resolve(); await registry.close(); }
});

test('last subscriber cancellation preserves the pending automatic follow-up', async () => {
  const fixture = fileURLToPath(new URL('../test-support/refresh-ownership-fixture.mjs', import.meta.url));
  const registry = await McpRegistry.open({ servers: [{ id: 'docs', transport: 'stdio', command: process.execPath, args: [fixture, 'cancel'] }] });
  const owner = new AbortController();
  const cancelled = registry.refresh('docs', { signal: owner.signal }).catch(error => error);
  try {
    await until(() => registry.pendingRefresh.has('docs'));
    owner.abort(new Error('last cancelled'));
    assert.match((await cancelled).message, /last cancelled/);
    await until(() => registry.catalog.get('docs').has('generation_3'));
    assert.equal(registry.status.get('docs').state, 'ready');
  } finally { await registry.close(); }
});

test('close rejects active and queued subscribers and cannot publish late results', async () => {
  const entered = gate(); let bCalls = 0;
  const registry = registryWithLists({ a: blockedList(entered), b: async () => { bCalls++; return { tools: [] }; } });
  const active = registry.refresh('a').catch(error => error);
  await entered.promise;
  const queued = registry.refresh('b').catch(error => error);
  await registry.close();
  assert.match((await active).message, /registry closed/);
  assert.match((await queued).message, /registry closed/);
  assert.equal(bCalls, 0);
  assert.equal(registry.catalogRevision, 0);
  assert.equal(registry.refreshQueue.length, 0);
  await until(() => registry.refreshPromise === null);
});

test('pre-aborted and expired refresh callers do not acquire collection ownership', async () => {
  let calls = 0;
  const registry = registryWithLists({ docs: async () => { calls++; return { tools: [] }; } });
  try {
    await assert.rejects(registry.refresh('docs', { signal: AbortSignal.abort(new Error('already cancelled')) }), /already cancelled/);
    await assert.rejects(registry.refresh('docs', { deadline: Date.now() - 1 }), { code: 'REFRESH_TIMEOUT' });
    assert.equal(calls, 0);
  } finally { await registry.close(); }
});

test('a refresh started in a completed caller continuation gets a new batch', async () => {
  let calls = 0;
  const registry = registryWithLists({ docs: async () => { calls++; return { tools: [tool(`v${calls}`)] }; } });
  try {
    await registry.refresh('docs');
    await registry.refresh('docs');
    assert.equal(calls, 2);
  } finally { await registry.close(); }
});

test('guest refresh cancellation releases its handler and aborts an unshared collection', async () => {
  const entered = gate();
  const registry = registryWithLists({ docs: blockedList(entered) }, 10_000);
  const runtime = new DolsotRuntime({ toolboxes: registry.toolboxes(), timeoutMs: 3_000 });
  try {
    const result = runtime.run('refresh-abort', 'await mcp.refresh()');
    const signal = await Promise.race([entered.promise, result.then(() => { throw new Error('cell ended before entering refresh'); })]);
    assert.equal((await result).ok, false);
    await until(() => runtime.activeToolCalls === 0 && registry.refreshPromise === null);
    assert.equal(signal.aborted, true);
  } finally { await registry.close(); }
});

test('request deadline bounds a paginated collection rather than resetting per page', async () => {
  let pages = 0, upstreamSignal;
  const registry = registryWithLists({ docs: async (_params, { signal }) => {
    upstreamSignal = signal;
    await delay(20, undefined, { signal });
    return { tools: [tool(`page_${++pages}`)], nextCursor: String(pages) };
  } });
  try {
    await assert.rejects(registry.refresh('docs', { deadline: Date.now() + 90 }), { code: 'REFRESH_TIMEOUT' });
    await until(() => registry.refreshPromise === null);
    assert.equal(upstreamSignal.aborted, true);
    assert(pages > 0 && pages < 100);
    assert.equal(registry.catalogRevision, 0);
  } finally { await registry.close(); }
});

test('collection aborts only after the last of two shared subscribers cancels', async () => {
  const entered = gate();
  const registry = registryWithLists({ docs: blockedList(entered) });
  const a = new AbortController(), b = new AbortController();
  const first = registry.refresh('docs', { signal: a.signal }).catch(error => error);
  try {
    const signal = await entered.promise;
    const second = registry.refresh('docs', { signal: b.signal }).catch(error => error);
    a.abort(); await first;
    assert.equal(signal.aborted, false);
    b.abort(); await second;
    await until(() => registry.refreshPromise === null);
    assert.equal(signal.aborted, true);
    assert.equal(registry.catalogRevision, 0);
  } finally { await registry.close(); }
});

test('close winning a completion race discards even an abort-ignoring late response', async () => {
  const entered = gate(), release = gate();
  const registry = registryWithLists({ docs: async () => {
    entered.resolve(); await release.promise; return { tools: [tool('late')] };
  } });
  const active = registry.refresh('docs').catch(error => error);
  await entered.promise;
  const closing = registry.close();
  release.resolve();
  await closing;
  assert.match((await active).message, /registry closed/);
  assert.equal(registry.catalogRevision, 0);
  assert.equal(registry.catalog.size, 0);
});

test('initial refresh deadline failure closes the registry and its connected transport', async () => {
  const fixture = fileURLToPath(new URL('../test-support/refresh-ownership-fixture.mjs', import.meta.url));
  const oldTimeout = process.env.DOLSOT_MCP_REFRESH_TIMEOUT_MS;
  const originalClose = McpRegistry.prototype.close;
  const originalRefresh = McpRegistry.prototype.refresh;
  let closedRegistry;
  let openedRegistry;
  McpRegistry.prototype.close = async function () {
    await originalClose.call(this);
    closedRegistry = this;
  };
  // Separate the caller deadline from the per-server timeout: either may win
  // when both are configured for the same millisecond.
  McpRegistry.prototype.refresh = function (serverId) {
    return originalRefresh.call(this, serverId, { deadline: Date.now() + 100 });
  };
  process.env.DOLSOT_MCP_REFRESH_TIMEOUT_MS = '1000';
  try {
    await assert.rejects(McpRegistry.open({ servers: [{ id: 'docs', transport: 'stdio', command: process.execPath, args: [fixture, 'startup-timeout'] }] }).then(registry => { openedRegistry = registry; return registry; }), { code: 'REFRESH_TIMEOUT' });
    assert.equal(closedRegistry?.closed, true);
    assert.equal(closedRegistry.servers.get('docs').client, null);
    assert.equal(closedRegistry.refreshQueue.length, 0);
  } finally {
    await openedRegistry?.close();
    McpRegistry.prototype.close = originalClose;
    McpRegistry.prototype.refresh = originalRefresh;
    if (oldTimeout === undefined) delete process.env.DOLSOT_MCP_REFRESH_TIMEOUT_MS;
    else process.env.DOLSOT_MCP_REFRESH_TIMEOUT_MS = oldTimeout;
  }
});
