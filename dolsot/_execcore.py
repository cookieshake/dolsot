"""Small pure helpers shared by both execution backends. Nothing here touches a
process, a namespace type, or output streams — just AST shape and text."""
from __future__ import annotations

import ast


def cap_text(text: str, limit: int) -> tuple[str, bool]:
    """Truncate `text` to `limit` chars, returning (text, was_truncated). A falsy
    limit disables the cap. The marker keeps the word 'truncated' so callers can
    surface it uniformly."""
    if not limit or len(text) <= limit:
        return text, False
    return text[:limit] + f"\n… [truncated {len(text) - limit} chars]", True


def split_trailing_expression(tree: ast.Module) -> ast.Expression | None:
    """If the module's last statement is a bare expression, pop it from
    `tree.body` and return it as an `ast.Expression` (for eval). Else None. The
    body left in `tree` is compiled for exec; the returned expression for its
    value."""
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        stmt = tree.body.pop()
        expr = ast.Expression(stmt.value)
        ast.copy_location(expr, expr.body)
        return expr
    return None
