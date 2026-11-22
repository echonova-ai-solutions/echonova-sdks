# 4. Retries and idempotency: never resend a POST that may have run

Date: 2026-11-09

## Status

Accepted. Amended by [ADR 0014](0014-idempotency-keys-and-long-sync-calls.md): operations that accept an `Idempotency-Key` send one and use the `POST_IDEMPOTENT` retry column.

## Context

Most EchoNova POST requests are paid: they synthesize speech, transcribe audio or clean audio. The API has no idempotency key. If the response to a POST is lost, the client can't tell whether the work ran. Sending it again may run it, and charge for it, a second time.

Other failures are clearly safe to retry: nothing was sent, the server answered that it was rate limited and said how long to wait, or the server answered that a service was temporarily unavailable and the charge was refunded (as the published spec documents).

The rate limits apply per API key and per endpoint. When a caller is throttled, every other caller on the same endpoint will be throttled too.

The same rules must hold in Python, TypeScript and Dart.

## Decision

### Never auto-retry a POST that may have run

Each failure is placed in a phase:

| Phase | Meaning |
| --- | --- |
| `connect` | DNS, TCP or TLS failure. No byte was sent. |
| `send_incomplete` | The body wasn't fully written. Only some HTTP clients can detect this; the others treat it as `no_response`. |
| `no_response` | The request was fully sent, but no response arrived (read timeout, reset). |
| `malformed_success` | A 2xx response whose body isn't a valid envelope. |
| status | The server answered with an HTTP status. |

A POST is retried automatically only when it **definitely did not run**: nothing was sent, the body was not fully sent, or the server answered with a status that means "not processed" (for example a throttle 429, or a 503 that the spec documents as refunded). After `no_response`, a POST is never retried.

### The retry table is data

The rules live in `spec/error-rules.json`, shared by every SDK, not in code:

- `transport` rows cover the phases without a status.
- `rules` are tried in order, and the first match wins. A rule can match on the status, a known error message (whole, or a known part of it), whether the body was the JSON envelope, and whether `Retry-After` was present.
- Each rule gives the error class, a retry flag per method (`GET`, `DELETE`, `POST`, and `WS` for the stream handshake), the delay type, and `may_have_executed` (`no`, `yes` or `unknown`).
- Test vectors in the same file, and every error example in the published spec, must classify the same way in every SDK.

Summary (the rules file is authoritative):

| Situation | GET | DELETE | POST | POST `may_have_executed` |
| --- | --- | --- | --- | --- |
| Nothing sent, or body not fully sent | retry | retry | retry | no |
| Fully sent, no response | retry | retry (a 404 then means already deleted) | **no** | yes |
| 2xx with a malformed body | once | no | no | yes |
| 400, 401, 402, 403, 404, 405, 409, 413, 415, 422 | no | no | no | no |
| 429 with `Retry-After` (throttled) | retry | retry | retry | no |
| 429 `Monthly spending limit exhausted` | no | no | no | no |
| 408 | retry | retry | retry | no |
| 503 whose message contains "temporarily unavailable" | retry | retry | retry | no |
| 503 that isn't JSON (from the hosting proxy) | retry | retry | retry | no |
| 500, 502, other 503, JSON 504 | retry | retry | **no** | unknown |
| 504 that isn't JSON (hosting proxy timeout) | retry | retry | **no** | yes |

For a JSON 503, the rule for POST is an **allow-list** of known messages. A new 503 message from the API is not retried for POST until someone adds it, with a test vector, so a change on the server can never silently start double-charging. A 503 that isn't JSON is the exception: it is taken to come from the hosting proxy before the request reached the API, and is retried for POST too (rule R15). That holds only while the hosting proxy never answers 503 for a request it already passed on.

### `may_have_executed` and `sent_at`

Connection and status errors carry:

- `may_have_executed`: `True` (the POST was fully sent and may have run and been charged), `False` (it did not run), or `None` (unknown). It is always `False` for GET and DELETE.
- `sent_at`: when the request finished sending.
- `retry_disabled_reason` (connection errors), when a retry was allowed but impossible, for example `body_not_replayable` for a stream upload that was already partly read.

### Recovery with `find_candidates`

`text_to_speech.jobs.find_candidates(sent_at=err.sent_at, text=...)` and `speech_to_text.jobs.find_candidates(sent_at=...)` list the jobs created between `sent_at` minus 5 seconds and now. They return a **list** and never pick one for the caller: several jobs can match, for example when the same input was sent concurrently. The caller decides whether to use a candidate or resend.

### Defaults

- `max_retries=2`. Retries after a 429 count toward it.
- Backoff before retry *n*: `min(8, 0.5 × 2^(n−1)) × U(0.5, 1)` seconds.
- A throttle 429 waits `Retry-After` plus `U(0, 1)` seconds. If `Retry-After` is longer than `max_retry_after` (60 s; 30 s for a stream handshake), the SDK raises `RateLimitError` instead of waiting.
- Per-operation timeouts are generous for long synchronous uploads, so the SDK is not the component that cuts off a call that is still running and may be charged.
- Every value can be overridden per client and per call. An optional total `deadline` caps all attempts.

### Rate limits are shared per client

- After a throttle 429, the client marks that endpoint's bucket as blocked until `Retry-After` has passed. Every caller on the same client waits, instead of each one sending and finding out separately.
- **Preflight is on by default:** if the last response for a bucket showed `X-RateLimit-Remaining: 0` and the window hasn't reset, the SDK waits for the window to reset before sending. `rate_limit_preflight=False` turns it off.

### Uploads and polling

- Retried uploads must be replayable: paths are reopened, bytes are reused, seekable files are rewound. A non-seekable stream is retried only if nothing was read from it yet. Large bodies are never buffered in memory just to make them replayable.
- `jobs.wait()` polls at the intervals the API docs recommend (3 s for Text to Speech, 5 s for Speech to Text) with ±10% jitter, and refuses intervals under 1 s. Concurrent `wait()` calls on one client share a polling budget below the rate limit. On timeout it raises `JobWaitTimeoutError`, and calling `wait()` again is safe.

## Consequences

- Retries in the SDK can't double-charge. In exchange, some failures that a naive client would retry are raised to the caller, who must reconcile with `find_candidates`. The error-handling guide explains how.
- Changing retry behaviour means changing `error-rules.json` and its vectors, which every SDK's tests check.
- The classifier relies on exact error messages for a few cases. When EchoNova changes a message, the error-catalog vectors and the nightly drift check show it.
- If the API ever supports idempotency keys, this decision will be revisited: the SDKs could then send a key automatically and retry more POST failures.
