"""In-process MCP toolbox for dolsot.

Connects to an MCP server and exposes its tools as synchronous Python callables
suitable for injection into `dolsot.InProcessSession(inject={...})`.

Importing this module does NOT require the `mcp` SDK; only `McpToolbox.http()`
and `McpToolbox.stdio()` do. Install it with `pip install 'dolsot[mcp]'`.
"""

from __future__ import annotations

import asyncio
import json
import threading
from contextlib import asynccontextmanager
from dataclasses import dataclass

_INSTALL_HINT = (
    "MCP support requires the optional dependency. "
    "Install it with: pip install 'dolsot[mcp]'"
)

_SHUTDOWN = object()


class McpToolError(Exception):
    """Raised when an MCP tool call returns an error result."""

    def __init__(self, tool: str, content: str):
        super().__init__(f"MCP tool {tool!r} failed: {content}")
        self.tool = tool
        self.content = content


@dataclass
class McpToolSpec:
    """A discovered MCP tool: its name, description, JSON input schema, and the
    MCP standard tool annotations (hints) when the server provides them."""

    name: str
    description: str
    input_schema: dict
    annotations: object | None = None


class _Loop:
    """A background daemon thread running a private asyncio event loop."""

    def __init__(self):
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    def run(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self._loop).result()

    def close(self):
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join()
        self._loop.close()


class McpToolbox:
    """Exposes an MCP server's tools as synchronous callables for a dolsot cell.

    A single background thread runs one asyncio event loop. One long-lived
    "service" coroutine owns the whole MCP session lifecycle: it opens the
    connection, discovers tools, then services a queue of tool-call requests,
    and finally closes the connection. Because the connection is opened AND
    closed inside that one coroutine (one asyncio task), anyio's requirement
    that a cancel scope be exited in the task that entered it is satisfied.
    """

    def __init__(self, connect, *, on_result=None, on_error=None, tool_filter=None):
        self._connect = connect
        self._on_result = on_result
        self._on_error = on_error
        self._tool_filter = tool_filter
        self._loop = None
        self._queue = None
        self._ready = None
        self._service_future = None
        self._start_error = None
        self._specs = {}
        self._bound = {}
        self._started = False
        self._closed = False

    @classmethod
    def http(cls, url, *, token=None, headers=None, on_result=None, on_error=None, tool_filter=None):
        streamablehttp_client, ClientSession = _require_http()
        hdrs = dict(headers or {})
        if token:
            hdrs["Authorization"] = f"Bearer {token}"

        @asynccontextmanager
        async def _connect():
            async with streamablehttp_client(url, headers=hdrs or None) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    yield session

        return cls(_connect, on_result=on_result, on_error=on_error, tool_filter=tool_filter)

    @classmethod
    def stdio(cls, command, args=None, *, env=None, on_result=None, on_error=None, tool_filter=None):
        stdio_client, StdioServerParameters, ClientSession = _require_stdio()
        params = StdioServerParameters(command=command, args=list(args or []), env=env)

        @asynccontextmanager
        async def _connect():
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    yield session

        return cls(_connect, on_result=on_result, on_error=on_error, tool_filter=tool_filter)

    async def _service(self):
        # Runs entirely in ONE task on the background loop: open -> discover ->
        # serve queue -> close, reopening whenever the session dies under us.
        # Enter and exit of every connection happen here, in this one task.
        pending = None  # a call to replay on the next session after a reconnect
        try:
            while True:
                teardown = False
                try:
                    async with self._connect() as session:
                        if not self._ready.is_set():
                            try:
                                await self._discover(session)
                            except BaseException as exc:  # noqa: BLE001
                                self._start_error = exc
                                self._ready.set()
                                return  # exits the async-with in THIS task
                            self._ready.set()
                        pending = await self._serve(session, pending)
                        teardown = True  # past here, errors are teardown noise
                    if pending is None:
                        return  # shutdown requested
                except BaseException as exc:  # noqa: BLE001
                    if self._ready is not None and not self._ready.is_set():
                        # The very first connection could not be opened.
                        self._start_error = exc
                        self._ready.set()
                        return
                    if teardown:
                        # Closing a session that just died often fails too; that
                        # must not cost us the retry (or stall the shutdown).
                        if pending is None:
                            return
                        continue
                    # The (re)connect itself failed. Surface it to the caller
                    # whose call triggered it, then idle until the next request
                    # rather than spinning on a server that is down.
                    if pending is not None:
                        _, _, fut = pending
                        pending = None
                        if not fut.done():
                            fut.set_exception(exc)
                    item = await self._queue.get()
                    if item is _SHUTDOWN:
                        return
                    pending = item
        finally:
            self._fail_pending()

    async def _discover(self, session):
        listing = await session.list_tools()
        for tool in listing.tools:
            spec = McpToolSpec(
                name=tool.name,
                description=tool.description or "",
                input_schema=tool.inputSchema or {},
                annotations=getattr(tool, "annotations", None),
            )
            if self._tool_filter is None or self._tool_filter(spec):
                self._specs[tool.name] = spec

    async def _serve(self, session, pending):
        """Serve queued calls on `session`.

        Returns None when shutdown was requested, or the item that must be
        replayed on a fresh session because this one died mid-call. `pending`
        is such a replay: it gets exactly one attempt, so a request is never
        sent to the server more than twice.
        """
        retrying = pending is not None
        while True:
            if pending is not None:
                item, pending = pending, None
            else:
                item = await self._queue.get()
                retrying = False
            if item is _SHUTDOWN:
                return None
            name, arguments, fut = item
            try:
                result = await session.call_tool(name, arguments)
            except BaseException as exc:  # noqa: BLE001
                if not retrying and _is_transport_error(exc):
                    return item
                if not fut.done():
                    fut.set_exception(exc)
            else:
                if not fut.done():
                    fut.set_result(result)

    def _fail_pending(self):
        # Fail any still-queued requests so callers never hang after shutdown.
        queue = self._queue
        if queue is None:
            return
        while not queue.empty():
            try:
                item = queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if item is _SHUTDOWN:
                continue
            _, _, fut = item
            if not fut.done():
                fut.set_exception(RuntimeError("McpToolbox session is closed"))

    def _ensure_started(self):
        if self._closed:
            raise RuntimeError("McpToolbox is closed")
        if self._started:
            return
        self._loop = _Loop()
        loop = self._loop._loop

        async def _setup():
            self._queue = asyncio.Queue()
            self._ready = asyncio.Event()

        asyncio.run_coroutine_threadsafe(_setup(), loop).result()
        self._service_future = asyncio.run_coroutine_threadsafe(self._service(), loop)
        # Block until the service task has connected + discovered (or failed).
        asyncio.run_coroutine_threadsafe(self._ready.wait(), loop).result()

        if self._start_error is not None:
            error = self._start_error
            # The service task already unwound its own connection in-task and
            # returned; just stop the loop/thread and reset state.
            self._service_future.result()
            self._loop.close()
            self._loop = None
            self._queue = None
            self._ready = None
            self._service_future = None
            self._start_error = None
            self._specs = {}
            raise error
        self._started = True

    def __getattr__(self, name):
        # Only called on normal-lookup miss. Guard internal/dunder names to avoid
        # recursion while __init__ attributes are still being set.
        if name.startswith("_"):
            raise AttributeError(name)
        self._ensure_started()
        if name in self._bound:
            return self._bound[name]
        if name not in self._specs:
            raise AttributeError(f"MCP server exposes no tool named {name!r}")
        fn = self._make_callable(self._specs[name])
        self._bound[name] = fn
        return fn

    def _make_callable(self, spec):
        def fn(*args, **kwargs):
            return self.call(spec.name, *args, **kwargs)

        fn.__name__ = spec.name
        fn.__qualname__ = spec.name
        fn.__doc__ = spec.description
        return fn

    def call(self, name, *args, **kwargs):
        """Invoke a tool by name. Escape hatch for tools whose names collide
        with McpToolbox's own methods/attributes (e.g. a tool named ``help``)."""
        self._ensure_started()
        if name not in self._specs:
            raise AttributeError(f"MCP server exposes no tool named {name!r}")
        props = list((self._specs[name].input_schema.get("properties") or {}).keys())
        merged = self._merge_args(name, props, args, kwargs)
        raw = self._call_tool(name, merged)
        return self._handle_result(name, raw)

    def _call_tool(self, name, arguments):
        loop = self._loop._loop

        async def _enqueue():
            fut = loop.create_future()
            await self._queue.put((name, arguments, fut))
            return await fut

        return asyncio.run_coroutine_threadsafe(_enqueue(), loop).result()

    def _merge_args(self, name, props, args, kwargs):
        if len(args) > len(props):
            raise TypeError(
                f"{name}() takes at most {len(props)} positional argument(s), "
                f"got {len(args)}"
            )
        merged = dict(kwargs)
        for value, key in zip(args, props):
            if key in merged:
                raise TypeError(f"{name}() got multiple values for argument {key!r}")
            merged[key] = value
        return merged

    def _handle_result(self, name, result):
        if _is_error(result):
            if self._on_error is not None:
                raise self._on_error(name, result)
            raise McpToolError(name, _error_text(result))
        value = _unwrap(result)
        if self._on_result is not None:
            return self._on_result(name, value)
        return value

    def tools(self):
        self._ensure_started()
        return list(self._specs.values())

    def catalog(self):
        self._ensure_started()
        lines = []
        for spec in self._specs.values():
            params = ", ".join((spec.input_schema.get("properties") or {}).keys())
            suffix = f"  # {spec.description}" if spec.description else ""
            lines.append(f"{spec.name}({params}){suffix}")
        return "\n".join(lines)

    def help(self):
        return self.catalog()

    def close(self):
        if self._closed:
            return
        if not self._started:
            if self._loop is not None:
                self._loop.close()
                self._loop = None
            self._closed = True
            return
        loop = self._loop._loop
        try:
            asyncio.run_coroutine_threadsafe(self._queue.put(_SHUTDOWN), loop).result()
            self._service_future.result()  # wait for in-task connection teardown
        finally:
            self._loop.close()
            self._loop = None
            self._queue = None
            self._ready = None
            self._service_future = None
            self._started = False
            self._closed = True

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def _require_http():
    try:
        from mcp import ClientSession
        from mcp.client.streamable_http import streamablehttp_client
    except ImportError as exc:
        raise ImportError(_INSTALL_HINT) from exc
    return streamablehttp_client, ClientSession


def _require_stdio():
    try:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
    except ImportError as exc:
        raise ImportError(_INSTALL_HINT) from exc
    return stdio_client, StdioServerParameters, ClientSession


def _is_transport_error(exc):
    """True when a failed `call_tool` means the session/transport is gone.

    An MCP server reports tool failures as results with `isError` set, so an
    exception out of `call_tool` is a protocol- or transport-level problem. The
    exception is `McpError`: a well-formed JSON-RPC error response, which proves
    the session is alive and the request already reached the server — replaying
    it would be pointless at best and a duplicate side effect at worst.
    """
    if isinstance(exc, BaseExceptionGroup):
        return any(_is_transport_error(inner) for inner in exc.exceptions)
    if not isinstance(exc, Exception):
        return False  # CancelledError, KeyboardInterrupt, ...
    return not any(base.__name__ == "McpError" for base in type(exc).__mro__)


def _is_error(result):
    value = getattr(result, "is_error", None)
    if value is None:
        value = getattr(result, "isError", False)
    return bool(value)


def _structured(result):
    value = getattr(result, "structured_content", None)
    if value is None:
        value = getattr(result, "structuredContent", None)
    return value


def _text(result):
    parts = []
    for block in getattr(result, "content", None) or []:
        text = getattr(block, "text", None)
        if text is not None:
            parts.append(text)
    return "".join(parts)


def _unwrap(result):
    structured = _structured(result)
    if structured is not None:
        return structured
    text = _text(result)
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return text


def _error_text(result):
    return _text(result) or "MCP tool returned an error"
