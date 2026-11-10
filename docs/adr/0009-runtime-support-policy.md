# 9. Runtime support policy

Date: 2026-11-09

## Status

Accepted

## Context

Each SDK has to choose which language versions and runtimes it supports. Supporting old versions widens adoption but holds back the code, the type system and the dependencies. Developers also need to know, in advance, when a version will stop being supported.

Streaming adds a technical constraint: the SDK must be able to read a rejected WebSocket handshake's status and body to raise the right error (ADR 0007). Not every runtime's built-in WebSocket client allows that.

## Decision

### Minimum versions

| SDK | Minimum | Also supported |
| --- | --- | --- |
| Python | CPython 3.11 | every later CPython release |
| JavaScript/TypeScript | Node.js 22 | Bun, Deno 2, Cloudflare Workers; REST on Vercel Edge |
| Dart | Dart 3.5 | Flutter on Android, iOS, desktop and web |

**We support every language version that is still maintained upstream:** all non-end-of-life CPython releases and all Node.js LTS releases. When a version reaches end of life, we drop it in a **minor** release and announce it one release ahead in the changelog. Dropping a version on any other schedule is a breaking change (ADR 0010).

Dart has no fixed end-of-life schedule. A change to the Dart minimum follows the same rule: a minor release, announced one release ahead.

### Runtime details

#### Python

- Runtime dependencies are `httpx`, `websockets` and `typing-extensions`, and nothing else.
- Sync and async clients are both supported.
- CI tests every supported CPython on Linux, plus macOS and Windows. It also runs with the lowest allowed dependency versions.

#### JavaScript/TypeScript

- REST uses the platform's `fetch`, `FormData` and `Blob`, with zero runtime dependencies.
- Streaming uses `ws`, loaded only when a stream is opened, because it exposes the handshake response.
- Bun and Deno run the same code through their npm compatibility, and CI tests both.
- Cloudflare Workers and Vercel Edge support REST, without file-path uploads. Streaming there depends on a fetch-based WebSocket upgrade, and is listed as supported only once it passes the conformance suite.
- *Amended 2026-11-10:* a runtime is listed as supported once the built package passes the runtime smoke suite (`js/scripts/smoke-runtime*.mjs`) in CI: REST, both streams, refused handshakes, closes and retries against a local mock of the API. Recorded live fixtures don't exist yet for any runtime, so this is the same bar Node.js, Bun and Deno meet. Cloudflare Workers passes it with a `fetch()` upgrade transport (loaded only on Workers), with and without `nodejs_compat`, so Workers streaming is supported; file paths there need `nodejs_compat`. Vercel Edge stays REST-only.
- Browsers: proxy mode only, unless the developer explicitly opts in (ADR 0008).
- The package ships ESM and CommonJS builds with type definitions.

#### Dart

- A pure-Dart package with no Flutter dependency, so server-side Dart can use it too.
- `package:http` for REST.
- WebSockets through a manual `dart:io` upgrade, which exposes handshake errors. Flutter web uses a browser transport and proxy mode only.

## Consequences

- Developers can predict support: if their language version is maintained upstream, the SDK supports it.
- CI must run a version matrix for each SDK, which costs time and is worth it.
- Some runtimes get REST without streaming. The docs say which deployment setups support streaming, including serverless platforms that can't hold a socket open for 25 to 30 minutes.
- Raising a minimum version outside this policy needs a major release.
- CPython 3.10 reached end of life in October 2026, before the first Python release, so the Python SDK starts at 3.11 and never supports an end-of-life version.
