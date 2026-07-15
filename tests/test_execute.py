import types

import pytest

from dolsot.worker import execute, held_names


def ns() -> types.ModuleType:
    return types.ModuleType("dolsot_session")


def test_trailing_expression_becomes_value() -> None:
    r = execute("2 ** 10", ns(), set())
    assert r["ok"] is True
    assert r["value"] == "1024"
    assert r["exit_code"] == 0


def test_no_trailing_expression_gives_no_value() -> None:
    r = execute("x = 1", ns(), set())
    assert r["ok"] is True
    assert r["value"] is None


def test_print_is_captured_not_leaked(capsys) -> None:
    r = execute("print('hi')\n40 + 2", ns(), set())
    assert r["stdout"] == "hi\n"
    assert r["value"] == "42"
    assert capsys.readouterr().out == ""   # must not reach the worker's real stdout


def test_state_persists_within_one_call() -> None:
    r = execute("xs = [1, 2, 3]\ntotal = sum(xs)\ntotal / len(xs)", ns(), set())
    assert r["value"] == "2.0"


def test_namespace_carries_names_out() -> None:
    n = ns()
    execute("df = 5\nimport math", n, set())
    assert held_names(n, set()) == ["df", "math"]


def test_injected_aliases_are_not_held() -> None:
    n = ns()
    n.mt = object()
    execute("x = 1", n, {"mt"})
    assert held_names(n, {"mt"}) == ["x"]


def test_toolbox_error_uses_its_exit_code() -> None:
    n = ns()
    exec("class E(Exception):\n    exit_code = 3", n.__dict__)
    r = execute("raise E('nope')", n, set())
    assert r["ok"] is False
    assert r["exit_code"] == 3
    assert r["error"] == "nope"          # no class-name prefix for toolbox errors


def test_plain_exception_is_exit_1_and_named() -> None:
    r = execute("1 / 0", ns(), set())
    assert r["ok"] is False
    assert r["exit_code"] == 1
    assert r["error"] == "ZeroDivisionError: division by zero"


def test_syntax_error_is_reported_not_raised() -> None:
    r = execute("def (", ns(), set())
    assert r["ok"] is False
    assert r["exit_code"] == 1
    assert r["error"].startswith("SyntaxError:")


def test_stdout_before_the_error_is_kept() -> None:
    r = execute("print('partial')\nraise ValueError('x')", ns(), set())
    assert r["stdout"] == "partial\n"
    assert r["error"] == "ValueError: x"


def test_stdout_over_the_limit_is_truncated_with_a_marker() -> None:
    r = execute("print('x' * 500)", ns(), set(), max_output=50)
    assert r["stdout"].startswith("x" * 50)
    assert "truncated" in r["stdout"]
    assert len(r["stdout"]) < 200          # capped, not the full 500+


def test_value_over_the_limit_is_truncated_with_a_marker() -> None:
    r = execute("'y' * 500", ns(), set(), max_output=50)
    assert r["value"].startswith("y" * 50)
    assert "truncated" in r["value"]


def test_output_under_the_limit_is_untouched() -> None:
    r = execute("print('hi')\n42", ns(), set(), max_output=1000)
    assert r["stdout"] == "hi\n"
    assert r["value"] == "42"


def test_non_int_exit_code_attribute_is_ignored() -> None:
    n = ns()
    exec("class E(Exception):\n    exit_code = 'three'", n.__dict__)
    r = execute("raise E('bad')", n, set())
    assert r["exit_code"] == 1
    assert r["error"] == "E: bad"
