import pytest

from dolsot.sandbox import SandboxViolation, check_ast


def test_plain_code_passes():
    check_ast("x = 1\nsorted([3, 1, 2])")   # no raise


@pytest.mark.parametrize("code", [
    "import os",
    "from os import system",
    "open('/etc/passwd')",
    "eval('1')",
    "exec('x=1')",
    "__import__('os')",
    "globals()",
    "getattr(x, 'y')",
    "(x for x in (1,)).gi_frame",
    "obj.f_globals",
    "x.__class__",
    "__builtins__",
])
def test_forbidden_constructs_raise(code):
    with pytest.raises(SandboxViolation):
        check_ast(code)


def test_syntax_error_is_wrapped():
    with pytest.raises(SandboxViolation):
        check_ast("def (")


def test_safe_builtins_drops_unsafe_names_but_keeps_useful_ones():
    from dolsot.sandbox import SAFE_BUILTINS

    for banned in ("open", "eval", "exec", "compile", "__import__", "breakpoint", "input", "exit"):
        assert banned not in SAFE_BUILTINS
    for kept in ("len", "range", "sorted", "sum", "print"):
        assert kept in SAFE_BUILTINS


def test_preinject_is_stdlib_only_no_pandas():
    from dolsot.sandbox import PREINJECT

    assert set(PREINJECT) == {"math", "json", "re", "datetime", "statistics", "collections"}
    assert "pd" not in PREINJECT
    assert PREINJECT["json"].__name__ == "json"
