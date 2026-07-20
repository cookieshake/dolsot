import sys

import pytest

from dolsot.mcp import McpToolError, McpToolSpec, _require_http, _require_stdio


def test_mcp_module_imports_and_exposes_symbols():
    assert issubclass(McpToolError, Exception)
    err = McpToolError("web_search", "boom")
    assert err.tool == "web_search"
    assert err.content == "boom"
    spec = McpToolSpec(name="web_search", description="d", input_schema={})
    assert spec.name == "web_search"


def test_require_http_guides_when_mcp_missing(monkeypatch):
    # Setting the module to None makes `from mcp import ...` raise ImportError.
    monkeypatch.setitem(sys.modules, "mcp", None)
    with pytest.raises(ImportError, match=r"dolsot\[mcp\]"):
        _require_http()


def test_require_stdio_guides_when_mcp_missing(monkeypatch):
    monkeypatch.setitem(sys.modules, "mcp", None)
    with pytest.raises(ImportError, match=r"dolsot\[mcp\]"):
        _require_stdio()


from tests.fixtures.fake_mcp import (
    FakeResult,
    FakeSession,
    FakeTool,
    make_connect,
    make_failing_connect,
)

from dolsot.mcp import McpToolbox


def _search_tool():
    return FakeTool(
        "web_search",
        "Search the web",
        {"type": "object", "properties": {"query": {"type": "string"}}},
    )


def test_discovers_and_calls_tool_returning_structured_content():
    session = FakeSession(
        tools=[_search_tool()],
        results={"web_search": FakeResult(structured={"hits": 3})},
    )
    tb = McpToolbox(make_connect(session))
    try:
        out = tb.web_search(query="dolsot")
        assert out == {"hits": 3}
        assert session.initialized is True
        assert session.calls == [("web_search", {"query": "dolsot"})]
    finally:
        tb.close()


def test_unknown_tool_raises_attribute_error():
    session = FakeSession(tools=[_search_tool()])
    tb = McpToolbox(make_connect(session))
    try:
        with pytest.raises(AttributeError, match="no tool named 'nope'"):
            tb.nope
    finally:
        tb.close()


def test_context_manager_closes():
    session = FakeSession(
        tools=[_search_tool()],
        results={"web_search": FakeResult(structured={"ok": True})},
    )
    with McpToolbox(make_connect(session)) as tb:
        assert tb.web_search(query="x") == {"ok": True}
    assert tb._started is False
    assert tb._loop is None


def test_failed_startup_leaves_no_leaked_loop_and_close_is_noop():
    tb = McpToolbox(make_failing_connect(RuntimeError("boom")))
    with pytest.raises(RuntimeError, match="boom"):
        tb.web_search
    assert tb._started is False
    assert tb._loop is None
    # A subsequent close() must be a safe no-op, not raise or hang.
    tb.close()
