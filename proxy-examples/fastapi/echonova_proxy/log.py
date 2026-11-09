"""Structured (JSON lines) logging.

Log lines carry the route template, status, user id, timings and request ids. They never
carry the API key, request or response bodies, query strings, cookies, tokens or headers.
"""

from __future__ import annotations

import json
import logging
import re
import sys
import time
from typing import Any

logger = logging.getLogger("echonova_proxy")


def log_event(event: str, level: int = logging.INFO, **fields: Any) -> None:
    logger.log(level, event, extra={"fields": {k: v for k, v in fields.items() if v is not None}})


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        line: dict[str, Any] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + f".{int(record.msecs):03d}Z",
            "level": record.levelname.lower(),
            "logger": record.name,
            "event": record.getMessage(),
        }
        line.update(getattr(record, "fields", {}))
        if record.exc_info and record.exc_info[0] is not None:
            # The exception type only: messages and tracebacks can quote request data.
            line["error"] = record.exc_info[0].__name__
        return json.dumps(line, ensure_ascii=False, default=str)


_TOKEN_IN_URL = re.compile(r"(access_token=)[^&\s\"']+")
# uvicorn's default WebSocket implementation (0.54) logs this after every upgrade refused with an
# HTTP response, which is how the proxy answers refused streams. It is logged as ws.rejected instead.
_FALSE_ALARM = "ASGI callable returned without completing handshake"


class RedactingFilter(logging.Filter):
    """Keeps tokens, credentials and stream content out of server log lines, at any log level."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        if message.startswith(_FALSE_ALARM):
            return False
        if record.levelno <= logging.DEBUG and message.startswith(("< ", "> ")):
            return False  # wire-level debug lines quote headers, URLs and frame contents
        redacted = _TOKEN_IN_URL.sub(r"\1REDACTED", message)
        if redacted != message:
            record.msg, record.args = redacted, ()
        return True


def quiet_libraries() -> None:
    """Make library logging safe. Called when the app starts, whatever server runs it.

    httpx, httpcore and websockets print URLs and (at DEBUG) request headers, which include the
    API key on upstream calls: they are limited to warnings. uvicorn's access log prints query
    strings: the proxy logs each request itself instead. uvicorn's error log is redacted.
    """
    for name in ("httpx", "httpcore", "websockets"):
        logging.getLogger(name).setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").disabled = True
    server_log = logging.getLogger("uvicorn.error")
    if not any(isinstance(f, RedactingFilter) for f in server_log.filters):
        server_log.addFilter(RedactingFilter())


def configure_logging(level: int = logging.INFO) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    handler.addFilter(RedactingFilter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)
    quiet_libraries()
