#!/usr/bin/env python3
"""Bring the shared files each SDK package needs into the SDK packages.

Python reads a copy of error-rules.json; Dart and TypeScript compile it into
generated source files (Flutter and bundlers can't read package data files).
Each package also ships a copy of the repository's LICENSE, since every
registry publishes from the package's own folder.

    python3 tools/sync_sdk_data.py           # copy and regenerate
    python3 tools/sync_sdk_data.py --check   # exit 1 if anything is stale (CI)
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COPIES = {
    ROOT / "spec" / "error-rules.json": [ROOT / "python" / "src" / "echonova" / "_data" / "error-rules.json"],
    ROOT / "LICENSE": [ROOT / "python" / "LICENSE", ROOT / "js" / "LICENSE", ROOT / "dart" / "LICENSE"],
}
GENERATORS = [ROOT / "tools" / "gen_dart_rules.py", ROOT / "tools" / "gen_ts_rules.py"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    stale = []
    for source, targets in COPIES.items():
        content = source.read_bytes()
        for target in targets:
            if target.exists() and target.read_bytes() == content:
                continue
            if args.check:
                stale.append(str(target.relative_to(ROOT)))
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            print(f"copied {source.relative_to(ROOT)} -> {target.relative_to(ROOT)}")
    for generator in GENERATORS:
        command = [sys.executable, str(generator), *(["--check"] if args.check else [])]
        if subprocess.run(command, cwd=ROOT, check=False).returncode != 0:  # noqa: S603 - fixed argv
            stale.append(str(generator.relative_to(ROOT)))
    if stale:
        print("stale SDK data (run tools/sync_sdk_data.py):\n  " + "\n  ".join(stale))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
