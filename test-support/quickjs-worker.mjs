import { readFile, writeFile } from 'node:fs/promises';
import { QuickJS, EvalFlags } from 'quickjs-wasi';

const [mode, snapshotPath, cellBase64] = process.argv.slice(2);
const wasmBytes = await readFile(new URL(import.meta.resolve('quickjs-wasi/quickjs.wasm')));

function registerHostAdd(vm) {
  vm.registerHostCallback('dolsot_host_add', (...args) =>
    vm.newNumber(args[0].toNumber() + args[1].toNumber()),
  );
}

if (mode === 'init') {
  const vm = await QuickJS.create(wasmBytes);
  try {
    const hostAdd = vm.newFunction('dolsot_host_add', (...args) =>
      vm.newNumber(args[0].toNumber() + args[1].toNumber()),
    );
    vm.setProp(vm.global, 'hostAdd', hostAdd);
    hostAdd.dispose();

    const initialCell = vm.evalCode(`
      var total = 40;
      let multiplier = 2;
      function scale(value) { return value * multiplier; }
      globalThis.note = 'state survived a process boundary';
    `);
    initialCell.dispose();
    await writeFile(snapshotPath, QuickJS.serializeSnapshot(vm.snapshot()));
  } finally {
    vm.dispose();
  }
  process.exit(0);
}

const snapshot = QuickJS.deserializeSnapshot(await readFile(snapshotPath));
const vm = await QuickJS.restore(snapshot, wasmBytes);
registerHostAdd(vm);

if (mode === 'hang') {
  process.stdout.write('READY\n');
  vm.evalCode('while (true) {}');
  process.exit(91);
}

try {
  const cell = Buffer.from(cellBase64, 'base64').toString('utf8');
  const promise = vm.evalCode(cell, '<test-cell>', EvalFlags.ASYNC);
  vm.executePendingJobs();
  const settled = await vm.resolvePromise(promise);
  promise.dispose();
  if ('error' in settled) {
    const error = settled.error.toString();
    settled.error.dispose();
    throw new Error(error);
  }
  const completionValue = settled.value.getProp('value');
  process.stdout.write(`${JSON.stringify({
    raw: vm.dump(settled.value),
    value: vm.dump(completionValue),
  })}\n`);
  completionValue.dispose();
  settled.value.dispose();
} finally {
  vm.dispose();
}
