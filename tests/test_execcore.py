import ast

from dolsot._execcore import cap_text, split_trailing_expression


def test_under_limit_is_unchanged():
    assert cap_text("hello", 100) == ("hello", False)


def test_zero_limit_disables_cap():
    assert cap_text("x" * 50, 0) == ("x" * 50, False)


def test_over_limit_truncates_and_flags():
    out, truncated = cap_text("y" * 500, 50)
    assert truncated is True
    assert out.startswith("y" * 50)
    assert "truncated" in out
    assert len(out) < 120


def test_trailing_expression_is_split_out():
    tree = ast.parse("x = 1\nx + 2", mode="exec")
    expr = split_trailing_expression(tree)
    assert isinstance(expr, ast.Expression)
    assert len(tree.body) == 1                 # the expression was popped
    assert eval(compile(expr, "<t>", "eval"), {"x": 10}) == 12


def test_no_trailing_expression_returns_none():
    tree = ast.parse("x = 1", mode="exec")
    assert split_trailing_expression(tree) is None
    assert len(tree.body) == 1
