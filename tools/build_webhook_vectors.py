#!/usr/bin/env python3
"""Generate shared webhook-signature test vectors: spec/fixtures/webhooks/vectors.json.

Signatures are computed here with the standard library, following
spec/webhooks.json (Standard Webhooks v1), independently of any SDK code. Each
SDK's verify helper must accept every "valid" vector and reject every "invalid"
one with the stated reason. The secrets are made-up test values.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "spec" / "fixtures" / "webhooks" / "vectors.json"

# whsec_ followed by base64. These two are made-up values that happen to be valid base64.
SECRET = "whsec_TEST0000000000000000000000000000000000000000"
OTHER_SECRET = "whsec_TEST1111111111111111111111111111111111111111"
# Secrets created before the gateway switched to standard base64 used the URL-safe alphabet, unpadded.
URLSAFE_SECRET = "whsec_TEST" + "-_ab" * 9 + "cQ"  # made up; - and _ make it URL-safe, no padding
WEBHOOK_ID = "6b0400000000000000000001"
NOW = 1_762_300_800  # "now" for every vector; tests pass it explicitly


def key(secret: str) -> bytes:
    """The HMAC key: the base64 after whsec_, decoded (either alphabet, padding optional)."""
    text = secret.removeprefix("whsec_").replace("-", "+").replace("_", "/")
    return base64.b64decode(text + "=" * (-len(text) % 4), validate=True)


def sign(secret: str, webhook_id: str, timestamp: str, body: str) -> str:
    digest = hmac.new(key(secret), f"{webhook_id}.{timestamp}.{body}".encode("utf-8"), hashlib.sha256).digest()
    return "v1," + base64.b64encode(digest).decode()


def compact(payload: dict) -> str:
    # The gateway sends JSON.stringify(payload): compact separators, non-ASCII kept as-is.
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)


def vector(name, event, payload, *, secret=SECRET, sign_with=None, timestamp=NOW, body=None, signature=None,
           webhook_id=WEBHOOK_ID, expect="valid", reason=None, expect_type=None, secrets=None):
    body = compact(payload) if body is None else body
    ts = str(timestamp)
    sig = signature if signature is not None else sign(sign_with or secret, webhook_id, ts, body)
    entry = {
        "name": name,
        "secrets": secrets or [secret],
        "now": NOW,
        "tolerance_seconds": 300,
        "headers": {"X-Webhook-Event": event, "webhook-id": webhook_id, "webhook-timestamp": ts,
                    "webhook-signature": sig},
        "body": body,
        "expect": expect,
    }
    if reason:
        entry["reason"] = reason
    if expect_type:
        entry["expect_type"] = expect_type
        entry["expect_webhook_id"] = webhook_id
    return entry


TTS_DONE = {
    "jobId": "000000000000000000000001",
    "apiKeyId": "000000000000000000000a01",
    "service": "tts",
    "durationSeconds": 3.4,
    "text": "مرحبا بكم في إيكونوڤا",
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
    signed = sign(SECRET, WEBHOOK_ID, str(NOW), compact(FAILED))
    vectors = [
        vector("tts job.completed", "job.completed", TTS_DONE, expect_type="JobCompleted"),
        vector("stt job.completed with terminology", "job.completed", STT_DONE, expect_type="JobCompleted"),
        vector("job.failed", "job.failed", FAILED, expect_type="JobFailed"),
        vector("spending.warning", "spending.warning", WARNING, expect_type="SpendingWarning"),
        vector("spending.exhausted", "spending.exhausted", EXHAUSTED, expect_type="SpendingExhausted"),
        vector("unknown event name parses", "agent.created", {"agentId": "000000000000000000000004"},
               expect_type="UnknownEvent"),
        vector("second secret in the list matches", "job.failed", FAILED, sign_with=OTHER_SECRET,
               secrets=[SECRET, OTHER_SECRET], expect_type="JobFailed"),
        # During a secret rotation the gateway signs with every active secret, space-separated.
        vector("one of several signatures matches (rotation)", "job.failed", FAILED,
               signature=sign(OTHER_SECRET, WEBHOOK_ID, str(NOW), compact(FAILED)) + " " + signed,
               expect_type="JobFailed"),
        vector("a signature of another version is ignored", "job.failed", FAILED,
               signature="v2,bm90IGEgcmVhbCBzaWduYXR1cmU= " + signed, expect_type="JobFailed"),
        vector("URL-safe secret from before the switch to base64", "job.failed", FAILED, secret=URLSAFE_SECRET,
               expect_type="JobFailed"),
        vector("secret without the whsec_ prefix", "job.failed", FAILED, secrets=[SECRET.removeprefix("whsec_")],
               expect_type="JobFailed"),
        vector("timestamp at the edge of tolerance", "job.failed", FAILED, timestamp=NOW - 300,
               expect_type="JobFailed"),
        vector("wrong secret", "job.failed", FAILED, sign_with=OTHER_SECRET, expect="invalid", reason="signature"),
        vector("tampered body", "job.failed", FAILED, body=compact({**FAILED, "error": None}), signature=signed,
               expect="invalid", reason="signature"),
        vector("re-serialised body (pretty-printed) does not match", "job.failed", FAILED,
               body=json.dumps(FAILED, indent=2, ensure_ascii=False), signature=signed, expect="invalid",
               reason="signature"),
        vector("a delivery replayed under another webhook-id", "job.failed", FAILED, signature=signed,
               webhook_id="6b0400000000000000000002", expect="invalid", reason="signature"),
        vector("signature without its v1, prefix", "job.failed", FAILED, signature=signed.removeprefix("v1,"),
               expect="invalid", reason="signature"),
        vector("hex signature of the old scheme", "job.failed", FAILED,
               signature=hmac.new(SECRET.encode(), f"{NOW}.{compact(FAILED)}".encode(), hashlib.sha256).hexdigest(),
               expect="invalid", reason="signature"),
        vector("stale timestamp", "job.failed", FAILED, timestamp=NOW - 301, expect="invalid", reason="timestamp"),
        vector("timestamp too far in the future", "job.failed", FAILED, timestamp=NOW + 301, expect="invalid",
               reason="timestamp"),
        vector("non-numeric timestamp", "job.failed", FAILED, timestamp="yesterday", expect="invalid",
               reason="timestamp"),
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
    for header in ("webhook-signature", "webhook-id", "webhook-timestamp", "X-Webhook-Event"):
        missing = vector(f"missing {header} header", "job.failed", FAILED, expect="invalid", reason="headers")
        del missing["headers"][header]
        vectors.append(missing)
    old_scheme = vector("only the old X-Webhook-Timestamp and X-Webhook-Signature headers", "job.failed", FAILED,
                        expect="invalid", reason="headers")
    old_scheme["headers"] = {"X-Webhook-Event": "job.failed", "X-Webhook-Timestamp": str(NOW),
                             "X-Webhook-Signature": old_scheme["headers"]["webhook-signature"]}
    vectors.append(old_scheme)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"source": "tools/build_webhook_vectors.py", "vectors": vectors}, indent=2,
                              ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(vectors)} vectors")


if __name__ == "__main__":
    main()
