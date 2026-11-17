"""Replay the stream traffic recorded from the live API (spec/fixtures/ws/) through the SDK's sessions.

A ReplayServer plays the server side of one recording. The test drives the SDK
through its public session API to produce the recorded client frames, in the
recorded order, and waits before each one until the SDK has taken in everything
the server sent before it. Then it checks what spec/fixtures/expected.json says
the caller must see. Each test runs on the async and the sync session.

Where the SDK can't send what the recorded client sent, ADAPTATIONS says how the
replay differs and why. An adaptation never changes an expectation.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import threading
import time
from collections import defaultdict
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qsl, urlsplit

import pytest
from replay_server import ReplayServer, Script, script_from_recording
from stream_adapters import Bridge, SttAdapter, SynthesisAdapter, TtsAdapter, open_stt, open_tts
from stream_helpers import options_for

from _support import SPEC_DIR, TEST_KEY, coverage_problems, fixture_expectations, load_mapping, recorded_fixtures
from echonova import APIStatusError, EchoNovaError, SessionEndedError
from echonova._streaming import (
    AsyncSynthesis,
    SessionEnded,
    SessionSaved,
    SessionSummary,
    StreamErrorEvent,
    StreamOptions,
    TerminologySet,
    Transcript,
)

NAMES = recorded_fixtures("ws")
EXPECTED = fixture_expectations("ws")
WAIT = 10.0
VOICE = "000000000000000000000001"  # for sessions whose recording never names a voice
EXPECTATION_KEYS = {
    "requests",
    "session_error",
    "handshake_error",
    "pong",
    "transcripts",
    "ended",
    "saved",
    "events",
    "note",
}
# synthesize() keyword arguments, by wire name: the same options as text_to_speech.generate.
SYNTHESIS_OPTIONS = {
    p["api"]: p["python"]
    for p in load_mapping()["operations"]["V1TtsController_generateSync"]["params"]
    if p["in"] == "json" and p["api"] != "text"
}
STT_EVENTS: dict[str, type] = {
    "transcript": Transcript,
    "terminology.set": TerminologySet,
    "session.ended": SessionEnded,
    "session.saved": SessionSaved,
    "error": StreamErrorEvent,
}


@dataclass(frozen=True)
class Adaptation:
    """How a replay differs from the recorded client."""

    unsent: frozenset[str] = frozenset()  # recorded client frames the SDK never sends: "json:<type>", "text", "binary"
    extra: tuple[dict[str, Any], ...] = ()  # frames the SDK sends that the recorded client didn't
    started_first: bool = False  # play session.started before anything the client sends
    keepalive: bool = False  # the recorded ping comes from the SDK's keepalive


ADAPTATIONS = {
    # expected.json: the SDK sends no cancel when nothing is in flight.
    "tts/cancel_while_idle": Adaptation(unsent=frozenset({"json:cancel"})),
    # expected.json: the SDK never sends invalid JSON, nor binary on the TTS stream. Only the server side is replayed.
    "tts/invalid_json": Adaptation(unsent=frozenset({"text"})),
    "tts/binary_frame": Adaptation(unsent=frozenset({"binary"})),
    # send_audio() splits audio into frames of at most 64 KiB (3,200 bytes at 16 kHz), so the 70,000-byte
    # frame can't be sent. Only the server side is replayed.
    "stt/frame_too_large": Adaptation(unsent=frozenset({"binary"})),
    # expected.json: once r2 is rejected, the SDK cancels r1 itself; the recorded server never saw that cancel.
    "tts/invalid_while_running": Adaptation(extra=({"type": "cancel"},)),
    # connect() returns only once session.started has arrived, so audio can't go before it.
    "stt/audio_before_started": Adaptation(started_first=True),
    # The SDK's keepalive sends the ping, and only on a session connect() has returned.
    "stt/ping": Adaptation(started_first=True, keepalive=True),
    "tts/ping": Adaptation(keepalive=True),
}
STT_QUERY_DEFAULTS = {"encoding": "pcm_s16le"}  # sent on every connect: the documented default


def load(name: str) -> list[dict[str, Any]]:
    lines = (SPEC_DIR / "fixtures" / "ws" / f"{name}.jsonl").read_text(encoding="utf-8").splitlines()
    return [json.loads(line) for line in lines if line.strip()]


def wait_for(predicate: Callable[[], bool], what: str, timeout: float = WAIT) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {what}")
        time.sleep(0.005)


@pytest.fixture
def replay() -> Iterator[Callable[[Script], ReplayServer]]:
    servers: list[ReplayServer] = []

    def start(script: Script) -> ReplayServer:
        server = ReplayServer(script).start()
        servers.append(server)
        return server

    yield start
    for server in servers:
        server.stop()


# --- What the recording says happened --------------------------------------------------------------


@dataclass
class Progress:
    """The recording read up to some point: what the SDK must have taken in by then."""

    delivered: dict[str, int] = field(default_factory=lambda: defaultdict(int))  # audio bytes a synthesis delivers
    recorded: dict[str, int] = field(default_factory=lambda: defaultdict(int))  # audio bytes the server sent for it
    started: set[str] = field(default_factory=set)
    finished: dict[str, dict[str, Any]] = field(default_factory=dict)  # requestId -> the event that ended it
    synthesized: list[str] = field(default_factory=list)
    stopped: set[str] = field(default_factory=set)  # cancelled or replaced by the client: later audio is dropped
    active: str | None = None
    pongs: int = 0
    transcripts: int = 0

    def inbound(self, event: dict[str, Any]) -> None:
        kind, data = event["kind"], event["data"]
        if kind == "binary":
            if self.active is not None:
                self.recorded[self.active] += data["bytes"]
                if self.active not in self.stopped:
                    self.delivered[self.active] += data["bytes"]
            return
        if kind != "json":
            return
        rid, kind = data.get("requestId"), data.get("type")
        if kind == "start":
            self.active = rid
            self.started.add(rid)
        elif kind in ("done", "cancelled", "error") and rid is not None:
            self.finished[rid] = data
            if self.active == rid:
                self.active = None
        elif kind == "pong":
            self.pongs += 1
        elif kind == "transcript":
            self.transcripts += 1

    def client_stops_running(self) -> None:
        self.stopped |= {rid for rid in self.synthesized if rid not in self.finished}


def inbound_json(events: list[dict[str, Any]], kind: str) -> list[dict[str, Any]]:
    return [e["data"] for e in events if e["dir"] == "in" and e["kind"] == "json" and e["data"].get("type") == kind]


def check_handshake(server: ReplayServer, events: list[dict[str, Any]], adapt: Adaptation) -> None:
    """The SDK connected to the recorded path, with the recorded query and credentials."""
    connect = events[0]["data"]
    assert events[0]["kind"] == "connect"
    assert len(server.attempts) == 1  # a rejected handshake is not retried either
    path, headers = server.attempts[0]
    sent, recorded = urlsplit(path), urlsplit(connect["path"])
    assert sent.path == recorded.path
    expected_query = dict(parse_qsl(recorded.query))
    if recorded.path.endswith("/speech-to-text/stream"):
        expected_query = {**expected_query, **STT_QUERY_DEFAULTS}
    assert dict(parse_qsl(sent.query)) == expected_query
    authorization = {k.lower(): v for k, v in headers.items()}.get("authorization")
    assert authorization == (f"Bearer {TEST_KEY}" if connect["authorization"] == "set" else None)


def check_handshake_error(error: EchoNovaError | None, events: list[dict[str, Any]], expected: str) -> None:
    rejected = next(e["data"] for e in events if e["kind"] == "handshake_rejected")
    assert isinstance(error, APIStatusError), f"connect() raised {error!r}"
    assert type(error).__name__ == expected
    assert error.status_code == rejected["status"]
    assert error.error_message == rejected["body"]["errorMessage"]
    assert error.request_id == rejected["headers"]["x-request-id"]


def check_close_error(error: BaseException | None, events: list[dict[str, Any]], expected: str) -> None:
    """The session failed with the recorded error frame and close code."""
    frame = inbound_json(events, "error")[-1]
    close = next(e["data"] for e in events if e["dir"] == "in" and e["kind"] == "close")
    assert isinstance(error, APIStatusError), f"expected {expected}, got {error!r}"
    assert type(error).__name__ == expected
    assert (error.error_code, error.error_message) == (frame["code"], frame["message"])
    assert error.close_code == close["code"]


def options(server: ReplayServer, events: list[dict[str, Any]], adapt: Adaptation) -> StreamOptions:
    key = events[0]["data"]["authorization"] == "set"
    return options_for(
        server,  # type: ignore[arg-type]  # only .url is used
        headers=(lambda: {"Authorization": f"Bearer {TEST_KEY}"}) if key else (lambda: {}),
        keepalive=0.05 if adapt.keepalive else None,
    )


def answered_ping(server: ReplayServer) -> bool:
    """The SDK sent another ping after the pong: it only does once a pong has answered the last one."""
    return bool(server.pongs_sent) and server.pings > server.pongs_sent[-1]


# --- Text to Speech --------------------------------------------------------------------------------


def read_chunk(synth: SynthesisAdapter) -> bytes | None:
    handle = synth.handle
    if isinstance(handle, AsyncSynthesis):
        assert synth.bridge is not None

        async def one() -> bytes | None:
            audio = handle.__aiter__()
            try:
                return await audio.__anext__()
            except StopAsyncIteration:
                return None
            finally:
                await audio.aclose()  # type: ignore[attr-defined]

        return asyncio.run_coroutine_threadsafe(one(), synth.bridge.loop).result(WAIT)
    return next(iter(handle), None)


@dataclass
class TtsRun:
    error: EchoNovaError | None = None  # what connect() raised
    tts: TtsAdapter | None = None
    synths: dict[str, SynthesisAdapter] = field(default_factory=dict)  # by recorded requestId
    read: dict[str, int] = field(default_factory=lambda: defaultdict(int))  # audio bytes read
    progress: Progress = field(default_factory=Progress)


def tts_catch_up(run: TtsRun, server: ReplayServer) -> None:
    """Wait until the SDK has taken in everything the recording received so far."""
    progress = run.progress
    for rid, total in progress.delivered.items():
        while run.read[rid] < total:
            chunk = read_chunk(run.synths[rid])
            assert chunk is not None, f"{rid} ended after {run.read[rid]} of {total} audio bytes"
            run.read[rid] += len(chunk)
        assert run.read[rid] == total
    for rid in progress.finished:
        wait_for(lambda rid=rid: run.synths[rid].done, f"{rid} to finish")  # type: ignore[misc]
    if progress.pongs:
        wait_for(lambda: answered_ping(server), "the pong to answer the keepalive ping")


def synthesis_kwargs(frame: dict[str, Any], voice: str) -> dict[str, Any]:
    kwargs: dict[str, Any] = {}
    extra = {}
    for key, value in frame.items():
        if key in ("type", "requestId", "text"):
            continue
        if key == "voiceId" and value == voice:
            continue  # the session's voice
        if key in SYNTHESIS_OPTIONS:
            kwargs[SYNTHESIS_OPTIONS[key]] = value
        else:
            extra[key] = value  # unknown fields go through the escape hatch
    if extra:
        kwargs["extra_body"] = extra
    return kwargs


def drive_tts(
    run: TtsRun,
    events: list[dict[str, Any]],
    server: ReplayServer,
    opts: StreamOptions,
    mode: str,
    bridge: Bridge | None,
) -> TtsRun:
    frames = [e["data"] for e in events if e["dir"] == "out" and e["kind"] == "json"]
    voice = next((f["voiceId"] for f in frames if f.get("type") == "synthesize"), VOICE)
    try:
        run.tts = open_tts(mode, opts, bridge, voice_id=voice)
    except EchoNovaError as error:
        run.error = error
        return run
    tts = run.tts
    for event in events[1:]:
        direction, kind, data = event["dir"], event["kind"], event["data"]
        if direction == "in":
            run.progress.inbound(event)
            continue
        tts_catch_up(run, server)
        if kind == "json" and data["type"] == "synthesize":
            synth = tts.synthesize(data["text"], **synthesis_kwargs(data, voice))
            wait_for(lambda synth=synth: synth.state != "queued", "the synthesis to be sent")  # type: ignore[misc]
            run.progress.client_stops_running()  # it replaces whatever is running
            run.synths[data["requestId"]] = synth
            run.progress.synthesized.append(data["requestId"])
        elif kind == "json" and data["type"] == "cancel":
            tts.cancel()
            run.progress.client_stops_running()
        elif kind == "json" and data["type"] == "ping":
            pass  # the SDK's keepalive sends it
        elif kind == "close":
            tts.close()
        elif kind == "abort":
            server.trigger_abort()
        else:
            assert kind in ("text", "binary"), f"no SDK call for {kind} {data}"  # unsendable: see ADAPTATIONS
    tts_catch_up(run, server)
    return run


def check_tts(run: TtsRun, server: ReplayServer, events: list[dict[str, Any]], expected: dict[str, Any]) -> None:
    progress, tts = run.progress, run.tts
    assert tts is not None
    if "pong" in expected:
        assert expected["pong"] is True
        assert answered_ping(server)
    if "session_error" in expected:
        wait_for(lambda: not tts.connected, "the server's close")
        with pytest.raises(SessionEndedError) as ended:
            tts.synthesize("hello")
        check_close_error(ended.value.__cause__, events, expected["session_error"])
    outcomes: dict[str, str] = expected.get("requests", {})
    assert set(run.synths) == set(outcomes), "the syntheses made are not the ones expected.json names"
    for rid, outcome in outcomes.items():
        synth = run.synths[rid]
        wait_for(lambda synth=synth: synth.done, f"{rid} to finish")  # type: ignore[misc]
        assert synth.request_id == server.request_ids[rid]  # the SDK's own ID went out where the recording had rN
        state, _, error_class = outcome.partition(":")
        error: EchoNovaError | None = None
        if error_class:
            assert synth.state == state, f"{rid}: {synth.state} != {state}"
            with pytest.raises(EchoNovaError) as caught:
                synth.result()
            error = caught.value
            assert type(error).__name__ == error_class
        else:
            result = synth.result()
            assert result.outcome == outcome
        # Audio: what arrived before the client stopped it, and for a completed synthesis all of it.
        while True:
            try:
                chunk = read_chunk(synth)
            except EchoNovaError:
                break
            if chunk is None:
                break
            run.read[rid] += len(chunk)
        assert run.read[rid] == progress.delivered.get(rid, 0), f"{rid}: audio delivered"
        if outcome == "completed":
            assert run.read[rid] == progress.recorded[rid] > 0
        # Credits: the final cost the server reported, if it did.
        final = progress.finished.get(rid, {})
        credits = final.get("creditsConsumed")
        assert synth.credits_consumed == credits, f"{rid}: credits"
        if not error_class:
            assert result.credits_consumed == credits
            if final.get("type") == "done":
                assert result.duration_seconds == final["durationSeconds"]
                assert result.characters == final["characters"]
        # Charged: once audio started, or when the server reported a cost (notes: cancel_before_start,
        # drop_mid_stream, invalid_while_running).
        charged = rid in progress.started or credits is not None
        assert synth.charge_state == ("yes" if charged else "no"), f"{rid}: charge state"
        if error is not None:
            assert error.charge_state == synth.charge_state


# --- Speech to Text --------------------------------------------------------------------------------


class EventCollector:
    """Iterates a session in the background, as a caller would, until it ends."""

    def __init__(self, stt: SttAdapter, bridge: Bridge | None) -> None:
        self.items: list[Any] = []
        self.error: BaseException | None = None
        self.done = threading.Event()
        session = stt.session
        if bridge is not None:

            async def drain() -> None:
                try:
                    async for event in session:  # type: ignore[union-attr]
                        self.items.append(event)
                except Exception as exc:
                    self.error = exc
                finally:
                    self.done.set()

            asyncio.run_coroutine_threadsafe(drain(), bridge.loop)
        else:

            def consume() -> None:
                try:
                    for event in session:  # type: ignore[union-attr]
                        self.items.append(event)
                except Exception as exc:
                    self.error = exc
                finally:
                    self.done.set()

            threading.Thread(target=consume, name="replay-stt-events", daemon=True).start()

    def count(self, kind: type) -> int:
        return sum(isinstance(item, kind) for item in self.items)


@dataclass
class SttRun:
    error: EchoNovaError | None = None  # what connect() raised
    stt: SttAdapter | None = None
    events: EventCollector | None = None
    summary: SessionSummary | None = None
    seen: list[str] = field(default_factory=list)  # what each set_terminology() call gave the caller
    progress: Progress = field(default_factory=Progress)


def drive_stt(
    run: SttRun,
    events: list[dict[str, Any]],
    server: ReplayServer,
    opts: StreamOptions,
    adapt: Adaptation,
    mode: str,
    bridge: Bridge | None,
) -> SttRun:
    query = dict(parse_qsl(urlsplit(events[0]["data"]["path"]).query))
    try:
        # A recording without language (stt/handshake_missing_language) is replayed without one.
        run.stt = open_stt(mode, opts, bridge, sample_rate=int(query["sample_rate"]), language=query.get("language"))
    except EchoNovaError as error:
        run.error = error
        return run
    stt = run.stt
    run.events = collector = EventCollector(stt, bridge)
    for event in events[1:]:
        direction, kind, data = event["dir"], event["kind"], event["data"]
        if direction == "in":
            run.progress.inbound(event)
            continue
        transcripts = run.progress.transcripts
        wait_for(lambda transcripts=transcripts: collector.count(Transcript) >= transcripts, "the transcripts")  # type: ignore[misc]
        if run.progress.pongs:
            wait_for(lambda: answered_ping(server), "the pong to answer the keepalive ping")
        if kind == "binary":
            if "binary" not in adapt.unsent:
                stt.send_audio(bytes(data["bytes"]))
        elif kind == "json" and data["type"] == "end_segment":
            stt.end_segment()
        elif kind == "json" and data["type"] == "terminology":
            try:
                reply = stt.set_terminology(data["terminology"])
            except APIStatusError as error:
                run.seen.append(f"error:{type(error).__name__}")
            else:
                assert isinstance(reply, TerminologySet)
                run.seen.append("terminology.set")
        elif kind == "json" and data["type"] == "stop":
            run.summary = stt.stop()
        elif kind == "json" and data["type"] == "ping":
            pass  # the SDK's keepalive sends it
        else:
            raise AssertionError(f"no SDK call for {kind} {data}")
    assert collector.done.wait(WAIT), "the session never ended"
    return run


def expected_stt_events(events: list[dict[str, Any]]) -> list[type]:
    """The events a caller iterating the session sees, from the recording.

    session.started and pong are taken in by connect() and the keepalive. An error that
    answers a terminology frame is raised by set_terminology() instead.
    """
    out: list[type] = []
    awaiting_terminology = False
    for event in events:
        if event["kind"] != "json":
            continue
        kind = event["data"].get("type")
        if event["dir"] == "out":
            awaiting_terminology = awaiting_terminology or kind == "terminology"
            continue
        if kind in ("terminology.set", "error") and awaiting_terminology:
            awaiting_terminology = False
            if kind == "error":
                continue
        if kind in STT_EVENTS:
            out.append(STT_EVENTS[kind])
    return out


def check_stt(run: SttRun, server: ReplayServer, events: list[dict[str, Any]], expected: dict[str, Any]) -> None:
    stt, collector = run.stt, run.events
    assert stt is not None
    assert collector is not None
    items = collector.items
    assert [type(item) for item in items] == expected_stt_events(events)
    started = inbound_json(events, "session.started")[0]
    assert (stt.session_id, stt.job_id) == (started["sessionId"], started["jobId"])

    recorded = inbound_json(events, "transcript")
    transcripts = [item for item in items if isinstance(item, Transcript)]
    assert len(transcripts) == len(recorded)
    for index, (transcript, data) in enumerate(zip(transcripts, recorded, strict=True)):
        assert transcript.index == index
        assert (transcript.segment_id, transcript.text, transcript.language) == (
            data["segmentId"],
            data["text"],
            data["language"],
        )
        assert (transcript.duration_seconds, transcript.credits_consumed) == (
            data["durationSeconds"],
            data["creditsConsumed"],
        )
        assert transcript.session_id == started["sessionId"]
    if "transcripts" in expected:
        if expected["transcripts"] == "in order":  # in the order the segments were cut: as recorded
            assert [t.segment_id for t in transcripts] == [d["segmentId"] for d in recorded]
            assert [t.duration_seconds for t in transcripts] == sorted(t.duration_seconds for t in transcripts)
        else:
            assert len(transcripts) == expected["transcripts"]

    if "events" in expected:
        assert run.seen == expected["events"]
        terminology = [item.active for item in items if isinstance(item, TerminologySet)]
        assert terminology == [e["active"] for e in inbound_json(events, "terminology.set")]

    if "session_error" in expected:
        check_close_error(collector.error, events, expected["session_error"])
        check_close_error(stt.failure, events, expected["session_error"])
        with pytest.raises(APIStatusError) as caught:
            stt.stop()
        assert caught.value is stt.failure
        return
    assert collector.error is None, f"the session failed: {collector.error!r}"

    ended = inbound_json(events, "session.ended")
    if "ended" in expected:
        assert ended[0]["reason"] == expected["ended"]
    if ended:
        ended_event = next(item for item in items if isinstance(item, SessionEnded))
        assert (ended_event.reason, ended_event.total_seconds, ended_event.credits_consumed) == (
            ended[0]["reason"],
            ended[0]["totalSeconds"],
            ended[0]["creditsConsumed"],
        )
        summary = run.summary
        assert summary is not None
        assert (summary.reason, summary.total_seconds, summary.credits_consumed) == (
            ended[0]["reason"],
            ended[0]["totalSeconds"],
            ended[0]["creditsConsumed"],
        )
        assert summary.session_id == started["sessionId"]
    saved = inbound_json(events, "session.saved")
    if "saved" in expected:
        assert expected["saved"] is True
        assert saved, "no session.saved"
        assert saved[0]["jobId"]
    if saved:
        saved_event = next(item for item in items if isinstance(item, SessionSaved))
        assert (saved_event.job_id, saved_event.status) == (saved[0]["jobId"], saved[0]["status"])
        assert run.summary is not None
        assert (run.summary.job_id, run.summary.saved_status) == (saved[0]["jobId"], saved[0]["status"])
    if "pong" in expected:
        assert expected["pong"] is True
        assert answered_ping(server)


# --- Tests -----------------------------------------------------------------------------------------


def test_every_fixture_has_an_expectation_and_every_expectation_a_fixture() -> None:
    assert coverage_problems("ws") == []


@pytest.mark.parametrize("name", NAMES)
def test_replay(name: str, mode: str, bridge: Bridge | None, replay: Callable[[Script], ReplayServer]) -> None:
    events, expected = load(name), EXPECTED[name]
    assert set(expected) <= EXPECTATION_KEYS, f"unknown expectation keys: {set(expected) - EXPECTATION_KEYS}"
    adapt = ADAPTATIONS.get(name, Adaptation())
    tolerated = {frame["type"] for frame in adapt.extra} | ({"ping"} if adapt.keepalive else set())
    script = script_from_recording(
        events, unsent=adapt.unsent, started_first=adapt.started_first, tolerated=frozenset(tolerated)
    )
    server = replay(script)
    opts = options(server, events, adapt)
    run: TtsRun | SttRun = TtsRun() if name.startswith("tts/") else SttRun()
    try:
        if isinstance(run, TtsRun):
            run = drive_tts(run, events, server, opts, mode, bridge)
        else:
            run = drive_stt(run, events, server, opts, adapt, mode, bridge)
        assert server.finished.wait(WAIT), "the replay never reached the end of the recording"
        assert server.problems == []
        check_handshake(server, events, adapt)
        if "handshake_error" in expected:
            check_handshake_error(run.error, events, expected["handshake_error"])
            return
        assert run.error is None, f"connect() raised {run.error!r}"
        assert [f.value for f in server.extras if f.type != "ping"] == list(adapt.extra)
        if isinstance(run, TtsRun):
            check_tts(run, server, events, expected)
        else:
            check_stt(run, server, events, expected)
    finally:
        session = run.tts if isinstance(run, TtsRun) else run.stt
        if session is not None:
            with contextlib.suppress(Exception):
                session.close()
