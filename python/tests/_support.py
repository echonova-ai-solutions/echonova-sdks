"""Test helpers: a fake clock, mock HTTP routing, envelopes and examples built from the OpenAPI schemas."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

from echonova import AsyncEchoNova, EchoNova
from echonova._config import Runtime

SPEC_DIR = Path(__file__).resolve().parents[2] / "spec"
TEST_KEY = "ek_REDACTED0testkey0for0unit0tests0only0000000000000000000000c21d"
WAV = b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x00" * 32
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\x00" * 32
JOB_ID = "6a1b2c3d4e5f60718293a4b5"
SIGNED_URL = "https://storage.example.com/tts/out.wav?sv=2024&sig=REDACTED-secret-signature"

Handler = Callable[[httpx.Request], httpx.Response]


class FakeTime:
    """A monotonic clock that only moves when the SDK sleeps."""

    def __init__(self, *, random: float = 0.5) -> None:
        self.monotonic = 1000.0
        self.sleeps: list[float] = []
        self.start = datetime(2026, 11, 9, 12, 0, 0, tzinfo=UTC)
        self.random = random

    def clock(self) -> float:
        return self.monotonic

    def now(self) -> datetime:
        return self.start + timedelta(seconds=self.monotonic - 1000.0)

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.monotonic += seconds

    async def async_sleep(self, seconds: float) -> None:
        self.sleep(seconds)
        await asyncio.sleep(0)

    def runtime(self) -> Runtime:
        return Runtime(
            clock=self.clock, now=self.now, sleep=self.sleep, async_sleep=self.async_sleep, random=lambda: self.random
        )


class Recorder:
    """Routes requests to a handler and keeps every request (with its body read)."""

    def __init__(self, handler: Handler) -> None:
        self.handler = handler
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.handler(request)

    @property
    def last(self) -> httpx.Request:
        return self.requests[-1]


def envelope_body(data: Any) -> dict[str, Any]:
    return {"data": data, "success": True, "statusCode": 200, "errorMessage": None}


def ok(data: Any, *, headers: dict[str, str] | None = None, request_id: str = "req-1") -> httpx.Response:
    return httpx.Response(200, json=envelope_body(data), headers={"X-Request-Id": request_id, **(headers or {})})


def fail(status: int, message: str | None, *, headers: dict[str, str] | None = None, **extra: Any) -> httpx.Response:
    body = {"data": None, "success": False, "statusCode": status, "errorMessage": message, **extra}
    return httpx.Response(status, json=body, headers={"X-Request-Id": "req-err", **(headers or {})})


def make_client(
    handler: Handler,
    *,
    time: FakeTime | None = None,
    download: Handler | None = None,
    **kwargs: Any,
) -> EchoNova:
    kwargs.setdefault("api_key", TEST_KEY)
    if "download_http_client" not in kwargs:
        kwargs["download_http_client"] = httpx.Client(transport=httpx.MockTransport(download or handler))
    return EchoNova(
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        _runtime=(time or FakeTime()).runtime(),
        **kwargs,
    )


def make_async_client(
    handler: Handler,
    *,
    time: FakeTime | None = None,
    download: Handler | None = None,
    **kwargs: Any,
) -> AsyncEchoNova:
    kwargs.setdefault("api_key", TEST_KEY)
    if "download_http_client" not in kwargs:
        kwargs["download_http_client"] = httpx.AsyncClient(transport=httpx.MockTransport(download or handler))
    return AsyncEchoNova(
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        _runtime=(time or FakeTime()).runtime(),
        **kwargs,
    )


def multipart_fields(request: httpx.Request) -> dict[str, tuple[str | None, str | None, bytes]]:
    """Parse a multipart body into {name: (filename, content_type, value)}."""
    content_type = request.headers["content-type"]
    boundary = content_type.split("boundary=")[1].encode()
    fields: dict[str, tuple[str | None, str | None, bytes]] = {}
    for part in request.content.split(b"--" + boundary)[1:-1]:
        head, _, value = part.strip(b"\r\n").partition(b"\r\n\r\n")
        headers = {}
        for line in head.decode().split("\r\n"):
            key, _, val = line.partition(": ")
            headers[key.lower()] = val
        disposition = headers["content-disposition"]
        params = dict(item.strip().split("=", 1) for item in disposition.split(";")[1:] if "=" in item)
        name = params["name"].strip('"')
        filename = params["filename"].strip('"') if "filename" in params else None
        fields[name] = (filename, headers.get("content-type"), value)
    return fields


# --- Examples synthesised from openapi.json -------------------------------------------------------

_OPENAPI: dict[str, Any] | None = None


def openapi() -> dict[str, Any]:
    global _OPENAPI
    if _OPENAPI is None:
        _OPENAPI = json.loads((SPEC_DIR / "openapi.json").read_text(encoding="utf-8"))
    return _OPENAPI


def resolve(schema: dict[str, Any]) -> dict[str, Any]:
    while "$ref" in schema:
        schema = openapi()["components"]["schemas"][schema["$ref"].rsplit("/", 1)[1]]
    return schema


def example_for(schema: dict[str, Any]) -> Any:
    """An example value for a schema: its ``example`` when given, otherwise built from its parts."""
    schema = resolve(schema)
    if "allOf" in schema:
        merged: dict[str, Any] = {}
        for part in schema["allOf"]:
            value = example_for(part)
            if isinstance(value, dict):
                merged.update(value)
            else:
                return value
        if "properties" in schema:
            merged.update(example_for({"type": "object", "properties": schema["properties"]}))
        return merged
    if "properties" in schema or schema.get("type") == "object":
        if "properties" not in schema and "example" in schema:
            return schema["example"]
        return {name: example_for(prop) for name, prop in schema.get("properties", {}).items()}
    if schema.get("type") == "array":
        return [example_for(schema.get("items", {}))]
    if "example" in schema and schema["example"] is not None:
        return schema["example"]
    if schema.get("nullable") and "example" in schema:
        return None  # documented as null in the example (endedAt of an open session)
    if "enum" in schema:
        return schema["enum"][0]
    return {"string": "text", "number": 1.5, "integer": 1, "boolean": True}.get(schema.get("type", ""))


def response_schema(path: str, method: str) -> dict[str, Any]:
    operation = openapi()["paths"][path][method.lower()]
    schema: dict[str, Any] = operation["responses"]["200"]["content"]["application/json"]["schema"]
    return schema


def schema_properties(schema: dict[str, Any]) -> dict[str, Any]:
    """The properties of an object schema, following refs and allOf."""
    schema = resolve(schema)
    props: dict[str, Any] = {}
    for part in schema.get("allOf", []):
        props.update(schema_properties(part))
    props.update(schema.get("properties", {}))
    return props


def load_spec(relative: str) -> Any:
    return json.loads((SPEC_DIR / relative).read_text(encoding="utf-8"))


def envelope(status: int, message: str | None, **extra: Any) -> bytes:
    """An error envelope body."""
    body = {"data": None, "statusCode": status, "success": False, "errorMessage": message, **extra}
    return json.dumps(body).encode()


def load_mapping() -> dict[str, Any]:
    mapping: dict[str, Any] = json.loads((SPEC_DIR / "mapping.json").read_text(encoding="utf-8"))
    return mapping
