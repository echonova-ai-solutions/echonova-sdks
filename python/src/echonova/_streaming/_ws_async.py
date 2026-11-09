"""Async WebSocket driver: handshake with retries, one reader task, one send lock, keepalive."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidStatus, InvalidURI

from ..errors import UsageError
from ._aio import wait_event
from ._errors import CloseInfo
from ._link import PING_FRAME, AttemptLimiter, HandshakeRetry, Liveness, connect_kwargs, encode_json
from ._options import StreamOptions, resolve_headers_async, split_user_agent

logger = logging.getLogger("echonova.streaming")


class LinkClosed(Exception):
    """Internal: a send was attempted on a socket that is closed or closing."""


async def open_websocket(
    options: StreamOptions,
    url: str,
    *,
    limiter: AttemptLimiter,
    wait_for_slot: float | None = None,
    after_abnormal: bool = False,
) -> ClientConnection:
    """Open a socket, retrying the handshake as the retry table allows."""
    clock = options.clock
    retry = HandshakeRetry(
        options.policy(),
        now=clock(),
        wait_for_slot=wait_for_slot if wait_for_slot is not None else options.wait_for_slot,
        after_abnormal=after_abnormal,
        slot_wait_after_loss=options.reconnect_slot_wait,
    )
    first = True
    while True:
        wait = limiter.wait_time(clock())
        if wait > 0:
            if first or not retry.may_wait(clock(), wait):
                raise limiter.error()
            await asyncio.sleep(wait)
        first = False
        limiter.record(clock())
        headers, user_agent = split_user_agent(await resolve_headers_async(options), options.user_agent)
        try:
            return await connect(url, **connect_kwargs(options, connect, headers, user_agent))
        except InvalidStatus as exc:
            response = exc.response
            delay = retry.on_status(response.status_code, response.headers, bytes(response.body or b""), clock())
        except InvalidURI as exc:
            raise UsageError(f"invalid stream URL: {exc}") from exc
        except (OSError, TimeoutError, InvalidHandshake, ConnectionClosed) as exc:
            delay = retry.on_network(exc, url)
        logger.debug("stream handshake failed; retrying in %.2f s", delay)
        await asyncio.sleep(delay)


class AsyncLink:
    """One open socket. Callbacks run on the reader task and must not block."""

    def __init__(
        self,
        ws: ClientConnection,
        options: StreamOptions,
        *,
        on_text: Callable[[str], None],
        on_binary: Callable[[bytes], None],
        on_closed: Callable[[CloseInfo], None],
    ) -> None:
        self.ws = ws
        self._clock = options.clock
        self._close_timeout = options.close_timeout
        now = self._clock()
        self.opened_at = now
        self.liveness = Liveness(
            now,
            keepalive=options.keepalive,
            pong_timeout=options.pong_timeout,
            silence_timeout=options.silence_timeout,
        )
        self._on_text = on_text
        self._on_binary = on_binary
        self._on_closed = on_closed
        self._send_lock = asyncio.Lock()
        self._local_close = False
        self._lost_reason: str | None = None
        self.closed = False
        self.close_info: CloseInfo | None = None
        self.done = asyncio.Event()
        self._keeper_wake = asyncio.Event()
        self._reader = asyncio.create_task(self._read_loop())
        self._keeper = asyncio.create_task(self._keepalive_loop()) if options.keepalive is not None else None

    @property
    def handshake_request_id(self) -> str | None:
        response = self.ws.response
        return response.headers.get("X-Request-Id") if response is not None else None

    def age(self, now: float) -> float:
        return now - self.opened_at

    def pong(self) -> None:
        self.liveness.pong(self._clock())
        self._keeper_wake.set()  # the next ping is now due earlier than the keeper planned

    async def send_text(self, text: str) -> None:
        async with self._send_lock:
            if self.closed or self._local_close:
                raise LinkClosed
            try:
                await self.ws.send(text)
            except ConnectionClosed as exc:
                raise LinkClosed from exc
            self.liveness.sent(self._clock())

    async def send_json(self, payload: dict[str, object]) -> None:
        await self.send_text(encode_json(payload))

    async def send_bytes(self, data: bytes) -> None:
        async with self._send_lock:
            if self.closed or self._local_close:
                raise LinkClosed
            try:
                await self.ws.send(data)
            except ConnectionClosed as exc:
                raise LinkClosed from exc
            self.liveness.sent(self._clock())

    async def close(self, code: int = 1000, reason: str = "") -> None:
        """Close cleanly (the SDK's own close: not an error). Waits until the reader has finished."""
        if not self.closed:
            self._local_close = True
            closing = asyncio.ensure_future(self.ws.close(code, reason))
            try:
                await asyncio.wait([closing], timeout=self._close_timeout + 1)
            finally:
                if not closing.done():
                    closing.cancel()
                    self.abort(None)
                elif not closing.cancelled() and closing.exception() is not None:
                    self.abort(None)
        await self.done.wait()

    def abort(self, lost_reason: str | None) -> None:
        """Drop the connection now, without a close handshake."""
        if lost_reason is not None and self._lost_reason is None:
            self._lost_reason = lost_reason
        transport = getattr(self.ws, "transport", None)
        if transport is not None:
            transport.abort()

    async def _read_loop(self) -> None:
        code, reason = 1006, ""
        try:
            while True:
                message = await self.ws.recv()
                self.liveness.received(self._clock())
                if isinstance(message, str):
                    self._on_text(message)
                else:
                    self._on_binary(bytes(message))
        except ConnectionClosed as exc:
            if exc.rcvd is not None:
                code, reason = exc.rcvd.code, exc.rcvd.reason
            elif self._local_close and exc.sent is not None and self._lost_reason is None:
                code, reason = exc.sent.code, exc.sent.reason
        except asyncio.CancelledError:
            self.abort(None)
            raise
        except Exception:  # a bug in a callback: don't leave the socket half-alive
            logger.exception("stream reader failed")
            self._lost_reason = self._lost_reason or "internal error in the stream reader"
            self.abort(None)
        finally:
            self.closed = True
            self._keeper_wake.set()
            if self._keeper is not None:
                self._keeper.cancel()
            self.close_info = CloseInfo(code, reason, local=self._local_close, lost_reason=self._lost_reason)
            try:
                self._on_closed(self.close_info)
            finally:
                self.done.set()

    async def _keepalive_loop(self) -> None:
        while not self.closed:
            now = self._clock()
            action = self.liveness.poll(now)
            if action == "ping":
                self.liveness.ping_sent(now)
                with contextlib.suppress(LinkClosed):
                    await self.send_text(PING_FRAME)
                continue
            if action is not None:
                logger.warning("stream connection lost: %s", self.liveness.describe(action))
                self.abort(self.liveness.describe(action))
                return
            deadline = self.liveness.next_deadline()
            if deadline is None:
                return
            self._keeper_wake.clear()
            await wait_event(self._keeper_wake, max(0.0, deadline - self._clock()) + 0.001)
