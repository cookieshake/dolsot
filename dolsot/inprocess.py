"""In-process execution backend. Runs a cell's exec IN THE HOST PROCESS against a
live namespace dict. This is deliberately LESS isolated than the subprocess
backend — there is no process boundary. The only defense is the caller-supplied
`check` gate and a pinned `__builtins__`; dolsot provides the mechanism, not a
safety guarantee. Injected values are live objects, placed as-is."""
from __future__ import annotations

import asyncio
import ast
import builtins
import concurrent.futures
import io
import threading
import traceback
from typing import Any, Callable

from ._execcore import cap_text, split_trailing_expression
from .types import Result


def _run_cell(
    code: str,
    namespace: dict,
    *,
    check: Callable[[str], None] | None,
    builtins_map: dict,
    max_output: int,
    stdout_buf: io.StringIO,
) -> Result:
    """Execute `code` in `namespace`. Never raises: every failure (gate, syntax,
    runtime) becomes a Result. `held`/`text` are left for the session to fill."""
    if check is not None:
        try:
            check(code)
        except Exception as exc:
            return Result(ok=False, value=None, stdout="", error=str(exc), exit_code=1)

    try:
        tree = ast.parse(code, mode="exec")
    except SyntaxError as exc:
        return Result(ok=False, value=None, stdout="", error=f"SyntaxError: {exc}", exit_code=1)

    last = split_trailing_expression(tree)

    # Namespace-local print capture — NEVER contextlib.redirect_stdout, which swaps
    # the global sys.stdout and would tangle concurrent turns in the same process.
    def _capture_print(*args: Any, **kwargs: Any) -> None:
        kwargs["file"] = stdout_buf
        print(*args, **kwargs)

    # Pinning __builtins__ to a dict also blocks CPython's auto-injected full
    # builtins module. print is rebound to this cell's buffer.
    namespace["__builtins__"] = {**builtins_map, "print": _capture_print}

    value: Any = None
    try:
        exec(compile(tree, "<inprocess>", "exec"), namespace)
        if last is not None:
            value = eval(compile(last, "<inprocess>", "eval"), namespace)
    except BaseException:   # SystemExit/KeyboardInterrupt included — nothing escapes
        stdout, truncated = cap_text(stdout_buf.getvalue(), max_output)
        return Result(
            ok=False, value=None, stdout=stdout,
            error=traceback.format_exc(limit=3), exit_code=1, truncated=truncated,
        )

    stdout, truncated = cap_text(stdout_buf.getvalue(), max_output)
    value_repr = None
    if value is not None:
        value_repr, v_trunc = cap_text(repr(value), max_output)
        truncated = truncated or v_trunc
    return Result(
        ok=True, value=value_repr, stdout=stdout,
        error=None, exit_code=0, truncated=truncated,
    )


class InProcessSession:
    """One turn-scoped live namespace. Create per turn, discard at turn end — the
    consumer owns the lifecycle (dolsot keeps no registry). Injected values are
    live objects placed as-is; state persists between cells by reference. NOT a
    sandbox: pass `check`/`safe_builtins` to raise the (leaky) defense line."""

    def __init__(
        self,
        *,
        inject: dict,
        preinject: dict | None = None,
        check: Callable[[str], None] | None = None,
        safe_builtins: dict | None = None,
        timeout: float = 20.0,
        max_output: int = 8000,
    ) -> None:
        preinject = preinject or {}
        self._ns: dict = {**preinject, **inject}
        self._injected_keys = set(preinject) | set(inject)
        self._check = check
        # None => permissive (full builtins, print still captured). A supplied map
        # locks the namespace to that subset.
        self._builtins = dict(safe_builtins) if safe_builtins is not None else dict(vars(builtins))
        self._timeout = timeout
        self._max_output = max_output

    def _held(self) -> list[str]:
        # list(self._ns) snapshots the keys before filtering: on an arun timeout
        # the abandoned daemon thread may still be mutating self._ns, and a lazy
        # generator over self._ns directly would raise RuntimeError ("dictionary
        # changed size during iteration"), breaking the never-raises contract.
        return sorted(
            k for k in list(self._ns)
            if not k.startswith("__") and k not in self._injected_keys
        )

    def _finish(self, result: Result) -> Result:
        result.held = self._held()
        parts = []
        if result.stdout:
            parts.append(result.stdout.rstrip("\n"))
        if result.value is not None:
            parts.append(result.value)
        if result.error:
            parts.append(f"error: {result.error}")
        result.text = "\n".join(parts)
        return result

    def run(self, code: str, timeout: float | None = None) -> Result:
        """Run one cell synchronously.

        The `timeout` argument is accepted for signature symmetry with `arun` but is NOT enforced:
        a synchronous in-process exec cannot be preempted. For a real wall-clock bound, use `arun`."""
        result = _run_cell(
            code, self._ns,
            check=self._check, builtins_map=self._builtins,
            max_output=self._max_output, stdout_buf=io.StringIO(),
        )
        return self._finish(result)

    async def arun(self, code: str, timeout: float | None = None) -> Result:
        """Run one cell on a daemon thread and await it, so the host event loop
        stays free for a toolbox that bridges coroutines back to it
        (run_coroutine_threadsafe). On timeout, returns whatever stdout was
        captured so far — the daemon thread is abandoned, not killed (cooperative
        interruption only; a runaway cell leaks a thread). Never uses
        asyncio.to_thread, whose non-daemon pool blocks process exit at atexit."""
        limit = self._timeout if timeout is None else timeout
        stdout_buf = io.StringIO()
        fut: concurrent.futures.Future[Result] = concurrent.futures.Future()

        def _worker() -> None:
            try:
                fut.set_result(_run_cell(
                    code, self._ns,
                    check=self._check, builtins_map=self._builtins,
                    max_output=self._max_output, stdout_buf=stdout_buf,
                ))
            except BaseException as exc:   # defensive; _run_cell should not raise
                if not fut.done():
                    fut.set_exception(exc)

        threading.Thread(target=_worker, daemon=True).start()
        try:
            result = await asyncio.wait_for(asyncio.wrap_future(fut), timeout=limit)
        except asyncio.TimeoutError:
            partial, truncated = cap_text(stdout_buf.getvalue(), self._max_output)
            return self._finish(Result(
                ok=False, value=None, stdout=partial,
                error=f"execution exceeded {limit}s (cooperative; thread abandoned)",
                exit_code=124, truncated=True,
            ))
        return self._finish(result)
