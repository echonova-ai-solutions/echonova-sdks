# 8. Keys stay on servers: the browser guard, proxy mode and reference proxies

Date: 2026-11-09

## Status

Accepted

## Context

An EchoNova API key (`ek_…`) spends the workspace's credits. Anything shipped to a user's device can be extracted: a web page's source, a mobile app bundle, a desktop binary. The EchoNova docs say never to send an API key to a user's device.

Browsers can't set the `Authorization` header on a WebSocket, so a browser can't open the streams with an API key at all, as the published AsyncAPI spec notes. Web and Flutter apps still need speech features, including streaming.

Keys can also leak through logs, error messages, `repr()` output, or by being sent to a host that isn't EchoNova, such as the storage host behind a signed download link.

## Decision

### The key is sent only to EchoNova, and never logged

- `Authorization: Bearer <key>` goes on every REST call and every WebSocket upgrade, and **only to the configured EchoNova origin**.
- `download()` uses a separate HTTP client with **no auth header**, because signed links point at a storage host, not at EchoNova.
- Keys are redacted everywhere: `repr(client)` and errors show only the last four characters (`ek_…c21d`).
- Logs never contain the `Authorization` header, request or response bodies (text, transcripts, audio), the query string of signed links, or webhook secrets. Tests assert this by capturing log output.
- The SDK reads the key from `ECHONOVA_API_KEY` by default, so it doesn't have to appear in code.

### The browser guard

- In the TypeScript SDK, creating a client **with an API key in a browser raises `UnsupportedEnvironmentError`**, unless the developer sets `dangerouslyAllowBrowser: true`. The option's name is meant to make the risk obvious in code review.
- The guard triggers only when an API key is present. Proxy mode, described next, works in browsers without any opt-in.
- Streaming from a browser with an API key is impossible, so it's refused with a clear error rather than failing during the handshake.

### Proxy mode for browsers and Flutter apps

- Every SDK accepts a custom base URL plus an **`auth` hook** that returns headers: `base_url` and `auth` in Python, `baseURL` and `auth` in TypeScript, `EchoNova.proxy(baseUrl:, auth:)` in Dart.
- In proxy mode, the app sends its own credentials, such as a session token or cookie, to the developer's backend. The backend adds the EchoNova key and forwards the request.
- The client-side SDK behaves exactly as it does against the API: the same methods, errors, retries and streaming.
- **The Flutter SDK uses proxy mode for apps.** `EchoNova(apiKey:)` is for server-side Dart only. Flutter web supports proxy mode only.

### Reference proxies

`proxy-examples/` holds reference backend proxies in FastAPI (Python) and Express (Node). They:

- forward only an **allow-list** of the API's REST routes and two streams, and are never open proxies;
- authenticate each user and apply per-user quotas;
- add the EchoNova key to the upstream request, and never return it to the client;
- pass WebSocket traffic through in both directions and preserve close codes, which the SDKs rely on (ADR 0007);
- pass request IDs back to the client;
- stream uploads instead of buffering them.

They use plain HTTP and WebSocket forwarding, don't depend on any SDK, and are tested in CI.

## Consequences

- An app that follows the SDK defaults can't leak its key to end users.
- Browser and mobile developers must run a backend. The reference proxies make that a small, known task, and the guides lead with proxy setup.
- `dangerouslyAllowBrowser` exists for internal tools and demos. Using it is the developer's explicit choice.
- The proxies are security-sensitive code in a public repository. Changes to them get the same review as SDK code, and security reports cover them (see `SECURITY.md`).
- If the API later offers a way for apps to authenticate without a long-lived key, this decision will be revisited.
