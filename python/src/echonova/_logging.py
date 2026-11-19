"""The ``echonova`` logger.

It records method, route template, status, request ID, attempt and timing. It
never records the API key, request or response bodies, or the query string of a
signed download link.
"""

from __future__ import annotations

import logging
import os
from urllib.parse import urlsplit, urlunsplit

logger = logging.getLogger("echonova")

_LEVELS = {"debug": logging.DEBUG, "info": logging.INFO, "warning": logging.WARNING, "error": logging.ERROR}
_configured = False


def setup_from_env() -> None:
    """Honour ``ECHONOVA_LOG=debug|info|warning|error`` once, if the app hasn't configured the logger."""
    global _configured
    if _configured:
        return
    _configured = True
    level = _LEVELS.get(os.environ.get("ECHONOVA_LOG", "").strip().lower())
    if level is None or logger.handlers:
        return
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("[%(asctime)s %(name)s %(levelname)s] %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(level)


def redact_url(url: str) -> str:
    """Drop the query string and fragment, which carry a signed link's signature, and any ``user:password@``."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return "<invalid url>"
    return urlunsplit((parts.scheme, parts.netloc.rpartition("@")[2], parts.path, "", ""))
