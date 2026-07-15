"""dolsot must never name a specific toolbox. This is the whole point of the
package; a grep test is the cheapest way to keep it true."""
from pathlib import Path

import pytest

PKG = Path(__file__).resolve().parent.parent / "dolsot"
FORBIDDEN = ("bibim", "bb.")


@pytest.mark.parametrize("path", sorted(PKG.rglob("*.py")), ids=lambda p: p.name)
def test_source_names_no_specific_toolbox(path: Path) -> None:
    src = path.read_text().lower()
    for word in FORBIDDEN:
        assert word not in src, f"{path.name} names a specific toolbox: {word!r}"
