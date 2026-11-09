# 3. A sans-IO core with thin I/O drivers

Date: 2026-11-09

## Status

Accepted

## Context

Each SDK needs more than one I/O model:

- Python needs both a blocking client and an asyncio client with identical behaviour.
- JavaScript runs on Node, Bun, Deno and edge runtimes, which differ in their HTTP and WebSocket APIs.
- Dart needs `dart:io` on servers, mobile and desktop, and a browser transport for Flutter web.

The hard logic is the same everywhere: classifying errors, deciding retries, tracking rate limits, framing audio and running the two streaming protocols. If that logic is written once per I/O model, the copies diverge, and testing them needs real sockets and real time.

## Decision

Each SDK has a **sans-IO core**: pure code that never opens a socket or sleeps. Bytes, frames, events and clock readings go in; decisions and actions come out. When the core says "wait", the driver does the waiting.

The core contains:

- configuration and request building (headers, JSON, multipart, query);
- envelope parsing;
- the error classifier, which applies `spec/error-rules.json`;
- the retry policy, whose `decide()` returns retry or don't retry, the delay, and `may_have_executed`;
- the rate-limit tracker;
- the PCM framer for outgoing audio;
- the Text to Speech and Speech to Text stream protocol state machines;
- the webhook verifier.

**Drivers** are thin layers that do the I/O and feed the core:

| SDK | HTTP | WebSocket |
| --- | --- | --- |
| Python | `httpx` (sync and async) | `websockets` (asyncio and sync) |
| TypeScript | `fetch` | `ws` on Node, Bun and Deno; fetch-upgrade on Workers |
| Dart | `package:http` | manual `dart:io` upgrade; `package:web` for Flutter web |

Rules for the core:

- No global state, and nothing reads the network or environment at import time.
- The clock and the random source (for backoff jitter) are injectable, defaulting to the system ones, so tests run on a fake clock with fixed jitter.

In the Python SDK, the core lives in `echonova/_core/` (envelope, classifier, rules, retry, rate limits) and `echonova/_streaming/` (the PCM framer, with the stream protocols to follow).

## Consequences

- Sync and async Python share one logic path, so they can't disagree.
- Most tests are fast and deterministic: recorded transcripts and fake clocks, no network.
- The Python core is the blueprint for the TypeScript and Dart ports. Porting is mostly translation, checked by the same shared vectors and fixtures (ADR 0011).
- Drivers stay small, so supporting a new runtime means writing a driver, not a new SDK.
- Contributors must keep I/O out of the core. A change that makes the core sleep, log a request body or open a connection is a design change, not a fix.
