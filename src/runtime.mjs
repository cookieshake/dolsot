import { fork } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import Ajv from 'ajv';

const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_CODE_BYTES = 256 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const DEFAULT_OUTPUT_BYTES = 32 * 1024;
const MAX_TOOL_CALLS = 100;
const MAX_TOOL_BYTES = 1024 * 1024;
const MAX_TOOL_CONCURRENCY = 4;
const MAX_ACTIVE_WORKERS = 4;
const MAX_QUEUED_WORKERS = 64;
const MAX_SESSIONS = 256;
const TOOL_ALIAS = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ajv = new Ajv({ allErrors: true, strict: false });
const SNAPSHOT_MAGIC = Buffer.from('DOLSOT2\0');
const WASM_HASH = createHash('sha256')
  .update(await readFile(new URL(import.meta.resolve('quickjs-wasi/quickjs.wasm'))))
  .digest('hex');
const SNAPSHOT_METADATA = JSON.stringify({ format: 1, dolsot: '2.0.0-alpha.0', quickjs: '3.6.3', wasmSha256: WASM_HASH, bridgeAbi: 1 });
const SNAPSHOT_METADATA_BYTES = Buffer.from(SNAPSHOT_METADATA, 'utf8');
const DEFAULT_TIMEOUT_MS = 20_000;
const MEMORY_LIMIT = 32 * 1024 * 1024;
const MAX_STACK_SIZE = 256 * 1024;

function validateSession(session) {
  if (typeof session !== 'string' || !SESSION_ID.test(session) || session === '.' || session === '..') {
    throw new TypeError('session must be 1–128 ASCII letters, digits, dots, underscores, or hyphens');
  }
}

function keyName(session) {
  return createHash('sha256').update(session).digest('hex');
}

export class DolsotRuntime {
  constructor({ sessionDir = process.env.DOLSOT_SESSION_DIR, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = process.env.DOLSOT_MAX_OUTPUT_BYTES === undefined ? DEFAULT_OUTPUT_BYTES : Number(process.env.DOLSOT_MAX_OUTPUT_BYTES), toolboxes = {} } = {}) {
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
      throw new RangeError('maxOutputBytes / DOLSOT_MAX_OUTPUT_BYTES must be a positive safe integer');
    }
    this.maxOutputBytes = maxOutputBytes;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20 * 60_000) {
      throw new RangeError('timeoutMs must be between 1 and 1200000');
    }
    if (sessionDir !== undefined && (typeof sessionDir !== 'string' || sessionDir.length === 0)) {
      throw new TypeError('DOLSOT_SESSION_DIR must be a non-empty path when set');
    }
    if (sessionDir !== undefined && !isAbsolute(sessionDir)) {
      throw new TypeError('DOLSOT_SESSION_DIR must be an absolute path');
    }
    this.sessionDir = sessionDir === undefined ? null : resolve(sessionDir);
    this.timeoutMs = timeoutMs;
    this.memory = new Map();
    this.localLocks = new Map();
    this.storeLock = Promise.resolve();
    this.storeWaiters = 0;
    this.resetEpoch = 0;
    this.sessionReservations = new Set();
    this.activeWorkers = 0;
    this.activeToolCalls = 0;
    this.workerQueue = [];
    this.toolboxes = new Map();
    for (const [alias, tools] of Object.entries(toolboxes)) this.addToolbox(alias, tools);
  }

  addToolbox(alias, tools) {
    if (!TOOL_ALIAS.test(alias)) throw new TypeError(`invalid toolbox alias: ${alias}`);
    if (alias === 'help') throw new TypeError('toolbox alias help is reserved for global help()');
    if (!tools || typeof tools !== 'object' || Array.isArray(tools)) throw new TypeError('toolbox must be an object');
    const entries = new Map();
    for (const [name, spec] of Object.entries(tools)) {
      if (!spec || typeof spec.handler !== 'function') throw new TypeError(`tool ${name} requires a handler function`);
      const inputSchema = spec.inputSchema ?? { type: 'object', additionalProperties: true };
      const validate = ajv.compile(inputSchema);
      entries.set(name, {
        alias,
        name,
        description: String(spec.description ?? ''),
        inputSchema,
        examples: Array.isArray(spec.examples) ? spec.examples.map(String) : [],
        validate,
        handler: spec.handler,
      });
    }
    this.toolboxes.set(alias, entries);
  }

  async run(session, code, { timeoutMs = this.timeoutMs } = {}) {
    validateSession(session);
    if (typeof code !== 'string' || code.trim().length === 0) throw new TypeError('code must not be empty');
    if (Buffer.byteLength(code) > MAX_CODE_BYTES) throw new RangeError(`code exceeds ${MAX_CODE_BYTES} bytes`);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20 * 60_000) {
      throw new RangeError('timeoutMs must be between 1 and 1200000');
    }

    return this.#withLock(session, async () => {
      let runEpoch;
      let previous;
      let reserved = false;
      const admitted = await this.#withStoreLock(async () => {
        runEpoch = await this.#readEpoch();
        previous = await this.#read(session);
        if (previous !== null) return true;
        const count = this.sessionDir === null ? this.memory.size : (await this.sessions()).length;
        if (!this.sessionReservations.has(session) && count + this.sessionReservations.size >= MAX_SESSIONS) return false;
        if (!this.sessionReservations.has(session)) {
          this.sessionReservations.add(session);
          reserved = true;
        }
        return true;
      });
      if (!admitted) {
        const error = `session limit exceeded (${MAX_SESSIONS})`;
        return { ok: false, value: null, stdout: '', error, exit_code: 1, held: [], text: `${error}\n`, save_error: null, dropped: [], truncated: false };
      }
      try {
      let response;
      try {
        response = await this.#execute(code, previous, timeoutMs);
      } catch (cause) {
        return {
          ok: false, value: null, stdout: '', error: cause.message, exit_code: 1,
          held: [], text: `${cause.message}\n`, save_error: null, dropped: [], truncated: false,
        };
      }
      if (response.exitCode === 124) {
        return {
          ok: false, value: null, stdout: response.stdout, error: 'cell timed out', exit_code: 124,
          held: [], text: `${response.stdout}cell timed out\n`, save_error: null, dropped: [], truncated: false,
        };
      }
      if (response.error) {
        return {
          ok: false, value: null, stdout: response.stdout ?? '', error: response.error, exit_code: 1,
          held: [], text: `${response.stdout ?? ''}${response.error}\n`, save_error: null, dropped: [], truncated: false,
        };
      }
      try {
        const committed = await this.#withStoreLock(async () => {
          if (await this.#readEpoch() !== runEpoch) return 'reset';
          if (previous === null && this.sessionDir !== null && (await this.sessions()).length >= MAX_SESSIONS) return 'limit';
          await this.#write(session, response.snapshot);
          return 'saved';
        });
        if (committed === 'reset') {
          const error = 'session was reset while the cell was running; result was not saved';
          return { ...response.result, ok: false, error, exit_code: 1, text: `${response.result.text}${error}\n` };
        }
        if (committed === 'limit') {
          const error = `session limit exceeded (${MAX_SESSIONS}); result was not saved`;
          return { ...response.result, ok: false, error, exit_code: 1, text: `${response.result.text}${error}\n` };
        }
        return response.result;
      } catch (cause) {
        return {
          ...response.result,
          ok: false,
          error: `session save failed: ${cause.message}`,
          exit_code: 1,
          save_error: cause.message,
          text: `${response.result.text}session save failed: ${cause.message}\n`,
        };
      }
      } finally {
        if (reserved) await this.#withStoreLock(() => this.sessionReservations.delete(session));
      }
    });
  }

  async sessions() {
    if (this.sessionDir === null) {
      return [...this.memory.keys()].sort().map(id => ({ id, size_bytes: this.memory.get(id).byteLength }));
    }
    await this.#ensureStore();
    const files = await readdir(this.sessionDir, { withFileTypes: true });
    const sessions = [];
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.state')) continue;
      const id = Buffer.from(file.name.slice(0, -6), 'base64url').toString('utf8');
      if (!SESSION_ID.test(id)) continue;
      const info = await stat(join(this.sessionDir, file.name));
      sessions.push({ id, size_bytes: info.size, last_used: info.mtime.toISOString() });
    }
    return sessions.sort((a, b) => a.id.localeCompare(b.id));
  }

  async reset(session) {
    if (session !== 'all') validateSession(session);
    if (this.sessionDir === null) {
      if (session === 'all') {
        return this.#withStoreLock(async () => {
          this.resetEpoch += 1;
          const ids = [...this.memory.keys()];
          let count = 0;
          for (const id of ids) count += await this.#remove(id);
          this.sessionReservations.clear();
          return count;
        });
      }
      return this.#withLock(session, () => this.#withStoreLock(() => this.#remove(session)));
    }
    await this.#ensureStore();
    if (session === 'all') {
      return this.#withStoreLock(async () => {
        const epoch = (await this.#readEpoch()) + 1;
        await this.#writeEpoch(epoch);
        const items = await this.sessions();
        let count = 0;
        for (const item of items) count += await this.#remove(item.id);
        this.sessionReservations.clear();
        return count;
      });
    }
    return this.#withLock(session, () => this.#withStoreLock(() => this.#remove(session)));
  }

  async #readEpoch() {
    if (this.sessionDir === null) return this.resetEpoch;
    try {
      const value = Number(await readFile(join(this.sessionDir, '.reset-epoch'), 'utf8'));
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid session reset epoch');
      return value;
    } catch (cause) {
      if (cause.code === 'ENOENT') return 0;
      throw cause;
    }
  }

  async #writeEpoch(epoch) {
    if (this.sessionDir === null) {
      this.resetEpoch = epoch;
      return;
    }
    const target = join(this.sessionDir, '.reset-epoch');
    const temporary = join(this.sessionDir, `.reset-epoch.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    let renamed = false;
    try {
      await handle.writeFile(String(epoch));
      await handle.sync();
      await handle.close();
      await rename(temporary, target);
      renamed = true;
    } finally {
      if (renamed === false) {
        await handle.close().catch(() => {});
        await rm(temporary, { force: true });
      }
    }
    const directory = await open(this.sessionDir, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async #withStoreLock(callback) {
    if (this.storeWaiters >= MAX_QUEUED_WORKERS) throw new Error('session store operation queue is full');
    this.storeWaiters += 1;
    if (this.sessionDir !== null) {
      try {
        await this.#ensureStore();
        const target = join(this.sessionDir, '.store.lockref');
        const handle = await open(target, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
        await handle.close();
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error('session store lock must be a private regular file');
        const release = await lockfile.lock(target, { stale: 30_000, update: 10_000, retries: { retries: 240, minTimeout: 25, maxTimeout: 250 } });
        try { return await callback(); } finally { await release(); }
      } finally {
        this.storeWaiters -= 1;
      }
    }

    const previous = this.storeLock;
    let unlock;
    const current = new Promise(resolveUnlock => { unlock = resolveUnlock; });
    this.storeLock = previous.then(() => current);
    await previous;
    try { return await callback(); } finally {
      unlock();
      this.storeWaiters -= 1;
    }
  }

  async #acquireWorker() {
    if (this.activeWorkers < MAX_ACTIVE_WORKERS) {
      this.activeWorkers += 1;
      return;
    }
    if (this.workerQueue.length >= MAX_QUEUED_WORKERS) throw new Error('execution queue is full');
    await new Promise(resolve => this.workerQueue.push(resolve));
  }

  #releaseWorker() {
    const next = this.workerQueue.shift();
    if (next) next();
    else this.activeWorkers -= 1;
  }

  async #withLock(session, callback) {
    if (this.sessionDir !== null) {
      await this.#ensureStore();
      const lockTarget = join(this.sessionDir, `${keyName(session)}.lockref`);
      const handle = await open(lockTarget, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
      await handle.close();
      const lockInfo = await lstat(lockTarget);
      if (!lockInfo.isFile() || lockInfo.isSymbolicLink() || (lockInfo.mode & 0o077) !== 0) {
        throw new Error('session lock file must be a private regular file');
      }
      const release = await lockfile.lock(lockTarget, {
        stale: 30_000,
        update: 10_000,
        retries: { retries: 240, minTimeout: 25, maxTimeout: 250 },
      });
      try {
        return await callback();
      } finally {
        await release();
      }
    }

    const previous = this.localLocks.get(session) ?? Promise.resolve();
    let unlock;
    const current = new Promise(resolveUnlock => { unlock = resolveUnlock; });
    const tail = previous.then(() => current);
    this.localLocks.set(session, tail);
    await previous;
    try {
      return await callback();
    } finally {
      unlock();
      if (this.localLocks.get(session) === tail) this.localLocks.delete(session);
    }
  }

  async #read(session) {
    if (this.sessionDir === null) {
      const stored = this.memory.get(session);
      return stored ? decodeSnapshot(stored) : null;
    }
    try {
      const path = join(this.sessionDir, `${Buffer.from(session).toString('base64url')}.state`);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error('session snapshot must be a private regular file');
      if (info.size > MAX_SNAPSHOT_BYTES) throw new RangeError('stored snapshot exceeds 64 MiB');
      return decodeSnapshot(await readFile(path));
    } catch (cause) {
      if (cause.code === 'ENOENT') return null;
      throw cause;
    }
  }

  async #write(session, snapshot) {
    const encodedSnapshot = encodeSnapshot(snapshot);
    if (encodedSnapshot.byteLength > MAX_SNAPSHOT_BYTES) throw new RangeError('snapshot exceeds 64 MiB');
    if (this.sessionDir === null) {
      this.memory.set(session, encodedSnapshot);
      return;
    }
    const target = join(this.sessionDir, `${Buffer.from(session).toString('base64url')}.state`);
    const temporary = join(this.sessionDir, `.${keyName(session)}.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    let renamed = false;
    let handleOpen = true;
    try {
      await handle.writeFile(encodedSnapshot);
      await handle.sync();
      await handle.close();
      handleOpen = false;
      await rename(temporary, target);
      renamed = true;
    } finally {
      if (handleOpen) await handle.close();
      if (!renamed) await rm(temporary, { force: true });
    }
    const directory = await open(dirname(target), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async #remove(session) {
    if (this.sessionDir === null) return this.memory.delete(session) ? 1 : 0;
    const target = join(this.sessionDir, `${Buffer.from(session).toString('base64url')}.state`);
    try {
      await rm(target);
      return 1;
    } catch (cause) {
      if (cause.code === 'ENOENT') return 0;
      throw cause;
    }
  }

  async #ensureStore() {
    await mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
    const info = await lstat(this.sessionDir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('DOLSOT_SESSION_DIR must be a real directory');
    if ((info.mode & 0o077) !== 0) throw new Error('DOLSOT_SESSION_DIR must not grant group or other access');
  }

  async #execute(code, snapshot, timeoutMs) {
    await this.#acquireWorker();
    try {
      return await new Promise((resolve, reject) => {
      const child = fork(workerPath, [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'advanced',
        env: {},
        execArgv: [],
      });
      let settled = false;
      let toolCalls = 0;
      let activeTools = 0;
      const toolAbortController = new AbortController();
      const deadline = Date.now() + timeoutMs;
      const toolSpecs = new Map();
      const serializedTools = [];
      for (const [alias, entries] of this.toolboxes) {
        const genericKey = createHash('sha256').update(`${alias}\0__call__`).digest('hex');
        toolSpecs.set(genericKey, { alias, name: '__call__' });
        for (const spec of entries.values()) {
          const bridgeKey = createHash('sha256').update(`${alias}\0${spec.name}`).digest('hex');
          toolSpecs.set(bridgeKey, spec);
          serializedTools.push({
            alias,
            name: spec.name,
            description: spec.description,
            inputSchema: spec.inputSchema,
            examples: spec.examples,
            bridgeKey,
          });
        }
      }
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        toolAbortController.abort(new Error('cell timed out'));
        child.kill('SIGKILL');
        resolve({ exitCode: 124, stdout: '' });
      }, timeoutMs);
      child.on('message', message => {
        if (settled) return;
        if (message.type === 'tool_call') {
          toolCalls += 1;
          let spec = toolSpecs.get(message.bridgeKey);
          if (spec?.name === '__call__') spec = this.toolboxes.get(message.alias)?.get(message.toolName);
          const respond = body => {
            if (!settled && child.connected) child.send({ type: 'tool_result', requestId: message.requestId, ...body });
          };
          if (toolCalls > MAX_TOOL_CALLS) {
            respond({ error: 'tool call limit exceeded' });
            return;
          }
          if (!spec || spec.alias !== message.alias || spec.name !== message.toolName) {
            respond({ error: 'TOOLBOX_TOOL_UNAVAILABLE: local toolbox method is unavailable; see <toolbox>.help()' });
            return;
          }
          if (activeTools >= MAX_TOOL_CONCURRENCY || this.activeToolCalls >= MAX_TOOL_CONCURRENCY * MAX_ACTIVE_WORKERS) {
            respond({ error: 'tool concurrency limit exceeded' });
            return;
          }
          let encodedArgs;
          try {
            encodedArgs = JSON.stringify(message.arguments ?? {});
            if (Buffer.byteLength(encodedArgs) > MAX_TOOL_BYTES) throw new Error('tool arguments exceed 1 MiB');
            if (!spec.validate(message.arguments ?? {})) throw new Error(`${spec.alias === 'mcp' ? 'MCP_INVALID_ARGUMENTS' : 'TOOLBOX_INVALID_ARGUMENTS'}: tool arguments do not match the input schema; see ${spec.alias}.help()`);
          } catch (error) {
            respond({ error: error.message });
            return;
          }
          activeTools += 1;
          this.activeToolCalls += 1;
          Promise.resolve().then(() => spec.handler(message.arguments ?? {}, { signal: toolAbortController.signal, deadline })).then(result => {
            const encoded = JSON.stringify(result ?? null);
            if (Buffer.byteLength(encoded) > MAX_TOOL_BYTES) throw new Error('tool result exceeds 1 MiB');
            respond({ result: result ?? null });
          }).catch(error => {
            respond({ error: error instanceof Error ? error.message : String(error) });
          }).finally(() => {
            activeTools -= 1;
            this.activeToolCalls -= 1;
          });
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (message.abortTools) toolAbortController.abort(new Error(message.result?.error ?? 'cell ended with pending toolbox calls'));
        resolve(message.discardSnapshot
          ? { error: message.result?.error ?? 'cell ended with pending toolbox calls', stdout: message.result?.stdout ?? '' }
          : message.error ? { error: message.error } : { snapshot: message.snapshot, result: message.result });
      });
      child.once('error', cause => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        toolAbortController.abort(cause);
        reject(cause);
      });
      child.once('exit', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        toolAbortController.abort(new Error('worker exited'));
        reject(new Error(`worker exited before returning a result (${signal ?? code})`));
      });
      child.send({
        code,
        snapshot,
        timeoutMs,
        memoryLimit: MEMORY_LIMIT,
        maxStackSize: MAX_STACK_SIZE,
        maxOutputBytes: this.maxOutputBytes,
        tools: serializedTools,
      });
      });
    } finally {
      this.#releaseWorker();
    }
  }
}

function encodeSnapshot(snapshot) {
  const header = Buffer.alloc(SNAPSHOT_MAGIC.length + 4 + SNAPSHOT_METADATA_BYTES.length);
  SNAPSHOT_MAGIC.copy(header, 0);
  header.writeUInt32BE(SNAPSHOT_METADATA_BYTES.length, SNAPSHOT_MAGIC.length);
  SNAPSHOT_METADATA_BYTES.copy(header, SNAPSHOT_MAGIC.length + 4);
  return Buffer.concat([header, Buffer.from(snapshot)]);
}

function decodeSnapshot(data) {
  const offset = SNAPSHOT_MAGIC.length;
  if (data.length < offset + 4 || !data.subarray(0, offset).equals(SNAPSHOT_MAGIC)) throw new Error('invalid dolsot session snapshot header');
  const metadataLength = data.readUInt32BE(offset);
  const metadataStart = offset + 4;
  const snapshotStart = metadataStart + metadataLength;
  if (metadataLength > 4096 || snapshotStart >= data.length) throw new Error('invalid dolsot session snapshot metadata');
  let metadata;
  try { metadata = JSON.parse(data.subarray(metadataStart, snapshotStart).toString('utf8')); } catch { throw new Error('invalid dolsot session snapshot metadata'); }
  if (JSON.stringify(metadata) !== SNAPSHOT_METADATA) throw new Error('session snapshot runtime version does not match this dolsot build');
  return data.subarray(snapshotStart);
}
