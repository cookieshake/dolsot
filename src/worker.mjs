import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { QuickJS, EvalFlags } from 'quickjs-wasi';

const wasmBytes = await readFile(new URL(import.meta.resolve('quickjs-wasi/quickjs.wasm')));

process.once('message', async request => {
  let vm;
  let stdout = '';
  let truncated = false;
  let nextToolCall = 0;
  const pendingTools = new Map();
  try {
    const start = Date.now();
    const options = {
      wasm: wasmBytes,
      memoryLimit: request.memoryLimit,
      maxStackSize: request.maxStackSize,
      interruptHandler: () => Date.now() - start >= request.timeoutMs,
    };
    vm = request.snapshot
      ? await QuickJS.restore(QuickJS.deserializeSnapshot(request.snapshot), options)
      : await QuickJS.create(options);

    process.on('message', message => {
      if (message.type !== 'tool_result') return;
      const deferred = pendingTools.get(message.requestId);
      if (!deferred) return;
      pendingTools.delete(message.requestId);
      if (message.error) {
        const error = vm.newError(message.error);
        deferred.reject(error);
        error.dispose();
      } else {
        const value = vm.hostToHandle(message.result);
        deferred.resolve(value);
        value.dispose();
      }
      vm.executePendingJobs();
    });

    const print = (...args) => {
      const line = `${args.map(arg => arg.toString()).join(' ')}\n`;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(line) <= request.maxOutputBytes) stdout += line;
      else truncated = true;
      return vm.undefined;
    };
    if (request.snapshot) {
      vm.registerHostCallback('dolsot_print', print);
    } else {
      const printFunction = vm.newFunction('dolsot_print', print);
      vm.setProp(vm.global, 'print', printFunction);
      const consoleObject = vm.newObject();
      vm.setProp(consoleObject, 'log', printFunction);
      vm.setProp(consoleObject, 'error', printFunction);
      vm.setProp(vm.global, 'console', consoleObject);
      printFunction.dispose();
      consoleObject.dispose();
    }

    installToolboxes(vm, request.tools ?? [], Boolean(request.snapshot), pendingTools, () => ++nextToolCall);

    let value = null;
    let error = null;
    try {
      const evaluation = vm.evalCode(request.code, '<cell>', EvalFlags.ASYNC);
      vm.executePendingJobs();
      const settled = await vm.resolvePromise(evaluation);
      evaluation.dispose();
      if ('error' in settled) {
        error = settled.error.toString();
        settled.error.dispose();
      } else {
        // quickjs-wasi 3.6.3 resolves ASYNC global scripts to a completion
        // record whose `value` property is the cell's actual completion value.
        const completion = settled.value.getProp('value');
        const dumped = vm.dump(completion);
        value = dumped === undefined ? null : typeof dumped === 'string' ? dumped : JSON.stringify(dumped);
        if (value !== null && Buffer.byteLength(value) > request.maxOutputBytes) {
          value = Buffer.from(value).subarray(0, request.maxOutputBytes).toString('utf8');
          truncated = true;
        }
        completion.dispose();
        settled.value.dispose();
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }

    const pending = pendingTools.size > 0;
    if (pending) {
      const suffix = 'cell ended while toolbox calls were still pending';
      error = error ? `${error}; ${suffix}` : suffix;
    }
    const ok = error === null;
    const text = `${stdout}${value ?? ''}${error ? `${error}\n` : ''}`;
    const result = {
        ok,
        value,
        stdout,
        error,
        exit_code: ok ? 0 : 1,
        held: [],
        text,
        save_error: null,
        dropped: [],
        truncated,
      };
    if (pending) {
      process.send({ discardSnapshot: true, abortTools: true, result }, () => {
        vm.dispose();
        process.disconnect();
      });
      return;
    }
    const snapshot = QuickJS.serializeSnapshot(vm.snapshot());
    process.send({ snapshot: Buffer.from(snapshot), result }, () => {
      vm.dispose();
      process.disconnect();
    });
  } catch (cause) {
    process.send({ error: cause instanceof Error ? cause.message : String(cause) }, () => process.disconnect());
  }
});

function installToolboxes(vm, tools, restored, pending, nextCall) {
  const aliases = new Map();
  for (const item of tools) {
    if (!aliases.has(item.alias)) aliases.set(item.alias, []);
    aliases.get(item.alias).push(item);
    registerBridge(item.bridgeKey, item.alias, item.name);
  }
  for (const [alias, aliasTools] of aliases) {
    const genericKey = createHash('sha256').update(`${alias}\0__call__`).digest('hex');
    registerBridge(genericKey, alias, '__call__');
    const functions = aliasTools.map(item =>
      `${JSON.stringify(item.name)}: (...args) => ${callbackName(item.bridgeKey)}(args[0] ?? {})`,
    );
    const callTool = aliasTools.find(item => item.name === 'call');
    const callTarget = callTool ? callbackName(callTool.bridgeKey) : callbackName(genericKey);
    functions.push(`call: (name, args = {}) => typeof name === 'string' ? ${callbackName(genericKey)}(name, args) : ${callTarget}(name ?? {})`);
    if (!aliasTools.some(item => item.name === 'catalog')) {
      functions.push(`catalog: () => ${JSON.stringify(aliasTools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })))}`);
    }
    functions.push(`help: () => ${JSON.stringify(aliasTools.map(({ name, description }) => ({ name, description })))}`);
    const code = `globalThis[${JSON.stringify(alias)}] = Object.freeze({ ${functions.join(', ')} });`;
    const installed = vm.evalCode(code);
    installed.dispose();
  }

  function registerBridge(bridgeKey, alias, name) {
    const hostName = callbackName(bridgeKey);
    const callback = (...args) => {
      const requestId = `${process.pid}-${nextCall()}`;
      const deferred = vm.newPromise();
      pending.set(requestId, deferred);
      const toolName = name === '__call__' ? args[0]?.toString() : name;
      const argHandle = name === '__call__' ? args[1] : args[0];
      let input = argHandle ? vm.dump(argHandle) : {};
      if (input === undefined || input === null) input = {};
      process.send({ type: 'tool_call', requestId, bridgeKey, alias, toolName, arguments: input });
      return deferred.handle;
    };
    if (restored) {
      try {
        const existing = vm.getProp(vm.global, hostName);
        const exists = vm.dump(existing) !== undefined;
        existing.dispose();
        if (exists) {
          vm.registerHostCallback(hostName, callback);
          return;
        }
      } catch {
        // Install a new guest function when this bridge did not exist in the snapshot.
      }
    }
    const fn = vm.newFunction(hostName, callback);
    vm.setProp(vm.global, hostName, fn);
    fn.dispose();
  }
}

function callbackName(key) {
  return `__dolsot_bridge_${Buffer.from(key).toString('hex')}`;
}
