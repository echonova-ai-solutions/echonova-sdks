"""Configuration and request logic shared by ``EchoNova`` and ``AsyncEchoNova``."""

from __future__ import annotations

import inspect
import io
import json
import os
import tempfile
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from datetime import datetime
from pathlib import Path
from typing import IO, TYPE_CHECKING, Any, Generic, TypeVar
from urllib.parse import quote, unquote, urlsplit

import httpx

from . import _operations as ops
from ._config import (
    DEFAULT_CONNECT_TIMEOUT,
    DEFAULT_MAX_RETRIES,
    Runtime,
    Timeout,
    merge_headers,
    redact_key,
    resolve_api_key,
    resolve_base_url,
    user_agent,
    ws_base_url,
)
from ._core._classifier import build_status_error, classify_response, executed_flag
from ._core._envelope import RAW_BODY_LIMIT, MalformedEnvelopeError, unwrap_success
from ._core._files import PreparedFile
from ._core._ratelimit import RateLimitInfo, RateLimitTracker
from ._core._retry import RetryDecision, RetryPolicy
from ._logging import logger, redact_url, setup_from_env
from ._polling import PollLimiter
from ._response import ApiResponse, RawResponse
from ._transport import PHASE_MESSAGES, Authenticate, Flow, Send, Sleep, classify_exception
from .errors import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    DownloadExpiredError,
    ProtocolError,
    RateLimitError,
    UsageError,
)

if TYPE_CHECKING:
    from ._streaming import StreamOptions

T = TypeVar("T")
HttpT = TypeVar("HttpT", httpx.Client, httpx.AsyncClient)

_OPTION_KEYS = frozenset({"timeout", "max_retries", "deadline", "extra_headers"})


class _NotGiven:
    def __repr__(self) -> str:
        return "NOT_GIVEN"

    def __bool__(self) -> bool:
        return False


NOT_GIVEN: Any = _NotGiven()


@dataclass
class RequestSpec:
    op: ops.Operation
    path_params: Mapping[str, str] = field(default_factory=dict)
    query: Mapping[str, Any] | None = None
    json: Mapping[str, Any] | None = None
    form: Mapping[str, str] | None = None
    file: PreparedFile | None = None
    options: Mapping[str, Any] = field(default_factory=dict)


class _Pool(Generic[HttpT]):
    """HTTP clients shared by a client and its ``with_options()`` copies."""

    def __init__(self, http: HttpT, *, owns_http: bool, download: HttpT | None, factory: Callable[[], HttpT]) -> None:
        self.http: HttpT = http
        self.owns_http = owns_http
        self._download: HttpT | None = download
        self._owns_download = False
        self._factory: Callable[[], HttpT] = factory
        self._lock = threading.Lock()

    def download_client(self) -> HttpT:
        with self._lock:
            if self._download is None:
                self._download = self._factory()
                self._owns_download = True
            return self._download

    def owned(self) -> list[HttpT]:
        clients = [self.http] if self.owns_http else []
        with self._lock:
            if self._owns_download and self._download is not None:
                clients.append(self._download)
                self._download = None
                self._owns_download = False
        return clients


@dataclass
class _Limits:
    """Client-side rate-limit state for one API key."""

    tracker: RateLimitTracker
    limiter: PollLimiter


class _Sink:
    """Where a download goes: memory, or a temporary file renamed into place on success."""

    def __init__(self, to: str | os.PathLike[str] | None, url: str) -> None:
        self.target: Path | None = None
        self.temp: Path | None = None
        self._buffer: io.BytesIO | None = None
        if to is None:
            self._buffer = io.BytesIO()
            self.file: IO[bytes] = self._buffer
            return
        target = Path(os.fspath(to))
        if target.is_dir():
            name = unquote(Path(urlsplit(url).path).name) or "download"
            target = target / name
        handle, temp = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".part", dir=target.parent or ".")
        self.target, self.temp = target, Path(temp)
        self.file = os.fdopen(handle, "w+b")

    def reset(self) -> None:
        self.file.seek(0)
        self.file.truncate()

    def finish(self) -> bytes | Path:
        if self._buffer is not None:
            return self._buffer.getvalue()
        assert self.target is not None
        assert self.temp is not None
        self.file.close()
        os.replace(self.temp, self.target)
        return self.target

    def discard(self) -> None:
        if self.temp is not None:
            self.file.close()
            self.temp.unlink(missing_ok=True)


def job_id_of(job: Any) -> str:
    """Accept a job ID or any job object (``JobInitiated``, ``TtsJob``, results...)."""
    value = job if isinstance(job, str) else getattr(job, "id", None)
    if not isinstance(value, str) or not value.strip():
        raise UsageError("expected a job ID or a job object")
    return value.strip()


def check_options(options: Mapping[str, Any]) -> None:
    unknown = set(options) - _OPTION_KEYS
    if unknown:
        raise TypeError(f"unexpected keyword argument(s): {', '.join(sorted(unknown))}")


class BaseClient(Generic[HttpT]):
    _pool: _Pool[HttpT]

    def __init__(
        self,
        *,
        api_key: str | None,
        base_url: str | None,
        auth: Callable[[], Any] | None,
        timeout: float | Timeout | None,
        max_retries: int,
        deadline: float | None,
        rate_limit_preflight: bool,
        default_headers: Mapping[str, str] | None,
        on_request: Callable[[httpx.Request], Any] | None,
        on_response: Callable[[httpx.Response], Any] | None,
        runtime: Runtime | None,
        limits: _Limits | None,
    ) -> None:
        setup_from_env()
        self._base_url = resolve_base_url(base_url)
        self._auth = auth
        # With an auth hook the environment key is not used: it must never reach a custom proxy by accident.
        self._api_key = resolve_api_key(api_key, use_env=auth is None)
        if self._api_key is None and auth is None:
            raise UsageError(
                "No API key. Pass api_key=..., set ECHONOVA_API_KEY, or pass auth=... with base_url=... (proxy mode)."
            )
        if self._api_key and not self._api_key.startswith("ek_"):
            logger.warning("the API key does not start with 'ek_'; check it is an EchoNova API key")
        parts = urlsplit(self._base_url)
        if parts.path.rstrip("/").endswith("/v1"):
            logger.warning("base_url ends with /v1, but request paths already start with /v1")
        if self._api_key and parts.scheme == "http" and parts.hostname not in ("localhost", "127.0.0.1", "::1"):
            logger.warning("base_url uses plain http, so the API key would be sent unencrypted")
        if isinstance(max_retries, bool) or not isinstance(max_retries, int) or max_retries < 0:
            raise UsageError("max_retries must be a non-negative integer")
        self._timeout = Timeout.coerce(timeout)
        self._max_retries = max_retries
        self._deadline = deadline
        self._rate_limit_preflight = rate_limit_preflight
        self._default_headers = dict(default_headers or {})
        self._on_request = on_request
        self._on_response = on_response
        self._runtime = runtime or Runtime()
        self._limits = limits or _Limits(
            tracker=RateLimitTracker(clock=self._runtime.clock), limiter=PollLimiter(clock=self._runtime.clock)
        )
        self._user_agent = user_agent()

    # --- Public helpers ---------------------------------------------------------------------------

    @property
    def base_url(self) -> str:
        return self._base_url

    @property
    def rate_limits(self) -> dict[str, RateLimitInfo]:
        """The last rate-limit headers seen for each operation (``"text_to_speech.jobs.get"``, ...)."""
        return self._limits.tracker.snapshot()

    def __repr__(self) -> str:
        auth = ", auth=<hook>" if self._auth is not None else ""
        return f"{type(self).__name__}(base_url={self._base_url!r}, api_key={redact_key(self._api_key)!r}{auth})"

    # --- For the streaming layer ------------------------------------------------------------------

    @property
    def _ws_base_url(self) -> str:
        return ws_base_url(self._base_url)

    def _key_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._api_key}"} if self._api_key else {}

    def _auth_headers(self) -> dict[str, str]:
        """Credentials for one request or WebSocket upgrade: the API key, then the ``auth`` hook's headers."""
        headers = self._key_headers()
        if self._auth is None:
            return headers
        extra = self._auth()
        if inspect.isawaitable(extra):
            if inspect.iscoroutine(extra):
                extra.close()
            raise UsageError("the auth hook is async; use AsyncEchoNova and _async_auth_headers()")
        return merge_headers(headers, extra)

    async def _async_auth_headers(self) -> dict[str, str]:
        headers = self._key_headers()
        if self._auth is None:
            return headers
        extra = self._auth()
        if inspect.isawaitable(extra):
            extra = await extra
        return merge_headers(headers, extra)

    def _stream_options(self, *, asynchronous: bool) -> StreamOptions:
        """Stream settings derived from this client: URL, credentials, default headers and retries."""
        from ._streaming import StreamOptions  # imported here so REST-only use never loads websockets

        defaults = dict(self._default_headers)
        policy = RetryPolicy(max_retries=self._max_retries, rng=self._runtime.random)
        if asynchronous:

            async def async_headers() -> dict[str, str]:
                return merge_headers(defaults, await self._async_auth_headers())

            return StreamOptions(
                ws_base_url=self._ws_base_url, headers=async_headers, user_agent=self._user_agent, retry_policy=policy
            )

        def headers() -> dict[str, str]:
            return merge_headers(defaults, self._auth_headers())

        return StreamOptions(
            ws_base_url=self._ws_base_url, headers=headers, user_agent=self._user_agent, retry_policy=policy
        )

    # --- Shared construction for with_options() ---------------------------------------------------

    def _option_kwargs(self, changes: Mapping[str, Any]) -> dict[str, Any]:
        current: dict[str, Any] = {
            "api_key": self._api_key,
            "base_url": self._base_url,
            "auth": self._auth,
            "timeout": self._timeout,
            "max_retries": self._max_retries,
            "deadline": self._deadline,
            "rate_limit_preflight": self._rate_limit_preflight,
            "default_headers": self._default_headers,
            "on_request": self._on_request,
            "on_response": self._on_response,
        }
        unknown = set(changes) - set(current) - {"http_client"}
        if unknown:
            raise TypeError(f"with_options() got unexpected argument(s): {', '.join(sorted(unknown))}")
        merged = {**current, **{k: v for k, v in changes.items() if v is not NOT_GIVEN and k != "http_client"}}
        same_identity = all(merged[k] == current[k] for k in ("api_key", "base_url", "auth"))
        merged["_runtime"] = self._runtime
        merged["_limits"] = self._limits if same_identity else None
        return merged

    # --- Request flow -----------------------------------------------------------------------------

    def _timeout_for(self, op_write: float, op_read: float, override: float | Timeout | None) -> Timeout:
        base = Timeout(connect=DEFAULT_CONNECT_TIMEOUT, read=op_read, write=op_write, pool=DEFAULT_CONNECT_TIMEOUT)
        return base.overlay(self._timeout).overlay(Timeout.coerce(override))

    def _attempt_timeout(self, timeout: Timeout, deadline_at: float | None, sent_at: datetime | None) -> httpx.Timeout:
        values = [timeout.connect, timeout.read, timeout.write, timeout.pool]
        if deadline_at is not None:
            remaining = deadline_at - self._runtime.clock()
            if remaining <= 0:
                raise APITimeoutError("the deadline expired before the request was sent", kind="total", sent_at=sent_at)
            values = [remaining if v is None else min(v, remaining) for v in values]
        connect, read, write, pool = values
        return httpx.Timeout(connect=connect, read=read, write=write, pool=pool)

    def _retry_delay(
        self, decision: RetryDecision, deadline_at: float | None, what: str, attempt: int, cause: str
    ) -> float | None:
        if not decision.retry:
            return None
        if deadline_at is not None and self._runtime.clock() + decision.delay >= deadline_at:
            return None
        logger.info(
            "retrying %s in %.2f s (attempt %d: %s, rule %s)", what, decision.delay, attempt, cause, decision.row
        )
        return decision.delay

    def _build_request(
        self, spec: RequestSpec, url: str, auth: Mapping[str, str], timeout: httpx.Timeout, body: Any
    ) -> httpx.Request:
        accept = "application/json" if spec.op.envelope else "*/*"
        headers = merge_headers(
            {"User-Agent": self._user_agent, "Accept": accept},
            self._default_headers,
            auth,
            spec.options.get("extra_headers"),
        )
        kwargs: dict[str, Any] = {}
        if spec.json is not None:
            kwargs["content"] = json.dumps(spec.json, ensure_ascii=False, separators=(",", ":")).encode()
            headers = merge_headers(headers, {"Content-Type": "application/json"})
        elif spec.file is not None:
            kwargs["data"] = dict(spec.form or {})
            kwargs["files"] = {"file": (spec.file.filename, body, spec.file.content_type)}
        params = {k: v for k, v in (spec.query or {}).items() if v is not None}
        request: httpx.Request = self._pool.http.build_request(
            spec.op.method, url, params=params or None, headers=headers, timeout=timeout, **kwargs
        )
        return request

    def _api_flow(self, spec: RequestSpec, parser: Callable[[ApiResponse], T], *, raw: bool) -> Flow[Any]:
        """One API call: rate-limit waits, attempts and retries. Returns the parsed result or a ``RawResponse``."""
        op, options, clock = spec.op, spec.options, self._runtime.clock
        method, bucket, what = op.method, op.name, f"{op.method} {op.path}"
        policy = RetryPolicy(max_retries=options.get("max_retries", self._max_retries), rng=self._runtime.random)
        deadline = options.get("deadline", self._deadline)
        deadline_at = clock() + deadline if deadline is not None else None
        timeout = self._timeout_for(op.write_timeout, op.read_timeout, options.get("timeout"))
        path = op.path
        for name, value in spec.path_params.items():
            path = path.replace("{" + name + "}", quote(value, safe=""))
        url = self._base_url + path

        def full_parser(response: ApiResponse) -> T:
            if op.envelope:
                response = replace(response, data=unwrap_success(response.http.content))
            return parser(response)

        retries = 0
        first_sent_at: datetime | None = None
        no_response_seen = False
        while True:
            wait = self._limits.tracker.wait_time(bucket, preflight=self._rate_limit_preflight)
            if wait > 0:
                if wait > policy.max_retry_after or (deadline_at is not None and clock() + wait > deadline_at):
                    raise RateLimitError(
                        f"the rate limit for {bucket} clears in {wait:.0f} s, beyond what this call may wait; "
                        + ("nothing was sent" if first_sent_at is None else "the request was not sent again"),
                        retry_after=wait,
                        sent_at=first_sent_at,
                    )
                logger.debug("waiting %.1f s for the %s rate limit before sending", wait, bucket)
                yield Sleep(wait)

            auth = yield Authenticate()
            attempt_timeout = self._attempt_timeout(timeout, deadline_at, first_sent_at)
            body = spec.file.open() if spec.file is not None else None
            try:
                request = self._build_request(spec, url, auth, attempt_timeout, body)
                sent_at = self._runtime.now()
                first_sent_at = first_sent_at or sent_at
                started = clock()
                result = yield Send(request)
            finally:
                if spec.file is not None:
                    spec.file.close_attempt()
            elapsed = clock() - started
            replayable = spec.file.replayable if spec.file is not None else True

            if isinstance(result, Exception):
                phase, kind = classify_exception(result)
                logger.debug("%s failed: %s (attempt %d, %.2f s)", what, type(result).__name__, retries + 1, elapsed)
                if phase is None:
                    raise APIConnectionError(
                        f"{what} could not be sent: {result}", may_have_executed=False, sent_at=first_sent_at
                    ) from result
                no_response_seen = no_response_seen or phase == "no_response"
                decision = policy.decide_transport(method, phase, retries_done=retries, body_replayable=replayable)
                executed = executed_flag(decision.may_have_executed, method)
                if kind is not None and deadline_at is not None and clock() >= deadline_at:
                    kind = "total"
                message = PHASE_MESSAGES[phase].format(target=what) + f": {type(result).__name__}: {result}"
                if executed:
                    message += ". It may have run and been charged: check recent jobs before sending it again."
                error: APIConnectionError = (
                    APITimeoutError(message, kind=kind, may_have_executed=executed, sent_at=first_sent_at)
                    if kind is not None
                    else APIConnectionError(message, may_have_executed=executed, sent_at=first_sent_at)
                )
                delay = self._retry_delay(decision, deadline_at, what, retries + 1, type(result).__name__)
                if delay is not None:
                    yield Sleep(delay)
                    retries += 1
                    continue
                if decision.reason == "body_not_replayable":
                    error.retry_disabled_reason = "body_not_replayable"
                raise error from result

            response: httpx.Response = result
            self._limits.tracker.observe(bucket, response.headers)
            status = response.status_code
            request_id = response.headers.get("x-request-id")
            logger.debug("%s -> %d (request_id=%s, attempt %d, %.2f s)", what, status, request_id, retries + 1, elapsed)

            if 200 <= status < 300:
                if raw:
                    return RawResponse(ApiResponse(None, response), full_parser)
                try:
                    return full_parser(ApiResponse(None, response))
                except MalformedEnvelopeError as exc:
                    decision = policy.decide_transport(
                        method, "malformed_success", retries_done=retries, body_replayable=replayable
                    )
                    protocol_error = ProtocolError(
                        status_code=status,
                        error_message=f"unexpected response body: {exc}",
                        request_id=request_id,
                        headers=dict(response.headers.items()),
                        raw_body=response.content[:RAW_BODY_LIMIT].decode("utf-8", errors="replace") or None,
                        may_have_executed=executed_flag(decision.may_have_executed, method),
                        rule="malformed_success",
                        sent_at=first_sent_at,
                    )
                    delay = self._retry_delay(decision, deadline_at, what, retries + 1, "malformed response")
                    if delay is not None:
                        yield Sleep(delay)
                        retries += 1
                        continue
                    raise protocol_error from exc

            if status < 400:
                raise ProtocolError(
                    status_code=status,
                    error_message=f"unexpected HTTP {status} {response.reason_phrase}".strip(),
                    request_id=request_id,
                    headers=dict(response.headers.items()),
                    may_have_executed=None if method == "POST" else False,
                    sent_at=first_sent_at,
                )

            rule, retry_after = classify_response(status, response.headers, response.content)
            if method == "DELETE" and no_response_seen and rule.error == "JobNotFoundError":
                gone = ApiResponse({"deleted": True}, response, already_deleted=True)
                return RawResponse(gone, parser) if raw else parser(gone)
            status_error: APIStatusError = build_status_error(
                status,
                response.headers,
                response.content,
                method=method,
                sent_at=first_sent_at,
                reason_phrase=response.reason_phrase,
            )
            if rule.blocks_bucket and retry_after is not None:
                self._limits.tracker.block(bucket, retry_after)
            decision = policy.decide_status(
                method, rule, retries_done=retries, retry_after=retry_after, body_replayable=replayable
            )
            delay = self._retry_delay(decision, deadline_at, what, retries + 1, f"HTTP {status}")
            if delay is not None:
                yield Sleep(delay)
                retries += 1
                continue
            if decision.reason == "body_not_replayable":
                status_error.retry_disabled_reason = "body_not_replayable"
            raise status_error

    def _download_flow(self, url: str, sink: _Sink) -> Flow[None]:
        """GET a signed link with no credentials, retrying transient failures."""
        shown = redact_url(url)
        policy = RetryPolicy(max_retries=self._max_retries, rng=self._runtime.random)
        timeout = self._timeout_for(ops.DOWNLOAD_WRITE_TIMEOUT, ops.DOWNLOAD_READ_TIMEOUT, None)
        clock = self._runtime.clock
        retries = 0
        while True:
            sink.reset()
            request = self._pool.download_client().build_request(
                "GET",
                url,
                headers={"User-Agent": self._user_agent},
                timeout=self._attempt_timeout(timeout, None, None),
            )
            started = clock()
            result = yield Send(request, download=True, sink=sink.file)
            elapsed = clock() - started
            what = f"download {shown}"
            if isinstance(result, Exception):
                phase, kind = classify_exception(result)
                logger.debug(
                    "GET %s failed: %s (attempt %d, %.2f s)", shown, type(result).__name__, retries + 1, elapsed
                )
                if phase is None:
                    raise APIConnectionError(
                        f"{what} failed: {type(result).__name__}", may_have_executed=False
                    ) from result
                decision = policy.decide_transport("GET", phase, retries_done=retries)
                delay = self._retry_delay(decision, None, what, retries + 1, type(result).__name__)
                if delay is not None:
                    yield Sleep(delay)
                    retries += 1
                    continue
                message = PHASE_MESSAGES[phase].format(target=shown) + f": {type(result).__name__}"
                if kind is not None:
                    raise APITimeoutError(message, kind=kind, may_have_executed=False) from result
                raise APIConnectionError(message, may_have_executed=False) from result

            status = result.status_code
            logger.debug("GET %s -> %d (attempt %d, %.2f s)", shown, status, retries + 1, elapsed)
            if 200 <= status < 300:
                return
            if status == 403:
                raise DownloadExpiredError(
                    f"the download link was refused (HTTP 403); it has probably expired. Get the job again for "
                    f"a fresh link: {shown}",
                    url=shown,
                )
            rule, retry_after = classify_response(status, result.headers, b"")
            decision = policy.decide_status("GET", rule, retries_done=retries, retry_after=retry_after)
            delay = self._retry_delay(decision, None, what, retries + 1, f"HTTP {status}")
            if delay is not None:
                yield Sleep(delay)
                retries += 1
                continue
            # The storage body is not kept: it can echo details of the signed link.
            raise build_status_error(
                status, result.headers, b"", method="GET", reason_phrase=f"{what} failed: {result.reason_phrase}"
            )

    @staticmethod
    def _download_url(url: str | None) -> str:
        if not url or not isinstance(url, str):
            raise UsageError("no download URL: the job has no output yet")
        return url


__all__ = ["DEFAULT_MAX_RETRIES", "NOT_GIVEN", "BaseClient", "RequestSpec", "check_options", "job_id_of"]
