#!/usr/bin/env python3
"""Vendor the gateway's published API specs into spec/ and pin them by hash.

    python3 tools/spec_sync.py            # fetch, write spec/*.json, update spec/spec-lock.json
    python3 tools/spec_sync.py --check    # exit 1 if the live specs differ from the lock (nightly drift job)

The hash is taken over canonical JSON (sorted keys, no whitespace), so it only
changes when the content changes. The vendored files are never edited by hand.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC_DIR = ROOT / "spec"
LOCK_FILE = SPEC_DIR / "spec-lock.json"
BASE_URL = "https://api.echonova.ai"
DOCUMENTS = {
    "openapi.json": "/openapi.json",
    "asyncapi.json": "/asyncapi.json",
}
USER_AGENT = "echonova-sdks-spec-sync/1"


def fetch(url: str) -> object:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310 - fixed https URL
        return json.loads(response.read())


def canonical_hash(document: object) -> str:
    canonical = json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def load_lock() -> dict:
    if LOCK_FILE.exists():
        return json.loads(LOCK_FILE.read_text(encoding="utf-8"))
    return {"source": BASE_URL, "documents": {}}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="compare live specs with the lock; write nothing")
    parser.add_argument("--base-url", default=BASE_URL)
    args = parser.parse_args()

    lock = load_lock()
    drift = []
    for name, path in DOCUMENTS.items():
        document = fetch(args.base_url + path)
        digest = canonical_hash(document)
        pinned = lock["documents"].get(name, {}).get("sha256")
        if args.check:
            if digest != pinned:
                drift.append(f"{name}: live {digest[:12]} != pinned {str(pinned)[:12]}")
            continue
        (SPEC_DIR / name).write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        version = document.get("info", {}).get("version") if isinstance(document, dict) else None
        lock["documents"][name] = {
            "url": args.base_url + path,
            "sha256": digest,
            "info_version": version,
            "fetched_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        }
        print(f"wrote spec/{name}  sha256={digest[:12]}  info.version={version}")

    if args.check:
        if drift:
            print("API spec drift detected:\n  " + "\n  ".join(drift))
            return 1
        print("specs match spec-lock.json")
        return 0

    lock["source"] = args.base_url
    LOCK_FILE.write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
