import sys
from pathlib import Path

import pytest

from dolsot import gate

FIXTURES = str(Path(__file__).parent / "fixtures")
sys.path.insert(0, FIXTURES)
import faketools   # noqa: E402

INJECT = {"mt": "faketools"}
INJECTED = {"mt": faketools}


@pytest.fixture(autouse=True)
def _fixtures_importable_by_ty(monkeypatch):
    # ty resolves imports through the interpreter environment; the fake toolbox
    # lives on sys.path via PYTHONPATH, so hand it the same path.
    monkeypatch.setenv("PYTHONPATH", FIXTURES)


def test_cell_not_touching_the_toolbox_is_skipped() -> None:
    assert gate.check("2 + 2", INJECT, [], "ty") == []


def test_good_call_passes() -> None:
    assert gate.check("mt.add(1, 2)", INJECT, [], "ty") == []


def test_gate_caps_its_timeout_by_the_cell_budget(monkeypatch) -> None:
    """The gate runs inside the worker, whose whole lifetime is bounded by the
    cell timeout. Its own subprocess timeout must not exceed that budget, or a
    slow gate could get the whole worker killed before the code ever runs."""
    captured = {}

    class _Done:
        stdout = ""
        stderr = ""

    def fake_run(cmd, **kw):
        captured["timeout"] = kw.get("timeout")
        return _Done()

    monkeypatch.setattr(gate.subprocess, "run", fake_run)
    gate.check("mt.add(1, 2)", INJECT, [], "ty", timeout=3)
    assert captured["timeout"] == 3          # min(TIMEOUT_S=15, budget=3)

    gate.check("mt.add(1, 2)", INJECT, [], "ty", timeout=100)
    assert captured["timeout"] == gate.TIMEOUT_S   # never exceeds the ceiling


def test_missing_argument_is_blocked() -> None:
    diags = gate.check("mt.add(1)", INJECT, [], "ty")
    assert any("missing-argument" in d for d in diags)


def test_bad_literal_is_blocked() -> None:
    diags = gate.check("mt.kind('z')", INJECT, [], "ty")
    assert any("invalid-argument-type" in d for d in diags)


def test_unknown_attribute_is_blocked() -> None:
    diags = gate.check("mt.nosuch(1)", INJECT, [], "ty")
    assert any("unresolved-attribute" in d for d in diags)


def test_diagnostic_line_numbers_are_user_code_relative() -> None:
    diags = gate.check("x = 1\nmt.add(1)", INJECT, [], "ty")
    assert any(d.strip().startswith("line 2:") for d in diags)


def test_held_session_names_do_not_trip_the_gate() -> None:
    # `df` exists in the session but not in the cell; without the preamble
    # declaring it, ty would cry unresolved-reference.
    assert gate.check("mt.add(df, 2)", INJECT, ["df"], "ty") == []


def test_missing_ty_binary_fails_open() -> None:
    assert gate.check("mt.add(1)", INJECT, [], "definitely-not-a-real-binary") == []


def test_syntax_error_is_left_to_the_executor() -> None:
    assert gate.check("mt.add(", INJECT, [], "ty") == []


def test_hint_names_the_offending_callable() -> None:
    diags = gate.check("mt.add(1)", INJECT, [], "ty")
    assert "mt.add(a: int, b: int) -> int" in gate.hint(diags, INJECTED)


def test_hint_falls_back_when_no_callable_named() -> None:
    assert "help()" in gate.hint(["  line 1: unresolved-reference: nope"], INJECTED)
