"""Data returned across dolsot's boundaries."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Result:
    """One code execution. Never raised — user code failing is a normal outcome
    the caller decides what to do with."""
    ok: bool
    value: str | None
    stdout: str
    error: str | None
    exit_code: int
    held: list[str] = field(default_factory=list)
    text: str = ""
    save_error: str | None = None
    #: names the worker computed but could not persist (unpicklable — a live
    #: connection, lock, socket, generator). Gone on the next call; not a fatal error.
    dropped: list[str] = field(default_factory=list)
    #: True when output was cut short — either it hit the output cap, or execution
    #: timed out with partial output. Set by the in-process backend; the subprocess
    #: backend signals truncation in-text and leaves this False.
    truncated: bool = False


@dataclass
class SessionInfo:
    id: str
    size_bytes: int
    last_used: float   # epoch seconds
