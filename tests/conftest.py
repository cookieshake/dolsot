from pathlib import Path

import pytest


@pytest.fixture
def fixtures_dir() -> str:
    """Directory holding the fake toolboxes. Handed to Repl(env={"PYTHONPATH": ...})
    so the *worker* subprocess can import them."""
    return str(Path(__file__).parent / "fixtures")
