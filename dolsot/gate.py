"""Type-check a cell before running it, so a bad toolbox call is reported as a
list of fixable diagnostics instead of a raw CPython TypeError.

dolsot knows no signatures: it writes the cell to a temp file under a generated
preamble (`import <module> as <alias>` for each injection, plus `name: Any = None`
for every name the session already holds) and lets ty read the toolbox's own
source. Any checker failure is fail-open — the gate must never be the reason a
legitimate cell cannot run.
"""
from __future__ import annotations

import ast
import os
import re
import subprocess
import sys
import tempfile
import types
from pathlib import Path

from . import hints

TIMEOUT_S = 15

BLOCKING_RULES = {
    "missing-argument",
    "too-many-positional-arguments",
    "unknown-argument",
    "invalid-argument-type",
    "unresolved-attribute",
    "unresolved-reference",
}

_TY_LINE = re.compile(r"^[^:]+:(\d+):\d+:\s*error\[([a-z-]+)\]\s*(.*)$")
_TY_FUNC = re.compile(r"function `(\w+)`")


def _references_any(code: str, aliases: set[str]) -> bool:
    try:
        tree = ast.parse(code, mode="exec")
    except SyntaxError:
        return False   # let the executor surface the SyntaxError normally
    return any(isinstance(n, ast.Name) and n.id in aliases for n in ast.walk(tree))


def check(
    code: str, inject: dict[str, str], held: list[str], ty_bin: str = "ty",
    timeout: int | None = None,
) -> list[str]:
    """Blocking diagnostics for `code`, or [] to allow it. `timeout` is the cell's
    wall-clock budget; the gate caps its own run at it (never above TIMEOUT_S) so a
    slow checker can't consume the budget and get the whole worker killed first."""
    if not inject or not _references_any(code, set(inject)):
        return []
    gate_timeout = TIMEOUT_S if not timeout else min(TIMEOUT_S, timeout)

    preamble = ["from typing import Any"]
    preamble += [f"import {mod} as {alias}" for alias, mod in inject.items()]
    preamble += [f"{name}: Any = None" for name in held]
    n_pre = len(preamble)
    doc = "\n".join(preamble) + "\n" + code

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir) / "cell.py"
            tmp.write_text(doc)
            proc = subprocess.run(
                [ty_bin, "check", "--python", sys.prefix,
                 "--output-format", "concise", str(tmp)],
                capture_output=True, text=True, timeout=gate_timeout,
                env={**os.environ, "VIRTUAL_ENV": sys.prefix},
            )
    except Exception:
        return []   # ty missing / crashed / timed out → fail open

    out = []
    for line in (proc.stdout + "\n" + proc.stderr).splitlines():
        m = _TY_LINE.match(line.strip())
        if not m:
            continue
        lineno, rule, msg = int(m.group(1)), m.group(2), m.group(3)
        if rule not in BLOCKING_RULES or lineno <= n_pre:
            continue
        out.append(f"  line {lineno - n_pre}: {rule}: {msg}")
    return out


def hint(diags: list[str], injected: dict[str, types.ModuleType]) -> str:
    """Actionable line appended to a failed gate: the offending callable's real
    signature when a diagnostic names one, otherwise a pointer at the API."""
    for d in diags:
        m = _TY_FUNC.search(d)
        if m:
            h = hints.signature_hint(m.group(1), injected)
            if h:
                return h
    aliases = sorted(injected)
    alias = aliases[0] if aliases else "the toolbox"
    return f"  hint: run  {alias}.help()  for the full API — every signature and argument."
