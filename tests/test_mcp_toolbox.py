import sys

import pytest

from dolsot.mcp import McpToolError, McpToolSpec, _Loop, _require_http, _require_stdio


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


def test_http_constructs_lazily_without_connecting():
    tb = McpToolbox.http(url="http://example/mcp", token="secret")
    assert isinstance(tb, McpToolbox)
    assert tb._started is False
    assert tb._loop is None


def test_stdio_constructs_lazily_without_connecting():
    tb = McpToolbox.stdio(command="true", args=["--flag"])
    assert isinstance(tb, McpToolbox)
    assert tb._started is False
    assert tb._loop is None


def test_http_merges_bearer_token_into_headers(monkeypatch):
    captured = {}

    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def fake_streamable(url, headers=None):
        captured["url"] = url
        captured["headers"] = headers
        raise AssertionError("should not actually connect in this test")
        yield  # pragma: no cover

    # Patch the resolver so .http builds its connect from our fake.
    monkeypatch.setattr(
        "dolsot.mcp._require_http",
        lambda: (fake_streamable, object),
    )
    tb = McpToolbox.http(url="http://example/mcp", token="secret", headers={"X-A": "1"})
    # Drive the connect callable far enough to capture the headers it would use.
    with pytest.raises(AssertionError):
        tb._loop = _Loop()
        try:
            tb._loop.run(tb._connect().__aenter__())
        finally:
            tb._loop.close()
            tb._loop = None
    assert captured["headers"] == {"X-A": "1", "Authorization": "Bearer secret"}


def test_session_open_and_close_happen_in_one_task():
    import anyio
    from contextlib import asynccontextmanager

    session = FakeSession(
        tools=[_search_tool()],
        results={"web_search": FakeResult(structured={"ok": True})},
    )

    @asynccontextmanager
    async def scoped_connect():
        # A real anyio cancel scope, like the MCP SDK's transports/ClientSession.
        # Exiting it from a different task than entered raises RuntimeError.
        async with anyio.create_task_group():
            await session.initialize()
            yield session

    tb = McpToolbox(scoped_connect)
    try:
        assert tb.web_search(query="x") == {"ok": True}
    finally:
        tb.close()  # must NOT raise a cancel-scope "different task" error
    assert tb._started is False
    assert tb._loop is None


def test_call_reaches_tool_whose_name_shadows_a_method():
    close_tool = FakeTool("close", "a tool literally named close", {"type": "object", "properties": {}})
    session = FakeSession(
        tools=[close_tool],
        results={"close": FakeResult(structured={"done": True})},
    )
    with McpToolbox(make_connect(session)) as tb:
        assert callable(tb.close)  # attribute access returns the METHOD, not the tool
        assert tb.call("close") == {"done": True}  # escape hatch reaches the tool


def test_call_unknown_tool_raises():
    session = FakeSession(tools=[_search_tool()])
    with McpToolbox(make_connect(session)) as tb:
        with pytest.raises(AttributeError, match="no tool named 'missing'"):
            tb.call("missing")


def test_falsy_structured_value_is_not_discarded():
    session = FakeSession(
        tools=[_search_tool()],
        results={"web_search": FakeResult(structured={})},
    )
    with McpToolbox(make_connect(session)) as tb:
        assert tb.web_search(query="x") == {}

    session_zero = FakeSession(
        tools=[_search_tool()],
        results={"web_search": FakeResult(structured=0)},
    )
    with McpToolbox(make_connect(session_zero)) as tb:
        assert tb.web_search(query="x") == 0


def test_use_after_close_raises():
    session = FakeSession(
        tools=[_search_tool()],
        results={"web_search": FakeResult(structured={"ok": True})},
    )
    tb = McpToolbox(make_connect(session))
    assert tb.web_search(query="x") == {"ok": True}
    tb.close()
    with pytest.raises(RuntimeError, match="closed"):
        tb.call("web_search", query="x")


def test_tool_filter_exposes_only_matching_tools():
    stock_tool = FakeTool("stock_price", "Get a stock price", {"type": "object", "properties": {"ticker": {"type": "string"}}})
    session = FakeSession(
        tools=[_search_tool(), _add_tool(), stock_tool],
        results={"stock_price": FakeResult(structured={"price": 42})},
    )
    tb = McpToolbox(make_connect(session), tool_filter=lambda s: s.name.startswith("stock_"))
    try:
        assert [spec.name for spec in tb.tools()] == ["stock_price"]
        assert "stock_price" in tb.catalog()
        assert "web_search" not in tb.catalog()
        assert tb.stock_price(ticker="X") == {"price": 42}
    finally:
        tb.close()


def test_filtered_out_tool_is_not_accessible():
    session = FakeSession(tools=[_search_tool(), _add_tool()])
    tb = McpToolbox(make_connect(session), tool_filter=lambda s: s.name == "add")
    try:
        with pytest.raises(AttributeError, match="no tool named 'web_search'"):
            tb.web_search
        with pytest.raises(AttributeError, match="no tool named 'web_search'"):
            tb.call("web_search", query="x")
    finally:
        tb.close()


def test_none_filter_exposes_all_tools():
    session = FakeSession(tools=[_search_tool(), _add_tool()])
    with McpToolbox(make_connect(session)) as tb:
        assert {spec.name for spec in tb.tools()} == {"web_search", "add"}


def test_predicate_receives_annotations():
    seen = {}
    annotated = FakeTool(
        "readonly_tool",
        "A read-only tool",
        {"type": "object", "properties": {}},
        annotations={"readOnlyHint": True},
    )
    session = FakeSession(tools=[annotated])

    def keep_readonly(spec):
        seen[spec.name] = spec.annotations
        return bool(spec.annotations and spec.annotations.get("readOnlyHint"))

    with McpToolbox(make_connect(session), tool_filter=keep_readonly) as tb:
        assert [spec.name for spec in tb.tools()] == ["readonly_tool"]
    assert seen["readonly_tool"] == {"readOnlyHint": True}
