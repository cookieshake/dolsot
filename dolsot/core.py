"""Repl — the host side. Validates, talks to the store, spawns the worker, and
assembles a Result. It never imports a toolbox and never deserializes a session:
sessions are opaque bytes here, and the toolbox is only a name it passes along."""
from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import types
from pathlib import Path

from .store import FileStore, SessionStore
from .types import Result, SessionInfo

DEFAULT_TIMEOUT = 20
DEFAULT_MAX_OUTPUT = 100_000
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")


class InvalidSession(ValueError):
    """The caller passed a session id or cell that dolsot refuses to run."""


class InvalidToolbox(TypeError):
    """An injected value is neither a module nor an importable module name."""


def valid_session_id(sid: str) -> bool:
    # "all" is reserved: it is reset()'s wipe-everything sentinel, so it must never
    # name a real session (that session could not be reset, and a global reset
    # would silently destroy it).
    return bool(SESSION_ID_RE.match(sid or "")) and sid not in (".", "..", "all")


def _normalize(inject: dict) -> dict[str, str]:
    """{alias: module | "module.name"} -> {alias: "module.name"}.

    Only importable modules can cross into the worker process, so a configured
    object instance is rejected loudly instead of silently behaving differently."""
    out: dict[str, str] = {}
    for alias, value in (inject or {}).items():
        if isinstance(value, types.ModuleType):
            out[alias] = value.__name__
        elif isinstance(value, str):
            out[alias] = value
        else:
            raise InvalidToolbox(
                f"inject[{alias!r}] must be a module or an importable module name, "
                f"got {type(value).__name__}. A toolbox has to be importable by name in "
                f"the worker process; configure it through the environment instead."
            )
    return out


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return max(0, int(raw))   # a negative timeout/output cap is never meaningful
    except ValueError:
        return default


def persistence_notes(
    sid: str, held: list[str], dropped: list[str], save_error: str | None
) -> list[str]:
    """The session-state banner lines shared by Result.text and the CLI's stderr —
    a single source of truth for the wording, so the two never drift apart."""
    notes: list[str] = []
    if save_error:
        notes.append(f"warning: computed ok but could not save session {sid!r} ({save_error})")
        lost = held + dropped
        if lost:
            notes.append(
                f"↳ session {sid!r} would hold: {', '.join(lost)}  "
                f"(NOT persisted — the save above failed, so these will be "
                f"lost; don't rely on them next call)"
            )
        return notes
    if held:
        notes.append(
            f"↳ session {sid!r} now holds: {', '.join(held)}  "
            f"(persisted — reuse them next call; don't recompute or re-import)"
        )
    if dropped:
        notes.append(
            f"↳ session {sid!r} could not persist: {', '.join(dropped)}  "
            f"(unpicklable — a live object like a connection, lock or socket "
            f"can't cross to the next cell; gone next call)"
        )
    return notes


class Repl:
    #: keys `_assemble` unconditionally indexes into a worker payload; a result.json
    #: missing any of these degrades to a "worker died" Result rather than raising.
    REQUIRED_KEYS = {"ok", "value", "stdout", "error", "exit_code", "held"}

    def __init__(
        self,
        inject: dict,
        *,
        store: SessionStore | None = None,
        timeout: int | None = None,
        typecheck: bool | None = None,
        max_output: int | None = None,
        env: dict[str, str] | None = None,
    ) -> None:
        self.inject = _normalize(inject)
        self.store: SessionStore = store or FileStore()
        self.timeout = timeout if timeout is not None else _env_int("DOLSOT_TIMEOUT", DEFAULT_TIMEOUT)
        self.typecheck = (
            os.environ.get("DOLSOT_TYPECHECK", "1") != "0" if typecheck is None else typecheck
        )
        self.max_output = (
            max_output if max_output is not None
            else _env_int("DOLSOT_MAX_OUTPUT", DEFAULT_MAX_OUTPUT)
        )
        self.env = dict(env or {})

    # --- plumbing ------------------------------------------------------------

    def _request(self, sid: str, code: str, workdir: Path, limit: int) -> dict:
        blob = self.store.load(sid)
        session_in = None
        if blob is not None:
            session_in = workdir / "in.pkl"
            session_in.write_bytes(blob)
        return {
            "code": code,
            "inject": self.inject,
            "session_in": str(session_in) if session_in else None,
            "session_out": str(workdir / "out.pkl"),
            "result_path": str(workdir / "result.json"),
            "typecheck": self.typecheck,
            "ty_bin": os.environ.get("DOLSOT_TY_BIN", "ty"),
            "max_output": self.max_output,
            "timeout": limit,
        }

    def _dead_worker(self, sid: str, detail: str) -> Result:
        detail = detail.strip()
        return self._assemble(sid, {
            "ok": False, "value": None, "stdout": "", "held": [], "exit_code": 1,
            "error": f"worker died: {detail}" if detail else "worker died",
            "saved": False, "save_error": None,
        })

    def _finish(self, sid: str, req: dict, stderr: str) -> Result:
        result_path = Path(req["result_path"])
        tail = "\n".join(stderr.strip().splitlines()[-5:])
        if not result_path.exists():
            return self._dead_worker(sid, tail)
        try:
            payload = json.loads(result_path.read_text())
            if not isinstance(payload, dict):
                raise TypeError("payload must be a dict")
            missing = self.REQUIRED_KEYS - payload.keys()
            if missing:
                raise KeyError(f"payload missing required keys: {sorted(missing)}")
        except (json.JSONDecodeError, TypeError, KeyError):
            # Truncated/malformed result.json or missing required keys = worker died
            return self._dead_worker(sid, tail)

        if payload.get("saved"):
            # The worker already dumped the namespace to session_out; persisting it
            # through the (pluggable, possibly flaky) store is a *separate* failure
            # mode from the worker's own dump — never let it escape run()/arun().
            try:
                self.store.save(sid, Path(req["session_out"]).read_bytes())
            except Exception as exc:
                payload = {**payload, "save_error": f"{type(exc).__name__}: {exc}"}
        return self._assemble(sid, payload)

    def _assemble(self, sid: str, p: dict) -> Result:
        save_error = p.get("save_error")
        dropped = p.get("dropped") or []
        parts: list[str] = []
        if p["stdout"]:
            parts.append(p["stdout"].rstrip("\n"))
        if p["value"] is not None:
            parts.append(p["value"])
        if p["error"]:
            parts.append(f"error: {p['error']}")
        parts.extend(persistence_notes(sid, p["held"], dropped, save_error))
        return Result(
            ok=p["ok"], value=p["value"], stdout=p["stdout"], error=p["error"],
            exit_code=p["exit_code"], held=p["held"], text="\n".join(parts),
            save_error=save_error, dropped=dropped,
        )

    def _guard(self, sid: str, code: str) -> str:
        if not valid_session_id(sid):
            raise InvalidSession(f"bad session id {sid!r} (use letters, digits, . _ -)")
        code = code.strip()
        if not code:
            raise InvalidSession("no code given")
        return code

    def _timed_out(self, sid: str, timeout: int) -> Result:
        return self._assemble(sid, {
            "ok": False, "value": None, "stdout": "", "held": [], "exit_code": 124,
            "error": f"execution exceeded {timeout}s (killed)",
            "saved": False, "save_error": None,
        })

    # --- API -----------------------------------------------------------------

    def run(self, session: str, code: str, timeout: int | None = None) -> Result:
        code = self._guard(session, code)
        limit = timeout if timeout is not None else self.timeout
        with tempfile.TemporaryDirectory() as tmp:
            workdir = Path(tmp)
            req = self._request(session, code, workdir, limit)
            try:
                proc = subprocess.Popen(
                    [sys.executable, "-m", "dolsot.worker"],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    text=True, env={**os.environ, **self.env}, start_new_session=True,
                )
                _, stderr = proc.communicate(json.dumps(req), timeout=limit)
            except subprocess.TimeoutExpired:
                _kill_group(proc)
                proc.communicate()
                return self._timed_out(session, limit)
            except OSError as exc:
                # fork/exec can fail under load (fd/process-table exhaustion); the
                # host must never raise here — surface it as a dead worker instead.
                return self._dead_worker(session, f"{type(exc).__name__}: {exc}")
            return self._finish(session, req, stderr)

    async def arun(self, session: str, code: str, timeout: int | None = None) -> Result:
        code = self._guard(session, code)
        limit = timeout if timeout is not None else self.timeout
        with tempfile.TemporaryDirectory() as tmp:
            workdir = Path(tmp)
            req = self._request(session, code, workdir, limit)
            try:
                proc = await asyncio.create_subprocess_exec(
                    sys.executable, "-m", "dolsot.worker",
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env={**os.environ, **self.env},
                    start_new_session=True,
                )
                _, stderr = await asyncio.wait_for(
                    proc.communicate(json.dumps(req).encode()), timeout=limit
                )
            except asyncio.TimeoutError:
                _akill_group(proc)
                await proc.wait()
                return self._timed_out(session, limit)
            except OSError as exc:
                # fork/exec can fail under load (fd/process-table exhaustion); the
                # host must never raise here — surface it as a dead worker instead.
                return self._dead_worker(session, f"{type(exc).__name__}: {exc}")
            return self._finish(session, req, stderr.decode(errors="replace"))

    def sessions(self) -> list[SessionInfo]:
        return self.store.list()

    def reset(self, session: str) -> int:
        if session != "all" and not valid_session_id(session):
            raise InvalidSession(f"bad session id {session!r}")
        return self.store.delete(session)


def _kill_group(proc: subprocess.Popen) -> None:
    """Kill the worker *and* anything it spawned — user code may have children."""
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        proc.kill()


def _akill_group(proc: "asyncio.subprocess.Process") -> None:
    """Async-friendly kill of the worker *and* anything it spawned."""
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass
