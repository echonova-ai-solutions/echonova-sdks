#!/usr/bin/env python3
"""Extract every documented error example from spec/openapi.json.

Writes spec/fixtures/errors/catalog.json: one entry per (operation, status,
example), with the verbatim envelope and whether the response documents a
Retry-After header. Every SDK classifies each entry in its tests, so a new or
changed error in the published spec shows up as a failing vector.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = ROOT / "spec" / "openapi.json"
OUT = ROOT / "spec" / "fixtures" / "errors" / "catalog.json"
METHODS = ("get", "post", "put", "patch", "delete")


def main() -> None:
    spec = json.loads(SPEC.read_text(encoding="utf-8"))
    entries = []
    for path, operations in spec["paths"].items():
        for method, operation in operations.items():
            if method not in METHODS:
                continue
            for status, response in operation.get("responses", {}).items():
                if not status.isdigit() or int(status) < 400:
                    continue
                headers = response.get("headers", {})
                content = response.get("content", {}).get("application/json", {})
                for key, example in content.get("examples", {}).items():
                    value = example.get("value", {})
                    entries.append(
                        {
                            "operation_id": operation.get("operationId"),
                            "method": method.upper(),
                            "path": path,
                            "status": int(status),
                            "example": key,
                            "error_message": value.get("errorMessage"),
                            "envelope": value,
                            "documents_retry_after": "Retry-After" in headers,
                            "when": example.get("x-echonova-when"),
                            "fix": example.get("x-echonova-fix"),
                        }
                    )
    entries.sort(key=lambda e: (e["path"], e["method"], e["status"], e["example"]))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps({"source": "spec/openapi.json", "count": len(entries), "entries": entries}, indent=2, ensure_ascii=False)
        + "\n",
        encoding="utf-8",
    )
    distinct = sorted({(e["status"], e["error_message"]) for e in entries})
    print(f"wrote {OUT.relative_to(ROOT)}: {len(entries)} examples, {len(distinct)} distinct (status, message) pairs")


if __name__ == "__main__":
    main()
