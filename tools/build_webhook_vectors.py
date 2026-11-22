#!/usr/bin/env python3
"""Generate shared webhook-signature test vectors: spec/fixtures/webhooks/vectors.json.

Signatures are computed here with the standard library, following
spec/webhooks.json, independently of any SDK code. Each SDK's verify helper
must accept every "valid" vector and reject every "invalid" one with the
stated reason. The secrets are made-up test values.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "spec" / "fixtures" / "webhooks" / "vectors.json"

SECRET = "whsec_TEST0000000000000000000000000000000000000000"
OTHER_SECRET = "whsec_TEST1111111111111111111111111111111111111111"
NOW = 1_762_300_800  # "now" for every vector; tests pass it explicitly


def sign(secret: str, timestamp: str, body: str) -> str:
    return hmac.new(secret.encode("utf-8"), f"{timestamp}.{body}".encode("utf-8"), hashlib.sha256).hexdigest()


def compact(payload: dict) -> str:
    # The gateway sends JSON.stringify(payload): compact separators, non-ASCII kept as-is.
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)


def vector(name, event, payload, *, secret=SECRET, sign_with=None, timestamp=NOW, body=None, signature=None,
           expect="valid", reason=None, expect_type=None, secrets=None):
    body = compact(payload) if body is None else body
    ts = str(timestamp)
    sig = signature if signature is not None else sign(sign_with or secret, ts, body)
    entry = {
        "name": name,
        "secrets": secrets or [secret],
        "now": NOW,
        "tolerance_seconds": 300,
        "headers": {"X-Webhook-Event": event, "X-Webhook-Timestamp": ts, "X-Webhook-Signature": sig},
        "body": body,
        "expect": expect,
    }
    if reason:
        entry["reason"] = reason
    if expect_type:
        entry["expect_type"] = expect_type
    return entry


TTS_DONE = {
    "jobId": "000000000000000000000001",
    "apiKeyId": "000000000000000000000a01",
    "service": "tts",
    "durationSeconds": 3.4,
    "text": "مرحبا بكم في إيكونوفا",
    "audioUrl": "https://storage.example.com/tts/out.wav?sig=redacted",
}
STT_DONE = {
    "jobId": "000000000000000000000002",
    "apiKeyId": "000000000000000000000a01",
    "service": "stt",
    "durationSeconds": 12.5,
    "transcription": "hello from the KYC team",
    "terminology": {"raw": "hello from the kyc team", "corrected": "hello from the KYC team", "edits": [],
                    "nearMisses": [], "warnings": [], "mapperStatus": "applied", "mapperVersion": "1"},
}
FAILED = {"jobId": "000000000000000000000003", "apiKeyId": "000000000000000000000a01", "service": "stt",
          "error": "Transcription failed. Try again."}
WARNING = {"apiKeyId": "000000000000000000000a01", "apiKeyName": "production", "creditsUsed": 8000,
           "creditLimit": 10000, "percentageUsed": 80}
EXHAUSTED = {"apiKeyId": "000000000000000000000a01", "apiKeyName": "production", "creditsUsed": 10000,
             "creditLimit": 10000}


def main() -> None:
    vectors = [
        vector("tts job.completed", "job.completed", TTS_DONE, expect_type="JobCompleted"),
        vector("stt job.completed with terminology", "job.completed", STT_DONE, expect_type="JobCompleted"),
        vector("job.failed", "job.failed", FAILED, expect_type="JobFailed"),
        vector("spending.warning", "spending.warning", WARNING, expect_type="SpendingWarning"),
        vector("spending.exhausted", "spending.exhausted", EXHAUSTED, expect_type="SpendingExhausted"),
        vector("unknown event name parses", "job.archived", {"jobId": "000000000000000000000004"},
               expect_type="UnknownEvent"),
        vector("second secret in the list matches", "job.failed", FAILED, sign_with=OTHER_SECRET,
               secrets=[SECRET, OTHER_SECRET], expect_type="JobFailed"),
        vector("timestamp at the edge of tolerance", "job.failed", FAILED, timestamp=NOW - 300,
               expect_type="JobFailed"),
        vector("uppercase hex signature accepted", "job.failed", FAILED,
               signature=sign(SECRET, str(NOW), compact(FAILED)).upper(), expect_type="JobFailed"),
        vector("wrong secret", "job.failed", FAILED, sign_with=OTHER_SECRET, expect="invalid", reason="signature"),
        vector("tampered body", "job.failed", FAILED, body=compact({**FAILED, "error": None}),
               signature=sign(SECRET, str(NOW), compact(FAILED)), expect="invalid", reason="signature"),
        vector("re-serialised body (pretty-printed) does not match", "job.failed", FAILED,
               body=json.dumps(FAILED, indent=2, ensure_ascii=False),
               signature=sign(SECRET, str(NOW), compact(FAILED)), expect="invalid", reason="signature"),
        vector("stale timestamp", "job.failed", FAILED, timestamp=NOW - 301, expect="invalid", reason="timestamp"),
        vector("timestamp too far in the future", "job.failed", FAILED, timestamp=NOW + 301, expect="invalid",
               reason="timestamp"),
        vector("non-numeric timestamp", "job.failed", FAILED, timestamp="yesterday", expect="invalid",
               reason="timestamp"),
        vector("signature with a sha256= prefix is not the gateway's format", "job.failed", FAILED,
               signature="sha256=" + sign(SECRET, str(NOW), compact(FAILED)), expect="invalid", reason="signature"),
        # X-Webhook-Event is not covered by the signature, so a captured delivery can be replayed under another
        # event name. A completed job must carry its result, which a failed job's body never has.
        vector("stt job.failed body sent as job.completed", "job.completed", FAILED, expect="invalid",
               reason="payload"),
        vector("tts job.failed body sent as job.completed", "job.completed", {**FAILED, "service": "tts"},
               expect="invalid", reason="payload"),
        # The other relabellings: a failed job carries no result, and a spending event carries its credits.
        vector("tts job.completed body sent as job.failed", "job.failed", TTS_DONE, expect="invalid",
               reason="payload"),
        vector("stt job.completed body sent as job.failed", "job.failed", STT_DONE, expect="invalid",
               reason="payload"),
        vector("job.failed body sent as spending.exhausted", "spending.exhausted", FAILED, expect="invalid",
               reason="payload"),
        vector("tts job.completed body sent as spending.warning", "spending.warning", TTS_DONE, expect="invalid",
               reason="payload"),
        vector("job.failed with a null result still parses", "job.failed", {**FAILED, "audioUrl": None},
               expect_type="JobFailed"),
        # Seconds since the epoch never need more than 15 digits; a longer value is refused before it is parsed.
        vector("timestamp with thousands of leading zeros", "job.failed", FAILED, timestamp="0" * 4990 + str(NOW),
               expect="invalid", reason="timestamp"),
    ]
    missing_headers = vector("missing signature header", "job.failed", FAILED, expect="invalid", reason="headers")
    del missing_headers["headers"]["X-Webhook-Signature"]
    vectors.append(missing_headers)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"source": "tools/build_webhook_vectors.py", "vectors": vectors}, indent=2,
                              ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(vectors)} vectors")


if __name__ == "__main__":
    main()
