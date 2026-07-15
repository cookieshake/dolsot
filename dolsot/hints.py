"""Error hints built by reflecting over the injected modules.

A CPython wrong-arguments TypeError names the callable but not where it lives
("add() missing 1 required positional argument: 'b'"). We resolve that bare name
back to the toolbox callable it came from and show its real signature.

Nothing here knows any specific toolbox: the public surface is whatever `__all__`
says, or every non-underscore attribute when there is no `__all__`.
"""
from __future__ import annotations

import inspect
import re
import types
from typing import Any, cast

MAX_DEPTH = 3

_ARG_TYPEERROR = re.compile(
    r"^(\w+)\(\) (?:missing \d+ required|takes \d+|got (?:an|multiple|some))"
)


def _belongs(name: str, root: str) -> bool:
    """Check if a module/callable name belongs to a root package.

    Exact match (name == root) or dotted subpackage (name.startswith(root + ".")),
    but not partial prefix match (e.g., "mytools" does not match "mytools_extra").
    """
    return name == root or name.startswith(root + ".")


def public_names(mod: types.ModuleType) -> list[str]:
    """Extract public names from a module: __all__ if declared, else all non-underscore attrs."""
    declared = getattr(mod, "__all__", None)
    if declared is not None:
        return [str(n) for n in declared]
    return [n for n in dir(mod) if not n.startswith("_")]


def _walk(mod: types.ModuleType, dotted: str, root: str, reg: dict, seen: set, depth: int) -> None:
    """Recursively walk a module tree, registering callables by bare name.

    Respects __all__, recurses into sub-packages up to MAX_DEPTH, and skips cycles.
    """
    if depth > MAX_DEPTH or id(mod) in seen:
        return
    seen.add(id(mod))
    for name in public_names(mod):
        obj = getattr(mod, name, None)
        if obj is None:
            continue
        path = f"{dotted}.{name}"
        if isinstance(obj, types.ModuleType):
            if _belongs(getattr(obj, "__name__", ""), root):
                _walk(obj, path, root, reg, seen, depth + 1)
        elif callable(obj) and _belongs(getattr(obj, "__module__", ""), root):
            reg.setdefault(getattr(obj, "__name__", name), (path, obj))


def registry(injected: dict[str, types.ModuleType]) -> dict[str, tuple[str, object]]:
    """Bare callable name -> (dotted path as the user writes it, the callable)."""
    reg: dict[str, tuple[str, object]] = {}
    for alias, mod in injected.items():
        root = getattr(mod, "__name__", "")
        _walk(mod, alias, root, reg, set(), 1)
    return reg


def _alias_of(dotted: str) -> str:
    """Extract the first component of a dotted path (e.g. 'mt' from 'mt.sub.fn')."""
    return dotted.split(".", 1)[0]


def signature_hint(name: str, injected: dict[str, types.ModuleType]) -> str | None:
    """Hint block for a toolbox callable named by its bare name. None if unknown."""
    entry = registry(injected).get(name)
    if entry is None:
        return None
    dotted, fn = entry
    try:
        sig = str(inspect.signature(cast(Any, fn)))
    except (TypeError, ValueError):
        sig = "(...)"
    lines = [
        f"  hint: {dotted}{sig}",
        "        every positional arg is REQUIRED — pass them all explicitly "
        "(use None for an optional one you don't need).",
    ]
    alias = _alias_of(dotted)
    mod = injected.get(alias)
    if mod is not None and callable(getattr(mod, "help", None)):
        bare = getattr(fn, "__name__", name)
        lines.append(
            f"        run  {alias}.help({bare!r})  for what each argument means, "
            f"or  {alias}.help()  for the whole API."
        )
    return "\n".join(lines)


def typeerror_hint(exc: TypeError, injected: dict[str, types.ModuleType]) -> str | None:
    """Hint for a wrong-arguments TypeError against a known toolbox callable.
    None for any other TypeError — leave those untouched."""
    m = _ARG_TYPEERROR.match(str(exc))
    return signature_hint(m.group(1), injected) if m else None
