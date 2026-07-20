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


def _add_tool():
    return FakeTool(
        "add",
        "Add two numbers",
        {
            "type": "object",
            "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
        },
    )


def test_positional_args_map_to_schema_order():
    session = FakeSession(
        tools=[_add_tool()],
        results={"add": lambda args: FakeResult(structured={"sum": args["a"] + args["b"]})},
    )
    with McpToolbox(make_connect(session)) as tb:
        assert tb.add(5, 3) == {"sum": 8}
        assert session.calls[-1] == ("add", {"a": 5, "b": 3})


def test_too_many_positionals_raises_type_error():
    session = FakeSession(tools=[_add_tool()])
    with McpToolbox(make_connect(session)) as tb:
        with pytest.raises(TypeError, match="at most 2 positional"):
            tb.add(1, 2, 3)


def test_duplicate_positional_and_keyword_raises():
    session = FakeSession(tools=[_add_tool()])
    with McpToolbox(make_connect(session)) as tb:
        with pytest.raises(TypeError, match="multiple values for argument 'a'"):
            tb.add(1, a=2)


def test_text_json_result_is_decoded():
    session = FakeSession(
        tools=[_search_tool()],
        results={"web_search": FakeResult(text='{"hits": 7}')},
    )
    with McpToolbox(make_connect(session)) as tb:
        assert tb.web_search(query="x") == {"hits": 7}


def test_raw_text_result_returned_as_string():
    session = FakeSession(
        tools=[_search_tool()],
        results={"web_search": FakeResult(text="plain answer")},
    )
    with McpToolbox(make_connect(session)) as tb:
        assert tb.web_search(query="x") == "plain answer"


def test_snake_case_result_spelling_supported():
    session = FakeSession(
        tools=[_search_tool()],
        results={"web_search": FakeResult(structured={"v": 1}, snake=True)},
    )
    with McpToolbox(make_connect(session)) as tb:
        assert tb.web_search(query="x") == {"v": 1}


def test_error_result_raises_mcp_tool_error():
    session = FakeSession(
        tools=[_search_tool()],
        results={"web_search": FakeResult(text="boom", error=True)},
    )
    with McpToolbox(make_connect(session)) as tb:
        with pytest.raises(McpToolError, match="boom") as excinfo:
            tb.web_search(query="x")
        assert excinfo.value.tool == "web_search"


def test_snake_case_error_spelling_supported():
    session = FakeSession(
        tools=[_search_tool()],
        results={"web_search": FakeResult(text="bad", error=True, snake=True)},
    )
    with McpToolbox(make_connect(session)) as tb:
        with pytest.raises(McpToolError):
            tb.web_search(query="x")


def test_on_result_hook_shapes_value():
    session = FakeSession(
        tools=[_search_tool()],
        results={"web_search": FakeResult(structured={"rows": [1, 2]})},
    )
    seen = {}

    def shaper(name, value):
        seen["name"] = name
        return value["rows"]

    with McpToolbox(make_connect(session), on_result=shaper) as tb:
        assert tb.web_search(query="x") == [1, 2]
        assert seen["name"] == "web_search"


def test_on_error_hook_maps_exception():
    session = FakeSession(
        tools=[_search_tool()],
        results={"web_search": FakeResult(text="nope", error=True)},
    )

    class MyError(Exception):
        pass

    def mapper(name, result):
        return MyError(f"{name} failed")

    with McpToolbox(make_connect(session), on_error=mapper) as tb:
        with pytest.raises(MyError, match="web_search failed"):
            tb.web_search(query="x")


def test_tools_returns_specs():
    session = FakeSession(tools=[_search_tool(), _add_tool()])
    with McpToolbox(make_connect(session)) as tb:
        names = [spec.name for spec in tb.tools()]
        assert names == ["web_search", "add"]


def test_catalog_renders_signatures():
    session = FakeSession(tools=[_add_tool()])
    with McpToolbox(make_connect(session)) as tb:
        catalog = tb.catalog()
        assert "add(a, b)" in catalog
        assert "# Add two numbers" in catalog


def test_help_matches_catalog():
    session = FakeSession(tools=[_search_tool()])
    with McpToolbox(make_connect(session)) as tb:
        assert tb.help() == tb.catalog()
