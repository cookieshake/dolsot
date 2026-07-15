"""faketools — a stand-in toolbox for dolsot's tests.

Satisfies every clause of the toolbox contract: __all__, an exception carrying
an int .exit_code, a help() callable, and real type annotations.
"""
from typing import Literal

from . import sub

__all__ = ["add", "boom", "kind", "sub", "help", "FakeError"]


class FakeError(Exception):
    exit_code = 3


def add(a: int, b: int) -> int:
    """Add two ints."""
    return a + b


def boom() -> None:
    """Always raises FakeError."""
    raise FakeError("boom happened")


def kind(k: Literal["x", "y"]) -> str:
    """Echo a narrowed literal back."""
    return f"kind={k}"


def help(topic: str | None = None) -> str:
    return "faketools cheat-sheet"


def _private() -> str:
    return "hidden"
