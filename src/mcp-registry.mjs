import { readFile } from 'node:fs/promises';
import { createHmac, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { EmbeddingSearch, reciprocalRankFusion } from './embedding-search.mjs';

const ajv = new Ajv({ allErrors: true, strict: false });
const MAX_PAGES = 100;
const MAX_TOOLS = 1000;
const MAX_CATALOG_BYTES = 10 * 1024 * 1024;
const MAX_LIMIT = 50;
const MAX_REFRESH_SERVER_MS = 30_000;
const SEARCH_MODES = ['bm25', 'vector', 'hybrid'];

function validateSearchMode(mode, source = 'mode') {
  if (!SEARCH_MODES.includes(mode)) {
    throw new TypeError(`${source} must be one of: ${SEARCH_MODES.join(', ')}`);
  }
  return mode;
}

export async function openMcpRegistry(configPath = process.env.DOLSOT_MCP_CONFIG) {
  if (configPath === undefined) return null;
  if (!configPath) throw new TypeError('DOLSOT_MCP_CONFIG must name a config file');
  const parsed = JSON.parse(await readFile(resolve(configPath), 'utf8'));
  return McpRegistry.open(parsed);
}

export class McpRegistry {
  static async open(config) {
    if (!config || !Array.isArray(config.servers)) throw new TypeError('MCP config must contain a servers array');
    const interval = Number(process.env.DOLSOT_MCP_REFRESH_INTERVAL_MS ?? 300_000);
    if (!Number.isInteger(interval) || interval < 1_000 || interval > 86_400_000) {
      throw new RangeError('DOLSOT_MCP_REFRESH_INTERVAL_MS must be between 1000 and 86400000');
    }
    const refreshTimeout = Number(process.env.DOLSOT_MCP_REFRESH_TIMEOUT_MS ?? MAX_REFRESH_SERVER_MS);
    if (!Number.isInteger(refreshTimeout) || refreshTimeout < 1_000 || refreshTimeout > 300_000) {
      throw new RangeError('DOLSOT_MCP_REFRESH_TIMEOUT_MS must be between 1000 and 300000');
    }
    const registry = new McpRegistry(interval, refreshTimeout);
    for (const spec of config.servers) registry.#addServer(spec);
    try {
      await Promise.all([...registry.servers.values()].map(state => registry.#connect(state)));
      await registry.refresh();
    } catch (error) {
      await registry.close();
      throw error;
    }
    registry.timer = setInterval(() => { void registry.refresh().catch(() => {}); }, interval);
    registry.timer.unref?.();
    return registry;
  }

  constructor(intervalMs, refreshTimeoutMs = MAX_REFRESH_SERVER_MS, searchMode = process.env.DOLSOT_SEARCH_MODE ?? 'hybrid') {
    this.intervalMs = intervalMs;
    this.refreshTimeoutMs = refreshTimeoutMs;
    this.searchMode = validateSearchMode(searchMode, 'DOLSOT_SEARCH_MODE');
    this.servers = new Map();
    this.catalog = new Map();
    this.catalogRevision = 0;
    this.cursorRevision = 0;
    this.status = new Map();
    this.pendingRefresh = new Set();
    this.refreshPromise = null;
    this.processingRefresh = new Set();
    this.refreshQueue = [];
    this.activeRefresh = null;
    this.debounceTimer = null;
    this.timer = null;
    this.cursorSecret = randomBytes(32);
    this.permissionFingerprints = new Map();
    this.activeCalls = new Set();
    this.inflightCalls = new Set();
    this.embeddingSearch = new EmbeddingSearch();
    this.closed = false;
  }

  #addServer(spec) {
    if (!spec || typeof spec.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(spec.id)) {
      throw new TypeError('MCP server id must be 1–64 ASCII letters, digits, dots, underscores, or hyphens');
    }
    if (this.servers.has(spec.id)) throw new TypeError(`duplicate MCP server id: ${spec.id}`);
    if (spec.transport !== 'http' && spec.transport !== 'stdio') throw new TypeError(`unsupported transport for ${spec.id}`);
    if (spec.transport === 'http' && !['http:', 'https:'].includes(new URL(spec.url).protocol)) {
      throw new TypeError(`MCP server ${spec.id} URL must use HTTP or HTTPS`);
    }
    if (spec.transport === 'stdio' && (typeof spec.command !== 'string' || !spec.command)) {
      throw new TypeError(`MCP server ${spec.id} requires a stdio command`);
    }
    const allowedTools = spec.allowedTools === undefined ? null : new Set(spec.allowedTools);
    this.servers.set(spec.id, {
      spec,
      allowedTools,
      client: null,
      transport: null,
      tools: new Map(),
      state: 'connecting',
      errorCode: null,
      lastRefreshAt: null,
      retryAttempt: 0,
      retryTimer: null,
      reconnectTimer: null,
      refreshController: null,
    });
    this.status.set(spec.id, { serverId: spec.id, state: 'connecting', stale: false, lastRefreshAt: null });
  }

  async #connect(state) {
    if (this.closed) return;
    try {
      const { spec } = state;
      let transport;
      if (spec.transport === 'http') {
        const headers = {};
        for (const [header, envName] of Object.entries(spec.headerEnv ?? {})) {
          const value = process.env[envName];
          if (value === undefined) throw new Error(`missing environment variable for header ${header}`);
          headers[header] = value;
        }
        transport = new StreamableHTTPClientTransport(new URL(spec.url), {
          requestInit: { headers },
          reconnectionOptions: { maxReconnectionDelay: 30_000, initialReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 2, maxRetries: 5 },
        });
      } else {
        const env = {};
        for (const [key, source] of Object.entries(spec.envFrom ?? {})) {
          if (process.env[source] === undefined) throw new Error(`missing environment variable ${source}`);
          env[key] = process.env[source];
        }
        transport = new StdioClientTransport({
          command: spec.command,
          args: spec.args ?? [],
          env,
          stderr: 'ignore',
        });
      }
      const client = new Client({ name: 'dolsot', version: '1.0.0-alpha.1' }, {
        capabilities: {},
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 0,
            onChanged: () => this.#scheduleNotificationRefresh(spec.id),
          },
        },
      });
      transport.onclose = () => {
        if (state.transport === transport) {
          state.client = null;
          state.transport = null;
          state.state = 'failed';
          const prior = this.status.get(spec.id) ?? {};
          this.status.set(spec.id, { ...prior, serverId: spec.id, state: 'failed', stale: state.tools.size > 0, errorCode: 'CONNECTION_CLOSED' });
        }
        this.#scheduleReconnect(state);
      };
      await client.connect(transport);
      state.client = client;
      state.transport = transport;
      state.state = 'ready';
      state.errorCode = null;
      state.retryAttempt = 0;
      state.reconnectAttempt = 0;
      const prior = this.status.get(spec.id) ?? {};
      this.status.set(spec.id, { ...prior, serverId: spec.id, state: 'ready', stale: false, errorCode: null });
    } catch (error) {
      state.client = null;
      state.transport = null;
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
      state.state = 'failed';
      state.errorCode = 'CONNECT_FAILED';
      this.status.set(state.spec.id, {
        ...this.status.get(state.spec.id),
        serverId: state.spec.id,
        state: 'failed',
        stale: state.tools.size > 0,
        errorCode: 'CONNECT_FAILED',
      });
      this.#scheduleRetry(state);
    }
  }

  #scheduleNotificationRefresh(serverId) {
    if (this.closed) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.pendingRefresh.add(serverId);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.#drainRefreshes().catch(() => {});
    }, 250);
    this.debounceTimer.unref?.();
  }

  #scheduleReconnect(state) {
    if (this.closed || state.reconnectTimer || state.retryTimer) return;
    state.reconnectAttempt = (state.reconnectAttempt ?? 0) + 1;
    const base = Math.min(60_000, 1_000 * 2 ** Math.min(state.reconnectAttempt - 1, 6));
    state.reconnectTimer = setTimeout(async () => {
      state.reconnectTimer = null;
      await this.#connect(state);
      if (state.state === 'ready' && !this.closed) await this.refresh(state.spec.id).catch(() => {});
    }, base + Math.floor(Math.random() * Math.min(base / 4, 5_000)));
    state.reconnectTimer.unref?.();
  }

  #scheduleRetry(state) {
    if (this.closed || state.retryTimer) return;
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    state.retryAttempt += 1;
    const base = Math.min(60_000, 1_000 * 2 ** Math.min(state.retryAttempt - 1, 6));
    state.retryTimer = setTimeout(async () => {
      state.retryTimer = null;
      if (!state.client) {
        await this.#connect(state);
        if (state.client) await this.refresh(state.spec.id).catch(() => {});
      } else {
        await this.refresh(state.spec.id).catch(() => {});
      }
    }, base + Math.floor(Math.random() * Math.min(base / 4, 5_000)));
    state.retryTimer.unref?.();
  }

  async refresh(serverId, { signal, deadline } = {}) {
    if (this.closed) throw new Error('MCP registry is closed');
    const ids = serverId === undefined ? [...this.servers.keys()] : [serverId];
    if (ids.some(id => !this.servers.has(id))) throw new Error('MCP server is unavailable');
    return this.#subscribeRefresh(ids, { signal, deadline });
  }

  #subscribeRefresh(ids, { signal, deadline, followup = false } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('refresh cancelled'));
    if (deadline !== undefined && !Number.isFinite(deadline)) return Promise.reject(new TypeError('refresh deadline must be a finite epoch timestamp'));
    const expiresAt = Math.min(Date.now() + this.refreshTimeoutMs, deadline ?? Infinity);
    if (expiresAt <= Date.now()) return Promise.reject(refreshTimeoutError());
    // A caller subscribes to one fixed batch, never to the scheduler's drain loop.
    let batch = !followup && this.activeRefresh && !this.activeRefresh.completed && !this.activeRefresh.controller.signal.aborted
      && ids.every(id => this.activeRefresh.ids.has(id)) ? this.activeRefresh : null;
    batch ??= this.refreshQueue.find(item => ids.every(id => item.ids.has(id)));
    if (!batch) {
      batch = { ids: new Set(ids), waiters: new Set(), controller: new AbortController() };
      this.refreshQueue.push(batch);
    }
    const promise = new Promise((resolve, reject) => {
      const waiter = { ids, resolve, reject, signal, timer: null, onAbort: null };
      const cancel = reason => {
        if (!batch.waiters.delete(waiter)) return;
        this.#cleanRefreshWaiter(waiter);
        reject(reason);
        if (batch.waiters.size === 0) {
          batch.controller.abort(new Error('refresh has no subscribers'));
          this.refreshQueue = this.refreshQueue.filter(item => item !== batch);
        }
      };
      waiter.onAbort = () => cancel(signal.reason ?? new Error('refresh cancelled'));
      waiter.timer = setTimeout(() => cancel(refreshTimeoutError()), expiresAt - Date.now());
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      batch.waiters.add(waiter);
    });
    this.#startRefreshBatch();
    return promise;
  }

  #cleanRefreshWaiter(waiter) {
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
  }

  #startRefreshBatch() {
    if (this.closed || this.activeRefresh) return;
    const batch = this.refreshQueue.shift();
    if (!batch) return;
    this.activeRefresh = batch;
    this.processingRefresh = batch.ids;
    const work = this.#collectRefreshBatch(batch);
    this.refreshPromise = work;
    void work.then(result => {
      batch.completed = true;
      for (const waiter of batch.waiters) {
        this.#cleanRefreshWaiter(waiter);
        waiter.resolve(this.#projectRefreshResult(result, waiter.ids));
      }
    }, error => {
      batch.completed = true;
      for (const waiter of batch.waiters) {
        this.#cleanRefreshWaiter(waiter);
        waiter.reject(error);
      }
    }).finally(() => {
      batch.waiters.clear();
      this.activeRefresh = null;
      this.processingRefresh = new Set();
      this.refreshPromise = null;
      this.#startRefreshBatch();
    });
  }

  #projectRefreshResult(result, ids) {
    const requested = new Set(ids);
    const latest = new Map(result.servers.filter(item => requested.has(item.serverId)).map(item => [item.serverId, item]));
    const servers = ids.map(id => latest.get(id)).filter(Boolean);
    const failures = servers.filter(item => item.status === 'failed');
    return {
      ...result,
      ok: servers.length === ids.length && failures.length === 0,
      partial: failures.length > 0,
      servers,
      serverStatuses: result.serverStatuses.filter(item => requested.has(item.serverId)),
    };
  }

  #drainRefreshes() {
    if (this.closed || this.pendingRefresh.size === 0) return Promise.resolve();
    const ids = [...this.pendingRefresh];
    this.pendingRefresh.clear();
    // Notifications own a separate follow-up subscription; cancelling a manual
    // waiter cannot consume the last change notification or kill its next batch.
    return this.#subscribeRefresh(ids, { followup: true });
  }

  async #collectRefreshBatch(batch) {
    const ids = [...batch.ids];
    for (const id of ids) {
      const previous = this.status.get(id) ?? {};
      this.status.set(id, { ...previous, serverId: id, refreshing: true });
    }
    const fetched = await Promise.all(ids.map(id => this.#fetchServer(this.servers.get(id), batch.controller.signal)));
    if (this.closed || batch.controller.signal.aborted) {
      for (const id of ids) {
        const previous = this.status.get(id);
        this.status.set(id, { ...previous, refreshing: false });
      }
      throw batch.controller.signal.reason ?? new Error('MCP registry closed');
    }
    this.cursorRevision += 1;
    const nextCatalog = new Map(this.catalog);
    const nextStatus = new Map(this.status);
    for (const result of fetched) {
      const state = this.servers.get(result.serverId);
      if (result.ok) {
        state.tools = result.tools;
        state.state = 'ready';
        state.errorCode = null;
        state.lastRefreshAt = new Date().toISOString();
        state.retryAttempt = 0;
        if (state.retryTimer) clearTimeout(state.retryTimer);
        state.retryTimer = null;
        nextCatalog.set(result.serverId, result.tools);
        nextStatus.set(result.serverId, {
          serverId: result.serverId,
          state: 'ready',
          refreshing: false,
          stale: false,
          lastRefreshAt: state.lastRefreshAt,
          count: result.tools.size,
        });
      } else {
        state.state = 'failed';
        state.errorCode = result.errorCode;
        nextStatus.set(result.serverId, {
          serverId: result.serverId,
          state: 'failed',
          refreshing: false,
          stale: state.tools.size > 0,
          lastRefreshAt: state.lastRefreshAt,
          errorCode: result.errorCode,
          count: state.tools.size,
        });
        this.#scheduleRetry(state);
      }
    }
    if (fetched.some(result => result.ok)) {
      this.catalog = nextCatalog;
      this.status = nextStatus;
      this.catalogRevision += 1;
      this.embeddingSearch.syncCatalog(this.#toolsForServers([...this.servers.keys()]));
    } else {
      this.status = nextStatus;
    }
    const statuses = [...this.status.values()];
    return {
      ok: fetched.every(result => result.ok),
      partial: fetched.some(result => !result.ok),
      catalogRevision: this.catalogRevision,
      servers: fetched.map(result => ({
        serverId: result.serverId,
        status: result.ok ? 'updated' : 'failed',
        stale: !result.ok && (this.servers.get(result.serverId)?.tools.size ?? 0) > 0,
        count: result.ok ? result.tools.size : this.servers.get(result.serverId)?.tools.size ?? 0,
        errorCode: result.ok ? undefined : result.errorCode,
      })),
      serverStatuses: statuses,
    };
  }

  async #fetchServer(state, signal) {
    if (!state?.client || state.state === 'connecting') return { serverId: state?.spec.id, ok: false, errorCode: 'CONNECT_FAILED' };
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const deadline = Date.now() + this.refreshTimeoutMs;
    const deadlineTimer = setTimeout(() => controller.abort(new Error('MCP catalog refresh deadline exceeded')), this.refreshTimeoutMs);
    deadlineTimer.unref?.();
    state.refreshController = controller;
    try {
      const all = [];
      let cursor;
      let bytes = 0;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw new Error('MCP catalog refresh deadline exceeded');
        if (controller.signal.aborted) throw controller.signal.reason;
        const response = await abortable(state.client.listTools(cursor ? { cursor } : undefined, {
          timeout: Math.min(5_000, remainingMs),
          signal: controller.signal,
        }), controller.signal);
        if (!Array.isArray(response.tools)) throw new Error('invalid list response');
        for (const tool of response.tools) {
          bytes += Buffer.byteLength(JSON.stringify(tool));
          if (bytes > MAX_CATALOG_BYTES) throw new Error('catalog too large');
          if (state.allowedTools && !state.allowedTools.has(tool.name)) continue;
          if (typeof tool.name !== 'string' || !tool.name || tool.name.length > 256) throw new Error('invalid tool name');
          const inputSchema = tool.inputSchema ?? { type: 'object', additionalProperties: true };
          const validate = ajv.compile(inputSchema);
          const revision = createHash('sha256').update(JSON.stringify([tool.description ?? '', inputSchema])).digest('hex').slice(0, 16);
          all.push({
            serverId: state.spec.id,
            name: tool.name,
            description: String(tool.description ?? ''),
            inputSchema,
            validate,
            revision,
          });
          if (all.length > MAX_TOOLS) throw new Error('too many tools');
        }
        cursor = response.nextCursor;
        if (!cursor) break;
        if (page === MAX_PAGES - 1) throw new Error('too many pages');
      }
      const tools = new Map();
      for (const tool of all) {
        if (tools.has(tool.name)) throw new Error('duplicate tool name');
        tools.set(tool.name, tool);
      }
      return { serverId: state.spec.id, ok: true, tools };
    } catch {
      return { serverId: state.spec.id, ok: false, errorCode: 'LIST_FAILED' };
    } finally {
      clearTimeout(deadlineTimer);
      signal?.removeEventListener('abort', onAbort);
      if (state.refreshController === controller) state.refreshController = null;
    }
  }

  #toolsForServers(ids) {
    const tools = [];
    for (const id of ids) {
      const allowed = this.servers.get(id).allowedTools;
      for (const tool of this.catalog.get(id)?.values() ?? []) {
        if (!allowed || allowed.has(tool.name)) tools.push(tool);
      }
    }
    return tools;
  }

  async search({ query, serverId, limit = 10, cursor, mode = this.searchMode } = {}) {
    if (typeof query !== 'string' || query.length === 0 || query.length > 256) throw new TypeError('query must contain 1–256 characters');
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new RangeError('limit must be between 1 and 50');
    validateSearchMode(mode);
    if (serverId !== undefined && !this.servers.has(serverId)) throw new Error('MCP server is unavailable');
    const scope = serverId ?? '*';
    const ids = serverId === undefined ? [...this.servers.keys()] : [serverId];
    const permissionFingerprint = this.#permissionFingerprint(scope, ids);
    const catalogRevision = this.catalogRevision;
    const cursorRevision = this.cursorRevision;
    const baseQueryHash = `${scope}\0${query}\0${limit}\0${permissionFingerprint}`;
    const queryHashes = Object.fromEntries([...new Set([mode, 'bm25'])].map(rankMode => [
      rankMode,
      createHash('sha256').update(`${baseQueryHash}\0${rankMode}`).digest('hex'),
    ]));
    let cursorState = cursor ? this.#readCursor(cursor) : null;
    if (cursorState && !Object.values(queryHashes).includes(cursorState.queryHash)) throw new Error('CURSOR_STALE');
    const offset = cursorState?.offset ?? 0;
    const docs = this.#toolsForServers(ids);
    const terms = [...new Set(tokenize(query))];
    const lexical = bm25(docs, terms).filter(item => item.score > 0);
    let ranked;
    let rankMode = mode;
    if (mode === 'bm25') {
      ranked = lexical;
    } else {
      this.embeddingSearch.syncCatalog(this.#toolsForServers([...this.servers.keys()]));
      try {
        const vector = await this.embeddingSearch.rank(query, docs);
        ranked = mode === 'vector' ? vector : reciprocalRankFusion(lexical, vector);
      } catch {
        ranked = lexical;
        rankMode = 'bm25';
      }
    }
    const queryHash = queryHashes[rankMode];
    const currentPermissionFingerprint = this.#permissionFingerprint(scope, ids);
    if (this.catalogRevision !== catalogRevision || this.cursorRevision !== cursorRevision
      || currentPermissionFingerprint !== permissionFingerprint) {
      this.embeddingSearch.syncCatalog(this.#toolsForServers([...this.servers.keys()]));
      throw new Error('CURSOR_STALE');
    }
    if (cursor) cursorState = this.#readCursor(cursor, queryHash);
    if (cursorState && cursorState.queryHash !== queryHash) throw new Error('CURSOR_STALE');
    const page = ranked.slice(offset, offset + limit);
    const statuses = ids.map(id => this.status.get(id) ?? { serverId: id, state: 'connecting', stale: false });
    return {
      catalogRevision: this.catalogRevision,
      partial: statuses.some(item => item.state !== 'ready' || item.stale),
      serverStatuses: statuses,
      tools: page.map(({ tool, score }) => ({
        serverId: tool.serverId,
        toolName: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        toolRevision: tool.revision,
        score,
        stale: this.status.get(tool.serverId)?.stale ?? false,
      })),
      nextCursor: offset + limit < ranked.length ? this.#makeCursor(queryHash, offset + limit) : null,
    };
  }

  async list({ serverId, toolName, detail = 'summary', limit = 50, cursor } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new RangeError('limit must be between 1 and 50');
    if (!['summary', 'full'].includes(detail)) throw new TypeError('detail must be summary or full');
    if (toolName !== undefined && (typeof toolName !== 'string' || !toolName)) throw new TypeError('toolName must be a non-empty string');
    if (serverId !== undefined && !this.servers.has(serverId)) throw new Error('MCP server is unavailable');
    const ids = serverId === undefined ? [...this.servers.keys()] : [serverId];
    const permissions = this.#permissionFingerprint(serverId ?? '*', ids);
    const queryHash = createHash('sha256').update(JSON.stringify(['list', serverId, toolName, detail, limit, permissions])).digest('hex');
    let offset = 0;
    if (cursor) ({ offset } = this.#readCursor(cursor, queryHash));
    const tools = ids.flatMap(id => [...(this.catalog.get(id)?.values() ?? [])]
      .filter(tool => !this.servers.get(id).allowedTools || this.servers.get(id).allowedTools.has(tool.name))
      .filter(tool => toolName === undefined || tool.name === toolName)
      .map(tool => ({
        serverId: id,
        toolName: tool.name,
        description: detail === 'full' ? tool.description : tool.description.slice(0, 240),
        ...(detail === 'full' ? { inputSchema: tool.inputSchema } : {}),
        toolRevision: tool.revision,
        stale: this.status.get(id)?.stale ?? false,
      }))).sort((a, b) => {
        const left = `${a.serverId}\0${a.toolName}`;
        const right = `${b.serverId}\0${b.toolName}`;
        return left < right ? -1 : left > right ? 1 : 0;
      });
    return {
      tools: tools.slice(offset, offset + limit),
      nextCursor: offset + limit < tools.length ? this.#makeCursor(queryHash, offset + limit) : null,
    };
  }

  async call(input = {}, { signal } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw mcpError('MCP_INVALID_CALL', 'use mcp.call({ serverId, toolName, arguments: {} }); see mcp.help()');
    }
    const { serverId, toolName, arguments: args = {}, expectedToolRevision } = input;
    if (typeof serverId !== 'string' || !serverId || typeof toolName !== 'string' || !toolName
      || !args || typeof args !== 'object' || Array.isArray(args)
      || (expectedToolRevision !== undefined && typeof expectedToolRevision !== 'string')) {
      throw mcpError('MCP_INVALID_ARGUMENTS', 'serverId and toolName must be non-empty strings; arguments must be an object; see mcp.help()');
    }
    if (this.closed) throw new Error('MCP registry is closed');
    const state = this.servers.get(serverId);
    const tool = this.catalog.get(serverId)?.get(toolName);
    if (!state) throw mcpError('MCP_SERVER_UNAVAILABLE', 'server is unavailable; discover serverId with mcp.list() or mcp.search()');
    if (state.allowedTools && !state.allowedTools.has(toolName)) throw mcpError('MCP_TOOL_DENIED', 'tool is not currently allowed');
    if (state.state !== 'ready') throw new Error('CATALOG_UNAVAILABLE');
    if (!tool) throw mcpError('MCP_TOOL_UNAVAILABLE', 'tool is absent from the published catalog; see mcp.list()');
    if (expectedToolRevision !== undefined && expectedToolRevision !== tool.revision) throw new Error('TOOL_CHANGED');
    if (!tool.validate(args)) throw mcpError('MCP_INVALID_ARGUMENTS', 'tool arguments do not match the current input schema; inspect mcp.list({serverId, toolName, detail: "full"})');
    const active = state.tools.get(toolName);
    if (!active || active.revision !== tool.revision) throw new Error('TOOL_CHANGED');
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    this.activeCalls.add(controller);
    let request;
    try {
      let response;
      try {
        request = state.client.callTool({ name: toolName, arguments: args }, undefined, { timeout: 20_000, signal: controller.signal });
        this.inflightCalls.add(request);
        response = await request;
      } catch (error) {
        throw mcpError('MCP_UPSTREAM_TRANSPORT_ERROR', JSON.stringify({ serverId, toolName, diagnostic: upstreamDiagnostic(error.message ?? String(error), state, args) }));
      }
      if (response.isError) {
        const diagnostic = {
          content: response.content?.filter(item => item.type === 'text').map(item => item.text),
          structuredContent: response.structuredContent,
        };
        throw mcpError('MCP_UPSTREAM_ERROR', JSON.stringify({ serverId, toolName, diagnostic: upstreamDiagnostic(diagnostic, state, args) }));
      }
      for (const item of response.content ?? []) {
        if (item.type !== 'text' || typeof item.text !== 'string') continue;
        const match = item.text.match(/\n…\[response truncated at (\d+) bytes\]$/);
        if (match && Buffer.byteLength(item.text.slice(0, match.index), 'utf8') === Number(match[1])) {
          throw mcpError('MCP_UPSTREAM_RESPONSE_TRUNCATED', `Upstream response was truncated at its ${match[1]} byte limit; reduce page size.`);
        }
      }
      return response.structuredContent ?? response;
    } finally {
      this.activeCalls.delete(controller);
      if (request) this.inflightCalls.delete(request);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  toolboxes() {
    return {
      mcp: {
        search: { description: `Search allowed external MCP tools by name and description. mode may be bm25, vector, or hybrid; it defaults to DOLSOT_SEARCH_MODE (${this.searchMode}). Vector runtime failures fall back to BM25.`, inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 256 }, serverId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: 10 }, cursor: { type: 'string' }, mode: { type: 'string', enum: SEARCH_MODES } }, required: ['query'], additionalProperties: false }, examples: ['await mcp.search({ query: "read status", limit: 5 })', 'await mcp.search({ query: "read status", mode: "bm25" })', 'await mcp.search({ query: "read status", mode: "vector" })', 'await mcp.search({ query: "read status", mode: "hybrid" })'], handler: args => this.search(args) },
        list: {
          description: 'List allowed external MCP tools. Summary is the default; request full for input schemas. Follow nextCursor with the same filters/detail/limit to read all pages.',
          inputSchema: { type: 'object', properties: { serverId: { type: 'string' }, toolName: { type: 'string', minLength: 1 }, detail: { enum: ['summary', 'full'], default: 'summary' }, limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: 50 }, cursor: { type: 'string' } }, additionalProperties: false },
          examples: ['await mcp.list({ limit: 50 })', 'await mcp.list({ serverId: selected.serverId, toolName: selected.toolName, detail: "full" })'],
          handler: args => this.list(args),
        },
        refresh: { description: 'Refresh external MCP tool lists. Omit serverId to refresh all configured servers.', inputSchema: { type: 'object', properties: { serverId: { type: 'string' } }, additionalProperties: false }, examples: ['await mcp.refresh()'], handler: (args, context) => this.refresh(args.serverId, context) },
        call: { description: 'Call an allowed external MCP tool using one object with serverId, toolName, and arguments. Get identifiers from list/search. Advanced: expectedToolRevision optionally rejects a changed definition; normally omit it.', inputSchema: { type: 'object', properties: { serverId: { type: 'string', minLength: 1 }, toolName: { type: 'string', minLength: 1 }, arguments: { type: 'object' }, expectedToolRevision: { type: 'string' } }, required: ['serverId', 'toolName'], additionalProperties: false }, examples: ['await mcp.call({ serverId: selected.serverId, toolName: selected.toolName, arguments: {} })'], handler: (args, context) => this.call(args, context) },
      },
    };
  }

  #makeCursor(queryHash, offset) {
    const payload = Buffer.from(JSON.stringify({ revision: this.cursorRevision, queryHash, offset })).toString('base64url');
    const signature = createHmac('sha256', this.cursorSecret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  #permissionFingerprint(scope, ids) {
    const permissions = ids.map(id => [id, this.servers.get(id).allowedTools ? [...this.servers.get(id).allowedTools].sort() : null]);
    const fingerprint = JSON.stringify(permissions);
    const previous = this.permissionFingerprints.get(scope);
    if (previous !== undefined && previous !== fingerprint) this.cursorRevision += 1;
    this.permissionFingerprints.set(scope, fingerprint);
    return fingerprint;
  }

  #readCursor(cursor, queryHash) {
    const [payload, signature] = String(cursor).split('.');
    if (!payload || !signature) throw new Error('CURSOR_STALE');
    const expected = createHmac('sha256', this.cursorSecret).update(payload).digest();
    let actual;
    try { actual = Buffer.from(signature, 'base64url'); } catch { throw new Error('CURSOR_STALE'); }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('CURSOR_STALE');
    let value;
    try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new Error('CURSOR_STALE'); }
    if (value.revision !== this.cursorRevision || (queryHash !== undefined && value.queryHash !== queryHash)
      || typeof value.queryHash !== 'string' || !Number.isInteger(value.offset) || value.offset < 0) throw new Error('CURSOR_STALE');
    return value;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.embeddingSearch.clear();
    if (this.timer) clearInterval(this.timer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.pendingRefresh.clear();
    const closing = new Error('MCP registry closed');
    for (const batch of [this.activeRefresh, ...this.refreshQueue].filter(Boolean)) {
      for (const waiter of batch.waiters) {
        this.#cleanRefreshWaiter(waiter);
        waiter.reject(closing);
      }
      batch.waiters.clear();
      batch.controller.abort(closing);
    }
    this.refreshQueue = [];
    for (const state of this.servers.values()) {
      if (state.retryTimer) clearTimeout(state.retryTimer);
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      state.refreshController?.abort(new Error('MCP registry closed'));
    }
    for (const controller of this.activeCalls) controller.abort(new Error('MCP registry closed'));
    await Promise.all([...this.servers.values()].map(async state => {
      try { await state.client?.close(); } catch {}
    }));
    await Promise.allSettled([...this.inflightCalls]);
    if (this.refreshPromise) await this.refreshPromise.catch(() => {});
  }
}

function mcpError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

// Only diagnostics pass through this path. Successful tool values keep their
// original contract; request arguments and host configuration are never echoed.
function upstreamDiagnostic(value, state, args) {
  const sensitiveKey = /authorization|cookie|password|passwd|secret|token|api[-_]?key|credential/i;
  const secrets = new Set();
  const addSecret = value => {
    if (typeof value !== 'string' || !value) return;
    secrets.add(value);
    if (/^Bearer\s+/i.test(value)) secrets.add(value.replace(/^Bearer\s+/i, ''));
  };
  for (const env of Object.values({ ...state.spec.headerEnv, ...state.spec.envFrom })) addSecret(process.env[env]);
  const collectSecrets = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 20) return;
    for (const [key, item] of Object.entries(value)) {
      if (sensitiveKey.test(key)) addSecret(item);
      else collectSecrets(item, depth + 1);
    }
  };
  collectSecrets(args);
  if (state.spec.url) {
    const url = new URL(state.spec.url);
    addSecret(decodeURIComponent(url.password));
    for (const [key, item] of url.searchParams) if (sensitiveKey.test(key)) addSecret(item);
  }
  const orderedSecrets = [...secrets].sort((a, b) => b.length - a.length);
  const redact = text => {
    for (const secret of orderedSecrets) text = text.split(secret).join('[REDACTED]');
    return text
      .replace(/Bearer\s+[^\s,"'<>]+/gi, 'Bearer [REDACTED]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
      .replace(/((?:authorization|cookie|password|passwd|secret|token|api[-_]?key|credential)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, '$1[REDACTED]');
  };
  const text = typeof value === 'string' ? redact(value) : JSON.stringify(value, (key, item) => {
    if (sensitiveKey.test(key)) return '[REDACTED]';
    return typeof item === 'string' ? redact(item) : item;
  });
  const bytes = Buffer.from(text ?? 'upstream returned an error');
  return bytes.length > 2048 ? `${bytes.subarray(0, 2048).toString('utf8')}… [truncated]` : bytes.toString('utf8');
}

function refreshTimeoutError() {
  const error = new Error('MCP refresh request deadline exceeded');
  error.code = 'REFRESH_TIMEOUT';
  return error;
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    if (signal.aborted) onAbort();
  });
}

function tokenize(text) {
  const normalized = text.normalize('NFKC').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  const segments = normalized.match(/[a-z0-9]+|[\p{Script=Hangul}]+/gu) ?? [];
  const tokens = [];
  for (const segment of segments) {
    tokens.push(segment);
    if (/^[\p{Script=Hangul}]+$/u.test(segment)) {
      const chars = [...segment];
      for (let i = 0; i + 1 < chars.length; i += 1) tokens.push(chars.slice(i, i + 2).join(''));
    }
  }
  return tokens;
}

function bm25(tools, queryTerms) {
  const docs = tools.map(tool => ({
    tool,
    name: tokenize(tool.name),
    description: tokenize(tool.description),
  }));
  const average = field => docs.length ? docs.reduce((sum, doc) => sum + doc[field].length, 0) / docs.length : 0;
  const avgName = average('name');
  const avgDescription = average('description');
  const frequencies = field => {
    const map = new Map();
    for (const term of queryTerms) map.set(term, docs.filter(doc => doc[field].includes(term)).length);
    return map;
  };
  const dfName = frequencies('name');
  const dfDescription = frequencies('description');
  const scoreField = (terms, term, df, avgLen) => {
    const tf = terms.filter(token => token === term).length;
    if (!tf || !docs.length) return 0;
    const idf = Math.log(1 + (docs.length - df.get(term) + 0.5) / (df.get(term) + 0.5));
    return idf * (tf * 2.2) / (tf + 1.2 * (1 - 0.75 + 0.75 * terms.length / Math.max(avgLen, 1)));
  };
  return docs.map(doc => ({
    tool: doc.tool,
    score: queryTerms.reduce((sum, term) => sum + 3 * scoreField(doc.name, term, dfName, avgName) + scoreField(doc.description, term, dfDescription, avgDescription), 0),
  })).sort((a, b) => b.score - a.score || Buffer.compare(Buffer.from(`${a.tool.serverId}\0${a.tool.name}`), Buffer.from(`${b.tool.serverId}\0${b.tool.name}`)));
}
