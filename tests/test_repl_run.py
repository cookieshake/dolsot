import json
import tempfile
from pathlib import Path

import pytest

from dolsot import FileStore, InvalidSession, InvalidToolbox, MemoryStore, Repl


@pytest.fixture
def repl(fixtures_dir):
    return Repl(
        inject={"mt": "faketools"},
        store=MemoryStore(),
        typecheck=False,
        env={"PYTHONPATH": fixtures_dir},
    )


def test_runs_code(repl) -> None:
    r = repl.run("s1", "40 + 2")
    assert r.ok and r.value == "42" and r.exit_code == 0


def test_state_persists_across_calls(repl) -> None:
    repl.run("s1", "df = [1, 2, 3]")
    r = repl.run("s1", "sum(df)")
    assert r.value == "6"


def test_sessions_are_isolated(repl) -> None:
    repl.run("s1", "x = 1")
    r = repl.run("s2", "'x' in dir()")
    assert r.value == "False"


def test_toolbox_is_injected(repl) -> None:
    assert repl.run("s1", "mt.add(2, 3)").value == "5"


def test_module_object_injection_is_equivalent(fixtures_dir, monkeypatch) -> None:
    import sys
    sys.path.insert(0, fixtures_dir)
    import faketools
    r = Repl(inject={"mt": faketools}, store=MemoryStore(), typecheck=False,
             env={"PYTHONPATH": fixtures_dir}).run("s1", "mt.add(1, 1)")
    assert r.value == "2"


def test_non_module_injection_is_rejected() -> None:
    with pytest.raises(InvalidToolbox):
        Repl(inject={"mt": 42})


def test_user_error_is_returned_not_raised(repl) -> None:
    r = repl.run("s1", "1 / 0")
    assert r.ok is False and r.exit_code == 1
    assert "ZeroDivisionError" in r.error


def test_toolbox_exit_code_is_propagated(repl) -> None:
    assert repl.run("s1", "mt.boom()").exit_code == 3


def test_timeout_kills_and_reports_124(repl) -> None:
    r = repl.run("s1", "while True:\n    pass", timeout=2)
    assert r.ok is False and r.exit_code == 124
    assert "exceeded 2s" in r.error


def test_bad_session_id_raises(repl) -> None:
    with pytest.raises(InvalidSession):
        repl.run("../etc/passwd", "1")
    with pytest.raises(InvalidSession):
        repl.run("..", "1")


def test_empty_code_raises(repl) -> None:
    with pytest.raises(InvalidSession):
        repl.run("s1", "   ")


def test_all_is_reserved_and_cannot_be_used_as_a_session(repl) -> None:
    """'all' is the wipe-everything sentinel for reset(); allowing it as a real
    session id would make that session impossible to reset individually and let a
    global reset silently destroy it. It must be rejected as a run target."""
    with pytest.raises(InvalidSession):
        repl.run("all", "1 + 1")


def test_reset_all_still_wipes_everything(repl) -> None:
    repl.run("s1", "x = 1")
    repl.run("s2", "y = 2")
    assert repl.reset("all") == 2          # the sentinel still works


def test_text_carries_stdout_value_and_held(repl) -> None:
    r = repl.run("s1", "print('hello')\ndf = 7\ndf + 1")
    assert "hello" in r.text
    assert "8" in r.text
    assert "now holds: df" in r.text


def test_max_output_caps_a_runaway_value(fixtures_dir) -> None:
    repl = Repl(inject={"mt": "faketools"}, store=MemoryStore(), typecheck=False,
                max_output=50, env={"PYTHONPATH": fixtures_dir})
    r = repl.run("s1", "'z' * 5000")
    assert r.value.startswith("z" * 50)
    assert "truncated" in r.value
    assert len(r.value) < 200


def test_store_receives_the_session_blob(fixtures_dir) -> None:
    store = MemoryStore()
    repl = Repl(inject={"mt": "faketools"}, store=store, typecheck=False,
                env={"PYTHONPATH": fixtures_dir})
    repl.run("s1", "x = 1")
    assert store.load("s1") is not None


def test_typecheck_on_blocks_a_bad_call(fixtures_dir) -> None:
    repl = Repl(inject={"mt": "faketools"}, store=MemoryStore(), typecheck=True,
                env={"PYTHONPATH": fixtures_dir})
    r = repl.run("s1", "mt.add(1)")
    assert r.ok is False
    assert "missing-argument" in r.error


def test_env_var_defaults_are_honoured(monkeypatch, fixtures_dir) -> None:
    monkeypatch.setenv("DOLSOT_TIMEOUT", "7")
    monkeypatch.setenv("DOLSOT_TYPECHECK", "0")
    repl = Repl(inject={"mt": "faketools"}, store=MemoryStore(),
                env={"PYTHONPATH": fixtures_dir})
    assert repl.timeout == 7
    assert repl.typecheck is False


def test_explicit_args_beat_env_vars(monkeypatch, fixtures_dir) -> None:
    monkeypatch.setenv("DOLSOT_TIMEOUT", "7")
    repl = Repl(inject={"mt": "faketools"}, store=MemoryStore(), timeout=3,
                env={"PYTHONPATH": fixtures_dir})
    assert repl.timeout == 3


def test_sessions_lists_created_sessions(repl, fixtures_dir) -> None:
    # Create two sessions with state
    repl.run("sess1", "x = 10")
    repl.run("sess2", "y = 20")

    sessions = repl.sessions()
    session_ids = [s.id for s in sessions]

    assert "sess1" in session_ids
    assert "sess2" in session_ids
    assert len(sessions) == 2

    # Check SessionInfo fields are populated
    for s in sessions:
        assert s.id in ("sess1", "sess2")
        assert s.size_bytes > 0
        assert s.last_used is not None


def test_sessions_empty_store(repl) -> None:
    sessions = repl.sessions()
    assert sessions == []


def test_reset_deletes_one_session(repl, fixtures_dir) -> None:
    repl.run("sess1", "x = 1")
    repl.run("sess2", "y = 2")

    # Reset one session
    count = repl.reset("sess1")
    assert count == 1

    # Verify it's gone
    sessions = repl.sessions()
    session_ids = [s.id for s in sessions]
    assert "sess1" not in session_ids
    assert "sess2" in session_ids


def test_reset_all_wipes_everything(repl, fixtures_dir) -> None:
    repl.run("sess1", "x = 1")
    repl.run("sess2", "y = 2")
    repl.run("sess3", "z = 3")

    # Reset all
    count = repl.reset("all")
    assert count == 3

    # Verify everything is gone
    sessions = repl.sessions()
    assert sessions == []


def test_reset_bad_id_raises(repl) -> None:
    repl.run("good", "x = 1")

    with pytest.raises(InvalidSession):
        repl.reset("../etc/passwd")

    with pytest.raises(InvalidSession):
        repl.reset("..")

    # But good id + "all" should work even without prior session
    count = repl.reset("all")
    assert count == 1


def test_truncated_result_json_returns_worker_died(fixtures_dir) -> None:
    """Simulate worker crash mid-write: truncated result.json should not crash host.

    This tests Finding 1: malformed result.json file is treated as worker died,
    not as JSONDecodeError escaping uncaught.
    """
    store = MemoryStore()
    repl = Repl(inject={"mt": "faketools"}, store=store, typecheck=False,
                env={"PYTHONPATH": fixtures_dir})

    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        result_path = workdir / "result.json"
        session_out = workdir / "out.pkl"

        # Write a truncated result.json (simulates worker killed mid-write)
        result_path.write_text('{"ok": true, "value": "4')  # Incomplete JSON

        # Build minimal request dict for _finish
        req = {
            "result_path": str(result_path),
            "session_out": str(session_out),
        }

        # Call _finish with truncated file; should not raise JSONDecodeError
        r = repl._finish("test_sid", req, "")

        # Should treat as worker died
        assert r.ok is False
        assert r.exit_code == 1
        assert "worker died" in r.error


def test_missing_keys_result_json_treated_as_worker_died(fixtures_dir) -> None:
    """Critical 3: valid JSON that parses to a dict but is missing required keys
    (e.g. a worker that died after writing a partial payload some other way)
    must degrade to the same "worker died" Result, not raise KeyError out of
    _assemble."""
    store = MemoryStore()
    repl = Repl(inject={"mt": "faketools"}, store=store, typecheck=False,
                env={"PYTHONPATH": fixtures_dir})

    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        result_path = workdir / "result.json"
        session_out = workdir / "out.pkl"

        # Valid JSON, valid dict, but missing stdout/value/held/error/exit_code.
        result_path.write_text('{"ok": true}')

        req = {
            "result_path": str(result_path),
            "session_out": str(session_out),
        }

        r = repl._finish("test_sid", req, "")

        assert r.ok is False
        assert r.exit_code == 1
        assert "worker died" in r.error


def test_malformed_result_json_dict_fails(fixtures_dir) -> None:
    """Non-dict result.json also treated as worker died."""
    store = MemoryStore()
    repl = Repl(inject={"mt": "faketools"}, store=store, typecheck=False,
                env={"PYTHONPATH": fixtures_dir})

    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        result_path = workdir / "result.json"
        session_out = workdir / "out.pkl"

        # Write valid JSON but not a dict (list instead)
        result_path.write_text('["not", "a", "dict"]')

        req = {
            "result_path": str(result_path),
            "session_out": str(session_out),
        }

        r = repl._finish("test_sid", req, "")

        # Should treat as worker died
        assert r.ok is False
        assert r.exit_code == 1
        assert "worker died" in r.error


def test_unpicklable_object_is_dropped_not_fatal_and_reported(tmp_path, fixtures_dir) -> None:
    """Best-effort persistence: an object dill cannot pickle (a live generator) is
    dropped and reported on Result.dropped — it must not take the rest of the
    session down with it. The picklable survivors really do persist to the
    next call, and the banner is honest about both halves."""
    store = FileStore(dir=tmp_path)
    repl = Repl(inject={"mt": "faketools"}, store=store, typecheck=False,
                env={"PYTHONPATH": fixtures_dir})

    r = repl.run("s1", "keep = 7\ngen = (i for i in range(3))")

    assert r.ok is True
    assert r.save_error is None            # a partial save succeeded — not a total failure
    assert r.dropped == ["gen"]
    assert "keep" in r.held and "gen" not in r.held
    assert "could not persist" in r.text.lower()   # dropped name is surfaced
    assert "gen" in r.text
    assert "(persisted" in r.text          # survivors are honestly reported as saved

    assert repl.run("s1", "keep + 1").value == "8"   # survivors are really there


class _BrokenSaveStore:
    """A SessionStore whose save() always raises — stands in for a flaky
    Redis/S3-backed store, or a FileStore hitting a full disk."""

    def load(self, sid: str) -> bytes | None:
        return None

    def save(self, sid: str, blob: bytes) -> None:
        raise OSError("disk full")

    def delete(self, sid: str) -> int:
        return 0

    def list(self):
        return []


def test_store_save_failure_does_not_escape_run(fixtures_dir) -> None:
    """Critical 2: self.store.save() is a pluggable Protocol implementation and
    routinely raises (Redis down, S3 error, full disk). run() must never let that
    escape — it feeds the same save_error mechanism as Critical 1."""
    repl = Repl(inject={"mt": "faketools"}, store=_BrokenSaveStore(), typecheck=False,
                env={"PYTHONPATH": fixtures_dir})

    r = repl.run("s1", "x = 1")

    assert r.ok is True                 # the code itself ran fine
    assert r.save_error is not None
    assert "disk full" in r.save_error
    assert "(persisted" not in r.text   # never falsely claim the names were saved
    assert "NOT persisted" in r.text    # the honest wording is used instead


def test_popen_oserror_returns_dead_worker_result_instead_of_raising(fixtures_dir, monkeypatch) -> None:
    """Critical 4: a fork/exec OSError (fd/process-table exhaustion) must not
    escape run() — it degrades to the same "worker died" Result as any other
    worker-launch failure."""
    import subprocess as sp

    def boom(*args, **kwargs):
        raise OSError("fork failed: resource temporarily unavailable")

    monkeypatch.setattr(sp, "Popen", boom)

    repl = Repl(inject={"mt": "faketools"}, store=MemoryStore(), typecheck=False,
                env={"PYTHONPATH": fixtures_dir})
    r = repl.run("s1", "1 + 1")

    assert r.ok is False
    assert r.exit_code == 1
    assert "worker died" in r.error
