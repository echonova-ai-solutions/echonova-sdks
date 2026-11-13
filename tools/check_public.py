#!/usr/bin/env python3
"""Fail if anything that must stay private is about to be published in this repo.

Checks every file git would publish (tracked or not ignored) for:
- secrets: API keys, webhook secrets, bearer tokens, signed storage links;
- private terms: internal project, host and environment names. The list itself
  is private, so it comes from the ECHONOVA_DENYLIST environment variable
  (comma-separated; a CI secret) or the git-ignored file .internal/denylist.txt.

    python3 tools/check_public.py
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools" / "record"))
from scrub import find_leaks  # noqa: E402

SKIP_SUFFIXES = {".png", ".jpg", ".ico", ".wav", ".mp3", ".flac", ".ogg", ".opus", ".pcm", ".lock"}


def publishable_files() -> list[Path]:
    output = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout
    return [ROOT / line for line in output.splitlines() if line]


def denylist() -> list[str]:
    terms = os.environ.get("ECHONOVA_DENYLIST", "")
    local = ROOT / ".internal" / "denylist.txt"
    if local.exists():
        terms += "," + ",".join(local.read_text(encoding="utf-8").splitlines())
    return [t.strip().lower() for t in terms.split(",") if t.strip() and not t.strip().startswith("#")]


def main() -> int:
    terms = denylist()
    problems = []
    for path in publishable_files():
        if path.suffix in SKIP_SUFFIXES or not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        relative = path.relative_to(ROOT)
        if relative.as_posix() in ("tools/record/scrub.py", "tools/record/test_scrub.py"):
            continue  # they contain the leak patterns on purpose
        fixture = relative.as_posix().startswith(("spec/fixtures/rest/", "spec/fixtures/ws/"))  # recorded traffic
        problems += [f"{relative}: {leak}" for leak in find_leaks(text, fixture=fixture)]
        lowered = text.lower()
        problems += [f"{relative}: private term #{terms.index(t) + 1}" for t in terms if t in lowered]
    if not terms:
        print("warning: no private-term list (set ECHONOVA_DENYLIST or .internal/denylist.txt); secrets only")
    if problems:
        print("not safe to publish:\n  " + "\n  ".join(problems))
        return 1
    print("nothing private found")
    return 0


if __name__ == "__main__":
    sys.exit(main())
