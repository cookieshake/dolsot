"""brokenhint_tools — a toolbox whose introspection blows up via a PEP 562
module-level __getattr__. Used to test that a gate.hint() failure in
worker.py:main() degrades to "no hint" instead of crashing the worker or
leaking the introspection exception text (see IMPORTANT 5)."""
from __future__ import annotations

__all__ = ["add", "unstable"]


def add(a: int, b: int) -> int:
    """Add two ints."""
    return a + b


def __getattr__(name: str):
    if name.startswith("_"):
        raise AttributeError(name)
    raise RuntimeError(f"introspection blew up for {name!r} — internal toolbox detail")
