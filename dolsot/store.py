"""Session storage. Stores deal in opaque bytes — serialization belongs to the
worker, so a store can be a file, a dict, or Redis without dolsot knowing."""
from __future__ import annotations

import builtins
import os
import stat
import tempfile
import time
from pathlib import Path
from typing import Protocol

from .types import SessionInfo

DEFAULT_TTL_DAYS = 7


class SessionStore(Protocol):
    def load(self, sid: str) -> bytes | None: ...
    def save(self, sid: str, blob: bytes) -> None: ...
    def delete(self, sid: str) -> int: ...   # sid == "all" wipes everything
    def list(self) -> builtins.list[SessionInfo]: ...


def _default_cache_dir() -> Path:
    """Session directory when DOLSOT_CACHE_DIR is unset. Uses the OS-agnostic
    platform temp dir (every OS defines one and keeps it writable) instead of a
    Linux-idiom ~/.cache path, namespaced by uid: that temp dir can be shared and
    world-writable (e.g. /tmp on Linux), and a session pickle runs code as us when
    dill loads it — so a *fixed* shared path would be a local code-injection vector.
    Persistence is therefore best-effort — temp dirs are cleared on reboot and by
    system reapers — so set DOLSOT_CACHE_DIR when a session must outlive that."""
    uid = os.geteuid() if hasattr(os, "geteuid") else "shared"
    return Path(tempfile.gettempdir()) / f"dolsot-{uid}" / "sessions"


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return max(0, int(raw))
    except ValueError:
        return default


class FileStore:
    """One pickle per session under `dir`. Reaps files untouched for ttl_days
    (0 disables reaping). Callers must validate session ids; the store trusts them."""

    def __init__(self, dir: Path | str | None = None, ttl_days: int | None = None) -> None:
        # Harden only the default (shared temp) location; an explicitly configured
        # dir is the caller's own choice and may legitimately be shared.
        using_default = dir is None and not os.environ.get("DOLSOT_CACHE_DIR")
        if dir is None:
            dir = os.environ.get("DOLSOT_CACHE_DIR") or _default_cache_dir()
        self.dir = Path(dir)
        self._harden = using_default and hasattr(os, "geteuid")
        self.ttl_days = (
            _env_int("DOLSOT_SESSION_TTL_DAYS", DEFAULT_TTL_DAYS)
            if ttl_days is None
            else max(0, ttl_days)
        )

    def _path(self, sid: str) -> Path:
        return self.dir / f"{sid}.pkl"

    def _ensure_dir(self) -> None:
        """Make the session dir exist and be safe to touch. For the default temp
        location, create every level 0700 and refuse a dir that is a symlink or not
        owned by the current user — otherwise another local user could plant a
        session pickle that runs as us when dill loads it."""
        if not self._harden:
            self.dir.mkdir(parents=True, exist_ok=True)
            return
        for d in (self.dir.parent, self.dir):
            d.mkdir(exist_ok=True, mode=0o700)
            info = d.lstat()
            if stat.S_ISLNK(info.st_mode) or info.st_uid != os.geteuid():
                raise PermissionError(
                    f"refusing to use session dir {d}: not a directory owned by the "
                    f"current user (possible tampering in a shared temp dir). "
                    f"Set DOLSOT_CACHE_DIR to a trusted location."
                )
            os.chmod(d, 0o700)

    def _reap(self) -> None:
        if self.ttl_days <= 0 or not self.dir.is_dir():
            return
        cutoff = time.time() - self.ttl_days * 86400
        for p in self.dir.glob("*.pkl"):
            try:
                if p.stat().st_mtime < cutoff:
                    p.unlink()
            except OSError:
                pass

    def load(self, sid: str) -> bytes | None:
        self._ensure_dir()
        self._reap()
        p = self._path(sid)
        return p.read_bytes() if p.exists() else None

    def save(self, sid: str, blob: bytes) -> None:
        # Write to a temp file in the same dir, then atomically swap it in, so a
        # crash mid-write can never leave a truncated session for the next load.
        self._ensure_dir()
        dest = self._path(sid)
        fd, tmp = tempfile.mkstemp(dir=self.dir, prefix=f".{sid}.", suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(blob)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, dest)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def delete(self, sid: str) -> int:
        targets = sorted(self.dir.glob("*.pkl")) if sid == "all" else [self._path(sid)]
        n = 0
        for p in targets:
            try:
                p.unlink()
                n += 1
            except OSError:
                pass
        return n

    def list(self) -> builtins.list[SessionInfo]:
        self._ensure_dir()
        self._reap()
        if not self.dir.is_dir():
            return []
        out = []
        for p in sorted(self.dir.glob("*.pkl")):
            try:
                st = p.stat()
            except OSError:
                continue   # unlinked between glob and stat (concurrent reset/reap)
            out.append(SessionInfo(id=p.stem, size_bytes=st.st_size, last_used=st.st_mtime))
        return out


class MemoryStore:
    """In-process store. No TTL. Mostly for tests and short-lived hosts."""

    def __init__(self) -> None:
        self._blobs: dict[str, bytes] = {}
        self._touched: dict[str, float] = {}

    def load(self, sid: str) -> bytes | None:
        return self._blobs.get(sid)

    def save(self, sid: str, blob: bytes) -> None:
        self._blobs[sid] = blob
        self._touched[sid] = time.time()

    def delete(self, sid: str) -> int:
        if sid == "all":
            n = len(self._blobs)
            self._blobs.clear()
            self._touched.clear()
            return n
        if sid in self._blobs:
            del self._blobs[sid]
            self._touched.pop(sid, None)
            return 1
        return 0

    def list(self) -> builtins.list[SessionInfo]:
        return [
            SessionInfo(id=sid, size_bytes=len(blob), last_used=self._touched[sid])
            for sid, blob in sorted(self._blobs.items())
        ]
