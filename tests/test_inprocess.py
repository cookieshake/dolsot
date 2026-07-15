import builtins
import io

from dolsot._execcore import cap_text  # noqa: F401 (ensures module import path)
from dolsot.inprocess import _run_cell
from dolsot.sandbox import check_ast


def _full_builtins():
    return dict(vars(builtins))


def test_value_is_the_trailing_expression_repr():
    ns = {}
    r = _run_cell("1 + 2", ns, check=None, builtins_map=_full_builtins(),
                  max_output=8000, stdout_buf=io.StringIO())
    assert r.ok is True
    assert r.value == "3"
    assert r.error is None
    assert r.exit_code == 0


def test_print_is_captured_into_stdout_not_the_real_one(capsys):
    ns = {}
    r = _run_cell("print('hi')\n40 + 2", ns, check=None, builtins_map=_full_builtins(),
                  max_output=8000, stdout_buf=io.StringIO())
    assert r.stdout == "hi\n"
    assert r.value == "42"
    assert capsys.readouterr().out == ""      # never reached the real stdout


def test_exception_becomes_a_failed_result_not_a_raise():
    ns = {}
    r = _run_cell("1 / 0", ns, check=None, builtins_map=_full_builtins(),
                  max_output=8000, stdout_buf=io.StringIO())
    assert r.ok is False
    assert r.exit_code == 1
    assert "ZeroDivisionError" in r.error


def test_gate_rejection_is_a_failed_result():
    ns = {}
    r = _run_cell("import os", ns, check=check_ast, builtins_map=_full_builtins(),
                  max_output=8000, stdout_buf=io.StringIO())
    assert r.ok is False
    assert r.exit_code == 1
    assert "import" in r.error
    assert r.stdout == ""                      # never executed


def test_output_over_cap_sets_truncated():
    ns = {}
    r = _run_cell("print('x' * 500)", ns, check=None, builtins_map=_full_builtins(),
                  max_output=50, stdout_buf=io.StringIO())
    assert r.truncated is True
    assert "truncated" in r.stdout


def test_state_mutates_the_passed_namespace():
    ns = {}
    _run_cell("keep = [1, 2, 3]", ns, check=None, builtins_map=_full_builtins(),
              max_output=8000, stdout_buf=io.StringIO())
    assert ns["keep"] == [1, 2, 3]             # lives by reference for the next cell


from dolsot.inprocess import InProcessSession


class _Live:
    """A live object that is NOT importable/picklable — the whole point of R2."""
    def __init__(self):
        self.calls = 0

    def add(self, a, b):
        self.calls += 1
        return a + b


def test_live_object_is_injected_as_is():
    live = _Live()
    s = InProcessSession(inject={"nn": live})
    r = s.run("nn.add(2, 3)")
    assert r.ok is True and r.value == "5"
    assert live.calls == 1                     # the very object we passed, by reference


def test_state_persists_across_cells_by_reference():
    s = InProcessSession(inject={})
    s.run("df = [1, 2, 3]")
    r = s.run("sum(df)")
    assert r.value == "6"


def test_unpicklable_live_object_is_not_dropped():
    s = InProcessSession(inject={})
    s.run("gen = (i for i in range(3))")        # unpicklable — would be dropped by subprocess
    r = s.run("next(gen)")
    assert r.value == "0"                        # still alive next cell
    assert r.dropped == []


def test_preinject_defaults_are_available():
    s = InProcessSession(inject={}, preinject={"j": __import__("json")})
    r = s.run("j.dumps({'a': 1})")
    assert r.value == "'{\"a\": 1}'"


def test_held_lists_user_names_not_injected_ones():
    live = _Live()
    s = InProcessSession(inject={"nn": live}, preinject={"pre": 1})
    s.run("mine = 5")
    r = s.run("mine + 1")
    assert "mine" in r.held
    assert "nn" not in r.held and "pre" not in r.held


def test_gate_can_be_opted_in():
    from dolsot.sandbox import check_ast
    s = InProcessSession(inject={}, check=check_ast)
    r = s.run("import os")
    assert r.ok is False and "import" in r.error


import asyncio

import pytest


@pytest.mark.asyncio
async def test_arun_runs_and_returns_value():
    s = InProcessSession(inject={})
    r = await s.arun("2 ** 10")
    assert r.ok is True and r.value == "1024"


@pytest.mark.asyncio
async def test_arun_keeps_state_across_calls():
    s = InProcessSession(inject={})
    await s.arun("acc = 41")
    r = await s.arun("acc + 1")
    assert r.value == "42"


@pytest.mark.asyncio
async def test_arun_timeout_returns_partial_stdout():
    s = InProcessSession(inject={})           # no gate, so the while-loop is allowed to run
    r = await s.arun("print('before')\nwhile True:\n    pass", timeout=0.3)
    assert r.ok is False
    assert r.exit_code == 124
    assert "before" in r.stdout        # output before the cut survived
    assert r.truncated is True


@pytest.mark.asyncio
async def test_arun_does_not_block_process_exit_after_timeout():
    # A leaked daemon thread must not keep the interpreter from exiting; if the
    # runner used asyncio.to_thread (non-daemon pool) this suite would hang at exit.
    s = InProcessSession(inject={})
    r = await s.arun("while True:\n    pass", timeout=0.2)
    assert r.exit_code == 124
    # Reaching here (and the suite finishing) is the assertion.


def test_public_exports():
    import dolsot
    assert hasattr(dolsot, "InProcessSession")
    assert hasattr(dolsot, "SandboxViolation")
    assert hasattr(dolsot, "check_ast")


@pytest.mark.asyncio
async def test_arun_timeout_with_a_namespace_growing_cell_returns_a_result():
    """The abandoned daemon thread keeps mutating the namespace after timeout; the
    held-names computation must snapshot it, not iterate a dict being mutated
    (which would raise RuntimeError and break the never-raises contract)."""
    s = InProcessSession(inject={})
    # No gate: globals() (which is the session namespace) is grown in a tight loop.
    code = "i = 0\nwhile True:\n    globals()[f'v{i}'] = i\n    i += 1"
    r = await s.arun(code, timeout=0.2)
    assert r.ok is False
    assert r.exit_code == 124
