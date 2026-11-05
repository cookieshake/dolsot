import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, '..', 'test-support', 'quickjs-worker.mjs');

function runWorker(mode, snapshotPath, cell = '') {
  return execFileSync(process.execPath, [worker, mode, snapshotPath, Buffer.from(cell).toString('base64')], {
    encoding: 'utf8',
    timeout: 15_000,
  }).trim();
}

test('snapshot restores globals, lexical closures, async completion, and named host callbacks in a fresh process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dolsot-qjs-gate-'));
  const snapshotPath = join(dir, 'state.bin');
  try {
    runWorker('init', snapshotPath);
    const value = runWorker('run', snapshotPath, `
      await Promise.resolve(hostAdd(scale(total), 2));
    `);
    assert.equal(value, '{"raw":{"value":82},"value":82}');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parent kill leaves the last committed snapshot byte-for-byte restorable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dolsot-qjs-kill-gate-'));
  const snapshotPath = join(dir, 'state.bin');
  try {
    runWorker('init', snapshotPath);
    const before = await readFile(snapshotPath);
    const hashBefore = createHash('sha256').update(before).digest('hex');
    const child = spawn(process.execPath, [worker, 'hang', snapshotPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    const exitPromise = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker did not become ready')), 10_000);
      child.stdout.on('data', chunk => {
        if (chunk.includes('READY\n')) {
          clearTimeout(timer);
          child.kill('SIGKILL');
          resolve();
        }
      });
      child.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const exit = await exitPromise;
    assert.equal(exit.signal, 'SIGKILL');

    const after = await readFile(snapshotPath);
    assert.equal(createHash('sha256').update(after).digest('hex'), hashBefore);
    assert.equal(runWorker('run', snapshotPath, 'total'), '{"raw":{"value":40},"value":40}');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
