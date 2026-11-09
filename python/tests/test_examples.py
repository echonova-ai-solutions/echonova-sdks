"""The examples import cleanly and only call the API when run as scripts (CI runs them with a key)."""

from __future__ import annotations

import runpy
from pathlib import Path

import pytest

EXAMPLES = sorted((Path(__file__).resolve().parents[1] / "examples").glob("*.py"))


def test_there_are_examples() -> None:
    assert len(EXAMPLES) >= 5


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda p: p.name)
def test_example_imports_without_side_effects(path: Path) -> None:
    source = path.read_text(encoding="utf-8")
    assert 'if __name__ == "__main__":' in source
    namespace = runpy.run_path(str(path), run_name="example")
    assert callable(namespace["main"])
