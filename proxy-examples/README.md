# EchoNova reference proxies

Small servers you run on your own backend so that browser, Flutter and mobile apps can use EchoNova **without ever holding your API key**.

| Proxy | Stack | Folder |
|---|---|---|
| FastAPI | Python 3.11+, FastAPI, httpx, websockets | [`fastapi/`](fastapi/) |
| Express | Node 22.19+, Express 5, ws, undici | [`express/`](express/) |

Both behave the same way and pass the same test cases. Pick the one that matches your backend, or read them as a blueprint for your own framework. They don't depend on any EchoNova SDK.

## Why a proxy

An EchoNova API key (`ek_…`) can spend your credits. Anything shipped inside an app can be extracted from it, so **a key must never be in a browser bundle, a mobile app or a desktop app**. Browsers also can't set the `Authorization` header on a WebSocket, so they can't open the streaming endpoints with a key at all.

The proxy sits between your apps and EchoNova:

```
app (your user's session)  ──►  your proxy  ──►  api.echonova.ai (your API key)
                                 checks the user
                                 applies a quota
                                 adds the key
```

1. The app calls the proxy with **its own credentials**: your session cookie or your access token.
2. The proxy checks the user (the `authenticate` hook) and their quota (the `quota` hook).
3. It removes the app's credentials, adds `Authorization: Bearer <API key>` and forwards the call. Uploads, downloads and WebSocket frames are streamed, never held in memory.
4. It relays EchoNova's answer: the same status code and body, and only a short list of safe headers.

## Point the SDKs at the proxy

Every SDK has a proxy mode: a base URL on your server and an `auth` callback that supplies **your** credentials instead of an API key. With the proxy mounted under `/echonova` on `https://api.myapp.com`:

**Python**

```python
from echonova import EchoNova


def access_token() -> str: ...  # your user's access token


client = EchoNova(
    base_url="https://api.myapp.com/echonova",
    auth=lambda: {"Authorization": f"Bearer {access_token()}"},
)
```

**TypeScript / JavaScript**

```ts
import EchoNova from 'echonova';

declare function accessToken(): Promise<string>; // your user's access token

const client = new EchoNova({
  baseURL: 'https://api.myapp.com/echonova',
  auth: async () => ({ Authorization: `Bearer ${await accessToken()}` }),
});
```

In a browser that authenticates with a cookie instead, pass `auth: () => ({})` (no extra headers: the cookie does the work) and make the SDK's requests carry cookies across origins: `fetch: (url, init) => fetch(url, { ...init, credentials: 'include' })`. No `apiKey` is set, so the SDK's browser guard doesn't apply.

**Dart / Flutter**

```dart
import 'package:echonova/echonova.dart';

Future<String> accessToken() async => '...'; // your user's access token

final client = EchoNova.proxy(
  baseUrl: Uri.parse('https://api.myapp.com/echonova'),
  auth: () async => {'Authorization': 'Bearer ${await accessToken()}'},
);
```

The SDKs derive the stream URLs from the base URL (`wss://api.myapp.com/echonova/v1/text-to-speech/stream`), so streaming goes through the proxy too.

### WebSockets in browsers

Browsers can't add headers to a WebSocket. The proxy accepts two other ways to identify the user on a stream:

- **A cookie.** The browser sends your session cookie with the WebSocket upgrade when the proxy is on your site (same site, or a cookie scoped to it).
- **A short-lived token in the URL.** The app first calls `POST /echonova/stream-token` with its normal credentials and gets `{"token": "…", "expiresIn": 60}`. It then opens the stream with `?access_token=<token>` added to the URL within 60 seconds. The proxy takes `access_token` out of the URL before it forwards the upgrade or logs anything.

Apps that can set headers (server-side, mobile, desktop) just send their `Authorization` header on the upgrade, like on REST calls.

## What the proxy does

**Forwards only the EchoNova speech API (an allow-list, never an open proxy).**
- The 16 REST routes of Text to Speech, Speech to Text and Sound Cleaning, each with its own method. A test checks the list against [`spec/openapi.json`](../spec/openapi.json).
- The 2 streams: `/v1/text-to-speech/stream` and `/v1/speech-to-text/stream`. Only the documented Speech to Text query parameters (`sample_rate`, `language`, `encoding`) are passed on.
- Widget tickets (`POST /v1/widgets/{publicId}/tickets`) and agent sessions (`/v1/agents/{agentId}/sessions...`) are left out on purpose. Your backend calls them directly, after deciding which of your users may start a session: starting one spends workspace credits and returns a room token for that user.
- Anything else is `404`. A known route with the wrong method is `405`, with an `Allow` header. Path parameters must be a single plain segment (`[A-Za-z0-9_-]`), so an encoded `../` can't reach another route.

**Authenticates your user, then applies a quota.** Both are hooks you replace (see each proxy's README):
- `authenticate(request)` returns your user's id, or nothing for `401`. The demo version accepts one static token (`PROXY_DEMO_TOKEN`) as a Bearer header or a cookie. **Replace it.**
- `quota` allows N requests a minute per user (`429` with `Retry-After`) and caps concurrent streams per user and in total (`429 Too many concurrent streams`). Your EchoNova workspace allows **10 concurrent streams in total** (TTS and STT combined), across everything that uses it.

**Handles the key.**
- The key comes only from `ECHONOVA_API_KEY`. It is never accepted from the app, never returned and never logged.
- Request headers are copied from an allow-list (`Accept`, `Content-Type`, `Content-Length`, the app's `User-Agent`). The app's `Authorization`, `Cookie`, hop-by-hop and any other headers are dropped.
- Response headers are copied from an allow-list: `Content-Type`, `Content-Disposition`, `Retry-After`, `X-RateLimit-*` and `X-Request-Id`. The proxy adds `Cache-Control: no-store`.
- The proxy refuses to start if `ECHONOVA_UPSTREAM_URL` isn't `https://` (local test servers excepted), so the key never travels in clear text. It never follows redirects.

**Streams everything.**
- Request bodies go upstream as they arrive, so a 150 MiB upload never sits in memory. The tests send 150 MiB and check both chunked transfer and memory use. Uploads larger than `PROXY_MAX_UPLOAD_BYTES` (160 MiB by default) are refused with `413`.
- Responses stream back with EchoNova's status code. If EchoNova's answer is cut off midway, the proxy drops the app's connection, so a partial download can never look complete.
- Upstream timeouts: 10 s to connect, 600 s to read. **Synchronous calls (`…/sync`, Sound Cleaning) can take several minutes on long audio.** Make sure your load balancer and your app's HTTP client allow that, or use the async job routes for long files.

**Relays WebSockets faithfully.**
- The app's upgrade is held until EchoNova accepts the proxy's own. If EchoNova refuses (401, 402, 403, 429, 503, …), the app gets **the same status, JSON body and safe headers**, so the SDK raises the same error as it would without a proxy.
- Text and binary frames are relayed in both directions, in order. A side that can't keep up slows the other one down (backpressure) instead of filling the proxy's memory.
- Close codes and reasons are repeated on the other side: `4002`, `4029`, `4008`, `1011`, `1008`, `1001` and the rest. The SDKs rely on them to report the right error.

  | One side… | The other side gets |
  |---|---|
  | closes with a code and reason | the same code and reason |
  | closes without a code (1005) | `1000` |
  | drops without a close frame (1006) | dropped too (the SDK sees `1006`) |
  | the proxy stops | `1012` on both sides |

**Also:** CORS for the origins you list (with credentials, for cookies); a `403` for requests carrying any other `Origin`, which blocks cross-site form posts and WebSockets that would ride on your users' cookies; `X-Request-Id` propagation (the app's id is forwarded, EchoNova's is returned); `GET /healthz`; and JSON log lines without secrets.

Errors the proxy produces itself use the EchoNova error shape, `{"data": null, "success": false, "statusCode": …, "errorMessage": "…"}`, so the SDKs handle them like API errors:

| Status | `errorMessage` | When |
|---|---|---|
| 401 | `Unauthorized` | `authenticate` returned nothing, or a stream token is invalid or expired |
| 403 | `Origin not allowed` | the request's `Origin` isn't in `PROXY_ALLOWED_ORIGINS` |
| 404 | `Route not found` | not on the allow-list |
| 405 | `Method not allowed` | known route, wrong method (see `Allow`) |
| 413 | `Request body too large` | over `PROXY_MAX_UPLOAD_BYTES` |
| 426 | `This route needs a WebSocket upgrade` | a stream route called without an upgrade |
| 429 | `Too many requests` + `Retry-After` | the user's per-minute quota |
| 429 | `Too many concurrent streams` | the user's (or the proxy's) stream cap |
| 500 | `Internal server error` | a hook threw; details stay in the server log |
| 502 | `Bad gateway: …` | EchoNova's connection failed after the request was sent, or it answered with a redirect |
| 503 | `The EchoNova API is temporarily unavailable. Try again.` | the proxy couldn't connect, so nothing was sent and a retry is safe |
| 504 | `Gateway timeout: …` | no answer within the read timeout |

## Configuration (both proxies)

| Variable | Default | Meaning |
|---|---|---|
| `ECHONOVA_API_KEY` | required | Your API key. Keep it in a secrets manager or your platform's secret store. |
| `ECHONOVA_UPSTREAM_URL` | `https://api.echonova.ai` | The API host, without a path. |
| `PROXY_PREFIX` | `/echonova` | Path the proxy is mounted under. Apps use `https://<your host><prefix>` as their base URL. |
| `PROXY_ALLOWED_ORIGINS` | none | Comma-separated web origins allowed to call the proxy from a browser, e.g. `https://app.example.com`. Include the proxy's own origin if your web app is served from it. |
| `PROXY_DEMO_TOKEN` | none | Demo auth only. Without it (and without your own `authenticate` hook) the proxy refuses to start. |
| `PROXY_SESSION_COOKIE` | `session` | Cookie name the demo auth reads. |
| `PROXY_STREAM_TOKEN_SECRET` | random per process | Signs stream tokens. Set the same value on every instance. |
| `PROXY_REQUESTS_PER_MINUTE` | `60` | Demo quota: requests per user per minute (streams count too). |
| `PROXY_MAX_STREAMS_PER_USER` | `2` | Demo quota: concurrent streams per user. |
| `PROXY_MAX_STREAMS_TOTAL` | `10` | Demo quota: concurrent streams for the whole proxy. |
| `PROXY_MAX_UPLOAD_BYTES` | `167772160` (160 MiB) | Largest request body accepted. |
| `HOST`, `PORT` | `127.0.0.1`, `8080` | Where the proxy listens. Use `HOST=0.0.0.0` in a container. |

## Security checklist

Before you deploy:

- [ ] **Allow-list:** delete the routes your app doesn't use from the route table. Never add a catch-all route.
- [ ] **User auth:** replace the demo `authenticate` hook with your real session or token check. Unset `PROXY_DEMO_TOKEN`.
- [ ] **Quotas:** set limits that match what one user should be able to spend. With more than one proxy instance, move the counters to a shared store (Redis, your database). Remember the workspace-wide limit of 10 concurrent streams.
- [ ] **Origins:** list your exact web origins in `PROXY_ALLOWED_ORIGINS`. Never use a wildcard. Set session cookies with `Secure`, `HttpOnly` and `SameSite=Lax` (or `Strict`).
- [ ] **HTTPS only:** serve the proxy over HTTPS and the streams over `wss://`, behind a load balancer or reverse proxy that terminates TLS. Allow long requests (several minutes) and long-lived WebSockets (up to 30 minutes) there.
- [ ] **Logging:** keep the proxy's logs as they are: no bodies, no query strings, no headers. Don't turn on debug logging for the HTTP or WebSocket libraries in production; they print headers, including the API key.
- [ ] **The key:** keep it only in the server's environment or secrets manager, give it access only to the services you use and a spending limit, and **rotate it**: create a new key, deploy it, then delete the old one. Rotate at once if it may have leaked.
- [ ] **Stream tokens:** keep the lifetime short (60 s) and set `PROXY_STREAM_TOKEN_SECRET` from your secrets manager.
- [ ] **Webhooks** don't go through this proxy: receive them on your server and verify their signature with the SDK.

## Running the tests

The tests start a fake EchoNova API (HTTP and WebSocket) on `127.0.0.1` and never call the real one.

```bash
cd proxy-examples/fastapi && uv sync && uv run ruff check . && uv run pytest
cd proxy-examples/express && npm ci && npm run typecheck && npm test
```
