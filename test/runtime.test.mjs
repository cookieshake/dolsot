import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { DolsotRuntime } from '../src/runtime.mjs';

const execFileAsync = promisify(execFile);

test('memory sessions persist across cells in one host and disappear with that host', async () => {
  const firstHost = new DolsotRuntime();
  assert.equal((await firstHost.run('memory', 'var x = 40; x + 2')).value, '42');
  assert.equal((await firstHost.run('memory', 'x + 1')).value, '41');
  assert.equal((await firstHost.sessions()).length, 1);
  assert.equal((await new DolsotRuntime().sessions()).length, 0);
});

test('disk sessions persist between independent CLI processes and support list/reset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dolsot-store-'));
  const cli = new URL('../src/cli.mjs', import.meta.url);
  const env = { ...process.env, DOLSOT_SESSION_DIR: dir };
  try {
    const first = await execFileAsync(process.execPath, [cli.pathname, '--session', 'cli', 'var n = 40; n + 2'], { env });
    const second = await execFileAsync(process.execPath, [cli.pathname, '--session', 'cli', 'n += 1; n'], { env });
    const listed = await execFileAsync(process.execPath, [cli.pathname, '--list-sessions'], { env });
    assert.equal(first.stdout.trim(), '42');
    assert.equal(second.stdout.trim(), '41');
    assert.match(listed.stdout, /^cli\t/m);
    await Promise.all([1, 2, 3].map(() =>
      execFileAsync(process.execPath, [cli.pathname, '--session', 'cli', 'n += 1; n'], { env }),
    ));
    const afterParallel = await execFileAsync(process.execPath, [cli.pathname, '--session', 'cli', 'n'], { env });
    assert.equal(afterParallel.stdout.trim(), '44');
    const reset = await execFileAsync(process.execPath, [cli.pathname, '--reset', 'cli'], { env });
    assert.equal(reset.stdout.trim(), 'reset 1 session(s)');
    const empty = await execFileAsync(process.execPath, [cli.pathname, '--list-sessions'], { env });
    assert.equal(empty.stdout, '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stdin cells run and parent timeout preserves the previously committed disk snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dolsot-timeout-'));
  const cli = new URL('../src/cli.mjs', import.meta.url);
  const env = { ...process.env, DOLSOT_SESSION_DIR: dir };
  try {
    const runtime = new DolsotRuntime({ sessionDir: dir, timeoutMs: 15_000 });
    assert.equal((await runtime.run('stdin', 'var baseline = 7; baseline')).value, '7');
    const timeout = await runtime.run('stdin', 'while (true) {}');
    assert.equal(timeout.exit_code, 124);
    const recovery = new DolsotRuntime({ sessionDir: dir, timeoutMs: 15_000 });
    assert.equal((await recovery.run('stdin', 'baseline')).value, '7');
    const piped = execFileSync(process.execPath, [cli.pathname, '--session', 'pipe'], {
      env,
      input: '1 + 2',
      encoding: 'utf8',
    });
    assert.equal(piped.trim(), '3');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('invalid session paths fail explicitly rather than falling back to memory', async () => {
  assert.throws(() => new DolsotRuntime({ sessionDir: 'relative/path' }), /absolute path/);
});

test('ordinary JavaScript errors preserve the resulting session state', async () => {
  const runtime = new DolsotRuntime();
  const failed = await runtime.run('partial', "var partialState = 9; throw new Error('cell failed')");
  assert.equal(failed.ok, false);
  assert.equal((await runtime.run('partial', 'partialState')).value, '9');
});

test('guest code does not receive Node globals or host environment variables', async () => {
  process.env.DOLSOT_TEST_PRIVATE_VALUE = 'should-not-enter-guest';
  try {
    const runtime = new DolsotRuntime();
    assert.equal((await runtime.run('isolation', "[typeof process, typeof require, typeof fetch].join(',')")).value, 'undefined,undefined,undefined');
  } finally {
    delete process.env.DOLSOT_TEST_PRIVATE_VALUE;
  }
});

test('version-incompatible disk snapshots fail without starting an empty session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dolsot-version-'));
  const sessionPath = join(dir, `${Buffer.from('broken').toString('base64url')}.state`);
  try {
    await writeFile(sessionPath, Buffer.from('not-a-dolsot-snapshot'), { mode: 0o600 });
    const runtime = new DolsotRuntime({ sessionDir: dir });
    await assert.rejects(runtime.run('broken', '1 + 1'), /invalid dolsot session snapshot header/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('host toolbox callbacks work after restore and validate arguments before invocation', async () => {
  let calls = 0;
  const toolboxes = {
    mt: {
      add: {
        description: 'Add two integers',
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'integer' }, b: { type: 'integer' } },
          required: ['a', 'b'],
          additionalProperties: false,
        },
        handler: ({ a, b }) => {
          calls += 1;
          return a + b;
        },
      },
    },
  };
  const runtime = new DolsotRuntime({ toolboxes });
  assert.equal((await runtime.run('tools', 'var base = 40; base')).value, '40');
  assert.equal((await runtime.run('tools', 'base + await mt.add({a: 1, b: 2})')).value, '43');
  const generic = await runtime.run('tools', "await mt.call('add', {a: 4, b: 5})");
  assert.equal(generic.ok, true, JSON.stringify(generic));
  assert.equal(generic.value, '9');
  const invalid = await runtime.run('tools', 'await mt.add({a: "1", b: 2})');
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /input schema/);
  assert.equal(calls, 2);
});

test('CLI loads a trusted local JavaScript toolbox module by path and alias', async () => {
  const cli = new URL('../src/cli.mjs', import.meta.url);
  const modulePath = new URL('../examples/math-tools.mjs', import.meta.url).pathname;
  const result = await execFileAsync(process.execPath, [
    cli.pathname,
    '--session', 'module',
    '--toolbox', `${modulePath}:mt`,
    'await mt.add({a: 20, b: 22})',
  ]);
  assert.equal(result.stdout.trim(), '42');
});

test('adding a toolbox after a snapshot installs new guest bridge functions', async () => {
  const runtime = new DolsotRuntime();
  assert.equal((await runtime.run('new-tool', 'var x = 40; x')).value, '40');
  runtime.addToolbox('mt', { add: { handler: ({ a, b }) => a + b } });
  const result = await runtime.run('new-tool', 'x + await mt.add({a: 1, b: 2})');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value, '43');
});

test('memory reset waits for an in-flight run before deleting the session', async () => {
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const release = new Promise(resolve => { releaseResolve = resolve; });
  const runtime = new DolsotRuntime({ toolboxes: { mt: { wait: { handler: async () => { enteredResolve(); await release; return 9; } } } } });
  await runtime.run('race', 'var x = 1; x');
  const running = runtime.run('race', 'x = await mt.wait({}); x');
  await entered;
  let resetDone = false;
  const resetting = runtime.reset('race').then(value => { resetDone = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(resetDone, false);
  releaseResolve();
  const [result, removed] = await Promise.all([running, resetting]);
  assert.equal(result.value, '9');
  assert.equal(removed, 1);
  assert.deepEqual(await runtime.sessions(), []);
});

test('reset all fences off a new in-flight session without waiting for host I/O', async () => {
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const release = new Promise(resolve => { releaseResolve = resolve; });
  const runtime = new DolsotRuntime({ toolboxes: { mt: { wait: { handler: async () => { enteredResolve(); await release; return 9; } } } } });
  const running = runtime.run('brand-new', 'var x = await mt.wait({}); x');
  await entered;
  assert.equal(await runtime.reset('all'), 0);
  releaseResolve();
  const result = await running;
  assert.equal(result.ok, false);
  assert.match(result.error, /reset while the cell was running/);
  assert.deepEqual(await runtime.sessions(), []);
});

test('disk reset all fences off a new in-flight session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dolsot-reset-all-'));
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const release = new Promise(resolve => { releaseResolve = resolve; });
  const runtime = new DolsotRuntime({ sessionDir: dir, toolboxes: { mt: { wait: { handler: async () => { enteredResolve(); await release; return 9; } } } } });
  try {
    const running = runtime.run('brand-new', 'var x = await mt.wait({}); x');
    await entered;
    assert.equal(await runtime.reset('all'), 0);
    releaseResolve();
    assert.match((await running).error, /reset while the cell was running/);
    assert.deepEqual(await runtime.sessions(), []);
  } finally {
    releaseResolve?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a cell with a pending toolbox request is not committed and aborts the host handler', async () => {
  let enteredResolve;
  let releaseResolve;
  let handlerSignal;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const release = new Promise(resolve => { releaseResolve = resolve; });
  const runtime = new DolsotRuntime({ toolboxes: { mt: { slow: { handler: async (_args, { signal }) => {
    handlerSignal = signal;
    enteredResolve();
    await release;
    return 9;
  } } } } });
  await runtime.run('pending', 'var baseline = 7; baseline');
  const result = await runtime.run('pending', 'var p = mt.slow({}); 42');
  await entered;
  assert.equal(result.ok, false);
  assert.match(result.error, /toolbox calls were still pending/);
  assert.equal(handlerSignal.aborted, true);
  releaseResolve();
  const after = await runtime.run('pending', 'typeof p + baseline');
  assert.equal(after.value, 'undefined7');
});

test('stored session totals are bounded', async () => {
  const runtime = new DolsotRuntime();
  for (let index = 0; index < 256; index += 1) runtime.memory.set(`existing-${index}`, Buffer.from('x'));
  const rejected = await runtime.run('overflow', '1 + 1');
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /session limit exceeded/);
  assert.throws(() => runtime.addToolbox('bad-alias', {}), /invalid toolbox alias/);
});

test('disk session totals are bounded before a new snapshot is started', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dolsot-session-cap-'));
  try {
    await Promise.all(Array.from({ length: 256 }, (_, index) => {
      const name = `${Buffer.from(`existing-${index}`).toString('base64url')}.state`;
      return writeFile(join(dir, name), Buffer.from('placeholder'), { mode: 0o600 });
    }));
    const runtime = new DolsotRuntime({ sessionDir: dir });
    const result = await runtime.run('overflow', '1 + 1');
    assert.equal(result.ok, false);
    assert.match(result.error, /session limit exceeded/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('active QuickJS workers are bounded across concurrent sessions', async () => {
  let active = 0;
  let peak = 0;
  let releaseResolve;
  const release = new Promise(resolve => { releaseResolve = resolve; });
  const runtime = new DolsotRuntime({ toolboxes: { mt: { wait: { handler: async () => {
    active += 1;
    peak = Math.max(peak, active);
    await release;
    active -= 1;
    return 1;
  } } } } });
  const runs = Array.from({ length: 6 }, (_, index) => runtime.run(`worker-${index}`, 'await mt.wait({})'));
  const until = Date.now() + 5_000;
  while (active < 4 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(active, 4);
  assert.equal(peak, 4);
  releaseResolve();
  const results = await Promise.all(runs);
  assert(results.every(result => result.ok));
  assert.equal(peak, 4);
});

test('the worker waiting queue rejects work after its configured capacity', async () => {
  const runtime = new DolsotRuntime();
  runtime.activeWorkers = 4;
  runtime.workerQueue = Array.from({ length: 64 }, () => () => {});
  const result = await runtime.run('queue-full', '1 + 1');
  assert.equal(result.ok, false);
  assert.match(result.error, /execution queue is full/);
  assert.equal(runtime.memory.has('queue-full'), false);
});
