"""Which CI jobs a change runs (tools/ci_changes.py)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ci_changes import AREAS, decide


def needed(*files: str) -> set[str]:
    return {area for area, run in decide(list(files)).items() if run}


def test_unknown_base_runs_everything() -> None:
    assert needed() == set()  # an empty change list is known: nothing to run
    assert {area for area, run in decide(None).items() if run} == set(AREAS)


def test_each_sdk_runs_alone() -> None:
    assert needed("python/src/echonova/_client.py") == {"python", "docs"}
    assert needed("js/src/index.ts") == {"js", "docs"}
    assert needed("dart/lib/echonova.dart") == {"dart", "docs", "flutter"}


def test_proxies_and_the_sample_run_alone() -> None:
    assert needed("proxy-examples/express/src/app.js") == {"express"}
    assert needed("proxy-examples/fastapi/echonova_proxy/app.py") == {"fastapi"}
    assert needed("samples/flutter/lib/main.dart") == {"flutter"}


def test_markdown_anywhere_runs_the_docs_job() -> None:
    assert needed("README.md") == {"docs"}
    assert needed("docs/guides/errors.md") == {"docs"}
    assert needed("proxy-examples/express/README.md") == {"docs", "express"}


def test_the_shared_spec_and_tools_run_every_sdk() -> None:
    sdks = {"python", "js", "dart", "docs", "flutter"}
    assert needed("spec/error-rules.json") == sdks
    assert needed("tools/record/scrub.py") == sdks


def test_ci_itself_runs_everything() -> None:
    assert needed(".github/workflows/ci.yml") == set(AREAS)
    assert needed("tools/ci_changes.py") == set(AREAS)


def test_other_workflows_only_need_linting() -> None:
    assert needed(".github/workflows/live.yml") == {"workflows"}
    assert needed(".github/dependabot.yml") == set()
