from __future__ import annotations

from pathlib import Path

import pytest

from _support import SPEC_DIR


@pytest.fixture(scope="session")
def spec_dir() -> Path:
    return SPEC_DIR
