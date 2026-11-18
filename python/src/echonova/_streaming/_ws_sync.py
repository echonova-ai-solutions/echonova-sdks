"""Sync WebSocket driver: handshake with retries, one background reader thread, one send lock.

The reader thread also runs the keepalive and the session's timers, by waking
up from ``recv(timeout=...)`` at the next deadline.
"""

from __future__ import annotations

import contextlib
import logging
import socket
import threading
import time
from collections.abc import Callable
from typing import Any

from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidStatus, InvalidURI
from websockets.sync.client import ClientConnection, connect

from ..errors import UsageError
from ._errors import CloseInfo
from ._link import (
    PING_FRAME,
    AttemptLimiter,
    HandshakeRetry,
    Liveness,
    connect_kwargs,
    encode_json,
)
from ._options import StreamOptions, resolve_headers_sync, split_user_agent
from ._ws_redirect import HandshakeRedirect

logger = logging.getLogger("echonova.streaming")


class LinkClosed(Exception):
    """Internal: a send was attempted on a socket that is closed or closing."""


class _NoRedirectConnection(ClientConnection):
    """A connection whose handshake never follows a redirect (see ``HandshakeRedirect``)."""

    def handshake(self, *args: Any, **kwargs: Any) -> None:
        try:
            super().handshake(*args, **kwargs)
        except InvalidStatus as exc:
            if 300 <= exc.response.status_code < 400:
                raise HandshakeRedirect(exc.response) from exc
            raise


def open_websocket_sync(
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
            time.sleep(wait)
        first = False
        limiter.record(clock())
        headers, user_agent = split_user_agent(resolve_headers_sync(options), options.user_agent)
        try:
            kwargs = connect_kwargs(options, connect, headers, user_agent)
            ws: ClientConnection = connect(url, create_connection=_NoRedirectConnection, **kwargs)
            return ws
        except (InvalidStatus, HandshakeRedirect) as exc:
            response = exc.response
            delay = retry.on_status(response.status_code, response.headers, bytes(response.body or b""), clock())
        except InvalidURI as exc:
            raise UsageError(f"invalid stream URL: {exc}") from exc
        except (OSError, TimeoutError, InvalidHandshake, ConnectionClosed) as exc:
            delay = retry.on_network(exc, url)
        logger.debug("stream handshake failed; retrying in %.2f s", delay)
        time.sleep(delay)


class SyncLink:
    """One open socket. Callbacks run on the reader thread and must not block for long.

    ``tick(now)`` is called on the reader thread at least at every deadline it
    returns, for the session's own timers.
    """

    def __init__(
        self,
        ws: ClientConnection,
        options: StreamOptions,
        *,
        on_text: Callable[[str], None],
        on_binary: Callable[[bytes], None],
        on_closed: Callable[[CloseInfo], None],
        tick: Callable[[float], float | None] | None = None,
        name: str = "stream",
    ) -> None:
        self.ws = ws
        self._clock = options.clock
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
        self._tick = tick
        self._send_lock = threading.Lock()
        self._local_close = False
        self._lost_reason: str | None = None
        self.closed = False
        self.close_info: CloseInfo | None = None
        self.done = threading.Event()
        self._thread = threading.Thread(target=self._run, name=f"echonova-{name}-reader", daemon=True)
        self._thread.start()

    @property
    def handshake_request_id(self) -> str | None:
        response = self.ws.response
        return response.headers.get("X-Request-Id") if response is not None else None

    def age(self, now: float) -> float:
        return now - self.opened_at

    def on_reader_thread(self) -> bool:
        return threading.current_thread() is self._thread

    def pong(self) -> None:
        self.liveness.pong(self._clock())

    def send_text(self, text: str) -> None:
        with self._send_lock:
            if self.closed or self._local_close:
                raise LinkClosed
            try:
                self.ws.send(text)
            except ConnectionClosed as exc:
                raise LinkClosed from exc
            self.liveness.sent(self._clock())

    def send_json(self, payload: dict[str, object]) -> None:
        self.send_text(encode_json(payload))

    def send_bytes(self, data: bytes) -> None:
        with self._send_lock:
            if self.closed or self._local_close:
                raise LinkClosed
            try:
                self.ws.send(data)
            except ConnectionClosed as exc:
                raise LinkClosed from exc
            self.liveness.sent(self._clock())

    def close(self, code: int = 1000, reason: str = "") -> None:
        """Close cleanly (the SDK's own close: not an error). Waits for the reader unless called from it."""
        if not self.closed:
            self._local_close = True
            try:
                self.ws.close(code, reason)
            except OSError:
                self.abort(None)
        if not self.on_reader_thread():
            self.done.wait()

    def abort(self, lost_reason: str | None) -> None:
        """Drop the connection now, without a close handshake."""
        if lost_reason is not None and self._lost_reason is None:
            self._lost_reason = lost_reason
        with contextlib.suppress(OSError):
            self.ws.socket.shutdown(socket.SHUT_RDWR)

    def _next_timeout(self, now: float) -> float | None:
        if self._lost_reason is not None:
            return 0.05  # aborting: wait for the library to notice the dead socket
        candidates = (self.liveness.next_deadline(), self._tick(now) if self._tick else None)
        deadlines = [d for d in candidates if d is not None]
        if not deadlines:
            return None
        return max(0.0, min(deadlines) - now) + 0.001

    def _run(self) -> None:
        code, reason = 1006, ""
        try:
            while True:
                now = self._clock()
                action = self.liveness.poll(now)
                if action == "ping":
                    self.liveness.ping_sent(now)
                    with contextlib.suppress(LinkClosed):
                        self.send_text(PING_FRAME)
                elif action is not None and self._lost_reason is None:
                    logger.warning("stream connection lost: %s", self.liveness.describe(action))
                    self.abort(self.liveness.describe(action))
                try:
                    message = self.ws.recv(timeout=self._next_timeout(self._clock()))
                except TimeoutError:
                    continue
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
        except Exception:  # a bug in a callback: don't leave the socket half-alive
            logger.exception("stream reader failed")
            self._lost_reason = self._lost_reason or "internal error in the stream reader"
            self.abort(None)
        finally:
            self.closed = True
            self.close_info = CloseInfo(code, reason, local=self._local_close, lost_reason=self._lost_reason)
            try:
                self._on_closed(self.close_info)
            finally:
                self.done.set()
