"""Run the proxy: uv run python -m echonova_proxy (settings come from the environment)."""

from __future__ import annotations

import logging
import os
import sys

import uvicorn

from .app import create_app
from .config import ConfigError, Settings
from .log import configure_logging, log_event


def main() -> int:
    configure_logging()
    try:
        app = create_app(Settings.from_env())
    except ConfigError as exc:
        log_event("proxy.config_error", logging.ERROR, message=str(exc))
        return 2
    uvicorn.run(
        app,
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8080")),
        log_config=None,  # keep the JSON logging configured above
        access_log=False,  # the proxy logs each request itself, without query strings
        ws="websockets-sansio",
        ws_max_size=1024 * 1024,  # the API's own frame limit
        ws_per_message_deflate=False,  # audio doesn't compress; the API doesn't compress either
        proxy_headers=False,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
