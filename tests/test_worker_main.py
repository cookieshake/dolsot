import json
import subprocess
import sys
from pathlib import Path

import pytest

FIXTURES = str(Path(__file__).parent / "fixtures")


def run_worker(tmp_path: Path, code: str, *, session_in: Path | None = None,
               typecheck: bool = False, inject: dict | None = None) -> dict:
    result_path = tmp_path / "result.json"
    session_out = tmp_path / "out.pkl"
    req = {
        "code": code,
        "inject": {"mt": "faketools"} if inject is None else inject,
        "session_in": str(session_in) if session_in else None,
        "session_out": str(session_out),
        "result_path": str(result_path),
        "typecheck": typecheck,
        "ty_bin": "ty",
    }
    proc = subprocess.run(
        [sys.executable, "-m", "dolsot.worker"],
        input=json.dumps(req), capture_output=True, text=True,
        env={**__import__("os").environ, "PYTHONPATH": FIXTURES},
    )
    assert proc.returncode == 0, proc.stderr
    out = json.loads(result_path.read_text())
    out["_session_out"] = session_out
    return out


def test_runs_code_and_returns_value(tmp_path: Path) -> None:
    r = run_worker(tmp_path, "40 + 2")
    assert r["ok"] is True and r["value"] == "42" and r["exit_code"] == 0


def test_injects_the_toolbox_under_its_alias(tmp_path: Path) -> None:
    r = run_worker(tmp_path, "mt.add(2, 3)")
    assert r["value"] == "5"


def test_import_of_the_alias_is_a_harmless_noop(tmp_path: Path) -> None:
    r = run_worker(tmp_path, "import mt\nmt.add(1, 1)")
    assert r["value"] == "2"


def test_toolbox_error_carries_its_exit_code(tmp_path: Path) -> None:
    r = run_worker(tmp_path, "mt.boom()")
    assert r["ok"] is False and r["exit_code"] == 3 and r["error"] == "boom happened"


def test_session_is_written_and_reloaded(tmp_path: Path) -> None:
    first = run_worker(tmp_path, "df = [1, 2, 3]\nlen(df)")
    assert first["value"] == "3"
    assert first["held"] == ["df"]
    second = run_worker(tmp_path, "sum(df)", session_in=first["_session_out"])
    assert second["value"] == "6"


def test_injected_alias_is_not_persisted_into_the_session(tmp_path: Path) -> None:
    r = run_worker(tmp_path, "x = 1")
    assert r["held"] == ["x"]          # "mt" must not be in there
    assert r["saved"] is True


def test_corrupt_session_reports_a_reset_instruction(tmp_path: Path) -> None:
    bad = tmp_path / "bad.pkl"
    bad.write_bytes(b"not a pickle")
    r = run_worker(tmp_path, "1 + 1", session_in=bad)
    assert r["ok"] is False and r["exit_code"] == 1
    assert "reset" in r["error"]


def test_gate_blocks_bad_call_without_executing(tmp_path: Path) -> None:
    r = run_worker(tmp_path, "print('should not run')\nmt.add(1)", typecheck=True)
    assert r["ok"] is False and r["exit_code"] == 1
    assert "missing-argument" in r["error"]
    assert r["stdout"] == ""          # the cell never ran


def test_gate_off_lets_the_call_reach_cpython(tmp_path: Path) -> None:
    r = run_worker(tmp_path, "mt.add(1)", typecheck=False)
    assert r["ok"] is False
    assert "TypeError:" in r["error"]
    assert "mt.add(a: int, b: int) -> int" in r["error"]   # hint still fires


def test_bad_toolbox_import_reports_a_loading_error(tmp_path: Path) -> None:
    r = run_worker(tmp_path, "1 + 1", inject={"bogus": "this_module_does_not_exist_xyz123"})
    assert r["ok"] is False and r["exit_code"] == 1
    assert "toolbox" in r["error"].lower()
    assert "inject" in r["error"].lower()


def test_all_picklable_reports_no_drops(tmp_path: Path) -> None:
    r = run_worker(tmp_path, "x = 1")
    assert r["saved"] is True
    assert r["dropped"] == []


def test_unpicklable_object_is_dropped_and_the_rest_is_saved(tmp_path: Path) -> None:
    """A single object dill can't pickle (a live generator) must not sink the whole
    session: it is dropped and reported, and every picklable name is still saved."""
    r = run_worker(tmp_path, "keep = [1, 2, 3]\ngen = (i for i in range(3))")
    assert r["saved"] is True
    assert r["dropped"] == ["gen"]
    assert "keep" in r["held"]
    assert "gen" not in r["held"]           # held reflects what was actually persisted


def test_survivors_reload_after_an_unpicklable_object_was_dropped(tmp_path: Path) -> None:
    """The whole point: one unpicklable object used to lose the entire session.
    Now the picklable state persists and is still there on the next call."""
    first = run_worker(tmp_path, "keep = 99\ngen = (i for i in range(3))")
    assert first["dropped"] == ["gen"]
    second = run_worker(tmp_path, "keep + 1", session_in=first["_session_out"])
    assert second["value"] == "100"


def test_gate_hint_failure_degrades_without_crashing_the_worker(tmp_path: Path) -> None:
    """Important 5: gate.hint() can raise when a toolbox's introspection blows up
    (e.g. a PEP 562 module __getattr__ that isn't well-behaved). The worker must
    still return a clean, diagnostics-only failure — not crash, and not leak the
    introspection exception text into the caller-visible error."""
    r = run_worker(tmp_path, "bt.add(1)", typecheck=True,
                    inject={"bt": "brokenhint_tools"})
    assert r["ok"] is False and r["exit_code"] == 1
    assert "missing-argument" in r["error"]
    assert r["stdout"] == ""                       # the cell never ran, gate blocked it
    assert "introspection blew up" not in r["error"]
    assert "internal toolbox detail" not in r["error"]
