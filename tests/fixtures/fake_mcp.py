"""Fake MCP session objects for testing McpToolbox without a real server."""

from contextlib import asynccontextmanager
from types import SimpleNamespace


class FakeResult:
    """Mimics mcp CallToolResult. Spelling (camel/snake) is configurable."""

    def __init__(self, *, structured=None, text=None, error=False, snake=False):
        content = []
        if text is not None:
            content.append(SimpleNamespace(type="text", text=text))
        self.content = content
        if snake:
            self.structured_content = structured
            self.is_error = error
        else:
            self.structuredContent = structured
            self.isError = error


class FakeTool:
    def __init__(self, name, description, input_schema, annotations=None):
        self.name = name
        self.description = description
        self.inputSchema = input_schema
        self.annotations = annotations


class FakeSession:
    """Records calls and returns canned results keyed by tool name."""

    def __init__(self, tools, results=None):
        self._tools = tools
        self._results = results or {}
        self.calls = []
        self.initialized = False

    async def initialize(self):
        self.initialized = True

    async def list_tools(self):
        return SimpleNamespace(tools=self._tools)

    async def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        result = self._results.get(name)
        if callable(result):
            result = result(arguments)
        if isinstance(result, BaseException):
            raise result
        return result


def make_connect(session):
    """Build a `connect` callable yielding the given (already-usable) session."""

    @asynccontextmanager
    async def _connect():
        await session.initialize()
        yield session

    return _connect


def make_connect_sequence(sessions, opened=None, exit_error=None):
    """Build a `connect` callable that yields a fresh session per connection.

    `sessions` items may be FakeSession instances (yielded) or exceptions
    (raised on entry, simulating a failed reconnect). Every entered session is
    appended to `opened`, so tests can count reconnections. When `exit_error` is
    set, leaving the context manager raises it — like a dead transport whose
    teardown also fails.
    """
    remaining = list(sessions)
    opened = [] if opened is None else opened

    @asynccontextmanager
    async def _connect():
        if not remaining:
            raise AssertionError("connect called more times than the test expected")
        session = remaining.pop(0)
        if isinstance(session, BaseException):
            raise session
        await session.initialize()
        opened.append(session)
        yield session
        if exit_error is not None:
            raise exit_error

    return _connect, opened


def make_failing_connect(exc):
    """Build a `connect` callable whose context manager raises `exc` on entry."""

    @asynccontextmanager
    async def _connect():
        raise exc
        yield  # pragma: no cover - unreachable, keeps this a generator

    return _connect
