"""The allow-list matches the public API spec, and path matching can't be steered elsewhere."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from echonova_proxy.routes import REST_ROUTES, STREAM_ROUTES, match_rest
from echonova_proxy.tokens import mint_stream_token, verify_stream_token

SPEC = Path(__file__).resolve().parents[3] / "spec"
needs_spec = pytest.mark.skipif(not (SPEC / "openapi.json").exists(), reason="run inside the SDK repo (needs spec/)")

SPEECH_PREFIXES = ("/v1/text-to-speech", "/v1/speech-to-text", "/v1/sound-cleaning")


@needs_spec
def test_rest_allow_list_is_exactly_the_speech_routes_of_the_spec() -> None:
    spec = json.loads((SPEC / "openapi.json").read_text(encoding="utf-8"))
    operations = {
        (method.upper(), path)
        for path, item in spec["paths"].items()
        for method in item
        if method in {"get", "post", "put", "patch", "delete"}
    }
    speech = {op for op in operations if op[1].startswith(SPEECH_PREFIXES)}
    assert set(REST_ROUTES) == speech
    assert len(REST_ROUTES) == 16
    # Everything else in the spec (the widget ticket route) stays server-side only.
    assert {path for _, path in operations - speech} == {"/v1/widgets/{publicId}/tickets"}


@needs_spec
def test_stream_allow_list_matches_the_asyncapi_channels_and_their_query() -> None:
    spec = json.loads((SPEC / "asyncapi.json").read_text(encoding="utf-8"))
    channels = {c["address"]: c for c in spec["channels"].values()}
    assert set(STREAM_ROUTES) == set(channels)
    for address, params in STREAM_ROUTES.items():
        query = channels[address].get("bindings", {}).get("ws", {}).get("query", {}).get("properties", {})
        assert set(params) == set(query)


@pytest.mark.parametrize(
    ("method", "path", "template"),
    [
        ("POST", "/v1/text-to-speech/sync", "/v1/text-to-speech/sync"),
        ("GET", "/v1/speech-to-text/jobs/65a1b2c3d4e5f60718293a4b/export", "/v1/speech-to-text/jobs/{jobId}/export"),
        ("DELETE", "/v1/sound-cleaning/jobs/abc", "/v1/sound-cleaning/jobs/{jobId}"),
    ],
)
def test_match(method: str, path: str, template: str) -> None:
    assert match_rest(method, path).template == template


@pytest.mark.parametrize(
    "path",
    [
        "/v1/widgets/w1/tickets",
        "/v1/text-to-speech/jobs/..%2F..%2Fwidgets%2Fw1%2Ftickets",
        "/v1/text-to-speech/jobs/%2e%2e",
        "/v1/text-to-speech/jobs/a/b",
        "/v1/text-to-speech/sync/",
        "/v1//text-to-speech/sync",
        "/v2/text-to-speech/sync",
        "/v1/text-to-speech/jobs/" + "a" * 129,
    ],
)
def test_unknown_or_crafted_paths_do_not_match(path: str) -> None:
    assert match_rest("GET", path).allowed == ()
    assert match_rest("POST", path).allowed == ()


def test_wrong_method_reports_the_allowed_ones() -> None:
    result = match_rest("PUT", "/v1/text-to-speech/jobs/abc")
    assert not result.found
    assert result.allowed == ("GET", "DELETE")


def test_stream_token_round_trip_and_shared_vector() -> None:
    # The Express proxy's tests check the same vector: both proxies accept each other's tokens.
    token = mint_stream_token("user-42", b"vector-secret", 60, now=1_700_000_000)
    assert token == "dXNlci00Mg.1700000060.Ezl3zLWTzcJfGhuqAcZyIvWhytL4KhcAwd-1sBKasUg"
    assert verify_stream_token(token, b"vector-secret", now=1_700_000_059) == "user-42"
    assert verify_stream_token(token, b"vector-secret", now=1_700_000_060) is None  # expired
    assert verify_stream_token(token, b"other-secret", now=1_700_000_000) is None  # forged
    assert verify_stream_token(token.replace("dXNlci00Mg", "dXNlci00Mw"), b"vector-secret", now=0) is None
    assert verify_stream_token("garbage", b"vector-secret") is None
