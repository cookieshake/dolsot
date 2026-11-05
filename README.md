# dolsot 1.0 alpha

`dolsot` runs JavaScript cells in a `quickjs-wasi` child process hosted by Node.js. This repository is the Node.js 1.0 line; the Python 0.x source remains available on the `v0` branch and `v0.4.2` tag. This alpha package is private and is not published to npm.

## Requirements and local setup

Node.js 24 or newer is required. From the repository root:

```sh
npm ci
```

Run a cell with the local CLI:

```sh
node src/cli.mjs --session work 'var total = 40; total += 2; total'
```

With no `DOLSOT_SESSION_DIR`, session snapshots live only in that host process. A one-shot CLI process exits after one cell, so its in-memory session does not carry into a later CLI process. To continue a session across separate CLI invocations, choose a dedicated absolute directory:

```sh
export DOLSOT_SESSION_DIR="$HOME/.local/state/dolsot"
node src/cli.mjs --session work 'var total = 40; total += 2; total'
node src/cli.mjs --session work 'total += 1; total'
```

The second invocation restores the disk snapshot and returns `43`. The directory stores version-tagged snapshots and uses atomic replacement and cross-process locking. The internal `2.0.0-alpha.0` snapshot compatibility marker is retained so existing Node alpha snapshots remain readable; it is separate from the npm/MCP product version. A malformed, oversized, or incompatible snapshot fails explicitly; it is not silently replaced with an empty session. `--reset all` fences off earlier in-flight cells so they cannot recreate state after reset. The local host limits stored sessions to 256.

Standard input, listing, and reset:

```sh
printf 'var message = "hello"; message.toUpperCase()\n' | node src/cli.mjs --session work
node src/cli.mjs --list-sessions
node src/cli.mjs --reset work
node src/cli.mjs --reset all
```

`--timeout` accepts seconds. Normal completion returns exit code 0, a cell error 1, a usage error 2, and a hard timeout 124. `print()` and `console.log()` write to stdout; the trailing cell value is printed afterward. Display output is capped at 1 MiB. A host allows at most four active QuickJS workers, 64 queued workers, and 16 active host toolbox handlers; each guest is configured with a 32 MiB QuickJS memory limit and 256 KiB stack limit. These are per-host interpreter limits, not OS-level RSS isolation or a machine-wide process quota.

## JavaScript toolboxes

A toolbox is a trusted Node.js module loaded by the host. Export `tools` as a map of names to descriptions, JSON input schemas, and handlers. The module is not executed inside QuickJS; only the declared API is bridged into the guest.

```sh
node src/cli.mjs --session work --toolbox "$PWD/examples/math-tools.mjs:mt" 'await mt.add({a: 1, b: 2})'
```

Start with global `help()` for cell usage and the currently installed toolbox names, then `<toolbox>.help()` for method descriptions, input schemas, and examples. The alias `help` is reserved for this entry point. Global help is refreshed when restoring sessions so it reflects the host's current toolboxes.

The guest also has `mt.catalog()`, `mt.help()`, and `mt.call(name, arguments)`. If a toolbox exports a tool named `catalog`, that tool owns `mt.catalog()` and the static metadata remains available through `mt.help()`. Calls are asynchronous and need `await`. A cell that finishes while one of its host tool calls is still pending fails without saving the new snapshot and aborts the host request; handlers should honor the supplied `{ signal }` context. Abort cannot undo an external side effect already performed. Host modules have the Node process's authority and should be trusted. QuickJS guest code does not receive `process`, `require`, Node built-ins, npm packages, filesystem, or network access directly.

## Connecting external MCP tools

Set `DOLSOT_MCP_CONFIG` to a JSON file. Only the host reads it. HTTP header and stdio environment values are named through environment-variable references so their values are not copied into guest code.

```json
{
  "servers": [
    {
      "id": "docs",
      "transport": "http",
      "url": "https://mcp.example.invalid/mcp",
      "headerEnv": { "Authorization": "DOCS_MCP_AUTHORIZATION" },
      "allowedTools": ["search_documents"]
    },
    {
      "id": "local-tools",
      "transport": "stdio",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/server.mjs"],
      "envFrom": { "API_TOKEN": "TOOLS_API_TOKEN" }
    }
  ]
}
```

With the config and referenced environment variables set, the JavaScript toolbox exposes search, list, refresh, and call:

```js
help();
mcp.help();
var page = await mcp.list({ limit: 50 });
// Follow page.nextCursor with the same options to read every page.
var hits = await mcp.search({ query: '회의록 검색', limit: 5 });
var first = hits.tools[0];
if (!first) throw new Error('No matching allowed tool');
var details = await mcp.list({ serverId: first.serverId, toolName: first.toolName, detail: 'full' });
// Inspect details.tools[0].inputSchema before choosing arguments.
await mcp.call({
  serverId: first.serverId,
  toolName: first.toolName,
  arguments: { query: '지난 회의' }
});
await mcp.refresh();
await mcp.refresh({ serverId: 'docs' });
```

Search uses BM25 over the currently allowed tool names and descriptions. Results include the server ID, tool name, description, input schema, revision, score, stale marker, and cursor. Calls re-check the currently published catalog and input schema. A call that has already been sent is never automatically replayed.

`mcp.list({ serverId?, toolName?, detail?, limit?, cursor? })` always returns `{ tools, nextCursor }`. It defaults to `detail: 'summary'` (identifiers, description up to 240 characters, revision, stale status) and 50 tools per page; `limit` is 1–50. `detail: 'full'` includes the full description and input schema. Filters are exact and optional; without a query or filter, pagination enumerates all currently allowed tools in server/name order. Cursors are bound to the filters, detail, limit, permissions, and catalog generation; refresh or permission changes reject old cursors with `CURSOR_STALE`.

Migration in `1.0.0-alpha.1`: replace `mcp.catalog()` with `mcp.list({ detail: 'full' })` and read `.tools` from the response, following `nextCursor` for more pages. `mcp.catalog` is removed from the external MCP toolbox. General JavaScript toolboxes keep their existing `.catalog()` and string `.call(name, arguments)` helpers. External `mcp.call` accepts only an object; strings fail immediately with `MCP_INVALID_CALL` and a correct example. The optional advanced `expectedToolRevision` can copy a discovered `toolRevision` to reject changed definitions with `TOOL_CHANGED`. It checks the host's published definition, so it cannot detect changes the host has not collected yet; ordinary examples omit it.

Failures distinguish local toolbox lookup (`TOOLBOX_TOOL_UNAVAILABLE`), malformed MCP calls (`MCP_INVALID_CALL`/`MCP_INVALID_ARGUMENTS`), missing servers/tools (`MCP_SERVER_UNAVAILABLE`/`MCP_TOOL_UNAVAILABLE`), current allowlist rejection (`MCP_TOOL_DENIED`), and upstream tool/transport errors (`MCP_UPSTREAM_ERROR`/`MCP_UPSTREAM_TRANSPORT_ERROR`). Upstream failures retain server/tool identifiers and a diagnostic capped at 2048 bytes plus a truncation marker. Configured credentials and recognizable secret fields, bearer tokens, and URL credentials are redacted before truncation. Arbitrary upstream text can contain unlabelled private data, so this is best-effort redaction, not a general data-loss prevention boundary. Calls are never retried automatically.

## Automatic catalog refresh

Automatic refresh is enabled by default in a long-running host. The host refreshes on initial connection and reconnection, coalesces tool-list change notifications over a proposed 250 ms debounce, and refreshes periodically even when a server sends no notifications. The proposed default period is five minutes; override it with `DOLSOT_MCP_REFRESH_INTERVAL_MS` (1,000–86,400,000 ms). Each refresh caller has a proposed 30-second total deadline, including time queued behind another batch; `DOLSOT_MCP_REFRESH_TIMEOUT_MS` can set it to 1,000–300,000 ms. A server collection is also capped at that duration, and each individual page request at five seconds. A caller deadline rejects with `REFRESH_TIMEOUT`; it is not a successful partial result. Shutdown aborts collection requests. A failed connection or list refresh is retried with a per-server delay starting at one second and increasing exponentially to 60 seconds, plus small jitter; success resets the delay. Manual refresh remains available. Each caller waits for one fixed batch, not later notification batches. Overlapping callers can share collection, but receive only their requested server results. New list-change notifications own a coalesced follow-up batch. Refreshes use the same complete pagination, schema validation, and atomic catalog/index publication path. A partial failure preserves that server's last good list and marks it stale; new calls to a failed server are rejected. Every completed refresh invalidates earlier cursors, including an all-server failure; changed current tool permissions also invalidate them and filter search/catalog immediately.

The MCP catalog and refresh timers live in the host process, not in the saved REPL snapshot. A one-shot CLI invocation performs initial discovery and can refresh only while that process is alive; its `finally` cleanup stops timers and closes transports before exit. A later process reconnects and discovers the catalog again. Long-running MCP hosts keep auto-refresh alive until shutdown, then clear timers/listeners, abort pending collection/call requests when the SDK supports it, and close external transports. In-flight catalog pages that have not been published are discarded during shutdown. The host refresh API accepts `registry.refresh(serverId, { signal, deadline })`, where deadline is an absolute epoch timestamp in milliseconds. The guest `mcp.refresh()` handler receives the cell signal and deadline automatically. A cancelled or expired waiter releases its handler slot without cancelling other subscribers; collection is aborted and not published when its last subscriber leaves. An independently owned automatic follow-up can still run. Cancellation before publication keeps the last catalog and does not mark a healthy server as failed. Initial discovery that exceeds its refresh deadline closes its connected transports before reporting the startup error. These deadlines bound asynchronous queue/collection waits; they cannot preempt synchronous host modules or schema validation while the Node event loop is blocked. Toolbox handlers that ignore their supplied abort signal may continue running; cancellation does not guarantee rollback of remote effects.

## Serving Dolsot over MCP

Build the private local tarball before using its installed `dolsot` bin:

```sh
npm pack --pack-destination .
```

### Run from GitHub with npx

The package is not published to npm, so `npx dolsot@1` is not available. You can run the GitHub source with Node.js 24 or newer. From your project root, keep disk-backed sessions in a project-specific directory and add `.dolsot/` to that project's `.gitignore`:

```sh
mkdir -p .dolsot/sessions
grep -qxF '.dolsot/' .gitignore || echo '.dolsot/' >> .gitignore
export DOLSOT_SESSION_DIR="$PWD/.dolsot/sessions"
export DOLSOT_PACKAGE='github:cookieshake/dolsot#main'

npx --yes --package="$DOLSOT_PACKAGE" -- dolsot --session work 'var total = 40; total += 2; total'
npx --yes --package="$DOLSOT_PACKAGE" -- dolsot --session work 'total += 1; total'
```

The two separate CLI processes share the `work` snapshot through `DOLSOT_SESSION_DIR`. Without that variable, session state lasts only for the host process. `#main` selects a moving branch; for a reproducible source revision, replace it with a commit SHA, or use a tag when you want a named release ref. A branch update does not guarantee that every npx invocation immediately runs the latest commit because package-manager caching may apply.

To start an MCP server from the same GitHub source, use one of these commands:

```sh
# stdio: the MCP client starts and manages this process
npx --yes --package="$DOLSOT_PACKAGE" -- dolsot mcp --transport stdio

# Streamable HTTP: keep this server running for a client on the same host
npx --yes --package="$DOLSOT_PACKAGE" -- dolsot mcp --transport http --host 127.0.0.1 --port 3000
```

For HTTP, register `http://127.0.0.1:3000/mcp` in the client. The server binds only to loopback and does not provide remote authentication or multi-user isolation.

Loopback Streamable HTTP:

```sh
npx --yes --package ./dolsot-1.0.0-alpha.1.tgz -- dolsot mcp --transport http --host 127.0.0.1 --port 3000
```

Register `http://127.0.0.1:3000/mcp` in an MCP client. The server provides `dolsot_run`, `dolsot_sessions`, and `dolsot_reset`. `dolsot_run` keeps its description short and points to global `help()`. Its optional `timeout` is an integer number of seconds from 1 to 1200 (the host default is 20 seconds unless configured). Setting `DOLSOT_MCP_CONFIG` connects backends for code cells but does not add tools to the external MCP server. Within a cell, use `mcp.help()`, `mcp.search()`, `mcp.list()`, and object-form `mcp.call()` to discover and call backend tools. Reuse the same `session` argument to continue cell state. MCP transport connections do not identify REPL sessions. HTTP currently binds only to `127.0.0.1`; remote exposure and multi-user authentication are not implemented. Sessions belong to the host's configured store and are not isolated by authenticated user identity.

stdio server for MCP hosts that spawn a process:

```sh
npx --yes --package ./dolsot-1.0.0-alpha.1.tgz -- dolsot mcp --transport stdio
```

The MCP server process keeps memory sessions and automatic refresh state until it exits. Set `DOLSOT_SESSION_DIR` if sessions should survive its restart.

## Python 0.x differences

The session-and-toolbox workflow remains, but cells use JavaScript and asynchronous tool calls use `await`. Python syntax, Python modules/DataFrames, and Python pickle/dill session files are not compatible or converted. Existing Python users can keep using the `v0.4.2` tag/PyPI release or the `v0` branch. The QuickJS guest is separate from the Node host; host toolbox handlers run with host permissions.

## Local verification limits

The pinned local dependency set is Node.js 24, `quickjs-wasi` 3.6.3, MCP TypeScript SDK 1.32.2, Ajv 8.20.0, `proper-lockfile` 4.1.2, and Zod 4.6.7. The package remains private and unpublished. The commands above assume the package tarball has been generated with `npm pack --pack-destination .`; this does not establish public npm availability. The per-host execution/session limits do not impose an OS RSS cap or a machine-wide quota. Remote HTTP authentication, multi-user principal isolation, other OSes and client implementations, the 2026 MCP protocol revision, and performance under production load remain unverified.
