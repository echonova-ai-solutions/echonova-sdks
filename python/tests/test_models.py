"""Response models: built from examples synthesised from openapi.json, and parsed leniently."""

from __future__ import annotations

import dataclasses
from datetime import UTC, datetime, timedelta, timezone
from typing import Any

import pytest

from _support import example_for, openapi, resolve, response_schema, schema_properties
from echonova import _operations as operations
from echonova import types
from echonova._core._envelope import MalformedEnvelopeError
from echonova.types._base import Model, _api_fields, to_bool, to_datetime, to_float, to_int

# Each 200 response's ``data`` schema, and the model the SDK parses it into.
RESPONSES: list[tuple[str, str, type[Model]]] = [
    ("/v1/text-to-speech", "POST", types.JobInitiated),
    ("/v1/text-to-speech/sync", "POST", types.TtsResult),
    ("/v1/text-to-speech/voices", "GET", types.VoiceList),
    ("/v1/text-to-speech/jobs/{jobId}", "GET", types.TtsJob),
    ("/v1/text-to-speech/jobs/{jobId}", "DELETE", types.DeleteResult),
    ("/v1/speech-to-text", "POST", types.JobInitiated),
    ("/v1/speech-to-text/sync", "POST", types.SttResult),
    ("/v1/speech-to-text/jobs/{jobId}", "GET", types.SttJob),
    ("/v1/speech-to-text/jobs/{jobId}", "DELETE", types.DeleteResult),
    ("/v1/sound-cleaning", "POST", types.CleanJob),
    ("/v1/sound-cleaning/jobs/{jobId}", "GET", types.CleanJob),
    ("/v1/sound-cleaning/jobs/{jobId}", "DELETE", types.DeleteResult),
    ("/v1/widgets/{publicId}/tickets", "POST", types.WidgetTicket),
    ("/v1/agents/{agentId}/sessions", "POST", types.StartedAgentSession),
    ("/v1/agents/{agentId}/sessions/{sessionId}", "GET", types.AgentSession),
    ("/v1/agents/{agentId}/sessions/{sessionId}/end", "POST", types.AgentSession),
]
LISTS: list[tuple[str, type[Model]]] = [
    ("/v1/text-to-speech/jobs", types.TtsJob),
    ("/v1/speech-to-text/jobs", types.SttJob),
    ("/v1/sound-cleaning/jobs", types.CleanJob),
]


def data_schema(path: str, method: str) -> dict[str, Any]:
    props = schema_properties(response_schema(path, method))
    schema: dict[str, Any] = props["data"]
    return schema


# API field name -> the model its nested objects parse into ((model, field) when it differs by model).
NESTED: dict[str, type[Model]] = {
    "items": types.Voice,
    "segments": types.SttSegment,
    "speakers": types.SttSpeaker,
    "terminology": types.TerminologyResult,
    "edits": types.TerminologyEdit,
    "nearMisses": types.TerminologyNearMiss,
    "warnings": types.TerminologyWarning,
    "options": types.CleanJobOptions,
    "metrics": types.CleanMetrics,
}
NESTED_BY_MODEL: dict[tuple[type[Model], str], type[Model]] = {
    (types.TtsJob, "stream"): types.TtsJobStream,
    (types.SttJob, "stream"): types.SttJobStream,
}


def assert_covers(model: type[Model], schema: dict[str, Any], path: str = "") -> None:
    """Every documented property has a model field, recursively."""
    props = schema_properties(schema)
    api_names = {api for _, api, _, _ in _api_fields(model)}
    missing = set(props) - api_names
    assert not missing, f"{model.__name__}{path} lacks fields for {sorted(missing)}"
    for name, prop in props.items():
        prop = resolve(prop)
        inner = prop.get("items") if prop.get("type") == "array" else prop
        if inner is not None and (schema_properties(inner) or "$ref" in inner or "allOf" in inner):
            nested = NESTED_BY_MODEL.get((model, name)) or NESTED[name]
            assert_covers(nested, inner, f"{path}.{name}")


@pytest.mark.parametrize(("path", "method", "model"), RESPONSES, ids=lambda v: getattr(v, "__name__", v))
def test_every_documented_field_is_modelled_and_parsed(path: str, method: str, model: type[Model]) -> None:
    schema = data_schema(path, method)
    if model is types.VoiceList:
        assert_covers(types.Voice, schema_properties(schema)["items"]["items"])
    else:
        assert_covers(model, schema)
    example = example_for(schema)
    parsed = model._from_json(example, request_id="req-9")
    assert parsed.request_id == "req-9"
    assert parsed.raw == example
    for name, api, _, _ in _api_fields(model):
        if api in example and example[api] is not None:
            assert getattr(parsed, name) is not None, f"{model.__name__}.{name} did not parse {example[api]!r}"


@pytest.mark.parametrize(("path", "model"), LISTS)
def test_list_items_are_documented_job_models(path: str, model: type[Model]) -> None:
    schema = data_schema(path, "GET")
    item_schema = schema_properties(schema)["items"]["items"]
    assert_covers(model, item_schema)
    assert set(schema_properties(schema)) == {"items", "total"}


def test_transcript_export_matches_the_documented_example() -> None:
    content = openapi()["paths"]["/v1/speech-to-text/jobs/{jobId}/export"]["get"]["responses"]["200"]["content"]
    example = content["application/json"]["example"]
    export = types.TranscriptExport._from_json(example)
    assert export.speakers is not None
    assert export.speakers[0].label == "Speaker 1"
    assert export.segments is not None
    assert export.segments[1].speaker_label == "Speaker 2"
    covered = {api for _, api, _, _ in _api_fields(types.TranscriptExport)}
    assert set(example) <= covered
    assert set(example["speakers"][0]) <= {api for _, api, _, _ in _api_fields(types.TranscriptExportSpeaker)}
    assert set(example["segments"][0]) <= {api for _, api, _, _ in _api_fields(types.TranscriptExportSegment)}


def test_values_from_the_examples() -> None:
    job = types.TtsJob._from_json(example_for(resolve({"$ref": "#/components/schemas/V1TtsJobResponseDto"})))
    assert job.created_at == datetime(2026, 9, 15, 10, 21, 4, 512000, tzinfo=UTC)
    assert job.credits_consumed == 41
    assert isinstance(job.credits_consumed, int)
    stt = types.SttResult._from_json(example_for(data_schema("/v1/speech-to-text/sync", "POST")))
    assert stt.terminology is not None
    assert stt.terminology.raw_text is not None
    assert stt.terminology.edits is not None
    assert stt.terminology.edits[0].replacement == "Emirates NBD"
    assert stt.segments is not None
    assert stt.segments[0].speaker == "spk0"
    assert stt.id == stt.job_id


def test_stream_jobs_say_where_they_came_from() -> None:
    tts = types.TtsJob._from_json(example_for(resolve({"$ref": "#/components/schemas/V1TtsJobResponseDto"})))
    assert tts.stream is not None
    assert tts.stream.session_id == "3f1c2b9e-8a47-4d1e-9b6a-2c5d7e8f9a01"
    assert tts.stream.synthesis_request_id == "reply-1"  # the API's requestId; .request_id is the HTTP one
    assert tts.stream.request_id is None
    assert (tts.stream.cancelled, tts.stream.audio_dropped) == (True, True)
    assert tts.to_dict()["stream"]["synthesis_request_id"] == "reply-1"
    stt = types.SttJob._from_json(example_for(resolve({"$ref": "#/components/schemas/V1SttJobResponseDto"})))
    assert stt.stream is not None
    assert stt.stream.session_id == "b1f0c2d4-5e6a-4f70-8a91-2c3d4e5f6a7b"
    assert stt.audio_url is not None
    assert stt.audio_url.startswith("https://storage.example.com/")
    rest = types.SttJob._from_json({"id": "j", "status": "completed"})  # a job from the REST endpoints
    assert (rest.stream, rest.audio_url) == (None, None)


def test_widget_ticket_is_kept_out_of_repr() -> None:
    ticket = types.WidgetTicket._from_json({"ticket": "wt-do-not-print", "expiresAt": "2026-11-07T10:05:00Z"})
    assert ticket.ticket == "wt-do-not-print"
    assert "wt-do-not-print" not in repr(ticket)
    assert "wt-do-not-print" not in str(ticket)
    assert operations.WIDGETS_CREATE_TICKET.secret_response


def test_started_session_token_is_kept_out_of_repr() -> None:
    data = {
        "id": "6651a1b2c3d4e5f6a7b8c9d0",
        "agentId": "6650a1b2c3d4e5f6a7b8c9d0",
        "channel": "chat",
        "status": "active",
        "startedAt": "2026-11-07T10:00:00.000Z",
        "endedAt": None,
        "token": "room-token-do-not-print",
        "wsUrl": "wss://rooms.echonova.ai",
        "greeting": "Hello! How can I help?",
    }
    started = types.StartedAgentSession._from_json(data, request_id="r1")
    assert isinstance(started, types.AgentSession)
    assert started.token == "room-token-do-not-print"
    assert "room-token-do-not-print" not in repr(started)
    assert "room-token-do-not-print" not in str(started)
    assert "ws_url='wss://rooms.echonova.ai'" in repr(started)
    assert started.to_dict()["token"] == "room-token-do-not-print"
    assert started.raw["token"] == "room-token-do-not-print"
    assert (started.channel, started.greeting, started.ended_at) == ("chat", "Hello! How can I help?", None)
    assert started.started_at == datetime(2026, 11, 7, 10, 0, tzinfo=UTC)
    with pytest.raises(MalformedEnvelopeError, match="'token'"):
        types.StartedAgentSession._from_json({**data, "token": None})
    ended = types.AgentSession._from_json({**data, "status": "ended", "endedAt": "2026-11-07T10:05:30Z"})
    assert ended.ended_at == datetime(2026, 11, 7, 10, 5, 30, tzinfo=UTC)
    assert "token" not in ended.to_dict()  # get() and end() never return the token


# --- Lenient parsing ----------------------------------------------------------------------------


def test_missing_fields_are_none_and_unknown_fields_are_kept() -> None:
    job = types.SttJob._from_json({"id": "j1", "status": "processing", "newField": {"x": 1}})
    assert job.transcription is None
    assert job.segments is None
    assert job.raw["newField"] == {"x": 1}


def test_unknown_status_values_parse() -> None:
    assert types.TtsJob._from_json({"id": "j", "status": "queued"}).status == "queued"


@pytest.mark.parametrize("model", [types.TtsJob, types.SttJob, types.CleanJob, types.Voice])
def test_missing_id_is_a_contract_violation(model: type[Model]) -> None:
    with pytest.raises(MalformedEnvelopeError, match="'id'"):
        model._from_json({"status": "completed"})


def test_non_object_data_is_a_contract_violation() -> None:
    with pytest.raises(MalformedEnvelopeError):
        types.TtsJob._from_json(["not", "an", "object"])


@pytest.mark.parametrize(
    ("value", "expected"), [(3, 3.0), (2.5, 2.5), ("4.25", 4.25), (" 7 ", 7.0), ("x", None), (True, None), ([], None)]
)
def test_lenient_float(value: Any, expected: float | None) -> None:
    assert to_float(value) == expected


def test_lenient_int() -> None:
    assert to_int(41) == 41
    assert to_int(41.0) == 41
    assert isinstance(to_int(41.0), int)
    assert to_int("26") == 26
    assert to_int(1.5) == 1.5  # never silently rounded
    assert to_int(None) is None


def test_lenient_bool() -> None:
    assert to_bool(True) is True
    assert to_bool("false") is False
    assert to_bool(1) is True
    assert to_bool("yes") is None


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("2026-09-15T10:21:04.512Z", datetime(2026, 9, 15, 10, 21, 4, 512000, tzinfo=UTC)),
        ("2026-09-15T10:21:04Z", datetime(2026, 9, 15, 10, 21, 4, tzinfo=UTC)),
        ("2026-09-15T10:21:04.1+02:00", datetime(2026, 9, 15, 10, 21, 4, 100000, tzinfo=timezone(timedelta(hours=2)))),
        ("2026-09-15T10:21:04.123456789Z", datetime(2026, 9, 15, 10, 21, 4, 123456, tzinfo=UTC)),
        ("2026-09-15 10:21", datetime(2026, 9, 15, 10, 21, tzinfo=UTC)),
        ("2026-09-15", datetime(2026, 9, 15, tzinfo=UTC)),
        ("yesterday", None),
        ("2026-13-45T00:00:00Z", None),
    ],
)
def test_datetime_parsing(text: str, expected: datetime | None) -> None:
    assert to_datetime(text) == expected


def test_unparseable_values_stay_in_raw() -> None:
    job = types.TtsJob._from_json({"id": "j", "status": "completed", "createdAt": "soon", "creditsConsumed": "n/a"})
    assert job.created_at is None
    assert job.credits_consumed is None
    assert job.raw["createdAt"] == "soon"


def test_to_dict_and_equality() -> None:
    data = {"id": "c1", "status": "completed", "metrics": {"sampleRate": 24000}, "options": {"qFactor": 0.707}}
    job = types.CleanJob._from_json(data, request_id="r1")
    plain = job.to_dict()
    assert plain["metrics"]["sample_rate"] == 24000
    assert plain["options"]["q_factor"] == 0.707
    assert "raw" not in plain
    assert "request_id" not in plain
    assert job == types.CleanJob._from_json(data, request_id="other")  # metadata is not part of equality
    with pytest.raises(dataclasses.FrozenInstanceError):
        job.status = "failed"  # type: ignore[misc]


def test_voice_list_is_iterable() -> None:
    voices = types.VoiceList._from_json(
        {"items": [{"id": "v1", "name": "a", "language": "ar"}, {"id": "v2", "language": "en"}], "total": 2}
    )
    assert [v.id for v in voices] == ["v1", "v2"]
    assert len(voices) == 2
    assert voices.total == 2
    assert voices[1].language == "en"
    assert next(v for v in voices if v.language == "ar").id == "v1"


def test_terminology_raw_field_is_renamed() -> None:
    result = types.TerminologyResult._from_json({"raw": "before", "corrected": "after"})
    assert result.raw_text == "before"
    assert result.raw == {"raw": "before", "corrected": "after"}


def test_delete_result_flags() -> None:
    result = types.DeleteResult._from_json({"deleted": True})
    assert result.deleted is True
    assert result.already_deleted is False
