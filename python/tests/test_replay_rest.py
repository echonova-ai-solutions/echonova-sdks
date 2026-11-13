"""Replay the REST traffic recorded from the live API (spec/fixtures/rest/) through the SDK.

Each fixture is one recorded call. Its operation is found in spec/mapping.json by
method and path, the SDK method for it is called with arguments rebuilt from the
recorded request, and the HTTP transport answers with the recorded response.
spec/fixtures/expected.json says what must come out: the parsed result (``ok``)
or an error class. The request the SDK sends is checked against the recording
too, except for the parts listed in CANNOT_SEND.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import unquote

import httpx
import pytest

from _support import (
    TEST_KEY,
    Recorder,
    coverage_problems,
    fixture_expectations,
    load_mapping,
    load_spec,
    make_async_client,
    make_client,
    multipart_fields,
    recorded_fixtures,
)
from echonova import AsyncEchoNova, AsyncPage, EchoNova, Page, UsageError, errors
from echonova._core._files import EXTENSION_TYPES
from echonova.types import Model

NAMES = recorded_fixtures("rest")
EXPECTED = fixture_expectations("rest")
OPERATIONS = load_mapping()["operations"]

# What a recording deliberately sent that the SDK's API can't send. The replay makes the closest
# call the SDK can, checks the rest of the request, and checks the response handling in full.
CANNOT_SEND: dict[str, list[str]] = {
    # The REST methods have no extra-body escape hatch (only the stream's synthesize() has extra_body).
    "tts/sync_unknown_field": ["JSON field foo"],
    # Nor extra multipart fields.
    "clean/clean_unknown_field": ["form field foo"],
    # The SDK always sends a JSON body; the replay sends one with placeholder text and voice.
    "tts/sync_not_json": ["a text/plain body"],
    # language is a required argument of transcribe(); the replay sends the placeholder "ar".
    "stt/sync_missing_language": ["no language"],
    # An explicit generic type raises UsageError before sending (see the test below), so the replay
    # lets the SDK type the file from its .mp3 extension.
    "stt/sync_octet_stream_mp3": ["content type application/octet-stream"],
}
# Values for required arguments a recording left out on purpose.
PLACEHOLDERS = {"language": "ar", "text": "hello", "voiceId": "000000000000000000000001"}
GENERIC_TYPES = {"application/octet-stream"}
# Model attributes that don't follow the snake_case rule, because every model already has .raw and .request_id.
RENAMED = {"raw": "raw_text", "requestId": "synthesis_request_id"}


def load(name: str) -> dict[str, Any]:
    recording: dict[str, Any] = load_spec(f"fixtures/rest/{name}.json")
    return recording


def find_operation(method: str, path: str) -> tuple[dict[str, Any], dict[str, str]]:
    """The mapping.json operation whose method and templated path match, with the path parameter values."""
    found = []
    for operation in OPERATIONS.values():
        if operation["method"] != method:
            continue
        pattern = re.sub(r"\\\{(\w+)\\\}", r"(?P<\1>[^/]+)", re.escape(operation["path"]))
        match = re.fullmatch(pattern, path)
        if match:
            found.append((operation, {k: unquote(v) for k, v in match.groupdict().items()}))
    assert len(found) == 1, f"{method} {path} matches {len(found)} operations in mapping.json"
    return found[0]


def form_argument(value: str) -> Any:
    """A recorded multipart value as the Python argument the SDK encodes back to the same text."""
    if value in ("true", "false"):
        return value == "true"
    for number in (int, float):
        try:
            return number(value)
        except ValueError:
            pass
    return value  # text, including terminology as a JSON string (sent verbatim)


@dataclass
class Call:
    """The SDK call that replays a recorded request, and the request it should send."""

    method: str  # dotted Python name from mapping.json, e.g. "text_to_speech.jobs.create"
    kwargs: dict[str, Any] = field(default_factory=dict)
    cannot_send: list[str] = field(default_factory=list)
    json: dict[str, Any] | None = None
    form: dict[str, str] | None = None
    file: tuple[str, str, int] | None = None  # (filename, content type the SDK sends, size)


def build_call(request: dict[str, Any]) -> Call:
    operation, path_values = find_operation(request["method"], request["path"])
    params = {p["api"]: p for p in operation["params"]}
    call = Call(operation["sdk"]["python"])

    def accept(api: str, where: str, value: Any, label: str) -> bool:
        param = params.get(api)
        if param is None or param["in"] != where:
            call.cannot_send.append(f"{label} {api}")
            return False
        call.kwargs[param["python"]] = value
        return True

    for api, value in path_values.items():
        accept(api, "path", value, "path parameter")
    for api, value in request.get("query", {}).items():
        accept(api, "query", value, "query parameter")
    if "json" in request:
        call.json = {k: v for k, v in request["json"].items() if accept(k, "json", v, "JSON field")}
    if "content" in request:
        call.cannot_send.append(f"a {request['content']['content_type']} body")
        call.json = {}
    if "form" in request or "file" in request:
        form = request.get("form", {})
        call.form = {k: v for k, v in form.items() if accept(k, "form", form_argument(v), "form field")}
    for api, param in params.items():  # required arguments the recording left out
        if not param["required"] or param["python"] in call.kwargs or param["in"] == "path" or api == "file":
            continue
        if "content" not in request:
            call.cannot_send.append(f"no {api}")
        call.kwargs[param["python"]] = PLACEHOLDERS[api]
        target = call.json if param["in"] == "json" else call.form
        assert target is not None
        target[api] = PLACEHOLDERS[api]
    if "file" in request:
        recorded = request["file"]
        assert recorded["field"] == "file"
        name, content_type, size = recorded["filename"], recorded["content_type"], recorded["bytes"]
        by_extension = EXTENSION_TYPES[PurePosixPath(name).suffix.lower()]
        content = bytes(size)
        if content_type in GENERIC_TYPES:
            call.cannot_send.append(f"content type {content_type}")
            call.kwargs["file"] = (name, content)
            content_type = by_extension
        elif content_type == by_extension:
            call.kwargs["file"] = (name, content)  # the SDK types it from the extension
        else:
            call.kwargs["file"] = (name, content, content_type)  # an explicit type (the escape hatch)
        call.file = (name, content_type, size)
    return call


def recorded_response(recording: dict[str, Any]) -> Callable[[httpx.Request], httpx.Response]:
    response = recording["response"]
    if "json" in response:
        body = json.dumps(response["json"], ensure_ascii=False).encode()
    else:
        body = response["text"].encode()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(response["status"], headers=response["headers"], content=body)

    return handler


def resolve(target: Any, dotted: str) -> Any:
    for part in dotted.split("."):
        target = getattr(target, part)
    return target


def invoke(client: Any, method: str, kwargs: dict[str, Any], *, asynchronous: bool) -> Any:
    function = resolve(client, method)
    if asynchronous:

        async def run() -> Any:
            result = function(**kwargs)
            return (await result) if inspect.isawaitable(result) else result

        return asyncio.run(run())
    return function(**kwargs)


def client_for(recording: dict[str, Any], recorder: Recorder, asynchronous: bool) -> EchoNova | AsyncEchoNova:
    options: dict[str, Any] = {}
    if recording["request"]["authorization"] == "none":
        # No key at all: an auth hook that adds nothing sends no Authorization header.
        options = {"api_key": None, "auth": lambda: {}, "base_url": "https://api.echonova.ai"}
    else:
        assert recording["request"]["authorization"] == "test key"
    return make_async_client(recorder, **options) if asynchronous else make_client(recorder, **options)


# --- What the SDK sends ----------------------------------------------------------------------------


def check_request(sent: httpx.Request, recorded: dict[str, Any], call: Call) -> None:
    assert sent.method == recorded["method"]
    assert sent.url.path == recorded["path"]
    assert dict(sent.url.params) == {k: str(v) for k, v in recorded.get("query", {}).items()}
    if recorded["authorization"] == "none":
        assert "authorization" not in sent.headers
    else:
        assert sent.headers["authorization"] == f"Bearer {TEST_KEY}"
    content_type = sent.headers.get("content-type", "")
    if call.json is not None:
        assert content_type == "application/json"
        assert json.loads(sent.content) == call.json
    elif call.file is not None:
        assert content_type.startswith("multipart/form-data; boundary=")
        fields = multipart_fields(sent)
        filename, file_type, content = fields.pop("file")
        assert (filename, file_type, len(content)) == call.file
        assert {k: v[2].decode() for k, v in fields.items()} == call.form
    else:
        assert sent.content == b""


# --- What the SDK returns --------------------------------------------------------------------------


def snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def check_model(model: Any, data: dict[str, Any], where: str) -> None:
    """Every recorded field reads back through the SDK's snake_case name; unknown ones stay in ``.raw``."""
    assert isinstance(model, Model), f"{where}: expected a model, got {type(model).__name__}"
    assert model.raw == data, f"{where}: .raw is not the JSON as received"
    known = model.to_dict()
    matched = set()
    for key, value in data.items():
        name = RENAMED.get(key, snake(key))
        if name not in known:
            continue  # a field this SDK version doesn't model: kept in .raw (checked above)
        matched.add(name)
        check_value(getattr(model, name), value, f"{where}.{name}")
    for name, value in known.items():
        if name not in matched:
            assert value is None, f"{where}.{name} is {value!r} but the response has no such field"


def check_value(actual: Any, expected: Any, where: str) -> None:
    if expected is None:
        assert actual is None, where
    elif isinstance(expected, dict):
        check_model(actual, expected, where)
    elif isinstance(expected, list):
        assert isinstance(actual, tuple), where
        assert len(actual) == len(expected), where
        for i, (item, value) in enumerate(zip(actual, expected, strict=True)):
            check_value(item, value, f"{where}[{i}]")
    elif isinstance(expected, bool):
        assert actual is expected, where
    elif isinstance(expected, (int, float)):
        assert isinstance(actual, (int, float)), where
        assert not isinstance(actual, bool), where
        assert actual == expected, f"{where}: {actual!r} != {expected!r}"
    elif isinstance(actual, datetime):
        assert actual == datetime.fromisoformat(expected), where
    else:
        assert actual == expected, f"{where}: {actual!r} != {expected!r}"


def check_result(result: Any, response: dict[str, Any], request_id: str) -> None:
    if "text" in response:
        assert result == response["text"]  # txt and srt exports: the body as received
        return
    body = response["json"]
    is_envelope = isinstance(body, dict) and "success" in body and "data" in body
    data = body["data"] if is_envelope else body  # the JSON export is not wrapped in an envelope
    if isinstance(result, (Page, AsyncPage)):
        assert result.request_id == request_id
        assert result.raw == data
        assert result.total == data.get("total")
        assert len(result.items) == len(data["items"])
        for i, (item, value) in enumerate(zip(result.items, data["items"], strict=True)):
            check_model(item, value, f"items[{i}]")
        return
    check_model(result, data, type(result).__name__)
    assert result.request_id == request_id


# --- Tests -----------------------------------------------------------------------------------------


def test_every_fixture_has_an_expectation_and_every_expectation_a_fixture() -> None:
    assert coverage_problems("rest") == []


@pytest.mark.parametrize("asynchronous", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("name", NAMES)
def test_replay(name: str, asynchronous: bool) -> None:
    recording, expected = load(name), EXPECTED[name]
    response = recording["response"]
    request_id = response["headers"]["x-request-id"]
    call = build_call(recording["request"])
    assert call.cannot_send == CANNOT_SEND.get(name, [])
    recorder = Recorder(recorded_response(recording))
    client = client_for(recording, recorder, asynchronous)

    if "error" in expected:
        with pytest.raises(errors.APIStatusError) as caught:
            invoke(client, call.method, call.kwargs, asynchronous=asynchronous)
        error = caught.value
        assert type(error).__name__ == expected["error"]
        assert error.status_code == response["status"]
        assert error.error_message == response["json"]["errorMessage"]
        assert error.request_id == request_id
        assert error.docs_url == response["json"].get("docs")
    else:
        assert expected == {"ok": True}
        check_result(invoke(client, call.method, call.kwargs, asynchronous=asynchronous), response, request_id)
        # The same call through with_raw_response: the request ID of a result that can't carry one (an export's text).
        raw = invoke(client.with_raw_response, call.method, call.kwargs, asynchronous=asynchronous)
        assert (raw.status_code, raw.request_id) == (response["status"], request_id)
        check_result(raw.parse(), response, request_id)

    # One request per call (the ok case also made the raw-response call): nothing was retried.
    assert len(recorder.requests) == (1 if "error" in expected else 2)
    for sent in recorder.requests:
        check_request(sent, recording["request"], call)


def test_the_sdk_refuses_to_send_a_generic_upload_type() -> None:
    """stt/sync_octet_stream_mp3 sent an MP3 as application/octet-stream, which the API rejects.

    The SDK never sends that type: it refuses an explicit generic type before sending anything.
    """
    recording = load("stt/sync_octet_stream_mp3")
    file = recording["request"]["file"]
    assert file["content_type"] == "application/octet-stream"
    recorder = Recorder(recorded_response(recording))
    with pytest.raises(UsageError, match="too generic"):
        make_client(recorder).speech_to_text.transcribe(
            (file["filename"], bytes(file["bytes"]), file["content_type"]), language="ar"
        )
    assert recorder.requests == []
