"""Plays one recorded stream transcript (spec/fixtures/ws/*.jsonl) back to the SDK.

The server side of the recording is replayed as recorded: its frames go out in
the recorded order. Before each frame the recorded client sent, the server waits
until the SDK sends the same frame. Audio is compared by total size, because the
SDK re-frames PCM. Binary frames were recorded as sizes only, so they are
replayed as zero-filled PCM of that size. The recorded request IDs (r1, r2, ...)
are mapped to the IDs the SDK generates, in the order its synthesize frames
arrive.

Every client frame is kept in ``received``. A frame the script doesn't expect is
a problem, unless its JSON type is in ``Script.tolerated``. Those frames are
kept in ``extras``. A problem aborts the connection, so the SDK fails fast
instead of waiting.
"""

from __future__ import annotations

import asyncio
import json
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from websockets.asyncio.server import ServerConnection, serve
from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Request, Response


@dataclass
class Step:
    """``send_json``/``send_text``/``send_binary`` (size), ``close`` ((code, reason)), ``abort`` (when
    the test triggers it), ``expect_json``/``expect_text``, ``expect_audio`` (total bytes) or ``expect_close``."""

    action: str
    value: Any = None


@dataclass
class Script:
    path: str  # the recorded connect path, with its query
    authorization: str  # "set" or "none"
    rejection: dict[str, Any] | None  # the recorded handshake_rejected, if the handshake failed
    steps: list[Step]
    tolerated: frozenset[str] = frozenset()  # JSON types read past when they don't match the step


@dataclass
class Frame:
    kind: str  # "json", "text" or "binary"
    value: Any  # the parsed JSON, the text, or the size of a binary frame

    @property
    def type(self) -> Any:
        """The ``type`` of a JSON object frame (None for anything else)."""
        return self.value.get("type") if self.kind == "json" and isinstance(self.value, dict) else None

    def describe(self) -> str:
        return f"{self.kind} {json.dumps(self.value, ensure_ascii=False)[:200]}"


class _Stop(Exception):
    """The replay can't go on (a problem was recorded)."""


def script_from_recording(
    events: list[dict[str, Any]],
    *,
    unsent: frozenset[str] = frozenset(),
    started_first: bool = False,
    tolerated: frozenset[str] = frozenset(),
) -> Script:
    """Build the server's script from a recording.

    ``unsent`` names recorded client frames the SDK never sends (``json:<type>``, ``text`` or
    ``binary``): the server doesn't wait for them. ``started_first`` plays ``session.started``
    right after the handshake, before anything the client sends.
    """
    events = list(events)
    if started_first:
        started = next(e for e in events if e["kind"] == "json" and e["data"].get("type") == "session.started")
        events.remove(started)
        events.insert(next(i for i, e in enumerate(events) if e["kind"] == "open") + 1, started)
    path, authorization, rejection = "", "", None
    steps: list[Step] = []
    client_closed = False
    for event in events:
        direction, kind, data = event["dir"], event["kind"], event["data"]
        if kind == "connect":
            path, authorization = data["path"], data["authorization"]
        elif kind == "handshake_rejected":
            rejection = data
        elif kind == "open":
            continue
        elif direction == "in":
            if kind == "json":
                steps.append(Step("send_json", data))
            elif kind == "text":
                steps.append(Step("send_text", data["text"]))
            elif kind == "binary":
                steps.append(Step("send_binary", data["bytes"]))
            elif kind == "close" and data["code"] != 1006 and not client_closed:
                steps.append(Step("close", (data["code"], data["reason"])))
            # A 1006 is the dropped connection itself; a close after the client's is the reply to it.
        elif kind == "binary":
            if "binary" in unsent:
                continue
            if steps and steps[-1].action == "expect_audio":
                steps[-1].value += data["bytes"]
            else:
                steps.append(Step("expect_audio", data["bytes"]))
        elif kind == "json":
            if f"json:{data.get('type')}" not in unsent:
                steps.append(Step("expect_json", data))
        elif kind == "text":
            if "text" not in unsent:
                steps.append(Step("expect_text", data["text"]))
        elif kind == "close":
            client_closed = True
            steps.append(Step("expect_close"))
        elif kind == "abort":
            steps.append(Step("abort"))
        else:
            raise ValueError(f"unknown recorded event {direction} {kind}")
    return Script(path, authorization, rejection, steps, tolerated)


class ReplayServer:
    def __init__(self, script: Script, *, step_timeout: float = 10.0) -> None:
        self.script = script
        self.step_timeout = step_timeout
        self.attempts: list[tuple[str, dict[str, str]]] = []  # (path, headers) of each handshake
        self.received: list[Frame] = []
        self.extras: list[Frame] = []
        self.problems: list[str] = []
        self.request_ids: dict[str, str] = {}  # recorded requestId -> the SDK's
        self.pings = 0  # ping frames received
        self.pongs_sent: list[int] = []  # for each pong sent, how many pings had arrived before it
        self.finished = threading.Event()  # the script ran to its end (or stopped on a problem)
        self.position = -1
        self.port = 0
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._abort = asyncio.Event()
        self._stopped = asyncio.Event()

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}"

    # --- Lifecycle ------------------------------------------------------------------------------------

    def start(self) -> ReplayServer:
        self._thread = threading.Thread(target=self._run, name="replay-ws-server", daemon=True)
        self._thread.start()
        if not self._ready.wait(5):
            raise RuntimeError("replay server did not start")
        return self

    def stop(self) -> None:
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self._stopped.set)
        if self._thread is not None:
            self._thread.join(5)

    def trigger_abort(self) -> None:
        """Let a pending ``abort`` step drop the connection (the recorded client dropped it here)."""
        assert self._loop is not None
        self._loop.call_soon_threadsafe(self._abort.set)

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
            self.port = next(iter(server.sockets)).getsockname()[1]
            self._ready.set()
            await self._stopped.wait()

    # --- Handshake ------------------------------------------------------------------------------------

    def _process_request(self, connection: ServerConnection, request: Request) -> Response | None:
        self.attempts.append((request.path, dict(request.headers.raw_items())))
        rejection = self.script.rejection
        if rejection is None:
            return None
        body = rejection.get("body")
        payload = json.dumps(body, ensure_ascii=False).encode() if isinstance(body, (dict, list)) else b""
        if isinstance(body, str):
            payload = body.encode()
        headers = Headers()
        for name, value in rejection["headers"].items():
            headers[name] = value
        headers["Content-Length"] = str(len(payload))
        self.finished.set()
        return Response(rejection["status"], "Rejected", headers, payload)

    # --- Playback -------------------------------------------------------------------------------------

    async def _handler(self, ws: ServerConnection) -> None:
        try:
            for index, step in enumerate(self.script.steps):
                self.position = index
                await self._play(ws, step)
        except _Stop:
            ws.transport.abort()
        except ConnectionClosed as exc:
            self.problems.append(f"the connection closed at step {self.position} {self._step(self.position)}: {exc}")
        finally:
            self.finished.set()

    def _step(self, index: int) -> str:
        step = self.script.steps[index]
        return f"{step.action} {json.dumps(step.value, ensure_ascii=False)[:200]}"

    def _fail(self, problem: str) -> _Stop:
        self.problems.append(f"step {self.position} ({self._step(self.position)}): {problem}")
        return _Stop()

    async def _play(self, ws: ServerConnection, step: Step) -> None:
        action, value = step.action, step.value
        if action == "send_json":
            if value.get("type") == "pong":
                self.pongs_sent.append(self.pings)
            await ws.send(json.dumps(self._map_ids(value), ensure_ascii=False))
        elif action == "send_text":
            await ws.send(value)
        elif action == "send_binary":
            await ws.send(bytes(value))
        elif action == "close":
            await ws.close(*value)
        elif action == "abort":
            try:
                await asyncio.wait_for(self._abort.wait(), self.step_timeout)
            except TimeoutError:
                raise self._fail("the test never triggered the drop") from None
            ws.transport.abort()
        elif action == "expect_json":
            frame = await self._expect(ws, lambda f: f.kind == "json" and self._same(value, f.value))
            if value.get("type") == "synthesize":
                self.request_ids[value["requestId"]] = frame.value["requestId"]
        elif action == "expect_text":
            await self._expect(ws, lambda f: f.kind == "text" and f.value == value)
        elif action == "expect_audio":
            total = 0
            while total < value:
                total += (await self._expect(ws, lambda f: f.kind == "binary")).value
            if total != value:
                raise self._fail(f"the audio came to {total} bytes")
        elif action == "expect_close":
            while True:
                try:
                    message = await asyncio.wait_for(ws.recv(), self.step_timeout)
                except ConnectionClosed:
                    return
                except TimeoutError:
                    raise self._fail("the client never closed") from None
                self._unexpected(self._keep(message), "the close")
        else:  # pragma: no cover
            raise ValueError(action)

    async def _expect(self, ws: ServerConnection, accept: Callable[[Frame], bool]) -> Frame:
        while True:
            try:
                message = await asyncio.wait_for(ws.recv(), self.step_timeout)
            except TimeoutError:
                raise self._fail("the client never sent it") from None
            frame = self._keep(message)
            if accept(frame):
                return frame
            self._unexpected(frame, "this step")

    def _keep(self, message: str | bytes) -> Frame:
        if isinstance(message, bytes):
            frame = Frame("binary", len(message))
        else:
            try:
                frame = Frame("json", json.loads(message))
            except ValueError:
                frame = Frame("text", message)
            if frame.type == "ping":
                self.pings += 1
        self.received.append(frame)
        return frame

    def _unexpected(self, frame: Frame, waiting_for: str) -> None:
        if frame.type in self.script.tolerated:
            self.extras.append(frame)
            return
        raise self._fail(f"got {frame.describe()} while waiting for {waiting_for}")

    def _same(self, recorded: dict[str, Any], sent: Any) -> bool:
        if not isinstance(sent, dict):
            return False
        if recorded.get("type") == "synthesize":  # the SDK generates its own requestId
            rest = {k: v for k, v in sent.items() if k != "requestId"}
            return isinstance(sent.get("requestId"), str) and rest == {
                k: v for k, v in recorded.items() if k != "requestId"
            }
        return sent == recorded

    def _map_ids(self, payload: dict[str, Any]) -> dict[str, Any]:
        rid = payload.get("requestId")
        if rid is None:
            return payload
        if rid not in self.request_ids:
            raise self._fail(f"the recording answers {rid}, which the SDK never sent")
        return {**payload, "requestId": self.request_ids[rid]}
