import os
import stat
import time
from pathlib import Path

import pytest

import dolsot.store as store_mod
from dolsot.store import FileStore, MemoryStore


@pytest.fixture(params=["file", "memory"])
def store(request, tmp_path: Path):
    if request.param == "file":
        return FileStore(dir=tmp_path, ttl_days=0)
    return MemoryStore()


# --- contract: both stores must behave identically ---------------------------

def test_load_missing_returns_none(store) -> None:
    assert store.load("nope") is None


def test_save_then_load_roundtrips(store) -> None:
    store.save("work", b"\x01\x02blob")
    assert store.load("work") == b"\x01\x02blob"


def test_save_overwrites(store) -> None:
    store.save("work", b"old")
    store.save("work", b"new")
    assert store.load("work") == b"new"


def test_delete_one_returns_count(store) -> None:
    store.save("work", b"x")
    assert store.delete("work") == 1
    assert store.load("work") is None


def test_delete_missing_returns_zero(store) -> None:
    assert store.delete("nope") == 0


def test_delete_all_wipes_everything(store) -> None:
    store.save("a", b"x")
    store.save("b", b"y")
    assert store.delete("all") == 2
    assert store.list() == []


def test_list_reports_id_and_size(store) -> None:
    store.save("a", b"12345")
    infos = store.list()
    assert [i.id for i in infos] == ["a"]
    assert infos[0].size_bytes == 5
    assert infos[0].last_used <= time.time() + 1


# --- FileStore-only: TTL reaping and disk layout ------------------------------

def test_filestore_writes_pkl_file(tmp_path: Path) -> None:
    FileStore(dir=tmp_path, ttl_days=0).save("work", b"x")
    assert (tmp_path / "work.pkl").read_bytes() == b"x"


def test_filestore_save_is_atomic_no_temp_residue(tmp_path: Path) -> None:
    """A successful save leaves exactly one file per session — no half-written
    temp files lying around for list()/load() to trip over."""
    s = FileStore(dir=tmp_path, ttl_days=0)
    s.save("work", b"a" * 10_000)
    s.save("work", b"b" * 10_000)
    assert [p.name for p in tmp_path.iterdir()] == ["work.pkl"]
    assert s.load("work") == b"b" * 10_000


def test_filestore_interrupted_save_preserves_previous_session(tmp_path: Path, monkeypatch) -> None:
    """A crash during the commit of a new blob must leave the previous session
    fully readable, not a truncated/corrupt file. This requires writing to a
    temp file and atomically swapping it in — a direct overwrite cannot offer it."""
    import dolsot.store as store_mod
    s = FileStore(dir=tmp_path, ttl_days=0)
    s.save("work", b"good-blob")

    def boom(*a, **k):
        raise OSError("crash mid-commit")
    monkeypatch.setattr(store_mod.os, "replace", boom)

    with pytest.raises(OSError):
        s.save("work", b"new-partial-blob")

    assert s.load("work") == b"good-blob"                 # old session survived intact
    assert [p.name for p in tmp_path.iterdir()] == ["work.pkl"]   # temp cleaned up


def test_filestore_reaps_stale_sessions(tmp_path: Path) -> None:
    s = FileStore(dir=tmp_path, ttl_days=7)
    s.save("old", b"x")
    s.save("fresh", b"y")
    stale = time.time() - 8 * 86400
    import os
    os.utime(tmp_path / "old.pkl", (stale, stale))
    assert [i.id for i in s.list()] == ["fresh"]
    assert s.load("old") is None


def test_filestore_ttl_zero_disables_reaping(tmp_path: Path) -> None:
    s = FileStore(dir=tmp_path, ttl_days=0)
    s.save("old", b"x")
    stale = time.time() - 900 * 86400
    import os
    os.utime(tmp_path / "old.pkl", (stale, stale))
    assert s.load("old") == b"x"


def test_list_tolerates_a_session_vanishing_mid_scan(tmp_path: Path, monkeypatch) -> None:
    """A concurrent reset/reap (the multi-host design's whole point) can unlink a
    .pkl between glob() and stat(). list() must skip the vanished session, not
    crash — its siblings _reap() and delete() already guard OSError."""
    import dolsot.store as store_mod
    s = FileStore(dir=tmp_path, ttl_days=0)
    s.save("a", b"x")
    s.save("b", b"y")

    real_stat = store_mod.Path.stat

    def flaky_stat(self, *a, **k):
        if self.name == "a.pkl":
            raise FileNotFoundError(self)
        return real_stat(self, *a, **k)
    monkeypatch.setattr(store_mod.Path, "stat", flaky_stat)

    assert [i.id for i in s.list()] == ["b"]     # 'a' vanished, skipped, no crash


def test_filestore_default_is_a_private_per_user_temp_dir(monkeypatch) -> None:
    """Without DOLSOT_CACHE_DIR, the default is the OS-agnostic platform temp dir —
    but namespaced by uid, because that dir can be shared/world-writable (e.g. /tmp
    on Linux). A fixed shared path would let another local user read session pickles
    or plant one that runs as us when dill loads it."""
    import tempfile
    monkeypatch.delenv("DOLSOT_CACHE_DIR", raising=False)
    s = FileStore()
    assert s.dir == Path(tempfile.gettempdir()) / f"dolsot-{os.geteuid()}" / "sessions"


def test_default_dir_is_created_private(tmp_path: Path, monkeypatch) -> None:
    """Both the per-user root and the sessions dir must be created 0700 so no other
    user can read or write the pickles they hold."""
    monkeypatch.delenv("DOLSOT_CACHE_DIR", raising=False)
    monkeypatch.setattr(store_mod.tempfile, "gettempdir", lambda: str(tmp_path))
    s = FileStore()
    s.save("a", b"x")
    root = tmp_path / f"dolsot-{os.geteuid()}"
    assert stat.S_IMODE(root.stat().st_mode) == 0o700
    assert stat.S_IMODE(s.dir.stat().st_mode) == 0o700
    assert s.load("a") == b"x"


def test_default_dir_refuses_a_tampered_root(tmp_path: Path, monkeypatch) -> None:
    """If the per-user root was pre-created by someone else (here: a symlink an
    attacker planted in the shared temp dir), refuse rather than read/write through
    it — loading a poisoned pickle would execute code as us."""
    monkeypatch.delenv("DOLSOT_CACHE_DIR", raising=False)
    monkeypatch.setattr(store_mod.tempfile, "gettempdir", lambda: str(tmp_path))
    elsewhere = tmp_path / "attacker"
    elsewhere.mkdir()
    (tmp_path / f"dolsot-{os.geteuid()}").symlink_to(elsewhere)
    s = FileStore()
    with pytest.raises(PermissionError):
        s.load("a")


def test_filestore_defaults_come_from_env(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DOLSOT_CACHE_DIR", str(tmp_path / "sessions"))
    monkeypatch.setenv("DOLSOT_SESSION_TTL_DAYS", "3")
    s = FileStore()
    assert s.dir == tmp_path / "sessions"
    assert s.ttl_days == 3


def test_explicit_args_beat_env(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DOLSOT_CACHE_DIR", str(tmp_path / "ignored"))
    monkeypatch.setenv("DOLSOT_SESSION_TTL_DAYS", "3")
    s = FileStore(dir=tmp_path / "used", ttl_days=9)
    assert s.dir == tmp_path / "used"
    assert s.ttl_days == 9
