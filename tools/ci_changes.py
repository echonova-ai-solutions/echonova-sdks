#!/usr/bin/env python3
"""Decide which CI jobs a change needs, from the files it touches.

Prints one ``area=true|false`` line per area, for ``$GITHUB_OUTPUT``. Every area
runs when the comparison base is unknown (a new branch, a manual or scheduled
run, a force push) or when a file every area depends on changed.

A pull request is compared with where it branched from. A push is compared with
the last commit CI passed on (``LAST_GREEN_SHA``), not with the previous push:
a push cancels the run still going for the one before, and that one's changes
must still be checked.

    python3 tools/ci_changes.py                  # reads the GitHub event from the environment
    python3 tools/ci_changes.py --files a b ...  # decide for an explicit list of paths
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from fnmatch import fnmatchcase

# Changes here can affect any job.
EVERYTHING = [".github/workflows/ci.yml", "tools/ci_changes.py"]

SDKS = ["spec/*", "tools/*"]  # the shared contract and the tools that generate each SDK's copy of it

AREAS: dict[str, list[str]] = {
    "python": ["python/*", *SDKS],
    "js": ["js/*", *SDKS],
    "dart": ["dart/*", *SDKS],
    # Code samples are type-checked against all three SDKs; the API references build from them.
    "docs": ["*.md", "docs/*", "python/*", "js/*", "dart/*", *SDKS],
    "flutter": ["samples/flutter/*", "dart/*", *SDKS],
    "fastapi": ["proxy-examples/fastapi/*"],
    "express": ["proxy-examples/express/*"],
    "workflows": [".github/workflows/*", ".github/actions/*"],
}

NO_COMMIT = "0" * 40


def decide(files: list[str] | None) -> dict[str, bool]:
    """``files`` is None when the base is unknown: then everything runs."""
    if files is None or any(f in EVERYTHING for f in files):
        return dict.fromkeys(AREAS, True)
    return {area: any(fnmatchcase(f, p) for f in files for p in patterns) for area, patterns in AREAS.items()}


def _git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], capture_output=True, text=True, check=False)  # noqa: S603, S607 - fixed argv


def changed_files() -> list[str] | None:
    event = os.environ.get("GITHUB_EVENT_NAME", "")
    if event == "pull_request":
        base, head = os.environ.get("BASE_SHA", ""), os.environ.get("HEAD_SHA", "HEAD")
        diff_range = f"{base}...{head}"  # what the pull request adds, from where it branched
    elif event == "push":
        base = os.environ.get("LAST_GREEN_SHA", "")
        diff_range = f"{base}..HEAD"
    else:  # workflow_dispatch, schedule: run everything
        return None
    if not base or base == NO_COMMIT or _git("cat-file", "-e", f"{base}^{{commit}}").returncode != 0:
        return None
    if event == "push" and _git("merge-base", "--is-ancestor", base, "HEAD").returncode != 0:
        return None  # history was rewritten since: check everything
    result = _git("diff", "--name-only", diff_range)
    if result.returncode != 0:
        return None
    return [line for line in result.stdout.splitlines() if line]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--files", nargs="*", help="decide for these paths instead of the GitHub event")
    args = parser.parse_args()
    files = args.files if args.files is not None else changed_files()
    for area, needed in decide(files).items():
        print(f"{area}={'true' if needed else 'false'}")
    print(f"changed {'(unknown base: everything)' if files is None else len(files)} file(s)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
