"""A scripted stand-in for the EchoNova stream endpoints, for tests.

It plays the message flows of both streams on localhost, plus edge-case
scenarios the SDK must tolerate (silent closes, unanswered cancels, errors
mid-stream), whether or not a given server ever produces them. It is not a
model of the real service. It runs its own event loop on a background thread,
so sync and async clients can both use it. Every knob is a plain attribute;
set it before the client connects.

Text to Speech scripting uses markers inside the synthesis text:
``[slow]`` many frames with pauses, ``[nostart]`` never answers,
``[upstream_pre]`` fails before audio the first time that text is seen,
``[upstream_pre_always]`` always does, ``[upstream_mid]`` fails after one
frame, ``[drop]`` kills the connection after one frame, ``[close:CODE]``
closes with CODE right away. A synthesis is charged when its ``start`` goes
out; one that stops after that reports the share of audio sent (at least 1
credit) as ``creditsConsumed`` on ``cancelled`` or ``error``.

Speech to Text sends ``jobId`` in ``session.started`` and, after
``session.ended``, ``session.saved`` with ``SttScript.saved_status`` (``auto``:
``saved`` when something was transcribed, else ``empty``; None leaves it out).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import math
import threading
import uuid
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, urlsplit

from websockets.asyncio.server import Server, ServerConnection, serve
from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Request, Response

TTS_FIELDS = {"type", "requestId", "text", "voiceId", "speed", "cfg", "numSteps", "tashkeel", "normalize"}
MAX_FRAME = 65_536


@dataclass
class Rejection:
    """A handshake answered with an HTTP error instead of 101."""

    status: int
    message: str
    retry_after: str | None = None
    json_body: bool = True


@dataclass
class Attempt:
    path: str
    headers: dict[str, str]
    rejected: int | None


@dataclass
class TtsScript:
    sample_rate: int = 22_050
    frames: int = 3
    frame_bytes: int = 960
    frame_interval: float = 0.0
    start_delay: float = 0.0
    idle_timeout: float | None = None
    max_duration: float | None = None
    answer_pings: bool = True


@dataclass
class SttAction:
    """Something to do to one STT connection once it has received ``after_bytes`` of audio."""

    kind: str  # "abort" (1006), "restart" (1001), "upstream" (error + session.ended + 1011), "abort_on_cut"
    after_bytes: int = 0  # for "abort_on_cut": the 1-based segment number whose end_segment triggers it


@dataclass
class SttScript:
    max_session_seconds: int = 1500
    started_delay: float = 0.0
    enforce_max_duration: float | None = None
    idle_timeout: float | None = None
    upstream_unreachable: bool = False
    auto_cut_seconds: float = 15.0
    segment_errors: set[int] = field(default_factory=set)  # 1-based segment numbers that fail
    fail_after_segments: tuple[int, str] | None = None  # (n, insufficient_balance|spending_limit|upstream_error)
    actions: deque[SttAction] = field(default_factory=deque)  # consumed, one per connection
    answer_pings: bool = True
    drain_delay: float = 0.0
    saved_status: str | None = "auto"  # session.saved status: auto, saved, empty, failed; None leaves it out
    saved_delay: float = 0.0  # pause between session.ended and session.saved


@dataclass
class TtsConnRecord:
    received: list[Any] = field(default_factory=list)  # parsed JSON frames (or bytes)
    charged: list[str] = field(default_factory=list)
    credits: dict[str, float] = field(default_factory=dict)  # final cost of a synthesis that stopped early
    close_code: int | None = None


@dataclass
class SttConnRecord:
    query: dict[str, str] = field(default_factory=dict)
    audio: bytearray = field(default_factory=bytearray)
    received: list[Any] = field(default_factory=list)
    session_id: str = ""
    job_id: str = ""
    close_code: int | None = None


class MockServer:
    def __init__(self) -> None:
        self.rejections: deque[Rejection] = deque()
        self.attempts: list[Attempt] = []
        self.tts = TtsScript()
        self.stt = SttScript()
        self.tts_conns: list[TtsConnRecord] = []
        self.stt_conns: list[SttConnRecord] = []
        self.seen_texts: set[str] = set()
        self.port = 0
        self._loop: asyncio.AbstractEventLoop | None = None
        self._server: Server | None = None
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._live: set[ServerConnection] = set()

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}"

    # --- Lifecycle ------------------------------------------------------------------------------------

    def start(self) -> MockServer:
        self._thread = threading.Thread(target=self._run, name="mock-ws-server", daemon=True)
        self._thread.start()
        if not self._ready.wait(5):
            raise RuntimeError("mock server did not start")
        return self

    def stop(self) -> None:
        loop = self._loop
        if loop is None:
            return
        loop.call_soon_threadsafe(self._shutdown)
        if self._thread is not None:
            self._thread.join(5)

    def _run(self) -> None:
        loop = asyncio.new_event_loop()
        self._loop = loop
        asyncio.set_event_loop(loop)
        loop.run_until_complete(self._serve())
        loop.close()

    async def _serve(self) -> None:
        async with serve(
            self._handler,
            "127.0.0.1",
            0,
            process_request=self._process_request,
            ping_interval=None,
            max_size=1 << 20,
            compression=None,
        ) as server:
            self._server = server
            self.port = next(iter(server.sockets)).getsockname()[1]
            self._stopped = asyncio.Event()
            self._ready.set()
            await self._stopped.wait()
            for conn in list(self._live):
                conn.transport.abort()

    def _shutdown(self) -> None:
        self._stopped.set()

    def call(self, function: Callable[[], Any]) -> None:
        """Run ``function`` on the server's loop (for tests that poke a live connection)."""
        assert self._loop is not None
        self._loop.call_soon_threadsafe(function)

    def abort_all(self) -> None:
        def abort() -> None:
            for conn in list(self._live):
                conn.transport.abort()

        self.call(abort)

    # --- Handshake ------------------------------------------------------------------------------------

    def _process_request(self, connection: ServerConnection, request: Request) -> Response | None:
        headers = {k: v for k, v in request.headers.raw_items()}
        rejection = self.rejections.popleft() if self.rejections else None
        self.attempts.append(Attempt(request.path, headers, rejection.status if rejection else None))
        if rejection is None:
            return None
        if rejection.json_body:
            body = json.dumps(
                {"data": None, "success": False, "statusCode": rejection.status, "errorMessage": rejection.message}
            ).encode()
            content_type = "application/json"
        else:
            body = rejection.message.encode()
            content_type = "text/html"
        response_headers = Headers()
        response_headers["Content-Type"] = content_type
        response_headers["Content-Length"] = str(len(body))
        response_headers["X-Request-Id"] = "req-" + uuid.uuid4().hex[:8]
        if rejection.retry_after is not None:
            response_headers["Retry-After"] = rejection.retry_after
        return Response(rejection.status, "Error", response_headers, body)

    async def _handler(self, ws: ServerConnection) -> None:
        self._live.add(ws)
        try:
            path = urlsplit(ws.request.path if ws.request else "/").path
            if path.endswith("/text-to-speech/stream"):
                await _TtsConn(self, ws).run()
            elif path.endswith("/speech-to-text/stream"):
                await _SttConn(self, ws).run()
            else:
                await ws.close(1008, "unknown path")
        finally:
            self._live.discard(ws)


async def _send_json(ws: ServerConnection, payload: dict[str, Any]) -> None:
    with contextlib.suppress(ConnectionClosed):
        await ws.send(json.dumps(payload))


class _Timer:
    """A restartable one-shot timer on the server loop."""

    def __init__(self, delay: float | None, callback: Callable[[], Any]) -> None:
        self.delay = delay
        self.callback = callback
        self.handle: asyncio.TimerHandle | None = None
        self.task: asyncio.Future[Any] | None = None
        self.reset()

    def reset(self) -> None:
        self.cancel()
        if self.delay is not None:
            self.handle = asyncio.get_running_loop().call_later(self.delay, self._fire)

    def _fire(self) -> None:
        self.task = asyncio.ensure_future(self.callback())

    def cancel(self) -> None:
        if self.handle is not None:
            self.handle.cancel()
            self.handle = None


class _TtsConn:
    def __init__(self, server: MockServer, ws: ServerConnection) -> None:
        self.server = server
        self.script = server.tts
        self.ws = ws
        self.record = TtsConnRecord()
        server.tts_conns.append(self.record)
        self.running: tuple[str, asyncio.Task[None]] | None = None
        self.progress: dict[str, tuple[int, int, int]] = {}  # rid -> (frames sent, frames planned, characters)

    async def run(self) -> None:
        idle = _Timer(self.script.idle_timeout, lambda: self._close(4008, "idle_timeout"))
        limit = _Timer(self.script.max_duration, lambda: self._close(4008, "max_duration"))
        try:
            async for message in self.ws:
                idle.reset()  # scenario: the idle timer counts frames from the client
                if isinstance(message, bytes):
                    self.record.received.append(message)
                    await _send_json(self.ws, {"type": "error", "code": "frame_too_large", "message": "binary frame"})
                    await self._close(1008, "frame_too_large")
                    return
                try:
                    frame = json.loads(message)
                    kind = frame["type"]
                except (ValueError, KeyError, TypeError):
                    await _send_json(self.ws, {"type": "error", "code": "invalid_message", "message": "bad frame"})
                    await self._close(1008, "invalid_message")
                    return
                self.record.received.append(frame)
                if kind == "ping":
                    if self.script.answer_pings:
                        await _send_json(self.ws, {"type": "pong"})
                elif kind == "cancel":
                    await self._cancel_running()
                elif kind == "synthesize":
                    await self._synthesize(frame)
                else:
                    await _send_json(self.ws, {"type": "error", "code": "invalid_message", "message": "unknown type"})
                    await self._close(1008, "invalid_message")
                    return
        except ConnectionClosed:
            pass
        finally:
            idle.cancel()
            limit.cancel()
            if self.running is not None:
                self.running[1].cancel()
            self.record.close_code = self.ws.close_code

    async def _close(self, code: int, reason: str) -> None:
        if self.running is not None:
            self.running[1].cancel()
            self.running = None
        with contextlib.suppress(ConnectionClosed):
            await self.ws.close(code, reason)

    def _cost(self, rid: str) -> int | None:
        """What a synthesis that stopped early finally costs: the share of audio sent, at least 1 credit."""
        if rid not in self.record.charged:
            return None  # cancelled before it was charged
        sent, planned, characters = self.progress[rid]
        cost = max(1, math.ceil(characters * sent / planned))
        self.record.credits[rid] = cost
        return cost

    async def _cancel_running(self) -> None:
        if self.running is None:
            return  # scenario: a cancel with nothing running gets no reply
        rid, task = self.running
        self.running = None
        task.cancel()
        payload: dict[str, Any] = {"type": "cancelled", "requestId": rid}
        cost = self._cost(rid)
        if cost is not None:
            payload["creditsConsumed"] = cost
        await _send_json(self.ws, payload)

    async def _synthesize(self, frame: dict[str, Any]) -> None:
        rid = frame.get("requestId") if isinstance(frame.get("requestId"), str) else str(uuid.uuid4())
        text = frame.get("text")
        problems = sorted(set(frame) - TTS_FIELDS)
        if not isinstance(text, str) or not 1 <= len(text.strip()) <= 500:
            problems.append("text must be 1 to 500 characters")
        if not isinstance(frame.get("voiceId"), str):
            problems.append("voiceId is required")
        if problems:  # scenario: a rejected request leaves the running one going
            await _send_json(
                self.ws,
                {"type": "error", "code": "validation_failed", "message": ", ".join(problems), "requestId": rid},
            )
            return
        assert isinstance(text, str)
        await self._cancel_running()
        if frame["voiceId"] == "missing":
            await _send_json(
                self.ws, {"type": "error", "code": "voice_not_found", "message": "Voice not found", "requestId": rid}
            )
            return
        if "[close:" in text:
            code = int(text.split("[close:", 1)[1].split("]", 1)[0])
            await self._close(code, "scripted")
            return
        task = asyncio.ensure_future(self._stream(rid, text))
        self.running = (rid, task)

    async def _stream(self, rid: str, text: str) -> None:
        script = self.script
        first_time = text not in self.server.seen_texts
        self.server.seen_texts.add(text)
        try:
            if "[nostart]" in text:
                await asyncio.sleep(3600)
            if ("[upstream_pre]" in text and first_time) or "[upstream_pre_always]" in text:
                await _send_json(  # scenario: fails before start, so nothing is charged
                    self.ws,
                    {
                        "type": "error",
                        "code": "upstream_error",
                        "message": "could not synthesize this text",
                        "requestId": rid,
                    },
                )
                self._finished(rid)
                return
            if script.start_delay:
                await asyncio.sleep(script.start_delay)
            slow = "[slow]" in text
            frames = 40 if slow else script.frames
            self.record.charged.append(rid)  # charged per character when it starts
            self.progress[rid] = (0, frames, len(text.strip()))
            await _send_json(
                self.ws,
                {
                    "type": "start",
                    "requestId": rid,
                    "sampleRate": script.sample_rate,
                    "encoding": "pcm_s16le",
                    "channels": 1,
                },
            )
            for i in range(frames):
                with contextlib.suppress(ConnectionClosed):
                    await self.ws.send(bytes([i % 256]) * script.frame_bytes)
                self.progress[rid] = (i + 1, frames, len(text.strip()))
                if i == 0 and "[upstream_mid]" in text:
                    await _send_json(
                        self.ws,
                        {
                            "type": "error",
                            "code": "upstream_error",
                            "message": "stopped during this synthesis",
                            "requestId": rid,
                            "creditsConsumed": self._cost(rid),
                        },
                    )
                    self._finished(rid)
                    return
                if i == 0 and "[drop]" in text:
                    self.ws.transport.abort()
                    return
                interval = 0.05 if slow else script.frame_interval
                if interval:
                    await asyncio.sleep(interval)
            seconds = frames * script.frame_bytes / (script.sample_rate * 2)
            await _send_json(
                self.ws,
                {
                    "type": "done",
                    "requestId": rid,
                    "durationSeconds": seconds,
                    "characters": len(text.strip()),
                    "creditsConsumed": len(text.strip()),
                },
            )
            self._finished(rid)
        except asyncio.CancelledError:
            pass

    def _finished(self, rid: str) -> None:
        if self.running is not None and self.running[0] == rid:
            self.running = None


class _SttConn:
    def __init__(self, server: MockServer, ws: ServerConnection) -> None:
        self.server = server
        self.script = server.stt
        self.ws = ws
        self.record = SttConnRecord(session_id=uuid.uuid4().hex, job_id=uuid.uuid4().hex[:24])
        server.stt_conns.append(self.record)
        self.started_sent = False
        self.action = self.script.actions.popleft() if self.script.actions else None
        self.segment = bytearray()
        self.segments = 0
        self.cuts = 0
        self.total_seconds = 0.0
        self.credits = 0.0
        self.terminology_active = False
        self.done = False

    async def run(self) -> None:
        ws = self.ws
        query = parse_qs(urlsplit(ws.request.path if ws.request else "").query)
        self.record.query = {k: v[0] for k, v in query.items()}
        self.sample_rate = int(self.record.query.get("sample_rate", "16000"))
        if self.script.upstream_unreachable:
            await _send_json(ws, {"type": "error", "code": "upstream_error", "message": "speech service unavailable"})
            await self._end("upstream_error", 1011)
            return
        idle = _Timer(self.script.idle_timeout, self._idle)
        limit = _Timer(self.script.enforce_max_duration, self._max_duration)
        started = asyncio.ensure_future(self._started())
        try:
            async for message in ws:
                idle.reset()
                if self.done:
                    continue
                if isinstance(message, bytes):
                    await self._audio(message)
                    continue
                frame = json.loads(message)
                self.record.received.append(frame)
                kind = frame.get("type")
                if kind == "ping":
                    if self.script.answer_pings:
                        await _send_json(ws, {"type": "pong"})
                elif kind == "end_segment":
                    action = self.action
                    if action is not None and action.kind == "abort_on_cut" and self.cuts + 1 >= action.after_bytes:
                        self.done = True
                        ws.transport.abort()  # cut, but no result ever comes
                        continue
                    self.cuts += 1
                    await self._cut()
                elif kind == "terminology":
                    await self._terminology(frame.get("terminology"))
                elif kind == "stop":
                    if self.script.drain_delay:
                        await asyncio.sleep(self.script.drain_delay)
                    await self._cut()
                    await self._end("stopped", 1000)
                    return
                else:
                    await _send_json(ws, {"type": "error", "code": "invalid_message", "message": "unknown type"})
                    await ws.close(1008, "invalid_message")
                    return
        except ConnectionClosed:
            pass
        finally:
            started.cancel()
            idle.cancel()
            limit.cancel()
            self.record.close_code = ws.close_code

    async def _started(self) -> None:
        if self.script.started_delay:
            await asyncio.sleep(self.script.started_delay)
        await _send_json(
            self.ws,
            {
                "type": "session.started",
                "sessionId": self.record.session_id,
                "language": self.record.query.get("language", "ar"),
                "sampleRate": self.sample_rate,
                "maxSessionSeconds": self.script.max_session_seconds,
                "jobId": self.record.job_id,
            },
        )
        self.started_sent = True

    async def _audio(self, data: bytes) -> None:
        if len(data) > MAX_FRAME:
            await _send_json(self.ws, {"type": "error", "code": "frame_too_large", "message": "frame too large"})
            await self.ws.close(1008, "frame_too_large")
            return
        self.record.audio += data
        self.segment += data
        action = self.action
        if action is not None and action.kind != "abort_on_cut" and len(self.record.audio) >= action.after_bytes:
            self.action = None
            if action.kind == "abort":
                self.done = True
                self.ws.transport.abort()
                return
            if action.kind == "restart":
                self.done = True
                await self.ws.close(1001, "server_restarting")
                return
            if action.kind == "upstream":
                await _send_json(self.ws, {"type": "error", "code": "upstream_error", "message": "upstream failed"})
                await self._end("upstream_error", 1011)
                return
        if len(self.segment) >= self.script.auto_cut_seconds * self.sample_rate * 2:
            await self._cut()

    async def _cut(self) -> None:
        segment, self.segment = bytes(self.segment), bytearray()
        if len(segment) < 0.05 * self.sample_rate * 2:
            return  # scenario: too short for a transcript
        self.segments += 1
        seconds = len(segment) / (self.sample_rate * 2)
        if self.segments in self.script.segment_errors:
            await _send_json(self.ws, {"type": "error", "code": "upstream_error", "message": "segment failed"})
        else:
            credits = round(seconds * 200 / 60, 3)
            self.total_seconds += seconds
            self.credits += credits
            payload: dict[str, Any] = {
                "type": "transcript",
                "segmentId": uuid.uuid4().hex[:24],
                "text": f"segment {self.segments}",
                "language": self.record.query.get("language", "ar"),
                "durationSeconds": seconds,
                "creditsConsumed": credits,
                "isFinal": True,
            }
            if self.terminology_active:
                payload["terminology"] = {"raw": "x", "corrected": "x", "edits": [], "mapperStatus": "applied"}
            await _send_json(self.ws, payload)
        fail = self.script.fail_after_segments
        if fail is not None and self.segments >= fail[0]:
            code = {"insufficient_balance": 4002, "spending_limit": 4029, "upstream_error": 1011}[fail[1]]
            await _send_json(self.ws, {"type": "error", "code": fail[1], "message": fail[1].replace("_", " ")})
            await self._end(fail[1], code)

    async def _terminology(self, value: Any) -> None:
        if value is not None and not (isinstance(value, dict) and isinstance(value.get("keywords"), list)):
            await _send_json(
                self.ws, {"type": "error", "code": "validation_failed", "message": "keywords must be a list"}
            )
            return
        self.terminology_active = value is not None
        await _send_json(self.ws, {"type": "terminology.set", "active": self.terminology_active})

    async def _end(self, reason: str, code: int) -> None:
        self.done = True
        await _send_json(
            self.ws,
            {
                "type": "session.ended",
                "reason": reason,
                "totalSeconds": round(self.total_seconds, 3),
                "creditsConsumed": round(self.credits, 3),
            },
        )
        status = self.script.saved_status
        if status is not None and self.started_sent:
            if status == "auto":
                status = "saved" if self.total_seconds > 0 else "empty"
            if self.script.saved_delay:
                await asyncio.sleep(self.script.saved_delay)
            await _send_json(self.ws, {"type": "session.saved", "jobId": self.record.job_id, "status": status})
        with contextlib.suppress(ConnectionClosed):
            await self.ws.close(code, reason)

    async def _idle(self) -> None:
        await self._cut()
        await self._end("idle_timeout", 4008)

    async def _max_duration(self) -> None:
        self.segment = bytearray()  # scenario: the open segment gets no transcript
        await self._end("max_duration", 4008)
