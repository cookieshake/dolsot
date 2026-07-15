"""Optional reference AST gate for the in-process backend. Blocks the constructs
that turn 'unspecified user text -> LLM -> code' into host RCE. In-process CPython
sandboxing is leaky by nature — this is a defense line, NOT a security boundary.
Callers may use this or supply their own `check`."""
from __future__ import annotations

import ast
import builtins as _builtins
import collections
import datetime
import json
import math
import re
import statistics

_FORBIDDEN_NAMES = frozenset({
    "open", "eval", "exec", "compile", "__import__",
    "globals", "locals", "vars", "getattr", "setattr", "delattr",
})

# Frame/generator/coroutine/traceback introspection attributes: not dunder-wrapped,
# so they slip past the dunder filter, yet reach caller frames (f_back) and the
# unrestricted real builtins (f_globals/f_builtins). Block the accessors outright.
_FORBIDDEN_ATTRS = frozenset({
    "gi_frame", "gi_code", "gi_yieldfrom",
    "cr_frame", "cr_code", "cr_await",
    "ag_frame", "ag_code", "ag_await",
    "tb_frame", "tb_next",
    "f_back", "f_builtins", "f_code", "f_globals", "f_locals", "f_trace", "f_lasti",
})


class SandboxViolation(Exception):
    """Submitted code broke a gate rule."""


class _Checker(ast.NodeVisitor):
    def visit_Import(self, node: ast.Import) -> None:
        raise SandboxViolation("import is not allowed — injected modules are already available.")

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        raise SandboxViolation("from-import is not allowed — injected modules are already available.")

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if node.attr.startswith("__") and node.attr.endswith("__"):
            raise SandboxViolation(f"dunder attribute access is not allowed: {node.attr}")
        if node.attr in _FORBIDDEN_ATTRS:
            raise SandboxViolation(f"frame/introspection attribute access is not allowed: {node.attr}")
        self.generic_visit(node)

    def visit_Name(self, node: ast.Name) -> None:
        if node.id.startswith("__") and node.id.endswith("__"):
            raise SandboxViolation(f"dunder name is not allowed: {node.id}")
        if node.id in _FORBIDDEN_NAMES:
            raise SandboxViolation(f"forbidden name: {node.id}")
        self.generic_visit(node)


def check_ast(code: str) -> None:
    """Raise SandboxViolation on a forbidden construct; wraps SyntaxError too."""
    try:
        tree = ast.parse(code, mode="exec")
    except SyntaxError as exc:
        raise SandboxViolation(f"syntax error: {exc}") from exc
    _Checker().visit(tree)


# RCE-adjacent names (above) plus DoS / interactive footguns removed from the
# builtins a cell may see. `open`, `eval`, etc. are already in _FORBIDDEN_NAMES.
_UNSAFE_BUILTINS = _FORBIDDEN_NAMES | frozenset({
    "breakpoint", "input", "help", "exit", "quit", "copyright", "credits", "license",
})

#: Full builtins minus the unsafe subset. Pin a namespace's __builtins__ to this
#: (the in-process backend does) to block CPython's auto-injected full builtins.
SAFE_BUILTINS: dict[str, object] = {
    name: obj for name, obj in vars(_builtins).items() if name not in _UNSAFE_BUILTINS
}

#: Stdlib-only fixed names merged into every cell. NO pandas — dolsot has no such
#: dependency; consumers merge their own live modules via the `preinject` param.
PREINJECT: dict[str, object] = {
    "math": math, "json": json, "re": re,
    "datetime": datetime, "statistics": statistics, "collections": collections,
}
