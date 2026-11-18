"""Every operation sends the documented request: method, path, query, JSON or multipart fields."""

from __future__ import annotations

import asyncio
import inspect
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest

from _support import JOB_ID, MP3, WAV, Recorder, envelope_body, load_mapping, make_async_client, make_client
from echonova import _operations as ops
from echonova import types

JOB = {
    "id": JOB_ID,
    "jobId": JOB_ID,
    "status": "completed",
    "ticket": "wtk_x",
    "deleted": True,
    "createdAt": None,
    "token": "room-token",
}
AGENT_ID = "6650a1b2c3d4e5f6a7b8c9d0"


def respond(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    if path.endswith("/export"):
        fmt = request.url.params["format"]
        if fmt == "json":
            return httpx.Response(200, json={"id": JOB_ID, "text": "hello"}, headers={"X-Request-Id": "r"})
        return httpx.Response(200, text="1\n00:00:00,000 --> 00:00:01,000\nhello\n", headers={"X-Request-Id": "r"})
    if request.method == "GET" and path.endswith(("/jobs", "/voices")):
        return httpx.Response(200, json=envelope_body({"items": [], "total": 0}))
    return httpx.Response(200, json=envelope_body(JOB))


@dataclass
class Case:
    name: str
    call: Callable[[Any], Any]
    method: str
    path: str
    query: dict[str, str] = field(default_factory=dict)
    json: dict[str, Any] | None = None
    form: dict[str, str] | None = None
    file: tuple[str, str] | None = None  # (filename, content type)
    result: type | None = None


TERMS: types.Terminology = {"keywords": ["KYC", {"term": "Emirates NBD", "variants": ["امريتس ان بي دي"]}]}

CASES = [
    Case(
        "tts.generate",
        lambda c: c.text_to_speech.generate("مرحبا", voice_id="v1", speed=1.1, num_steps=32, tashkeel=True),
        "POST",
        "/v1/text-to-speech/sync",
        json={"text": "مرحبا", "voiceId": "v1", "speed": 1.1, "numSteps": 32, "tashkeel": True},
        result=types.TtsResult,
    ),
    Case(
        "tts.generate minimal",
        lambda c: c.text_to_speech.generate(text="hi", voice_id="v1"),
        "POST",
        "/v1/text-to-speech/sync",
        json={"text": "hi", "voiceId": "v1"},
    ),
    Case(
        "tts.jobs.create",
        lambda c: c.text_to_speech.jobs.create("hi", voice_id="v1", cfg=3, normalize=False),
        "POST",
        "/v1/text-to-speech",
        json={"text": "hi", "voiceId": "v1", "cfg": 3, "normalize": False},
        result=types.JobInitiated,
    ),
    Case(
        "tts.voices.list",
        lambda c: c.text_to_speech.voices.list(),
        "GET",
        "/v1/text-to-speech/voices",
        result=types.VoiceList,
    ),
    Case(
        "tts.jobs.list",
        lambda c: c.text_to_speech.jobs.list(offset=40, limit=20),
        "GET",
        "/v1/text-to-speech/jobs",
        query={"offset": "40", "limit": "20"},
    ),
    Case("tts.jobs.list defaults", lambda c: c.text_to_speech.jobs.list(), "GET", "/v1/text-to-speech/jobs"),
    Case(
        "tts.jobs.get",
        lambda c: c.text_to_speech.jobs.get(JOB_ID),
        "GET",
        f"/v1/text-to-speech/jobs/{JOB_ID}",
        result=types.TtsJob,
    ),
    Case(
        "tts.jobs.delete",
        lambda c: c.text_to_speech.jobs.delete(JOB_ID),
        "DELETE",
        f"/v1/text-to-speech/jobs/{JOB_ID}",
        result=types.DeleteResult,
    ),
    Case(
        "stt.transcribe",
        lambda c: c.speech_to_text.transcribe(
            ("call.mp3", MP3), language="ar", numbers_as_digits=False, identify_speakers=True, terminology=TERMS
        ),
        "POST",
        "/v1/speech-to-text/sync",
        form={
            "language": "ar",
            "numbers_as_digits": "false",
            "identify_speakers": "true",
            "terminology": json.dumps(TERMS, ensure_ascii=False),
        },
        file=("call.mp3", "audio/mpeg"),
        result=types.SttResult,
    ),
    Case(
        "stt.transcribe minimal",
        lambda c: c.speech_to_text.transcribe(WAV, language="en"),
        "POST",
        "/v1/speech-to-text/sync",
        form={"language": "en"},
        file=("audio.wav", "audio/wav"),
    ),
    Case(
        "stt.transcribe without language",
        lambda c: c.speech_to_text.transcribe(WAV),
        "POST",
        "/v1/speech-to-text/sync",
        form={},  # no language field: the API detects it (auto)
        file=("audio.wav", "audio/wav"),
        result=types.SttResult,
    ),
    Case(
        "stt.transcribe auto",
        lambda c: c.speech_to_text.transcribe(WAV, language="auto", numbers_as_digits=True),
        "POST",
        "/v1/speech-to-text/sync",
        form={"language": "auto", "numbers_as_digits": "true"},
        file=("audio.wav", "audio/wav"),
    ),
    Case(
        "stt.jobs.create without language",
        lambda c: c.speech_to_text.jobs.create(("m.mp3", MP3)),
        "POST",
        "/v1/speech-to-text",
        form={},
        file=("m.mp3", "audio/mpeg"),
        result=types.JobInitiated,
    ),
    Case(
        "stt.jobs.create with JSON-string terminology",
        lambda c: c.speech_to_text.jobs.create(("m.flac", b"fLaC...."), language="en", terminology='{"keywords":[]}'),
        "POST",
        "/v1/speech-to-text",
        form={"language": "en", "terminology": '{"keywords":[]}'},
        file=("m.flac", "audio/flac"),
        result=types.JobInitiated,
    ),
    Case(
        "stt.jobs.list",
        lambda c: c.speech_to_text.jobs.list(limit=100),
        "GET",
        "/v1/speech-to-text/jobs",
        query={"limit": "100"},
    ),
    Case(
        "stt.jobs.get",
        lambda c: c.speech_to_text.jobs.get(JOB_ID),
        "GET",
        f"/v1/speech-to-text/jobs/{JOB_ID}",
        result=types.SttJob,
    ),
    Case(
        "stt.jobs.delete",
        lambda c: c.speech_to_text.jobs.delete(JOB_ID),
        "DELETE",
        f"/v1/speech-to-text/jobs/{JOB_ID}",
    ),
    Case(
        "stt.jobs.export srt",
        lambda c: c.speech_to_text.jobs.export(JOB_ID, format="srt", lang="ar"),
        "GET",
        f"/v1/speech-to-text/jobs/{JOB_ID}/export",
        query={"format": "srt", "lang": "ar"},
        result=str,
    ),
    Case(
        "stt.jobs.export json",
        lambda c: c.speech_to_text.jobs.export(JOB_ID, format="json"),
        "GET",
        f"/v1/speech-to-text/jobs/{JOB_ID}/export",
        query={"format": "json"},
        result=types.TranscriptExport,
    ),
    Case(
        "clean",
        lambda c: c.sound_cleaning.clean(
            ("noisy.wav", WAV), cutoff_freq=80, q_factor=0.707, target_lufs=-16, sample_rate=48000, bit_depth=24
        ),
        "POST",
        "/v1/sound-cleaning",
        form={"cutoffFreq": "80", "qFactor": "0.707", "targetLufs": "-16", "sampleRate": "48000", "bitDepth": "24"},
        file=("noisy.wav", "audio/wav"),
        result=types.CleanJob,
    ),
    Case(
        "clean all options",
        lambda c: c.sound_cleaning.clean(
            ("a.ogg", b"OggS...."),
            true_peak_dbfs=-1,
            comp_thresh_db=-3.8,
            comp_ratio=4,
            comp_attack_ms=5,
            comp_release_ms=50,
        ),
        "POST",
        "/v1/sound-cleaning",
        form={
            "truePeakDbfs": "-1",
            "compThreshDb": "-3.8",
            "compRatio": "4",
            "compAttackMs": "5",
            "compReleaseMs": "50",
        },
        file=("a.ogg", "audio/ogg"),
    ),
    Case(
        "clean.jobs.list",
        lambda c: c.sound_cleaning.jobs.list(offset=0),
        "GET",
        "/v1/sound-cleaning/jobs",
        query={"offset": "0"},
    ),
    Case(
        "clean.jobs.get",
        lambda c: c.sound_cleaning.jobs.get(JOB_ID),
        "GET",
        f"/v1/sound-cleaning/jobs/{JOB_ID}",
        result=types.CleanJob,
    ),
    Case(
        "clean.jobs.delete",
        lambda c: c.sound_cleaning.jobs.delete(JOB_ID),
        "DELETE",
        f"/v1/sound-cleaning/jobs/{JOB_ID}",
    ),
    Case(
        "widgets.create_ticket",
        lambda c: c.widgets.create_ticket(
            "wdg_abc", user={"id": "u1", "name": "Sara"}, channel="chat", ttl_seconds=600
        ),
        "POST",
        "/v1/widgets/wdg_abc/tickets",
        json={"user": {"id": "u1", "name": "Sara"}, "channel": "chat", "ttlSeconds": 600},
        result=types.WidgetTicket,
    ),
    Case(
        "widgets.create_ticket empty",
        lambda c: c.widgets.create_ticket("wdg_abc"),
        "POST",
        "/v1/widgets/wdg_abc/tickets",
        json={},
    ),
    Case(
        "agents.sessions.start",
        lambda c: c.agents.sessions.start(AGENT_ID, channel="chat"),
        "POST",
        f"/v1/agents/{AGENT_ID}/sessions",
        json={"channel": "chat"},
        result=types.StartedAgentSession,
    ),
    Case(
        "agents.sessions.start default channel",
        lambda c: c.agents.sessions.start(AGENT_ID),
        "POST",
        f"/v1/agents/{AGENT_ID}/sessions",
        json={},  # the body is required; an omitted channel is voice
    ),
    Case(
        "agents.sessions.get",
        lambda c: c.agents.sessions.get(AGENT_ID, JOB_ID),
        "GET",
        f"/v1/agents/{AGENT_ID}/sessions/{JOB_ID}",
        result=types.AgentSession,
    ),
    Case(
        "agents.sessions.end",
        lambda c: c.agents.sessions.end(AGENT_ID, JOB_ID),
        "POST",
        f"/v1/agents/{AGENT_ID}/sessions/{JOB_ID}/end",
        result=types.AgentSession,
    ),
]


IDEMPOTENT_PATHS = {op.path for op in ops.ALL if op.idempotency_key}


def check(case: Case, request: httpx.Request, result: Any) -> None:
    assert request.method == case.method
    assert request.url.path == case.path
    assert dict(request.url.params) == case.query
    assert ("idempotency-key" in request.headers) is (case.path in IDEMPOTENT_PATHS)
    content_type = request.headers.get("content-type", "")
    if case.json is not None:
        assert content_type == "application/json"
        assert json.loads(request.content) == case.json
    elif case.form is not None:
        assert content_type.startswith("multipart/form-data; boundary=")
        from _support import multipart_fields

        fields = multipart_fields(request)
        file = fields.pop("file")
        assert {k: v[2].decode() for k, v in fields.items()} == case.form
        assert all(filename is None for filename, _, _ in fields.values())
        assert (file[0], file[1]) == case.file
    else:
        assert request.content == b""
    if case.result is not None:
        assert isinstance(result, case.result)


@pytest.mark.parametrize("case", CASES, ids=lambda c: c.name)
def test_sync_request_shape(case: Case) -> None:
    recorder = Recorder(respond)
    result = case.call(make_client(recorder))
    assert len(recorder.requests) == 1
    check(case, recorder.last, result)


@pytest.mark.parametrize("case", CASES, ids=lambda c: c.name)
def test_async_request_shape(case: Case) -> None:
    recorder = Recorder(respond)
    client = make_async_client(recorder)

    async def run() -> Any:
        result = case.call(client)
        return (await result) if inspect.isawaitable(result) else result

    result = asyncio.run(run())
    assert len(recorder.requests) == 1
    check(case, recorder.last, result)


def test_job_objects_are_accepted_wherever_an_id_is() -> None:
    recorder = Recorder(respond)
    client = make_client(recorder)
    initiated = client.text_to_speech.jobs.create("hi", voice_id="v1")
    job = client.text_to_speech.jobs.get(initiated)
    client.text_to_speech.jobs.get(job)
    assert [r.url.path for r in recorder.requests[1:]] == [f"/v1/text-to-speech/jobs/{JOB_ID}"] * 2


def test_path_parameters_are_escaped() -> None:
    recorder = Recorder(respond)
    make_client(recorder).text_to_speech.jobs.get("a/b?c")
    assert recorder.last.url.raw_path == b"/v1/text-to-speech/jobs/a%2Fb%3Fc"
    make_client(recorder).agents.sessions.end("../x", " s/1 ")
    assert recorder.last.url.raw_path == b"/v1/agents/..%2Fx/sessions/s%2F1/end"


@pytest.mark.parametrize("value", [".", ".."])
@pytest.mark.parametrize(
    "call",
    [
        lambda c, v: c.text_to_speech.jobs.get(v),
        lambda c, v: c.speech_to_text.jobs.delete(v),
        lambda c, v: c.sound_cleaning.jobs.get(v),
        lambda c, v: c.widgets.create_ticket(v),
        lambda c, v: c.agents.sessions.get(AGENT_ID, v),
        lambda c, v: c.agents.sessions.end(v, JOB_ID),
    ],
)
def test_dot_segment_ids_are_refused_before_sending(call: Callable[[Any, str], Any], value: str) -> None:
    from echonova import UsageError

    recorder = Recorder(respond)
    with pytest.raises(UsageError, match="not a valid ID"):
        call(make_client(recorder), value)
    with pytest.raises(UsageError, match="not a valid ID"):
        asyncio.run(call(make_async_client(recorder), value))
    assert recorder.requests == []


@pytest.mark.parametrize(
    "call",
    [
        lambda c: c.agents.sessions.start(""),
        lambda c: c.agents.sessions.get(AGENT_ID, "  "),
        lambda c: c.agents.sessions.end(None, JOB_ID),
    ],
)
def test_agent_and_session_ids_are_required(call: Callable[[Any], Any]) -> None:
    from echonova import UsageError

    recorder = Recorder(respond)
    with pytest.raises(UsageError):
        call(make_client(recorder))
    assert recorder.requests == []


def test_export_returns_raw_text_not_an_envelope() -> None:
    srt = make_client(respond).speech_to_text.jobs.export(JOB_ID, format="srt")
    assert srt.startswith("1\n00:00:00,000")
    export = make_client(respond).speech_to_text.jobs.export(JOB_ID, format="json")
    assert export.text == "hello"
    assert export.request_id == "r"


# --- Conformance with spec/mapping.json -----------------------------------------------------------


def mapped_operations() -> list[dict[str, Any]]:
    """The operations in spec/mapping.json, without the ones it excludes (with their reason)."""
    return [entry for entry in load_mapping()["operations"].values() if "excluded" not in entry]


def test_operations_match_the_mapping() -> None:
    registry = {op.name: op for op in ops.ALL}
    assert {entry["sdk"]["python"] for entry in mapped_operations()} == set(registry)
    for entry in mapped_operations():
        op = registry[entry["sdk"]["python"]]
        assert (op.method, op.path) == (entry["method"], entry["path"])
        assert op.idempotency_key is entry["idempotency_key"], entry["sdk"]["python"]


def resolve_method(client: Any, dotted: str) -> Any:
    target = client
    for part in dotted.split("."):
        target = getattr(target, part)
    return target


@pytest.mark.parametrize("asynchronous", [False, True])
def test_every_mapped_parameter_is_accepted(asynchronous: bool) -> None:
    client = make_async_client(respond) if asynchronous else make_client(respond)
    for entry in mapped_operations():
        method = resolve_method(client, entry["sdk"]["python"])
        parameters = inspect.signature(method).parameters
        for param in entry["params"]:
            assert param["python"] in parameters, f"{entry['sdk']['python']} lacks {param['python']}"
