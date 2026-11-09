#!/usr/bin/env python3
"""Compile spec/error-rules.json into the Dart SDK (dart/lib/src/core/rules.g.dart).

Flutter apps can't read package files at runtime, so the Dart SDK carries the
shared error rules as Dart constants instead of a JSON copy.

    python3 tools/gen_dart_rules.py           # write the Dart file
    python3 tools/gen_dart_rules.py --check   # exit 1 if it is stale (CI)

The output is already in `dart format` style (every collection split, with
trailing commas), so formatting the package leaves it unchanged.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "spec" / "error-rules.json"
TARGET = ROOT / "dart" / "lib" / "src" / "core" / "rules.g.dart"
PAGE_WIDTH = 80
INDENT = "  "

RETRY_FLAGS = {True: "RetryFlag.yes", False: "RetryFlag.no", "once": "RetryFlag.once", "opt_in": "RetryFlag.optIn"}
DELAYS = {
    "none": "RetryDelay.none",
    "backoff": "RetryDelay.backoff",
    "retry_after": "RetryDelay.retryAfter",
    "retry_after_or_backoff": "RetryDelay.retryAfterOrBackoff",
}
EXECUTED = {"no": "Executed.no", "yes": "Executed.yes", "unknown": "Executed.unknown"}
MATCH_KEYS = {
    "message_equals": "messageEquals",
    "message_prefix": "messagePrefix",
    "message_suffix": "messageSuffix",
    "message_contains": "messageContains",
    "json": "json",
    "retry_after": "retryAfter",
}
KNOWN_MATCH_KEYS = {"status", "status_range", *MATCH_KEYS}


def dart_string(value: str) -> str:
    escaped = []
    for char in value:
        if char in "\\'$":
            escaped.append("\\" + char)
        elif char == "\n":
            escaped.append("\\n")
        elif char == "\r":
            escaped.append("\\r")
        elif char == "\t":
            escaped.append("\\t")
        elif ord(char) < 0x20 or ord(char) == 0x7F:
            escaped.append(f"\\x{ord(char):02X}")
        else:
            escaped.append(char)
    return "'" + "".join(escaped) + "'"


def dart_double(value: Any) -> str:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"expected a number, got {value!r}")
    text = repr(float(value))
    if text in ("inf", "-inf", "nan"):
        raise ValueError(f"{value!r} can't be a Dart constant")
    return text


def dart_bool(value: Any) -> str:
    if not isinstance(value, bool):
        raise ValueError(f"expected a boolean, got {value!r}")
    return "true" if value else "false"


def lookup(table: dict[Any, str], value: Any, what: str) -> str:
    for key, dart in table.items():
        if key == value and type(key) is type(value):
            return dart
    raise ValueError(f"unknown {what}: {value!r}")


class Writer:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self.depth = 0

    def line(self, text: str) -> None:
        self.lines.append(INDENT * self.depth + text if text else "")

    def field(self, name: str, value: str) -> None:
        """`name: value,` — or, like dart format, the value on its own line when too long."""
        indent = INDENT * self.depth
        single = f"{indent}{name}: {value},"
        if len(single) <= PAGE_WIDTH:
            self.lines.append(single)
        else:
            self.lines.append(f"{indent}{name}:")
            self.lines.append(f"{indent}{INDENT * 2}{value},")

    def open(self, text: str) -> None:
        self.line(text)
        self.depth += 1

    def close(self, text: str) -> None:
        self.depth -= 1
        self.line(text)


def write_retry(out: Writer, retry: dict[str, Any]) -> None:
    unknown = set(retry) - {"GET", "DELETE", "POST", "WS", "delay"}
    if unknown:
        raise ValueError(f"unknown retry columns {sorted(unknown)}")
    out.open("retry: RetryColumns(")
    for column, name in (("GET", "get"), ("DELETE", "delete"), ("POST", "post"), ("WS", "ws")):
        out.field(name, lookup(RETRY_FLAGS, retry[column], f"{column} retry flag"))
    out.field("delay", lookup(DELAYS, retry["delay"], "retry delay"))
    out.close("),")


def write_rule(out: Writer, rule: dict[str, Any]) -> None:
    match = rule["match"]
    unknown = set(match) - KNOWN_MATCH_KEYS
    if unknown:
        raise ValueError(f"rule {rule['id']}: unknown match keys {sorted(unknown)}")
    out.open("ErrorRule(")
    out.field("id", dart_string(rule["id"]))
    out.field("row", dart_string(rule["row"]))
    out.field("error", dart_string(rule["error"]))
    write_retry(out, rule["retry"])
    out.field("mayHaveExecuted", lookup(EXECUTED, rule["may_have_executed"], "may_have_executed"))
    status = match.get("status")
    if status is not None:
        statuses = status if isinstance(status, list) else [status]
        if not statuses or not all(isinstance(s, int) and not isinstance(s, bool) for s in statuses):
            raise ValueError(f"rule {rule['id']}: bad status {status!r}")
        out.field("statuses", "{" + ", ".join(str(s) for s in statuses) + "}")
    bounds = match.get("status_range")
    if bounds is not None:
        low, high = (int(b) for b in bounds)
        out.field("statusRange", f"({low}, {high})")
    for key, name in MATCH_KEYS.items():
        if key not in match:
            continue
        value = match[key]
        out.field(name, dart_bool(value) if key in ("json", "retry_after") else dart_string(value))
    if rule.get("blocks_bucket", False):
        out.field("blocksBucket", dart_bool(rule["blocks_bucket"]))
    if rule.get("from_proxy", False):
        out.field("fromProxy", dart_bool(rule["from_proxy"]))
    out.close("),")


def render(source: bytes) -> str:
    data = json.loads(source)
    digest = hashlib.sha256(source).hexdigest()
    out = Writer()
    out.line("// GENERATED CODE - DO NOT EDIT BY HAND.")
    out.line("//")
    out.line("// Generated by tools/gen_dart_rules.py from spec/error-rules.json")
    out.line(f"// (SHA-256 {digest[:16]}...). To change the rules, edit the JSON")
    out.line("// file and run: python3 tools/gen_dart_rules.py")
    out.line("")
    out.line("part of 'rules.dart';")
    out.line("")
    out.line(f"/// The shared error rules (`spec/error-rules.json`, version {int(data['version'])}).")
    out.line("///")
    out.line("/// Compiled in, so Flutter apps don't need to read package files.")
    out.open("const RuleSet errorRules = RuleSet(")
    out.field("version", str(int(data["version"])))

    out.open("taxonomy: {")
    for name, parent in data["taxonomy"].items():
        out.line(f"{dart_string(name)}: {'null' if parent is None else dart_string(parent)},")
    out.close("},")

    out.open("rules: [")
    for rule in data["rules"]:
        write_rule(out, rule)
    out.close("],")

    out.open("transport: {")
    for row in data["transport"]:
        out.open(f"{dart_string(row['phase'])}: TransportRule(")
        out.field("row", dart_string(row["row"]))
        out.field("phase", dart_string(row["phase"]))
        out.field("error", dart_string(row["error"]))
        write_retry(out, row["retry"])
        out.field("mayHaveExecuted", lookup(EXECUTED, row["may_have_executed"], "may_have_executed"))
        out.close("),")
    out.close("},")

    defaults = data["defaults"]
    backoff = defaults["backoff"]
    out.open("defaults: RetryDefaults(")
    out.field("maxRetries", str(int(defaults["max_retries"])))
    out.field("backoffInitialSeconds", dart_double(backoff["initial_seconds"]))
    out.field("backoffMultiplier", dart_double(backoff["multiplier"]))
    out.field("backoffMaxSeconds", dart_double(backoff["max_seconds"]))
    low, high = backoff["jitter"]
    out.field("backoffJitter", f"({dart_double(low)}, {dart_double(high)})")
    low, high = defaults["retry_after_jitter_seconds"]
    out.field("retryAfterJitterSeconds", f"({dart_double(low)}, {dart_double(high)})")
    out.field("maxRetryAfterSeconds", dart_double(defaults["max_retry_after_seconds"]))
    out.field("wsMaxRetryAfterSeconds", dart_double(defaults["ws_handshake_max_retry_after_seconds"]))
    out.close("),")
    out.close(");")
    return "\n".join(out.lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--check", action="store_true", help="exit 1 if the Dart file is stale")
    args = parser.parse_args()
    content = render(SOURCE.read_bytes())
    current = TARGET.read_text(encoding="utf-8") if TARGET.exists() else None
    if current == content:
        return 0
    relative = TARGET.relative_to(ROOT)
    if args.check:
        print(f"{relative} is stale: run python3 tools/gen_dart_rules.py")
        return 1
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(content, encoding="utf-8", newline="\n")
    print(f"wrote {relative}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
