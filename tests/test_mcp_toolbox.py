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
