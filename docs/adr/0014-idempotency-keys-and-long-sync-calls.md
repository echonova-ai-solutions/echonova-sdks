# 14. Idempotency keys, safe retries and long synchronous calls

Date: 2026-11-17

## Status

Accepted. Amends [ADR 0004](0004-retries-and-idempotency.md) for the operations that accept an `Idempotency-Key`.

## Context

The published API spec changed on 2026-11-15. For three operations, synchronous Text to Speech (`POST /v1/text-to-speech/sync`), synchronous Speech to Text (`POST /v1/speech-to-text/sync`) and Sound Cleaning (`POST /v1/sound-cleaning`), it now documents:

- **Idempotency.** An optional `Idempotency-Key` header: repeating a key within 24 hours returns the first result and makes nothing twice. The same input and options within 24 hours also return the same job.
- **Three new 409s:** the key was already used for a different request; a request with this key is still running; the same request is still being started.
- **`202 Processing`.** If the job is still processing after 220 seconds, the call answers `202` with `{jobId, status: "processing", resultUrl}`. The result can be read from the job, or the same request sent again without a second charge.

Speech to Text's `language` also became optional, defaulting to `auto` (detect Arabic or English), on REST and on the stream.

ADR 0004 never retries a POST that may have run, because the API had no idempotency key. For these three operations that reason is gone.

## Decision

### Every idempotent call carries a key

For each operation whose spec accepts `Idempotency-Key` (`spec/mapping.json` marks it `"idempotency_key": true`), the SDK sends the header on every call. The SDK generates a new random key (a UUID) once per call and sends the same key on each retry of that call. A caller can pass their own key, to retry safely across processes or restarts: `idempotency_key=` in Python, `idempotencyKey` in the per-call request options in TypeScript and Dart.

Errors raised by these calls expose the key (`idempotency_key` / `idempotencyKey`), so a caller can send the request again later with the same key and get the first result, without a second charge.

Asynchronous job creation (`POST /v1/text-to-speech`, `POST /v1/speech-to-text`) and agent sessions don't accept a key. ADR 0004 still applies to them unchanged.

### A retry column for idempotent POSTs

`spec/error-rules.json` gains a fifth retry column, `POST_IDEMPOTENT`, used for a POST sent with an `Idempotency-Key`. It allows a retry whenever repeating the request is harmless:

- a lost response (`no_response`);
- a 500, 502, 503 or 504, JSON or not;
- a malformed 2xx (once);
- the throttle 429, the 408 and the refunded 503 (as for any POST).

Client errors, authentication and billing errors are never retried, as for any POST.

The new 409s are rules of their own:

- **"This Idempotency-Key was already used for a different request."** is an `InvalidRequestError` and is never retried.
- **"A request with this Idempotency-Key is still running."** and **"The same request is still being started. Send it again in a few seconds."** raise a new class, `RequestInProgressError` (under `APIStatusError`). With a key, the SDK retries them after its backoff, because the first request is running and will answer the retry.

### `202 Processing` waits for the job

When one of these calls answers `202`, the SDK doesn't return a half result. It polls the job named by `jobId`, through the same jobs `get` endpoint the SDK already wraps:

- **Poll interval:** 3 s for Text to Speech and 5 s for Speech to Text and Sound Cleaning.
- **Rate limits:** polls share the client's per-route limiter with `jobs.wait()`.
- **When it ends:**
  - When the job completes, the call returns the **same result type a `200` would have**, built from the job, with the request ID of the last poll.
  - A failed job raises `JobFailedError` with the job.
  - Past the wait budget, the call raises `JobWaitTimeoutError` with the job ID and the last job seen. Waiting again is safe.
- **Wait budget:** `wait_timeout` / `waitTimeout`, default 1,200 seconds, the same as `jobs.wait()`.

Polling is used rather than sending the request again, so that a large upload is never sent twice.

Details every SDK follows:

- **Deadline.** If the caller set a total `deadline` for the call, the wait budget is the smaller of `wait_timeout` and what is left of it.
- **Polls.** Polls send the caller's extra headers, except `Idempotency-Key`.
- **Errors.** API status and connection errors raised while waiting carry the call's key. `JobFailedError` and `JobWaitTimeoutError` carry the job instead.
- **Result.** The returned result keeps the job's JSON, plus `jobId`, as its raw data.
- **Synchronous Text to Speech read timeout: 240 seconds,** above the API's 220. With a shorter one the client would give up before the `202` could arrive.

### A request that is still running is waited for

The in-progress 409s mean the first request with this key is still running. On an idempotent call the SDK doesn't give up after its normal retries:

- **Resending.** It sends the request again with the same key every 5 seconds, or after `Retry-After` when that is longer.
- **Budget.** It uses the same wait budget as a `202`, and these resends don't count against `max_retries`.
- **The outcome.** The first answer that isn't an in-progress 409 decides the call. Once the budget runs out, the SDK raises `RequestInProgressError` with the key.
- **One budget.** A call has one wait budget, which starts at its first in-progress 409 or `202` and is shared by both waits. No resend is made that would land past it.
- **Uploads that can't be sent again.** If the upload can't be read again (a partly read stream), the SDK raises `RequestInProgressError` at once, with `retry_disabled_reason` `body_not_replayable`.

### `language` is optional

Speech to Text `language`, on REST and on the stream, becomes optional and accepts `auto`, `ar` and `en`, along with any value a future API adds. When it's left out, the SDK doesn't send it, and the server uses its default, `auto`. Results report the language as the API returns it, which can be `auto`.

## Consequences

- Synchronous Text to Speech, Speech to Text and Sound Cleaning become safe to retry, so transient server errors and lost responses no longer reach the caller as "may have been charged". `may_have_executed` keeps its meaning, but on these calls retrying with the reported key is always safe.
- Long synchronous calls keep working past the hosting proxy's limit: the caller still gets one result.
- One more error class, and one more retry column, in every SDK.
- The 32 agent-management operations the same spec change added are excluded from the coverage gate for now. They are planned for `0.1.0`.
