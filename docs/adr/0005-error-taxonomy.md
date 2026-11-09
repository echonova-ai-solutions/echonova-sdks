# 5. An error taxonomy grouped by meaning

Date: 2026-11-09

## Status

Accepted

## Context

The same problem can reach an SDK in several ways. Running out of credits can be:

- a REST response with status 402;
- a WebSocket handshake rejected with 402;
- an open stream closed with code 4002.

A caller wants to handle "out of credits" once, not once per transport. Callers also need to tell apart failures that look alike but need different handling. A 429 can mean "wait a few seconds" (throttled) or "stop until the spending limit is raised", and those must not share a parent class.

The API returns errors in a JSON envelope with `errorMessage` and `docs`. Messages can contain commas, so a validation message can't be split reliably into parts.

## Decision

Errors are classified by **meaning, not transport**. Every SDK uses the same class names. Dart adds an `Exception` suffix, as is idiomatic there. The tree is defined in `spec/error-rules.json` (`taxonomy`) and checked by tests:

```text
EchoNovaError
├─ UsageError                       the SDK was called incorrectly; nothing was sent
│  └─ SessionEndedError
├─ UnsupportedEnvironmentError      e.g. an API key in a browser (ADR 0008)
├─ APIConnectionError               no response (connect, send, read failures)
│  ├─ APITimeoutError               .kind: connect, write, read, pool, total, session_start, stop_drain
│  └─ StreamConnectionLostError     stream dropped without a close frame
├─ APIStatusError                   the server answered: REST status, handshake, stream error or close
│  ├─ InvalidRequestError           400, 405, 409, 413, 415, 422; stream validation_failed
│  ├─ AuthenticationError           401
│  ├─ PermissionDeniedError         403
│  │  └─ FeatureNotEnabledError
│  ├─ NotFoundError                 404
│  │  ├─ VoiceNotFoundError
│  │  └─ JobNotFoundError
│  ├─ RequestTimeoutError           408
│  ├─ BillingError
│  │  ├─ InsufficientBalanceError   402, close 4002
│  │  └─ SpendingLimitError         429 "Monthly spending limit exhausted", close 4029
│  ├─ RateLimitError                429 throttle (.retry_after)
│  ├─ ConcurrencyLimitError         429 "Too many concurrent streams"
│  ├─ ServerError                   5xx
│  │  ├─ ServiceUnavailableError    503
│  │  ├─ GatewayError               502, 504 (.from_proxy)
│  │  └─ UpstreamError              stream upstream_error, close 1011
│  └─ ProtocolError                 1008, 1009, malformed envelope, contract violation
├─ StreamClosedError                a close not covered above
│  ├─ ServerRestartingError         1001
│  └─ SessionExpiredError           4008
├─ JobFailedError                   .job
├─ JobWaitTimeoutError              .job_id, .last_job
├─ DownloadExpiredError             signed link expired; fetch the job again for a fresh one
└─ WebhookVerificationError         .reason
```

Rules:

- **`RateLimitError` is deliberately not the parent of `SpendingLimitError`.** A rate limit clears by waiting; a spending limit doesn't. Code that catches `RateLimitError` and retries later must never catch a spending limit by accident.
- **Classification is data.** The ordered rules in `spec/error-rules.json` (ADR 0004) map status, exact message, envelope presence and `Retry-After` to a class. Messages are matched only against known strings listed in the rules file. An unknown message falls back to the generic class for its status, never to a more specific one.
- **The server's text is kept whole.** `error_message` is the raw `errorMessage`, never split on `", "`.
- **`error_code`** holds the stream error's `code`. For REST errors, the SDK fills it from an `errorCode` field if the envelope has one.
- **Cancellations the caller asked for are outcomes, not exceptions** (ADR 0007).

Common attributes (each may be empty): `message`, `error_message`, `status_code`, `error_code`, `close_code`, `request_id`, `session_id`, `docs_url`, `retry_after`, `may_have_executed`, `headers`, `raw_body` (truncated to 4 KiB) and `transport` (`http` or `websocket`). Stream errors add `charge_state` where it applies (ADR 0007).

`str(err)` includes the status or close code, the server's message and the request ID, so a logged error is enough to open a support ticket.

## Consequences

- Callers write one `except InsufficientBalanceError` for every transport.
- Adding a subclass under an existing parent is non-breaking. Moving a class to another parent is a breaking change (ADR 0010).
- The classifier depends on exact server messages for a few cases. When a message changes, the shared vectors fail, and the error falls back to its status's generic class, which is still correct, only less specific.
- Each SDK expresses the same attributes in its own naming convention (`request_id` in Python, `requestId` in TypeScript and Dart).
