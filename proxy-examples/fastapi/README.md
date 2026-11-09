# EchoNova proxy: FastAPI

A reference backend proxy that lets your apps use EchoNova while the API key stays on your server. Start with [the overview](../README.md): it explains what the proxy does, how to point the SDKs at it and what to check before you deploy.

Python 3.11+, with FastAPI, uvicorn, httpx and websockets.

## Run it

```bash
cd proxy-examples/fastapi
uv sync
export ECHONOVA_API_KEY=ek_...                          # your key, from a secret store
export PROXY_DEMO_TOKEN=change-me                       # demo auth only: replace the hook
export PROXY_ALLOWED_ORIGINS=http://localhost:3000      # your web app, if any
uv run python -m echonova_proxy                         # http://127.0.0.1:8080/echonova
```

Try it:

```bash
curl http://127.0.0.1:8080/healthz
curl -H "Authorization: Bearer change-me" http://127.0.0.1:8080/echonova/v1/text-to-speech/voices
```

All settings are environment variables; see [Configuration](../README.md#configuration-both-proxies).

`python -m echonova_proxy` runs uvicorn with the settings the proxy expects: JSON logs, no access log (it would print query strings), uvicorn's default WebSocket implementation (`websockets-sansio`), a 1 MiB WebSocket frame limit (the API's own), and no WebSocket compression. If you start uvicorn yourself, keep those settings (`--ws websockets-sansio --ws-max-size 1048576 --ws-per-message-deflate false --no-access-log`). Run it behind a TLS-terminating load balancer or reverse proxy.

## Plug in your authentication and quota

```python
from starlette.requests import HTTPConnection

from echonova_proxy import InMemoryQuota, Settings, create_app


async def authenticate(conn: HTTPConnection) -> str | None:
    """Return your user's id, or None for 401. conn is a Request or a WebSocket."""
    session = await my_sessions.load(conn.cookies.get("session"))  # or verify a JWT from conn.headers
    return session.user_id if session else None


app = create_app(
    Settings.from_env(),
    authenticate=authenticate,
    quota=InMemoryQuota(requests_per_minute=30, max_streams_per_user=1),
)
```

- `authenticate` runs for every REST call and every WebSocket upgrade. On upgrades, a valid `?access_token=` stream token is accepted before your hook is called.
- `quota` is any object with `allow_request(user_id)`, `acquire_stream(user_id)` and `release_stream(user_id)` (see `hooks.py`). `InMemoryQuota` keeps its counters in one process: with several workers or instances, implement the same three methods on Redis or your database.
- With your own hook, `PROXY_DEMO_TOKEN` isn't needed. Without either, `create_app` refuses to build the app.

You can serve `app` on its own, or mount it at `/` inside an existing FastAPI app, after your own routes: `my_app.mount("/", app)`.

## Files

| File | What it holds |
|---|---|
| `echonova_proxy/routes.py` | The allow-list. Delete the routes you don't use. |
| `echonova_proxy/hooks.py` | The demo `authenticate` hook (**replace it**) and `InMemoryQuota`. |
| `echonova_proxy/http_proxy.py` | REST relay: checks, key injection, streaming in both directions. |
| `echonova_proxy/ws_proxy.py` | WebSocket relay: handshake mirroring, frames, close codes. |
| `echonova_proxy/app.py` | `create_app`, CORS and the cross-site origin check, `/healthz`, `/stream-token`. |
| `echonova_proxy/tokens.py` | Short-lived stream tokens (same format as the Express proxy). |
| `echonova_proxy/config.py` | Settings and their checks. |
| `echonova_proxy/log.py` | JSON logs, and redaction of library log lines. |

## Notes

- uvicorn 0.53 or later is required (`pyproject.toml` says so). Earlier versions of its default WebSocket implementation don't wait for a slow app to read, so the proxy would buffer audio for it without limit. The backpressure tests catch this.
- Outbound calls honour the standard `HTTPS_PROXY` and `NO_PROXY` variables (httpx and websockets both read them), in case your servers reach the internet through an egress proxy.
- Logs carry only the exception type, never its message or traceback, because those can quote request data. Debug logging for httpx, httpcore and websockets is capped at warnings for the same reason.
- uvicorn 0.54 logs "ASGI callable returned without completing handshake" after each WebSocket upgrade refused with an HTTP response. The proxy filters out that false alarm; the refusal itself is logged as `ws.rejected`.

## Test

```bash
uv run ruff check . && uv run ruff format --check . && uv run pytest
```

The tests run the proxy and a fake EchoNova API (HTTP and WebSocket) as real servers on `127.0.0.1`. They cover the allow-list (checked against `spec/openapi.json` and `spec/asyncapi.json`), key injection, header filtering, user auth, quotas, a 150 MiB upload (chunked, with peak memory checked), a 64 MiB download, WebSocket relaying in both directions with backpressure, close codes, refused handshakes, CORS, shutdown, mounting inside another app, and logs without secrets.
