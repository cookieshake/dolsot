# dolsot

A toolbox-agnostic, **stateful** Python REPL engine for LLM agents.

You inject a "toolbox" — any importable Python module — into a namespace, then
run cells of Python against it. Each cell can read and rebind whatever the
previous cell left behind, keyed by a session id: variables, DataFrames,
functions, imports.

## Backends

dolsot ships two ways to run a cell, and the choice is a real trade-off
between isolation and what you can inject.

**Subprocess backend (`Repl`)** — the default, and what the rest of this
README describes. Toolboxes are importable, stateless modules referenced by
name; dolsot itself never imports or knows anything about a toolbox, it only
ever handles a module *name*, because only a name can cross into the child
worker. Sessions are persistent across calls, and each cell runs in its own
worker process, so a timeout is enforced by hard-killing that process
(`SIGKILL`) — a runaway cell cannot take the host down, and the worker is
fully isolated from the host's live objects and memory. That process
boundary is also the cost: state must be pickled between cells, and a live
object (a socket, a lock, an open connection) cannot cross it.

**In-process backend (`InProcessSession`)** — runs cells directly in the
host process against a live namespace dict, with no process boundary. This
lets you inject live objects as-is — a database connection, a client, a
generator — and state persists across cells by reference, not by pickling.
It is **less isolated** than `Repl`: there is no worker to kill, so a
per-call timeout is **cooperative only** — a cell that ignores it keeps
running on a leaked daemon thread that cannot be forcibly stopped. An
optional caller-supplied AST gate (`dolsot.sandbox.check_ast`, or your own)
can reject dangerous constructs before a cell runs, but dolsot provides that
gate as a mechanism, not a safety guarantee; in-process CPython sandboxing is
inherently leaky. Use it only for code and toolboxes you already trust to
run unsandboxed.

State crosses between `Repl` cells by being **pickled to disk** (via `dill`) and
reloaded in the next cell's fresh worker process — so what persists is exactly
what `dill` can serialize. A **live object** — an open database connection, a
socket, a file handle, a generator, a lock — cannot cross that boundary. Such a
value is *dropped* (best-effort, so one of them never sinks the rest of the
session), reported on `Result.dropped`, and gone on the next call. If your work
needs a connection to live across cells, re-open it at the top of each cell.

**dolsot is not a sandbox.** Every cell runs in a child worker process, and
that process is killed if it runs past its timeout — that protects the host
from a hung or runaway cell, nothing more. The worker has full filesystem,
network, and process access, exactly like the toolbox code it runs. Only
inject toolboxes, and only run code, that you'd trust to run unsandboxed.

## Install

```bash
uv add dolsot                # core: the REPL engine
uv add "dolsot[typecheck]"   # + the ty type gate (optional)
```

The only hard runtime dependency is `dill` (session pickling). The type gate is
powered by `ty`, pulled in by the `typecheck` extra; without it the gate fails
open (a no-op) and the REPL still runs. Requires Python >= 3.11 on a **POSIX
platform** — the worker timeout kills a process group with `SIGKILL`, so Windows
is not supported.

## Library usage

```python
import mytools  # your toolbox module
from dolsot import Repl

repl = Repl(inject={"mt": mytools})

r = repl.run("task-42", "mt.add(1, 2)")
print(r.value)   # "3"

# state from the previous cell is still there
r = repl.run("task-42", "df = mt.load('orders')")
r = repl.run("task-42", "len(df)")
print(r.value)
```

`inject` maps the alias code will use (`mt`) to either a module object or an
importable module name (`"mytools"`) — a module object is resolved to its
`__name__` and re-imported inside the worker, since only something importable
by name can cross the process boundary.

An `async` twin, `arun`, exists for event-loop hosts:

```python
r = await repl.arun("task-42", "mt.add(1, 2)")
```

### `Result`

Every call returns a `Result`, never raises for a user-code failure:

| field | meaning |
|---|---|
| `ok` | `True` if the cell ran without raising |
| `value` | the trailing expression's value, stringified, or `None` |
| `stdout` | anything the cell printed |
| `error` | the error message, or `None` |
| `exit_code` | `0` on success; see below otherwise |
| `held` | names now persisted in the session (variables, imports, functions) |
| `dropped` | names the cell computed but could not persist — unpicklable live objects (a connection, socket, generator, lock). Gone next call; not a failure |
| `text` | `stdout` + `value` + `error` + the held-names banner, pre-joined |

`exit_code` is:
- `0` — the cell ran and returned normally.
- an `int` your toolbox exception carries as `.exit_code` — a toolbox can
  signal its own failure classes this way (e.g. "not found" vs. "bad input").
- `1` — any other unhandled exception, or a worker-side failure (session
  wouldn't load, type gate failed, etc.).
- `124` — the cell was killed for exceeding its timeout.

`Repl.run`/`arun` raise only for a *caller* mistake, before any code runs:
`InvalidSession` (bad session id, or empty code) and `InvalidToolbox` (an
`inject` value that isn't a module or module name).

### Session housekeeping

```python
repl.sessions()      # -> list[SessionInfo] (id, size_bytes, last_used)
repl.reset("task-42")  # forget one session
repl.reset("all")       # forget every session in the configured store
```

## CLI usage

Installing dolsot also installs the `dolsot` command — the shape pi (or any
agent host) spawns as a subprocess. It is a thin shell over `Repl`: parse
arguments, run one cell, print, exit with `Result.exit_code`.

```bash
# run code given as an argument
dolsot --toolbox mytools:mt --session work "mt.add(1, 2)"

# or piped in on stdin
echo "2 ** 10" | dolsot --toolbox mytools:mt --session work

# multiple toolboxes, repeatable
dolsot --toolbox mytools:mt --toolbox otherlib:ol --session work "mt.add(1, ol.scale(2))"

# a session works fine with no toolbox at all
dolsot --session scratch "1 + 1"

# session management
dolsot --list-sessions
dolsot --reset work
dolsot --reset all

# per-call timeout override (seconds)
dolsot --toolbox mytools:mt --session work --timeout 5 "slow_call()"
```

`--toolbox MODULE:ALIAS` may be repeated; it is not required to run code —
a session with no toolbox still runs plain Python. A malformed spec (missing
`:`, or an empty module/alias) is a usage error.

`--session` is required for running code — not for `--list-sessions` or
`--reset`. Without it dolsot exits `2` and explains why: state (variables,
imports, DataFrames) persists per session id, so a stable id per task is
what makes that useful.

### Output contract

This split is deliberate and stable, because callers parse it:

| stream | content |
|---|---|
| stdout | the cell's captured `stdout`, then the trailing expression's `value` |
| stderr | the error line, the "session now holds" banner, any save warning |
| exit code | `Result.exit_code` (see the table above), or `2` for a CLI usage error |

## The toolbox contract

A toolbox is just an importable Python module — dolsot places no import-time
requirements on it — but a few conventions make it far more usable by an
agent driving it through a REPL:

| convention | why |
|---|---|
| importable by name (`import mytools` works in the worker) | only a module *name* crosses the host/worker boundary; a live object can't |
| `__all__` | declares the public surface dolsot's error hints and the type gate reflect over; without it, every non-underscore attribute is public |
| an exception with an `int` `.exit_code` | lets a toolbox signal its own failure classes through the process exit code, instead of everything collapsing to `1` |
| a `help()` callable | dolsot's argument-count hints point the agent at `mt.help("fn_name")` when a call fails, so it's worth having one |
| real type annotations | the type gate (`ty`) type-checks a cell against the toolbox's own signatures *before* running it, turning a wrong-arguments call into a fixable diagnostic instead of a raw traceback |

Example toolbox shape:

```python
# mytools/__init__.py
__all__ = ["add", "load", "help", "ToolError"]

class ToolError(Exception):
    exit_code = 3

def add(a: int, b: int) -> int:
    """Add two ints."""
    return a + b

def load(name: str) -> list[int]:
    ...

def help(topic: str | None = None) -> str:
    return "mytools cheat-sheet"
```

## MCP toolbox (optional)

`dolsot.mcp.McpToolbox` wraps an MCP server so its tools become synchronous
callables inside an `InProcessSession`. It is an optional feature:

    pip install 'dolsot[mcp]'

```python
from dolsot import InProcessSession
from dolsot.mcp import McpToolbox

# Remote server over streamable HTTP:
nn = McpToolbox.http(url="https://example/mcp", token="…")

# Or a locally spawned server over stdio:
# nn = McpToolbox.stdio(command="npx", args=["-y", "server-filesystem", "/data"])

session = InProcessSession(inject={"nn": nn})
# In a cell, the agent calls tools synchronously, positionally or by keyword:
#   nn.web_search(query="…")
# Introspect what's available with nn.catalog() / nn.help().
nn.close()  # or use `with McpToolbox.http(...) as nn:`
```

Policy stays with you via two optional hooks:

- `on_result(tool_name, value)` — post-process each result (e.g. turn a
  `{"rows": [...]}` payload into a DataFrame).
- `on_error(tool_name, result)` — return the exception to raise when a tool
  reports an error (defaults to `dolsot.mcp.McpToolError`).

Notes and limits: in-process backend only (not the subprocess `Repl`); transports
are streamable-HTTP and stdio; dispatch is dynamic, so tool calls are not covered
by the `ty` type gate. A tool whose name collides with a toolbox method
(`tools`, `catalog`, `help`, `close`, `call`, `http`, `stdio`) is shadowed on
attribute access, but always reachable via `nn.call("name", ...)`.

## Sessions and `SessionStore`

A session is opaque bytes to dolsot — the worker process owns pickling (via
`dill`) and unpickling; the host only ever loads and saves a blob under a
session id. Only what `dill` can serialize survives: when the namespace holds an
unpicklable live object, the worker saves everything else and drops just that
name (surfaced on `Result.dropped`), rather than losing the whole session. That's
the whole `SessionStore` protocol:

```python
from typing import Protocol

class SessionStore(Protocol):
    def load(self, sid: str) -> bytes | None: ...
    def save(self, sid: str, blob: bytes) -> None: ...
    def delete(self, sid: str) -> int: ...   # sid == "all" wipes everything
    def list(self) -> list[SessionInfo]: ...
```

Two implementations ship in `dolsot.store`:

- **`FileStore`** (the default) — one pickle file per session under a
  directory (`DOLSOT_CACHE_DIR`, or an OS-agnostic default under the platform
  temp dir, `{tempdir}/dolsot-{uid}/sessions`). The temp dir can be shared and
  world-writable (e.g. `/tmp` on Linux), and a session pickle **runs code when
  dill loads it**, so the default is namespaced per uid and created `0700`;
  FileStore refuses a session dir that is a symlink or not owned by the current
  user. Because temp dirs are cleared on reboot and by system reapers, default
  persistence is **best-effort**; point `DOLSOT_CACHE_DIR` at a durable directory
  when a session must outlive that. It also reaps files untouched for
  `DOLSOT_SESSION_TTL_DAYS` on each access (`0` disables it), where "untouched"
  means not written — every run rewrites its session, so an actively-used session
  is never reaped.
- **`MemoryStore`** — an in-process dict, no TTL. No persistence beyond the
  host process's lifetime; mainly for tests and short-lived hosts.

Writing a custom store (e.g. Redis, S3, a database row) means implementing
those four methods and passing an instance to `Repl`:

```python
from dolsot import Repl

class RedisStore:
    def __init__(self, client):
        self.client = client

    def load(self, sid: str) -> bytes | None:
        return self.client.get(f"dolsot:{sid}")

    def save(self, sid: str, blob: bytes) -> None:
        self.client.set(f"dolsot:{sid}", blob)

    def delete(self, sid: str) -> int:
        if sid == "all":
            keys = self.client.keys("dolsot:*")
            return self.client.delete(*keys) if keys else 0
        return self.client.delete(f"dolsot:{sid}")

    def list(self):
        ...  # SessionInfo(id, size_bytes, last_used) per key

repl = Repl(inject={"mt": "mytools"}, store=RedisStore(my_redis_client))
```

A store deals in bytes only — it must never deserialize a session, and
dolsot never asks it to.

## Configuration

Every setting can be passed explicitly to `Repl(...)`, or left to fall back
to an environment variable, or a hardcoded default. Precedence is always:

**explicit argument > environment variable > default.**

| variable | controls | default |
|---|---|---|
| `DOLSOT_CACHE_DIR` | `FileStore`'s session directory | `{tempdir}/dolsot-{uid}/sessions` |
| `DOLSOT_SESSION_TTL_DAYS` | days a session file survives unused before `FileStore` reaps it (`0` disables reaping) | `7` |
| `DOLSOT_TIMEOUT` | wall-clock seconds before a cell is killed. Bounds the **whole worker lifetime** — interpreter startup, session load/dump, the type gate, and your code — not your code alone, so loading a very large session eats into it. The gate caps its own run at this budget too | `20` |
| `DOLSOT_MAX_OUTPUT` | max chars of `stdout`/`value` kept before truncation (`0` disables the cap) | `100000` |
| `DOLSOT_TYPECHECK` | set to `0` to skip the `ty` type gate before running a cell | `1` (on) |
| `DOLSOT_TY_BIN` | the `ty` binary to invoke for the type gate | `ty` |

The `dolsot` CLI's `--timeout` maps straight to `Repl(timeout=...)`; when the
flag is omitted the CLI passes `None`, so `DOLSOT_TIMEOUT` (or the built-in
default) applies exactly as it would from the library. There is no
`--cache-dir` flag — set `DOLSOT_CACHE_DIR` instead.
