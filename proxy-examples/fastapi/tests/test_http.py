"""REST relay: allow-list, key injection, header filtering, auth, quota, streaming, errors."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import tracemalloc
from collections.abc import AsyncIterator

import httpx
import pytest
from conftest import (
    API_KEY,
    ORIGIN,
    UPSTREAM_RID,
    USER_TOKEN,
    FakeUpstream,
    Harness,
    Recorded,
    Server,
    StartProxy,
    all_log_text,
    make_settings,
)
from fastapi import FastAPI
from starlette.requests import HTTPConnection

from echonova_proxy import ConfigError, InMemoryJobOwners, Settings, create_app
from echonova_proxy.log import quiet_libraries
from echonova_proxy.routes import REST_ROUTES

pytestmark = pytest.mark.anyio

MiB = 1024 * 1024


JOB_ID = "65a1b2c3d4e5f60718293a4b"


def concrete(path: str) -> str:
    return path.replace("{jobId}", JOB_ID)


def scoped(user: str, key: str) -> str:
    """The Idempotency-Key the proxy sends upstream for a user's key (the tests' secret is test-secret)."""
    return hmac.new(b"test-secret", f"{user}\0{key}".encode(), hashlib.sha256).hexdigest()


@pytest.mark.parametrize(("method", "path"), REST_ROUTES)
async def test_every_allowed_route_is_forwarded(harness: Harness, method: str, path: str) -> None:
    if "{jobId}" in path:
        await harness.jobs.record(path.split("/")[2], JOB_ID, "demo-user")
    response = await harness.client.request(method, harness.base + concrete(path) + "?limit=5")
    assert response.status_code == 200
    seen = harness.fake.requests[-1]
    assert (seen.method, seen.path, seen.query) == (method, concrete(path), "limit=5")


@pytest.mark.parametrize(
    "path",
    [
        "/v1/widgets/w1/tickets",
        "/v1/unknown",
        "/v2/text-to-speech/sync",
        "/v1/text-to-speech/jobs/..%2F..%2Fwidgets%2Fw1%2Ftickets",
        "/stream-token-x",
    ],
)
async def test_anything_else_is_404_and_never_reaches_upstream(harness: Harness, path: str) -> None:
    response = await harness.client.post(harness.base + path)
    assert response.status_code == 404
    assert response.json() == {"data": None, "success": False, "statusCode": 404, "errorMessage": "Route not found"}
    outside = await harness.client.get(harness.proxy.url + "/v1/text-to-speech/voices")  # outside the prefix
    assert outside.status_code == 404
    assert harness.fake.requests == []


async def test_wrong_method_is_405_with_allow(harness: Harness) -> None:
    response = await harness.client.put(harness.base + "/v1/text-to-speech/jobs/abc")
    assert response.status_code == 405
    assert response.headers["allow"] == "GET, DELETE"
    assert response.json()["statusCode"] == 405
    stream = await harness.client.get(harness.base + "/v1/text-to-speech/stream")
    assert stream.status_code == 426
    assert harness.fake.requests == []


async def test_key_is_injected_and_app_credentials_are_stripped(harness: Harness) -> None:
    response = await harness.client.post(
        harness.base + "/v1/text-to-speech/sync",
        json={"text": "hello", "voiceId": "v1"},
        headers={
            "cookie": "session=abc; other=1",
            "x-forwarded-for": "10.0.0.1",
            "proxy-authorization": "Basic Zm9vOmJhcg==",
            "connection": "keep-alive, x-custom-hop",
            "x-custom-hop": "1",
            "te": "trailers",
            "x-api-key": "ek_REDACTED_from_the_app",
            "x-request-id": "app-req-7",
            "user-agent": "echonova-python/0.1.0",
            "idempotency-key": "4b6f2c1e-1d2a-4e7b-9a3c-2f1e0d9c8b7a",
        },
    )
    assert response.status_code == 200
    seen = harness.fake.requests[-1]
    assert seen.headers["idempotency-key"] == scoped("demo-user", "4b6f2c1e-1d2a-4e7b-9a3c-2f1e0d9c8b7a")
    assert [v for k, v in seen.raw_headers if k == "authorization"] == [f"Bearer {API_KEY}"]
    for name in ("cookie", "x-forwarded-for", "proxy-authorization", "x-custom-hop", "te", "x-api-key"):
        assert name not in seen.headers, name
    assert seen.headers["content-type"] == "application/json"
    assert seen.headers["x-request-id"] == "app-req-7"
    assert seen.headers["user-agent"].startswith("echonova-python/0.1.0 echonova-proxy/")
    assert seen.headers["accept-encoding"] == "identity"
    # The key never comes back.
    assert API_KEY not in response.text
    assert all(API_KEY not in value for value in response.headers.values())


async def test_only_safe_response_headers_come_back(harness: Harness) -> None:
    response = await harness.client.get(harness.base + "/v1/text-to-speech/voices")
    headers = response.headers
    assert headers["content-type"] == "application/json; charset=utf-8"
    assert headers["x-request-id"] == UPSTREAM_RID
    assert (headers["x-ratelimit-limit"], headers["x-ratelimit-remaining"], headers["x-ratelimit-reset"]) == (
        "100",
        "99",
        "60",
    )
    assert headers["cache-control"] == "no-store"
    for name in ("set-cookie", "x-powered-by", "access-control-allow-origin", "x-internal-trace"):
        assert name not in headers, name
    assert headers.get("server") != "fake-upstream"


async def test_status_body_and_retry_after_are_preserved(harness: Harness) -> None:
    async def respond(scope, receive, send, recorded: Recorded) -> None:  # type: ignore[no-untyped-def]
        body = {"data": None, "success": False, "statusCode": 429, "errorMessage": "ThrottlerException"}
        await send(
            {
                "type": "http.response.start",
                "status": 429,
                "headers": [(b"content-type", b"application/json"), (b"retry-after", b"17")],
            }
        )
        await send({"type": "http.response.body", "body": json.dumps(body).encode()})

    harness.fake.respond = respond
    response = await harness.client.post(harness.base + "/v1/speech-to-text", content=b"x")
    assert response.status_code == 429
    assert response.headers["retry-after"] == "17"
    assert response.json()["errorMessage"] == "ThrottlerException"
    assert response.headers["x-request-id"]  # the proxy's own id when upstream sends none


async def test_export_download_keeps_content_disposition(harness: Harness) -> None:
    async def respond(scope, receive, send, recorded: Recorded) -> None:  # type: ignore[no-untyped-def]
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [
                    (b"content-type", b"application/x-subrip"),
                    (b"content-disposition", b"attachment; filename*=UTF-8''call.srt"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": b"1\n00:00:00,000 --> 00:00:01,000\nhi\n"})

    harness.fake.respond = respond
    await harness.jobs.record("speech-to-text", "abc", "demo-user")
    response = await harness.client.get(harness.base + "/v1/speech-to-text/jobs/abc/export?format=srt")
    assert response.headers["content-disposition"] == "attachment; filename*=UTF-8''call.srt"
    assert response.text.startswith("1\n")


async def test_user_must_authenticate(harness: Harness) -> None:
    url = harness.base + "/v1/text-to-speech/voices"
    async with httpx.AsyncClient() as anonymous:
        missing = await anonymous.get(url)
        wrong = await anonymous.get(url, headers={"authorization": "Bearer wrong-token"})
        api_key_as_user = await anonymous.get(url, headers={"authorization": f"Bearer {API_KEY}"})
        query = await anonymous.get(url, params={"access_token": USER_TOKEN})  # REST never takes URL tokens
        cookie = await anonymous.get(url, headers={"cookie": f"session={USER_TOKEN}"})
    for response in (missing, wrong, api_key_as_user, query):
        assert response.status_code == 401
        assert response.json() == {"data": None, "success": False, "statusCode": 401, "errorMessage": "Unauthorized"}
    assert cookie.status_code == 200
    assert len(harness.fake.requests) == 1


async def test_custom_authenticate_hook_and_quota(start_proxy: StartProxy) -> None:
    async def authenticate(conn: HTTPConnection) -> str | None:
        return {"Bearer alice-token": "alice", "Bearer bob-token": "bob"}.get(conn.headers.get("authorization", ""))

    async with start_proxy(authenticate=authenticate, requests_per_minute=3) as h:
        url = h.base + "/v1/text-to-speech/voices"
        alice = {"authorization": "Bearer alice-token"}
        statuses = [(await h.client.get(url, headers=alice)).status_code for _ in range(4)]
        assert statuses == [200, 200, 200, 429]
        limited = await h.client.get(url, headers=alice)
        assert limited.json()["errorMessage"] == "Too many requests"
        assert 1 <= int(limited.headers["retry-after"]) <= 60
        # Quotas are per user.
        assert (await h.client.get(url, headers={"authorization": "Bearer bob-token"})).status_code == 200
        assert (await h.client.get(url)).status_code == 401  # the demo token means nothing to this hook
        assert len(h.fake.requests) == 4


ALICE = {"authorization": "Bearer alice-token"}
BOB = {"authorization": "Bearer bob-token"}


async def alice_or_bob(conn: HTTPConnection) -> str | None:
    return {"Bearer alice-token": "alice", "Bearer bob-token": "bob"}.get(conn.headers.get("authorization", ""))


def creates(h: Harness, data: dict[str, object], status: int = 200) -> None:
    """Make the fake API answer the next calls with a job-creating body."""

    async def respond(scope, receive, send, recorded: Recorded) -> None:  # type: ignore[no-untyped-def]
        body = {"data": data, "success": True, "statusCode": status, "errorMessage": None}
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [(b"content-type", b"application/json; charset=utf-8")],
            }
        )
        await send({"type": "http.response.body", "body": json.dumps(body).encode()})

    h.fake.respond = respond


async def test_another_users_job_is_404_for_get_delete_and_export(start_proxy: StartProxy) -> None:
    async with start_proxy(authenticate=alice_or_bob) as h:
        creates(h, {"jobId": "stt-alice-1", "status": "processing"})
        assert (await h.client.post(h.base + "/v1/speech-to-text", headers=ALICE)).status_code == 200
        h.fake.respond = None
        before = len(h.fake.requests)
        for method, path in (
            ("GET", "/v1/speech-to-text/jobs/stt-alice-1"),
            ("DELETE", "/v1/speech-to-text/jobs/stt-alice-1"),
            ("GET", "/v1/speech-to-text/jobs/stt-alice-1/export"),
        ):
            response = await h.client.request(method, h.base + path, headers=BOB)
            assert response.status_code == 404, (method, path)
            # The API's own answer for an unknown job: Bob can't tell that the job exists.
            assert response.json() == {
                "data": None,
                "success": False,
                "statusCode": 404,
                "errorMessage": "STT Job not found",
            }
        assert len(h.fake.requests) == before  # never reached the API
        assert (await h.client.get(h.base + "/v1/speech-to-text/jobs/stt-alice-1", headers=ALICE)).status_code == 200
        export = await h.client.get(h.base + "/v1/speech-to-text/jobs/stt-alice-1/export", headers=ALICE)
        assert export.status_code == 200
        assert (await h.client.get(h.base + "/v1/speech-to-text/jobs/never-made", headers=ALICE)).status_code == 404
        assert len(h.fake.requests) == before + 2


async def test_every_job_creating_route_records_its_job(start_proxy: StartProxy) -> None:
    async with start_proxy(authenticate=alice_or_bob) as h:
        creates(h, {"jobId": "tts-sync-1", "status": "completed", "audioUrl": "https://storage.example.com/a.wav"})
        await h.client.post(h.base + "/v1/text-to-speech/sync", headers=ALICE)
        creates(
            h, {"jobId": "stt-sync-1", "status": "processing", "resultUrl": "/v1/speech-to-text/jobs/stt-sync-1"}, 202
        )
        await h.client.post(h.base + "/v1/speech-to-text/sync", headers=ALICE)
        creates(h, {"id": "clean-1", "status": "completed"})
        await h.client.post(h.base + "/v1/sound-cleaning", headers=ALICE)
        creates(h, {"jobId": "tts-async-1", "status": "processing"})
        await h.client.post(h.base + "/v1/text-to-speech", headers=ALICE)
        creates(h, {"jobId": "tts-refused-1"}, 402)
        await h.client.post(h.base + "/v1/text-to-speech", headers=ALICE)
        h.fake.respond = None
        for product, job_id in (
            ("text-to-speech", "tts-sync-1"),
            ("speech-to-text", "stt-sync-1"),
            ("sound-cleaning", "clean-1"),
            ("text-to-speech", "tts-async-1"),
        ):
            url = f"{h.base}/v1/{product}/jobs/{job_id}"
            assert (await h.client.get(url, headers=ALICE)).status_code == 200, job_id
            assert (await h.client.get(url, headers=BOB)).status_code == 404, job_id
        assert (await h.client.get(h.base + "/v1/text-to-speech/jobs/tts-refused-1", headers=ALICE)).status_code == 404
        # Jobs are per product: a TTS job id doesn't open the STT routes.
        assert (await h.client.get(h.base + "/v1/speech-to-text/jobs/tts-sync-1", headers=ALICE)).status_code == 404


async def test_a_deleted_job_is_forgotten(start_proxy: StartProxy) -> None:
    async with start_proxy(authenticate=alice_or_bob) as h:
        await h.jobs.record("sound-cleaning", "clean-del-1", "alice")
        response = await h.client.delete(h.base + "/v1/sound-cleaning/jobs/clean-del-1", headers=ALICE)
        assert response.status_code == 200
        assert not await h.jobs.is_owner("sound-cleaning", "clean-del-1", "alice")


@pytest.mark.parametrize("product", ["text-to-speech", "speech-to-text", "sound-cleaning"])
async def test_the_job_lists_are_not_forwarded(harness: Harness, product: str) -> None:
    response = await harness.client.get(f"{harness.base}/v1/{product}/jobs?limit=5")
    assert response.status_code == 404
    assert response.json()["errorMessage"] == "Route not found"
    assert harness.fake.requests == []


async def test_idempotency_keys_are_scoped_to_the_user_and_stable(start_proxy: StartProxy) -> None:
    idempotency_key = "4b6f2c1e-1d2a-4e7b-9a3c-2f1e0d9c8b7a"
    async with start_proxy(authenticate=alice_or_bob) as h:

        async def forwarded(who: dict[str, str], value: str) -> str:
            await h.client.post(h.base + "/v1/text-to-speech/sync", json={}, headers={**who, "idempotency-key": value})
            return h.fake.requests[-1].headers["idempotency-key"]

        first = await forwarded(ALICE, idempotency_key)
        assert await forwarded(ALICE, idempotency_key) == first  # a retry gets the first result
        assert await forwarded(BOB, idempotency_key) != first  # Bob can't replay Alice's key
        assert await forwarded(ALICE, idempotency_key + "x") != first
        assert first == scoped("alice", idempotency_key)
        assert len(first) == 64
        assert set(first) <= set("0123456789abcdef")  # a key the API accepts
        # A key the API would refuse is left as it is, so the app gets the API's own 400.
        assert await forwarded(ALICE, "has space") == "has space"
        assert await forwarded(ALICE, "k" * 201) == "k" * 201


async def test_the_in_memory_job_store_is_bounded_and_fails_closed() -> None:
    jobs = InMemoryJobOwners(max_jobs=2)
    await jobs.record("text-to-speech", "a", "alice")
    await jobs.record("text-to-speech", "b", "alice")
    await jobs.record("text-to-speech", "a", "bob")  # the same job for the same input: both own it
    await jobs.record("text-to-speech", "c", "alice")  # evicts b, the oldest
    assert len(jobs.owners) == 2
    assert not await jobs.is_owner("text-to-speech", "b", "alice")
    assert await jobs.is_owner("text-to-speech", "a", "alice")
    assert await jobs.is_owner("text-to-speech", "a", "bob")
    assert not await jobs.is_owner("speech-to-text", "a", "alice")


async def chunks(total: int, size: int = 64 * 1024, gate: asyncio.Event | None = None) -> AsyncIterator[bytes]:
    block = bytes(range(256)) * (size // 256)
    sent = 0
    while sent < total:
        piece = block[: min(size, total - sent)]
        yield piece
        sent += len(piece)
        if gate is not None and not gate.is_set():
            # The first chunk must reach the API before we send the second: nothing is buffered.
            await asyncio.wait_for(gate.wait(), timeout=10)


def expected_sha(total: int, size: int = 64 * 1024) -> str:
    block = bytes(range(256)) * (size // 256)
    digest = hashlib.sha256()
    sent = 0
    while sent < total:
        piece = block[: min(size, total - sent)]
        digest.update(piece)
        sent += len(piece)
    return digest.hexdigest()


async def test_a_failing_hook_is_a_plain_500(start_proxy: StartProxy) -> None:
    async def authenticate(conn: HTTPConnection) -> str | None:
        raise RuntimeError("session store down: secret-detail")

    async with start_proxy(authenticate=authenticate) as h:
        response = await h.client.get(h.base + "/v1/text-to-speech/voices")
    assert response.status_code == 500
    assert response.json()["errorMessage"] == "Internal server error"
    assert "secret-detail" not in response.text


async def test_upload_is_streamed_chunked_and_not_buffered(harness: Harness) -> None:
    total = 150 * MiB
    tracemalloc.start()
    try:
        tracemalloc.reset_peak()
        response = await harness.client.post(
            harness.base + "/v1/speech-to-text",
            content=chunks(total, gate=harness.fake.first_chunk),
            headers={"content-type": "multipart/form-data; boundary=x"},
            timeout=120,
        )
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert response.status_code == 200
    seen = harness.fake.requests[-1]
    assert seen.headers.get("transfer-encoding") == "chunked"
    assert "content-length" not in seen.headers
    assert seen.body_bytes == total
    assert seen.body_sha256 == expected_sha(total)
    assert seen.chunks > 100
    assert peak < 32 * MiB, f"peak traced memory {peak / MiB:.1f} MiB for a 150 MiB upload"


async def test_upload_with_content_length_keeps_it(harness: Harness) -> None:
    body = b"a" * (3 * MiB)
    response = await harness.client.post(harness.base + "/v1/sound-cleaning", content=body)
    assert response.status_code == 200
    seen = harness.fake.requests[-1]
    assert seen.headers["content-length"] == str(len(body))
    assert "transfer-encoding" not in seen.headers
    assert seen.body_bytes == len(body)


async def test_upload_cap(start_proxy: StartProxy) -> None:
    async with start_proxy(max_upload_bytes=MiB) as h:
        url = h.base + "/v1/speech-to-text/sync"
        declared = await h.client.post(url, content=b"a" * (MiB + 1))
        assert declared.status_code == 413
        assert h.fake.requests == []
        streamed = await h.client.post(url, content=chunks(2 * MiB))
        assert streamed.status_code == 413
        assert streamed.json()["errorMessage"] == "Request body too large"
        assert all(r.body_bytes <= 2 * MiB for r in h.fake.requests)


async def test_download_is_streamed_not_buffered(harness: Harness) -> None:
    total = 64 * MiB
    release = asyncio.Event()

    async def respond(scope, receive, send, recorded: Recorded) -> None:  # type: ignore[no-untyped-def]
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/plain")]})
        block = b"z" * (256 * 1024)
        await send({"type": "http.response.body", "body": block, "more_body": True})
        await asyncio.wait_for(release.wait(), timeout=10)  # held until the app has the first bytes
        for _ in range(total // len(block) - 1):
            await send({"type": "http.response.body", "body": block, "more_body": True})
        await send({"type": "http.response.body", "body": b""})

    harness.fake.respond = respond
    await harness.jobs.record("speech-to-text", "abc", "demo-user")
    received = 0
    tracemalloc.start()
    try:
        tracemalloc.reset_peak()
        async with harness.client.stream("GET", harness.base + "/v1/speech-to-text/jobs/abc/export") as response:
            assert response.status_code == 200
            assert response.headers.get("transfer-encoding") == "chunked"
            async for chunk in response.aiter_raw():
                received += len(chunk)
                release.set()
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert received == total
    assert peak < 32 * MiB, f"peak traced memory {peak / MiB:.1f} MiB for a 64 MiB download"


async def test_upstream_unreachable_is_503_and_safe_to_retry(start_proxy: StartProxy) -> None:
    async with start_proxy(upstream_url="http://127.0.0.1:9") as h:
        response = await h.client.post(h.base + "/v1/text-to-speech/sync", json={"text": "x"})
    assert response.status_code == 503
    assert "temporarily unavailable" in response.json()["errorMessage"]


async def test_upstream_timeout_is_504(start_proxy: StartProxy) -> None:
    async with start_proxy(read_timeout=0.3) as h:

        async def respond(scope, receive, send, recorded: Recorded) -> None:  # type: ignore[no-untyped-def]
            await asyncio.sleep(2)

        h.fake.respond = respond
        response = await h.client.get(h.base + "/v1/text-to-speech/voices")
    assert response.status_code == 504


async def test_upstream_redirect_is_never_followed(harness: Harness) -> None:
    async def respond(scope, receive, send, recorded: Recorded) -> None:  # type: ignore[no-untyped-def]
        headers = [(b"location", b"https://elsewhere.example.com/collect")]
        await send({"type": "http.response.start", "status": 302, "headers": headers})
        await send({"type": "http.response.body", "body": b""})

    harness.fake.respond = respond
    response = await harness.client.post(harness.base + "/v1/text-to-speech/sync", json={})
    assert response.status_code == 502
    assert response.json()["errorMessage"] == "Bad gateway: unexpected redirect from the EchoNova API"
    assert "location" not in response.headers
    assert len(harness.fake.requests) == 1


async def test_upstream_cut_mid_body_fails_the_download(harness: Harness) -> None:
    async def respond(scope, receive, send, recorded: Recorded) -> None:  # type: ignore[no-untyped-def]
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-length", b"1000")]})
        await send({"type": "http.response.body", "body": b"x" * 10, "more_body": True})
        raise RuntimeError("upstream crashed")  # the fake server drops the connection

    harness.fake.respond = respond
    with pytest.raises(httpx.HTTPError):
        await harness.client.get(harness.base + "/v1/text-to-speech/voices")


async def test_cors_for_listed_origins_only(harness: Harness) -> None:
    url = harness.base + "/v1/text-to-speech/sync"
    preflight = await harness.client.options(
        url,
        headers={
            "origin": ORIGIN,
            "access-control-request-method": "POST",
            "access-control-request-headers": "authorization, content-type",
        },
    )
    assert preflight.status_code == 204
    assert preflight.headers["access-control-allow-origin"] == ORIGIN
    assert preflight.headers["access-control-allow-credentials"] == "true"
    assert "POST" in preflight.headers["access-control-allow-methods"]
    assert "Authorization" in preflight.headers["access-control-allow-headers"]
    assert "Idempotency-Key" in preflight.headers["access-control-allow-headers"]

    allowed = await harness.client.post(url, json={"text": "x"}, headers={"origin": ORIGIN})
    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == ORIGIN
    assert "X-Request-Id" in allowed.headers["access-control-expose-headers"]
    assert "Retry-After" in allowed.headers["access-control-expose-headers"]

    # A page on another site can't even send a request with your users' cookies.
    evil = await harness.client.post(url, json={"text": "x"}, headers={"origin": "https://evil.example.org"})
    assert evil.status_code == 403
    assert "access-control-allow-origin" not in evil.headers
    evil_preflight = await harness.client.options(
        url, headers={"origin": "https://evil.example.org", "access-control-request-method": "POST"}
    )
    assert evil_preflight.status_code == 403
    assert len(harness.fake.requests) == 1


async def test_healthz(harness: Harness) -> None:
    async with httpx.AsyncClient() as anonymous:
        response = await anonymous.get(harness.proxy.url + "/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_stream_token_endpoint(harness: Harness) -> None:
    response = await harness.client.post(harness.base + "/stream-token")
    assert response.status_code == 200
    assert response.json()["expiresIn"] == 60
    assert response.headers["cache-control"] == "no-store"
    async with httpx.AsyncClient() as anonymous:
        assert (await anonymous.post(harness.base + "/stream-token")).status_code == 401


async def test_logs_never_contain_secrets_or_bodies(harness: Harness, logs: pytest.LogCaptureFixture) -> None:
    quiet_libraries()  # what python -m echonova_proxy sets up
    secret_text = "my private sentence 12345"
    await harness.client.post(
        harness.base + "/v1/text-to-speech/sync?voice=private-query", json={"text": secret_text, "voiceId": "v"}
    )
    await harness.client.get(harness.base + "/v1/unknown")
    text = all_log_text(logs)
    assert '"event": "http"' in text
    assert '"route": "/v1/text-to-speech/sync"' in text
    for secret in (API_KEY, USER_TOKEN, secret_text, "private-query"):
        assert secret not in text


def test_config_refuses_unsafe_settings() -> None:
    with pytest.raises(ConfigError):
        Settings(api_key="  ")
    with pytest.raises(ConfigError):
        Settings(api_key=API_KEY, upstream_url="http://api.echonova.ai")  # the key would travel in clear text
    with pytest.raises(ConfigError):
        Settings(api_key=API_KEY, upstream_url="https://api.echonova.ai/v1")
    with pytest.raises(ConfigError):
        create_app(Settings(api_key=API_KEY))  # no auth hook and no demo token: fail closed
    assert API_KEY not in repr(Settings(api_key=API_KEY))
    env = {"ECHONOVA_API_KEY": API_KEY, "PROXY_ALLOWED_ORIGINS": "https://a.example.com/, https://b.example.com"}
    settings = Settings.from_env(env)
    assert settings.allowed_origins == {"https://a.example.com", "https://b.example.com"}
    assert settings.upstream_url == "https://api.echonova.ai"
    assert settings.upstream_ws_url == "wss://api.echonova.ai"


async def test_works_mounted_in_another_app() -> None:
    fake = FakeUpstream()
    async with Server(fake) as upstream:
        parent = FastAPI()

        @parent.get("/mine")
        async def mine() -> dict[str, str]:
            return {"app": "yours"}

        parent.mount("/", create_app(make_settings(upstream.url)))
        async with Server(parent) as server, httpx.AsyncClient(headers={"authorization": f"Bearer {USER_TOKEN}"}) as c:
            assert (await c.get(server.url + "/mine")).json() == {"app": "yours"}
            response = await c.get(server.url + "/echonova/v1/text-to-speech/voices")
            assert response.status_code == 200
            assert fake.requests[-1].path == "/v1/text-to-speech/voices"
