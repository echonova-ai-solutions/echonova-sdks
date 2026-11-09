"""Response metadata: ``RawResponse`` and the ``with_raw_response`` wrappers."""

from __future__ import annotations

import contextvars
import functools
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Generic, TypeVar

import httpx
from typing_extensions import ParamSpec

from ._core._envelope import MalformedEnvelopeError
from ._core._ratelimit import RateLimitInfo, parse_rate_limit
from .errors import ProtocolError

T = TypeVar("T")
P = ParamSpec("P")

_RAW_MODE: contextvars.ContextVar[bool] = contextvars.ContextVar("echonova_raw_mode", default=False)


@dataclass(frozen=True, slots=True)
class ApiResponse:
    """What a parser gets: the unwrapped ``data`` (or ``None`` for a raw file) and the HTTP response."""

    data: Any
    http: httpx.Response
    already_deleted: bool = False

    @property
    def request_id(self) -> str | None:
        value: str | None = self.http.headers.get("x-request-id")
        return value


class RawResponse(Generic[T]):
    """An HTTP response with its metadata. Call ``parse()`` for the usual return value."""

    def __init__(self, response: ApiResponse, parser: Callable[[ApiResponse], T]) -> None:
        self._response = response
        self._parser = parser
        self._parsed: list[T] = []

    @property
    def http_response(self) -> httpx.Response:
        return self._response.http

    @property
    def status_code(self) -> int:
        return self._response.http.status_code

    @property
    def headers(self) -> httpx.Headers:
        return self._response.http.headers

    @property
    def request_id(self) -> str | None:
        return self._response.request_id

    @property
    def rate_limit(self) -> RateLimitInfo | None:
        return parse_rate_limit(self._response.http.headers)

    @property
    def content(self) -> bytes:
        return self._response.http.content

    def parse(self) -> T:
        if not self._parsed:
            try:
                self._parsed.append(self._parser(self._response))
            except MalformedEnvelopeError as exc:
                http = self._response.http
                raise ProtocolError(
                    status_code=http.status_code,
                    error_message=str(exc),
                    request_id=self.request_id,
                    headers=dict(http.headers.items()),
                    rule="malformed_success",
                ) from exc
        return self._parsed[0]

    def __repr__(self) -> str:
        return f"<RawResponse status_code={self.status_code} request_id={self.request_id!r}>"


def raw_mode() -> bool:
    return _RAW_MODE.get()


def to_raw_response_wrapper(func: Callable[P, T]) -> Callable[P, RawResponse[T]]:
    @functools.wraps(func)
    def wrapped(*args: P.args, **kwargs: P.kwargs) -> RawResponse[T]:
        token = _RAW_MODE.set(True)
        try:
            return func(*args, **kwargs)  # type: ignore[return-value]  # the request returns RawResponse in raw mode
        finally:
            _RAW_MODE.reset(token)

    return wrapped


def async_to_raw_response_wrapper(func: Callable[P, Awaitable[T]]) -> Callable[P, Awaitable[RawResponse[T]]]:
    @functools.wraps(func)
    async def wrapped(*args: P.args, **kwargs: P.kwargs) -> RawResponse[T]:
        token = _RAW_MODE.set(True)
        try:
            return await func(*args, **kwargs)  # type: ignore[return-value]
        finally:
            _RAW_MODE.reset(token)

    return wrapped
