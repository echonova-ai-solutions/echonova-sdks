"""Agent sessions: a start is never sent twice, and the room token stays out of logs, reprs and errors."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any

import httpx
import pytest

from _support import FakeTime, Recorder, fail, make_async_client, make_client, ok
from echonova import (
    APIConnectionError,
    APITimeoutError,
    ConcurrencyLimitError,
    InsufficientBalanceError,
    InvalidRequestError,
    NotFoundError,
    ProtocolError,
    ServerError,
    types,
)

AGENT_ID = "6650a1b2c3d4e5f6a7b8c9d0"
SESSION_ID = "6651a1b2c3d4e5f6a7b8c9d0"
TOKEN = "room-token-never-log-this"
SESSION = {
    "id": SESSION_ID,
    "agentId": AGENT_ID,
    "channel": "voice",
    "status": "active",
    "startedAt": "2026-11-07T10:00:00.000Z",
    "endedAt": None,
}
STARTED = {**SESSION, "token": TOKEN, "wsUrl": "wss://rooms.echonova.ai", "greeting": None}


def sequence(*steps: Any) -> Recorder:
    """Answer each request with the next step: a response, or an httpx exception class to raise."""
    pending = list(steps)

    def handler(request: httpx.Request) -> httpx.Response:
        step = pending.pop(0) if pending else ok(STARTED)
        if isinstance(step, httpx.Response):
            return step
        raise step(f"simulated {step.__name__}", request=request)

    return Recorder(handler)


def start(client: Any) -> Any:
    return client.agents.sessions.start(AGENT_ID, channel="voice")


def test_start_returns_the_room_details() -> None:
    started = start(make_client(sequence()))
    assert isinstance(started, types.StartedAgentSession)
    assert (started.id, started.agent_id, started.status) == (SESSION_ID, AGENT_ID, "active")
    assert (started.token, started.ws_url) == (TOKEN, "wss://rooms.echonova.ai")
    assert started.request_id == "req-1"


# --- Retries: a retried start opens a second session ---------------------------------------------


@pytest.mark.parametrize("exc", [httpx.ReadTimeout, httpx.ReadError, httpx.RemoteProtocolError])
def test_start_is_never_resent_after_the_request_went_out(exc: type[Exception]) -> None:
    time = FakeTime()
    recorder = sequence(exc)
    with pytest.raises(APIConnectionError) as info:
        start(make_client(recorder, time=time, max_retries=5))
    assert len(recorder.requests) == 1
    assert info.value.may_have_executed is True
    assert info.value.sent_at == time.start
    assert "may have run" in str(info.value)


def test_start_is_never_resent_after_a_server_error() -> None:
    recorder = sequence(fail(500, "Something went wrong"), fail(504, "Database timed out"))
    with pytest.raises(ServerError) as info:
        start(make_client(recorder))
    assert len(recorder.requests) == 1
    assert info.value.may_have_executed is None  # unknown: it may have started a session


def test_start_is_never_resent_after_a_malformed_success() -> None:
    recorder = sequence(ok({**STARTED, "status": None}))
    with pytest.raises(ProtocolError) as info:
        start(make_client(recorder))
    assert len(recorder.requests) == 1
    assert info.value.may_have_executed is True
    assert info.value.raw_body is None  # the body holds the room token: it is not copied onto the error


@pytest.mark.parametrize("exc", [httpx.ConnectError, httpx.ConnectTimeout])
def test_start_is_retried_when_nothing_was_sent(exc: type[Exception]) -> None:
    recorder = sequence(exc)
    assert start(make_client(recorder)).token == TOKEN
    assert len(recorder.requests) == 2


def test_start_is_retried_when_live_sessions_are_unavailable() -> None:
    # Documented 503: no session is left open, so trying again is safe.
    recorder = sequence(fail(503, "Live sessions are not available right now. Try again later."))
    assert start(make_client(recorder)).token == TOKEN
    assert len(recorder.requests) == 2


@pytest.mark.parametrize(
    ("message", "status", "error"),
    [
        ("This agent has reached its call limit. Try again later.", 409, ConcurrencyLimitError),
        ("This agent has reached its chat limit. Try again later.", 409, ConcurrencyLimitError),
        ("Cannot start a session on an archived agent", 409, InvalidRequestError),
        ("Out of credits. Top up your plan to start a voice session.", 402, InsufficientBalanceError),
        ("Agent not found", 404, NotFoundError),
    ],
)
def test_start_refusals_are_not_retried(message: str, status: int, error: type[Exception]) -> None:
    recorder = sequence(fail(status, message))
    with pytest.raises(error) as info:
        start(make_client(recorder))
    assert len(recorder.requests) == 1
    assert info.value.error_message == message  # type: ignore[attr-defined]


def test_get_is_retried_after_a_read_timeout() -> None:
    recorder = sequence(httpx.ReadTimeout, ok({**SESSION, "status": "ended", "endedAt": "2026-11-07T10:05:00Z"}))
    session = make_client(recorder).agents.sessions.get(AGENT_ID, SESSION_ID)
    assert session.status == "ended"
    assert len(recorder.requests) == 2


def test_end_is_a_post_and_is_not_resent_after_a_lost_response() -> None:
    recorder = sequence(httpx.ReadTimeout)
    with pytest.raises(APITimeoutError) as info:
        make_client(recorder).agents.sessions.end(AGENT_ID, SESSION_ID)
    assert len(recorder.requests) == 1
    assert info.value.may_have_executed is True  # ending again is safe: an ended session answers 200


def test_async_start_is_never_resent_after_the_request_went_out() -> None:
    recorder = sequence(httpx.ReadTimeout)
    with pytest.raises(APITimeoutError):
        asyncio.run(start(make_async_client(recorder, max_retries=5)))
    assert len(recorder.requests) == 1


# --- Timeouts and buckets -------------------------------------------------------------------------


@pytest.mark.parametrize(
    "call",
    [
        lambda c: c.agents.sessions.start(AGENT_ID),
        lambda c: c.agents.sessions.get(AGENT_ID, SESSION_ID),
        lambda c: c.agents.sessions.end(AGENT_ID, SESSION_ID),
    ],
)
def test_default_timeouts(call: Any) -> None:
    recorder = sequence()
    call(make_client(recorder))
    assert recorder.last.extensions["timeout"] == {"connect": 10, "read": 30, "write": 10, "pool": 10}


def test_each_operation_has_its_own_rate_limit_bucket() -> None:
    headers = {"X-RateLimit-Limit": "100", "X-RateLimit-Remaining": "7", "X-RateLimit-Reset": "30"}
    client = make_client(Recorder(lambda r: ok(STARTED, headers=headers)))
    client.agents.sessions.start(AGENT_ID)
    client.agents.sessions.end(AGENT_ID, SESSION_ID)
    assert {"agents.sessions.start", "agents.sessions.end"} <= set(client.rate_limits)
    assert "agents.sessions.get" not in client.rate_limits


def test_raw_response() -> None:
    client = make_client(sequence())
    raw = client.with_raw_response.agents.sessions.start(AGENT_ID)
    assert raw.status_code == 200
    assert TOKEN not in repr(raw)
    assert raw.parse().token == TOKEN
    assert client.with_raw_response.agents.sessions.end(AGENT_ID, SESSION_ID).parse().id == SESSION_ID

    async def run() -> str:
        async_client = make_async_client(sequence())
        raw = await async_client.with_raw_response.agents.sessions.get(AGENT_ID, SESSION_ID)
        return raw.parse().status

    assert asyncio.run(run()) == "active"


# --- The token stays secret -----------------------------------------------------------------------


def test_the_token_is_never_logged(caplog: pytest.LogCaptureFixture) -> None:
    recorder = sequence(httpx.ConnectError, fail(503, "Live sessions are not available right now. Try again later."))
    with caplog.at_level(logging.DEBUG, logger="echonova"):
        started = start(make_client(recorder))
        logging.getLogger("echonova").debug("started %r", started)
        with contextlib.suppress(ProtocolError):
            start(make_client(sequence(ok({**STARTED, "id": None}))))
    assert len(recorder.requests) == 3
    assert caplog.records
    assert TOKEN not in caplog.text
