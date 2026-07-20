"""In-process MCP toolbox for dolsot.

Connects to an MCP server and exposes its tools as synchronous Python callables
suitable for injection into `dolsot.InProcessSession(inject={...})`.

Importing this module does NOT require the `mcp` SDK; only `McpToolbox.http()`
and `McpToolbox.stdio()` do. Install it with `pip install 'dolsot[mcp]'`.
"""

from __future__ import annotations

import asyncio
import threading
from contextlib import AsyncExitStack
from dataclasses import dataclass

_INSTALL_HINT = (
    "MCP support requires the optional dependency. "
    "Install it with: pip install 'dolsot[mcp]'"
)


class McpToolError(Exception):
    """Raised when an MCP tool call returns an error result."""

    def __init__(self, tool: str, content: str):
        super().__init__(f"MCP tool {tool!r} failed: {content}")
        self.tool = tool
        self.content = content


@dataclass
class McpToolSpec:
    """A discovered MCP tool: its name, description, and JSON input schema."""

    name: str
    description: str
    input_schema: dict


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
    """Exposes an MCP server's tools as synchronous callables for a dolsot cell."""

    def __init__(self, connect, *, on_result=None, on_error=None):
        self._connect = connect
        self._on_result = on_result
        self._on_error = on_error
        self._loop = None
        self._stack = None
        self._session = None
        self._specs = {}
        self._bound = {}
        self._started = False

    def _ensure_started(self):
        if self._started:
            return
        self._loop = _Loop()

        async def _startup():
            self._stack = AsyncExitStack()
            self._session = await self._stack.enter_async_context(self._connect())
            listing = await self._session.list_tools()
            for tool in listing.tools:
                self._specs[tool.name] = McpToolSpec(
                    name=tool.name,
                    description=tool.description or "",
                    input_schema=tool.inputSchema or {},
                )

        try:
            self._loop.run(_startup())
        except Exception:
            if self._stack is not None:
                try:
                    self._loop.run(self._stack.aclose())
                except Exception:
                    pass
            self._loop.close()
            self._loop = None
            self._stack = None
            self._session = None
            self._specs = {}
            raise
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
        props = list((spec.input_schema.get("properties") or {}).keys())

        def call(*args, **kwargs):
            merged = self._merge_args(spec.name, props, args, kwargs)
            result = self._loop.run(self._session.call_tool(spec.name, merged))
            return self._handle_result(spec.name, result)

        call.__name__ = spec.name
        call.__qualname__ = spec.name
        call.__doc__ = spec.description
        return call

    def _merge_args(self, name, props, args, kwargs):
        # Argument mapping is fleshed out in Task 3; for now, keywords only.
        return dict(kwargs)

    def _handle_result(self, name, result):
        # Full unwrap + hooks land in Task 3; for now, structured content only.
        return getattr(result, "structuredContent", None)

    def close(self):
        if not self._started:
            return
        if self._stack is not None:
            self._loop.run(self._stack.aclose())
            self._stack = None
        self._loop.close()
        self._loop = None
        self._session = None
        self._started = False

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
