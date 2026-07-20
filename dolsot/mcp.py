"""In-process MCP toolbox for dolsot.

Connects to an MCP server and exposes its tools as synchronous Python callables
suitable for injection into `dolsot.InProcessSession(inject={...})`.

Importing this module does NOT require the `mcp` SDK; only `McpToolbox.http()`
and `McpToolbox.stdio()` do. Install it with `pip install 'dolsot[mcp]'`.
"""

from __future__ import annotations

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
