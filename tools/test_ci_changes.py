"""Which CI jobs a change runs (tools/ci_changes.py)."""

from __future__ import annotations

import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ci_changes import AREAS, changed_files, decide


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


def _repo(tmp_path: Path) -> Callable[..., str]:
    def git(*args: str) -> str:
        return subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True, text=True).stdout.strip()  # noqa: S603, S607 - fixed argv

    git("init", "-q", "-b", "main")
    git("config", "user.email", "ci@example.com")
    git("config", "user.name", "CI")
    return git


def _commit(git: Callable[..., str], tmp_path: Path, path: str) -> str:
    (tmp_path / path).parent.mkdir(parents=True, exist_ok=True)
    (tmp_path / path).write_text(path, encoding="utf-8")
    git("add", path)
    git("commit", "-q", "-m", path)
    return git("rev-parse", "HEAD")


def test_a_push_is_compared_with_the_last_green_commit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    git = _repo(tmp_path)
    green = _commit(git, tmp_path, "README.md")
    _commit(git, tmp_path, "python/a.py")  # its run was cancelled by the next push
    _commit(git, tmp_path, "js/b.ts")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("GITHUB_EVENT_NAME", "push")
    monkeypatch.setenv("LAST_GREEN_SHA", green)
    assert sorted(changed_files() or []) == ["js/b.ts", "python/a.py"]


def test_a_push_without_a_usable_base_checks_everything(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    git = _repo(tmp_path)
    first = _commit(git, tmp_path, "README.md")
    _commit(git, tmp_path, "python/a.py")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("GITHUB_EVENT_NAME", "push")
    for base in ("", "0" * 40, "1234567890abcdef1234567890abcdef12345678"):
        monkeypatch.setenv("LAST_GREEN_SHA", base)
        assert changed_files() is None
    git("checkout", "-q", "--orphan", "rewritten")  # history rewritten: the green commit isn't an ancestor
    _commit(git, tmp_path, "js/b.ts")
    monkeypatch.setenv("LAST_GREEN_SHA", first)
    assert changed_files() is None


def test_manual_runs_check_everything(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GITHUB_EVENT_NAME", "workflow_dispatch")
    assert changed_files() is None
