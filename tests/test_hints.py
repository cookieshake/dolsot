import sys
import types
from pathlib import Path

import pytest

from dolsot import hints
from dolsot.worker import execute

sys.path.insert(0, str(Path(__file__).parent / "fixtures"))
import faketools          # noqa: E402
import plaintools         # noqa: E402

FULL = {"mt": faketools}
PLAIN = {"pt": plaintools}


def test_registry_finds_top_level_callables() -> None:
    reg = hints.registry(FULL)
    assert reg["add"][0] == "mt.add"


def test_registry_recurses_into_sub_namespaces() -> None:
    reg = hints.registry(FULL)
    assert reg["echo"][0] == "mt.sub.echo"


def test_registry_respects_dunder_all() -> None:
    reg = hints.registry(FULL)
    assert "_private" not in reg


def test_registry_without_dunder_all_takes_public_attrs() -> None:
    reg = hints.registry(PLAIN)
    assert reg["ping"][0] == "pt.ping"


def test_signature_hint_shows_real_signature() -> None:
    h = hints.signature_hint("add", FULL)
    assert "mt.add(a: int, b: int) -> int" in h


def test_signature_hint_mentions_help_when_toolbox_has_one() -> None:
    h = hints.signature_hint("add", FULL)
    assert "mt.help('add')" in h


def test_signature_hint_omits_help_when_toolbox_lacks_one() -> None:
    h = hints.signature_hint("ping", PLAIN)
    assert "help(" not in h


def test_signature_hint_is_none_for_unknown_name() -> None:
    assert hints.signature_hint("nosuchfn", FULL) is None


def test_typeerror_hint_only_fires_on_argument_errors() -> None:
    assert hints.typeerror_hint(TypeError("unsupported operand type(s)"), FULL) is None


def test_execute_appends_hint_to_argument_typeerror() -> None:
    ns = types.ModuleType("s")
    ns.mt = faketools
    r = execute("mt.add(1)", ns, {"mt"}, injected=FULL)
    assert r["ok"] is False
    assert "TypeError:" in r["error"]
    assert "mt.add(a: int, b: int) -> int" in r["error"]


def test_execute_leaves_unrelated_typeerror_alone() -> None:
    ns = types.ModuleType("s")
    ns.mt = faketools
    r = execute("1 + 'x'", ns, {"mt"}, injected=FULL)
    assert "hint:" not in r["error"]


def test_execute_degrades_on_hint_generation_exception() -> None:
    """When hint generation raises an exception (not the original TypeError),
    the original TypeError is still reported — hint generation exceptions are
    caught and degraded to no hint, never propagated."""
    # Create a module with a broken __getattr__ that raises on introspection.
    class BrokenModule(types.ModuleType):
        def __getattr__(self, name: str):
            if name.startswith("_"):
                raise AttributeError(name)
            raise RuntimeError(f"introspection blocked for {name}")

    prob_mod = BrokenModule("problem_tools")
    prob_mod.__name__ = "problem_tools"

    ns = types.ModuleType("s")
    # Add faketools but also include the problematic module.
    ns.mt = faketools
    injected = {"mt": faketools, "pt": prob_mod}

    # Trigger a TypeError in user code (calling add with insufficient args).
    r = execute("mt.add(1)", ns, {"mt", "pt"}, injected=injected)
    assert r["ok"] is False
    # The core TypeError should be reported (missing argument to add).
    assert "TypeError:" in r["error"]
    # With the fix, hint generation exceptions are caught, and we get a degraded
    # response (just the original error, no hint). Without the fix, the
    # RuntimeError from prob_mod would escape and appear in the error message.


def test_registry_prefix_collision_fix() -> None:
    """Verify that a callable with __module__ 'mytools_extra' does NOT match
    root 'mytools' — the _belongs() helper prevents false prefix matches."""
    # Create a fake callable with a colliding name.
    def colliding_fn():
        pass
    colliding_fn.__module__ = "mytools_extra"
    colliding_fn.__name__ = "colliding"

    # Create a root module with that callable somehow accessible.
    root_mod = types.ModuleType("mytools")
    root_mod.__name__ = "mytools"

    # Create a sub-namespace to attach the colliding callable.
    extra_mod = types.ModuleType("mytools_extra")
    extra_mod.__name__ = "mytools_extra"
    extra_mod.__dict__["colliding"] = colliding_fn

    # Inject only the root; the registry walk should NOT find colliding_fn
    # because its __module__ is "mytools_extra", not "mytools" or "mytools.*".
    injected = {"mt": root_mod}
    reg = hints.registry(injected)

    # The colliding callable should not be in the registry.
    assert "colliding" not in reg
