"""The worker: user code runs here, in a child process, never in the host.

exec()/eval() of arbitrary code is the entire point of this module — it is a
deliberate, user-approved Python REPL, not a sandbox. The child process is for
timeout enforcement and host protection, not isolation: code here has full
filesystem, network, and process access.
"""
from __future__ import annotations

import ast
import importlib
import io
import json
import sys
import types
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any

from . import gate, hints
from ._execcore import split_trailing_expression


def held_names(ns: types.ModuleType, aliases: set[str]) -> list[str]:
    """Names the session carries to the next call: user variables, imports and
    functions — minus dunders and the re-injected toolbox aliases."""
    return sorted(
        k for k in vars(ns)
        if not k.startswith("__") and k not in aliases
    )


def _cap(text: str, limit: int | None) -> str:
    """Truncate runaway output so a cell that prints (or returns) gigabytes can't
    blow up the worker's result payload or the host reading it back."""
    if not limit or len(text) <= limit:
        return text
    return text[:limit] + f"\n… [truncated {len(text) - limit} chars; raise DOLSOT_MAX_OUTPUT]"


def _describe(exc: BaseException) -> tuple[str, int]:
    """(message, exit_code) for an exception raised by user code.

    A toolbox signals its own exit code by carrying an int `.exit_code`; its
    message is shown as-is. Everything else is exit 1, prefixed with its class."""
    code = getattr(exc, "exit_code", None)
    if isinstance(code, int) and not isinstance(code, bool):
        return str(exc), code
    return f"{type(exc).__name__}: {exc}", 1


def execute(
    code: str,
    ns: types.ModuleType,
    aliases: set[str],
    injected: dict[str, types.ModuleType] | None = None,
    max_output: int | None = None,
) -> dict:
    """Run `code` in `ns`. The value of a trailing expression is stringified into
    `value`; print() output is captured into `stdout`. When `injected` is given, a
    wrong-arguments TypeError gets the offending callable's signature appended.
    `stdout` and `value` are each capped at `max_output` chars (None = no cap)."""
    buf = io.StringIO()
    value: Any = None
    try:
        tree = ast.parse(code, mode="exec")
        last = split_trailing_expression(tree)
        body_code = compile(tree, "<dolsot>", "exec")
        expr_code = compile(last, "<dolsot>", "eval") if last is not None else None

        with redirect_stdout(buf):
            exec(body_code, ns.__dict__)
            if expr_code is not None:
                value = eval(expr_code, ns.__dict__)
    except BaseException as exc:   # SystemExit/KeyboardInterrupt included on purpose:
        error_msg: str
        exit_code: int
        error_msg, exit_code = _describe(exc)  # user code must not take the worker down silently
        if isinstance(exc, TypeError) and injected:
            try:
                hint = hints.typeerror_hint(exc, injected)
            except Exception:
                hint = None
            if hint:
                error_msg += "\n" + hint
        return {
            "ok": False, "value": None, "stdout": _cap(buf.getvalue(), max_output),
            "error": _cap(error_msg, max_output), "exit_code": exit_code,
            "held": held_names(ns, aliases),
        }

    return {
        "ok": True,
        "value": None if value is None else _cap(str(value), max_output),
        "stdout": _cap(buf.getvalue(), max_output),
        "error": None,
        "exit_code": 0,
        "held": held_names(ns, aliases),
    }


NS_NAME = "dolsot_session"


def _load_namespace(session_in: str | None) -> types.ModuleType:
    if not session_in:
        return types.ModuleType(NS_NAME)
    import dill
    loaded = dill.load_module(session_in)
    if loaded is None:
        raise ValueError(f"dill.load_module returned no module for {session_in!r}")
    return loaded


def _inject(ns: types.ModuleType, spec: dict[str, str]) -> dict[str, types.ModuleType]:
    """Import each toolbox and bind it under its alias. Also registers the alias in
    sys.modules so a habitual `import <alias>` in a cell is a harmless no-op."""
    injected: dict[str, types.ModuleType] = {}
    for alias, modname in spec.items():
        mod = importlib.import_module(modname)
        setattr(ns, alias, mod)
        sys.modules[alias] = mod
        injected[alias] = mod
    return injected


def _unpicklable_names(ns: types.ModuleType, aliases: set[str]) -> list[str]:
    """Held names whose value dill cannot pickle. Probing each in isolation also
    catches the transitive case — a picklable-looking object that references an
    unpicklable one fails here too, since pickling it pickles the reference."""
    import dill
    bad = []
    for name in held_names(ns, aliases):
        try:
            dill.dumps(getattr(ns, name))
        except Exception:
            bad.append(name)
    return bad


def _dump(
    ns: types.ModuleType, session_out: str, aliases: set[str]
) -> tuple[bool, str | None, list[str]]:
    """Persist the namespace with the injected toolboxes stripped out — the next
    call re-injects the live modules, so a session never resurrects stale code.

    Best-effort: a single object dill cannot pickle (a live connection, lock,
    socket, generator) must not sink the whole session. The happy path dumps once;
    only when that fails do we find the offenders, drop them, and save the rest.
    Returns (saved, save_error, dropped_names)."""
    import dill
    stashed = {}   # name -> value, removed before the dump and restored after
    for alias in aliases:
        if hasattr(ns, alias):
            stashed[alias] = getattr(ns, alias)
            delattr(ns, alias)
    dropped: list[str] = []
    try:
        try:
            dill.dump_module(session_out, module=ns)
        except Exception:
            dropped = _unpicklable_names(ns, aliases)
            for name in dropped:
                stashed[name] = getattr(ns, name)
                delattr(ns, name)
            dill.dump_module(session_out, module=ns)   # may still raise -> outer except
        return True, None, dropped
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}", dropped
    finally:
        for name, val in stashed.items():
            setattr(ns, name, val)


def main() -> int:
    req = json.load(sys.stdin)
    result_path = req["result_path"]
    spec: dict[str, str] = req.get("inject") or {}
    aliases = set(spec)

    def emit(payload: dict) -> int:
        payload.setdefault("saved", False)
        payload.setdefault("save_error", None)
        payload.setdefault("dropped", [])
        Path(result_path).write_text(json.dumps(payload))
        return 0

    try:
        ns = _load_namespace(req.get("session_in"))
    except Exception as exc:
        return emit({
            "ok": False, "value": None, "stdout": "", "held": [], "exit_code": 1,
            "error": f"could not load session ({type(exc).__name__}: {exc}) — reset it and start over",
        })

    try:
        injected = _inject(ns, spec)
    except Exception as exc:
        return emit({
            "ok": False, "value": None, "stdout": "", "held": [], "exit_code": 1,
            "error": f"could not load toolbox ({type(exc).__name__}: {exc}) — check the inject configuration",
        })

    if req.get("typecheck"):
        diags = gate.check(req["code"], spec, held_names(ns, aliases), req.get("ty_bin") or "ty",
                           timeout=req.get("timeout"))
        if diags:
            lines = ["type check failed (fix all, then re-run) —", *diags]
            try:
                lines.append(gate.hint(diags, injected))
            except Exception:
                pass   # a toolbox's introspection blowing up must not crash the worker
            message = "\n".join(lines)
            return emit({
                "ok": False, "value": None, "stdout": "", "held": held_names(ns, aliases),
                "exit_code": 1, "error": message,
            })

    out = execute(req["code"], ns, aliases, injected=injected, max_output=req.get("max_output"))
    saved, save_error, dropped = _dump(ns, req["session_out"], aliases)
    out["saved"] = saved
    out["save_error"] = save_error
    out["dropped"] = dropped
    if dropped:
        # held must name only what actually persisted, or the banner lies.
        out["held"] = [h for h in out["held"] if h not in dropped]
    return emit(out)


if __name__ == "__main__":
    sys.exit(main())
