import os
import subprocess
import sys
from pathlib import Path

import pytest

FIXTURES = str(Path(__file__).parent / "fixtures")


def cli(*args: str, stdin: str = "", cache: Path, extra_env: dict | None = None):
    env = {
        **os.environ,
        "PYTHONPATH": FIXTURES,
        "DOLSOT_CACHE_DIR": str(cache),
        "DOLSOT_TYPECHECK": "0",
        **(extra_env or {}),
    }
    return subprocess.run(
        [sys.executable, "-m", "dolsot.cli", *args],
        input=stdin, capture_output=True, text=True, env=env,
    )


def test_runs_code_from_argument(tmp_path: Path) -> None:
    p = cli("--toolbox", "faketools:mt", "--session", "w", "mt.add(1, 2)", cache=tmp_path)
    assert p.returncode == 0
    assert p.stdout.strip() == "3"


def test_runs_code_from_stdin(tmp_path: Path) -> None:
    p = cli("--toolbox", "faketools:mt", "--session", "w", stdin="40 + 2", cache=tmp_path)
    assert p.returncode == 0
    assert p.stdout.strip() == "42"


def test_state_persists_between_invocations(tmp_path: Path) -> None:
    cli("--toolbox", "faketools:mt", "--session", "w", "df = [1, 2, 3]", cache=tmp_path)
    p = cli("--toolbox", "faketools:mt", "--session", "w", "sum(df)", cache=tmp_path)
    assert p.stdout.strip() == "6"


def test_held_banner_goes_to_stderr(tmp_path: Path) -> None:
    p = cli("--toolbox", "faketools:mt", "--session", "w", "df = 1", cache=tmp_path)
    assert "now holds: df" in p.stderr
    assert "now holds" not in p.stdout


def test_missing_session_is_exit_2_with_an_explanation(tmp_path: Path) -> None:
    p = cli("--toolbox", "faketools:mt", "1 + 1", cache=tmp_path)
    assert p.returncode == 2
    assert "--session" in p.stderr


def test_bad_session_id_is_exit_2(tmp_path: Path) -> None:
    p = cli("--toolbox", "faketools:mt", "--session", "../x", "1", cache=tmp_path)
    assert p.returncode == 2


def test_toolbox_error_exit_code_propagates(tmp_path: Path) -> None:
    p = cli("--toolbox", "faketools:mt", "--session", "w", "mt.boom()", cache=tmp_path)
    assert p.returncode == 3
    assert "boom happened" in p.stderr


def test_timeout_is_exit_124(tmp_path: Path) -> None:
    p = cli("--toolbox", "faketools:mt", "--session", "w", "--timeout", "2",
            "while True:\n    pass", cache=tmp_path)
    assert p.returncode == 124


def test_list_sessions(tmp_path: Path) -> None:
    cli("--toolbox", "faketools:mt", "--session", "alpha", "x = 1", cache=tmp_path)
    p = cli("--list-sessions", cache=tmp_path)
    assert p.returncode == 0
    assert "alpha" in p.stdout


def test_list_sessions_when_empty(tmp_path: Path) -> None:
    p = cli("--list-sessions", cache=tmp_path)
    assert "(no sessions)" in p.stdout


def test_reset_one(tmp_path: Path) -> None:
    cli("--toolbox", "faketools:mt", "--session", "alpha", "x = 1", cache=tmp_path)
    p = cli("--reset", "alpha", cache=tmp_path)
    assert p.returncode == 0
    assert "(no sessions)" in cli("--list-sessions", cache=tmp_path).stdout


def test_reset_all(tmp_path: Path) -> None:
    cli("--toolbox", "faketools:mt", "--session", "a", "x = 1", cache=tmp_path)
    cli("--toolbox", "faketools:mt", "--session", "b", "y = 1", cache=tmp_path)
    p = cli("--reset", "all", cache=tmp_path)
    assert "2" in p.stdout
    assert "(no sessions)" in cli("--list-sessions", cache=tmp_path).stdout


def test_malformed_toolbox_spec_is_exit_2(tmp_path: Path) -> None:
    p = cli("--toolbox", "faketools", "--session", "w", "1", cache=tmp_path)
    assert p.returncode == 2
    assert "MODULE:ALIAS" in p.stderr


def test_unpicklable_object_is_reported_on_stderr_not_fatal(tmp_path: Path) -> None:
    """Critical 1 (CLI side): an unpicklable object is dropped and named on stderr
    as "could not persist", without failing the command, while the picklable
    survivors are honestly reported as held."""
    code = "keep = 7\ngen = (i for i in range(3))"
    p = cli("--toolbox", "faketools:mt", "--session", "w", code, cache=tmp_path)
    assert p.returncode == 0             # the computation itself succeeded
    assert "could not persist" in p.stderr.lower()
    assert "gen" in p.stderr             # the dropped name is surfaced
    assert "now holds: keep" in p.stderr  # survivors honestly reported as saved


def test_non_ascii_output_does_not_crash_the_cli(tmp_path: Path) -> None:
    """A cell returning non-ASCII text must not blow up with a raw UnicodeEncodeError
    traceback when stdout is an ASCII stream (C locale, a redirected pipe). Toolbox
    data is full of non-ASCII; the host must degrade, not crash."""
    p = cli("--session", "w", "'café'", cache=tmp_path,
            extra_env={"PYTHONIOENCODING": "ascii"})
    assert p.returncode == 0
    assert "UnicodeEncodeError" not in p.stderr
    assert "Traceback" not in p.stderr


def test_stdout_without_trailing_newline_does_not_glue_to_the_value(tmp_path: Path) -> None:
    p = cli("--toolbox", "faketools:mt", "--session", "w",
             "print('hi', end='')\n1 + 1", cache=tmp_path)
    assert p.returncode == 0
    lines = p.stdout.splitlines()
    assert lines[0] == "hi"
    assert lines[-1] == "2"
