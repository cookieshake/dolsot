"""dolsot — a toolbox-agnostic stateful Python REPL engine.

    from dolsot import Repl
    repl = Repl(inject={"mt": mytools})
    print(repl.run("work", "mt.add(1, 2)").text)

User code always runs in a child worker process: timeouts are enforced by killing
it, and a runaway cell cannot take the host down. This is not a sandbox — the
worker has full filesystem, network, and process access. The in-process backend
(`InProcessSession`) instead runs cells directly in the host process, trading that
isolation for speed and live-object sharing; it offers only weaker, cooperative
isolation (timeouts abandon rather than kill a runaway thread).
"""
from .core import InvalidSession, InvalidToolbox, Repl, valid_session_id
from .inprocess import InProcessSession
from .sandbox import SandboxViolation, check_ast
from .store import FileStore, MemoryStore, SessionStore
from .types import Result, SessionInfo

try:
    from importlib.metadata import version as _version

    __version__ = _version("dolsot")
except Exception:   # not installed (e.g. run straight from a source tree)
    __version__ = "0.0.0+unknown"

__all__ = [
    "Repl", "Result", "SessionInfo", "SessionStore", "FileStore", "MemoryStore",
    "InvalidSession", "InvalidToolbox", "valid_session_id", "__version__",
    "InProcessSession", "SandboxViolation", "check_ast",
]
