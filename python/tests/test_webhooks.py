from __future__ import annotations

import http.client
from collections.abc import Iterable, Iterator
from typing import Any

import httpx
import pytest

from _support import load_spec
from echonova import WebhookVerificationError, webhooks

VECTORS = load_spec("fixtures/webhooks/vectors.json")["vectors"]


@pytest.mark.parametrize("vector", VECTORS, ids=lambda v: v["name"])
def test_shared_vectors(vector: dict[str, Any]) -> None:
    body = vector["body"].encode("utf-8")
    kwargs = {"tolerance": vector["tolerance_seconds"], "now": vector["now"]}
    if vector["expect"] == "valid":
        event = webhooks.verify(body, vector["headers"], vector["secrets"], **kwargs)
        assert type(event).__name__ == vector["expect_type"]
    else:
        with pytest.raises(WebhookVerificationError) as caught:
            webhooks.verify(body, vector["headers"], vector["secrets"], **kwargs)
        assert caught.value.reason == vector["reason"]


def _vector(name: str) -> dict[str, Any]:
    return next(v for v in VECTORS if v["name"] == name)


def test_parsed_fields_and_dedupe_key() -> None:
    v = _vector("tts job.completed")
    event = webhooks.verify(v["body"].encode(), v["headers"], v["secrets"][0], now=v["now"])
    assert isinstance(event, webhooks.JobCompleted)
    assert event.service == "tts"
    assert event.text == "مرحبا بكم في إيكونوفا"
    assert event.duration_seconds == 3.4
    assert event.dedupe_key == "job.completed:000000000000000000000001"
    assert event.raw["audioUrl"].startswith("https://")


def test_spending_dedupe_key() -> None:
    v = _vector("spending.warning")
    event = webhooks.verify(v["body"].encode(), v["headers"], v["secrets"], now=v["now"])
    assert isinstance(event, webhooks.SpendingWarning)
    assert event.percentage_used == 80
    assert event.dedupe_key == "spending.warning:000000000000000000000a01:8000:10000"


def test_headers_are_case_insensitive_and_str_bodies_work() -> None:
    v = _vector("job.failed")
    lowered = {k.lower(): val for k, val in v["headers"].items()}
    event = webhooks.verify(v["body"], lowered, v["secrets"], now=v["now"])
    assert isinstance(event, webhooks.JobFailed)
    assert event.error == "Transcription failed. Try again."


class _WerkzeugStyleHeaders:
    """Like Flask's ``request.headers``: not a ``Mapping``; iterating yields pairs; ``get`` ignores case."""

    def __init__(self, pairs: list[tuple[str, str]]) -> None:
        self._pairs = pairs

    def get(self, key: str, default: str | None = None, type: Any = None) -> str | None:
        return next((v for k, v in self._pairs if k.lower() == key.lower()), default)

    def items(self, lower: bool = False) -> list[tuple[str, str]]:
        return [(k.lower() if lower else k, v) for k, v in self._pairs]

    def __iter__(self) -> Iterator[tuple[str, str]]:
        return iter(self._pairs)


class _ItemsOnlyHeaders:
    """A headers object whose ``get`` is case-sensitive: the lookup falls back to ``items()``."""

    def __init__(self, headers: dict[str, str]) -> None:
        self._headers = headers

    def get(self, key: str) -> str | None:
        return self._headers.get(key)

    def items(self) -> Iterable[tuple[str, str]]:
        return self._headers.items()


def test_framework_header_objects_that_are_not_mappings() -> None:
    v = _vector("job.failed")
    pairs = [(k.upper(), val) for k, val in v["headers"].items()]
    message = http.client.HTTPMessage()
    for k, val in v["headers"].items():
        message[k.lower()] = val
    candidates: list[webhooks.HeadersLike] = [
        _WerkzeugStyleHeaders(pairs),
        _ItemsOnlyHeaders(dict(pairs)),
        httpx.Headers(v["headers"]),
        message,  # http.server and urllib
    ]
    for headers in candidates:
        assert not isinstance(headers, dict)
        event = webhooks.verify(v["body"], headers, v["secrets"], now=v["now"])
        assert isinstance(event, webhooks.JobFailed), type(headers).__name__


def test_missing_headers_on_a_header_object() -> None:
    v = _vector("job.failed")
    pairs = [(k, val) for k, val in v["headers"].items() if k.lower() != "x-webhook-signature"]
    with pytest.raises(WebhookVerificationError) as caught:
        webhooks.verify(v["body"], _WerkzeugStyleHeaders(pairs), v["secrets"], now=v["now"])
    assert caught.value.reason == "headers"


def test_non_ascii_digits_in_timestamp_are_rejected() -> None:
    v = _vector("job.failed")
    headers = {**v["headers"], "X-Webhook-Timestamp": "١٧٦٢٣٠٠٨٠٠"}
    with pytest.raises(WebhookVerificationError) as caught:
        webhooks.verify(v["body"], headers, v["secrets"], now=v["now"])
    assert caught.value.reason == "timestamp"


@pytest.mark.parametrize("secret", ["", [], [""]])
def test_empty_secret_is_a_programming_error(secret: Any) -> None:
    v = _vector("job.failed")
    with pytest.raises(ValueError, match="secret"):
        webhooks.verify(v["body"], v["headers"], secret, now=v["now"])


def test_non_ascii_signature_is_a_mismatch_not_a_crash() -> None:
    v = _vector("job.failed")
    headers = {**v["headers"], "X-Webhook-Signature": "é" * 64}
    with pytest.raises(WebhookVerificationError) as caught:
        webhooks.verify(v["body"], headers, v["secrets"], now=v["now"])
    assert caught.value.reason == "signature"


def test_non_finite_amounts_parse_as_none() -> None:
    import hashlib
    import hmac
    import json

    v = _vector("spending.exhausted")
    body = json.dumps({**json.loads(v["body"]), "creditsUsed": "inf", "creditLimit": "nan"})
    timestamp = v["headers"]["X-Webhook-Timestamp"]
    signature = hmac.new(v["secrets"][0].encode(), f"{timestamp}.{body}".encode(), hashlib.sha256).hexdigest()
    headers = {**v["headers"], "X-Webhook-Signature": signature}
    event = webhooks.verify(body, headers, v["secrets"], now=v["now"])
    assert isinstance(event, webhooks.SpendingExhausted)
    assert (event.credits_used, event.credit_limit) == (None, None)
    assert event.dedupe_key.endswith(":-:-")


def test_nan_now_is_rejected() -> None:
    v = _vector("job.failed")
    with pytest.raises(ValueError, match="finite"):
        webhooks.verify(v["body"], v["headers"], v["secrets"], now=float("nan"))
