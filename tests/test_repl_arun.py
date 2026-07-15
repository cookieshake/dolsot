import asyncio

import pytest

from dolsot import MemoryStore, Repl


@pytest.fixture
def repl(fixtures_dir):
    return Repl(inject={"mt": "faketools"}, store=MemoryStore(), typecheck=False,
                env={"PYTHONPATH": fixtures_dir})


async def test_arun_runs_code(repl) -> None:
    r = await repl.arun("s1", "mt.add(20, 22)")
    assert r.ok and r.value == "42"


async def test_arun_persists_state(repl) -> None:
    await repl.arun("s1", "df = [1, 2, 3]")
    r = await repl.arun("s1", "sum(df)")
    assert r.value == "6"


async def test_arun_timeout_does_not_block_the_loop(repl) -> None:
    """The whole point of arun: a runaway cell must not freeze the event loop.
    While the cell burns, another coroutine keeps making progress."""
    ticks = 0

    async def ticker() -> None:
        nonlocal ticks
        while True:
            await asyncio.sleep(0.1)
            ticks += 1

    t = asyncio.create_task(ticker())
    r = await repl.arun("s1", "while True:\n    pass", timeout=2)
    t.cancel()

    assert r.exit_code == 124
    assert ticks >= 5          # the loop kept running while the worker burned


async def test_arun_toolbox_error_keeps_its_exit_code(repl) -> None:
    r = await repl.arun("s1", "mt.boom()")
    assert r.exit_code == 3


async def test_create_subprocess_exec_oserror_returns_dead_worker_result(repl, monkeypatch) -> None:
    """Critical 4 (async side): arun() must stay symmetric with run() — a
    fork/exec OSError from asyncio.create_subprocess_exec must not escape it."""
    import asyncio as aio

    async def boom(*args, **kwargs):
        raise OSError("fork failed: resource temporarily unavailable")

    monkeypatch.setattr(aio, "create_subprocess_exec", boom)

    r = await repl.arun("s1", "1 + 1")

    assert r.ok is False
    assert r.exit_code == 1
    assert "worker died" in r.error
