# Changelog

## 0.0.2

Security fixes. Upgrading is recommended.

- `verifyWebhook` checks that a delivery's body matches its event. The signature doesn't cover the `X-Webhook-Event` header, so a signed delivery could otherwise be replayed under another event name:
  - a `job.completed` must carry its result (`audioUrl` or `transcription`);
  - a `job.failed` must not carry one;
  - `spending.warning` and `spending.exhausted` must carry finite `creditsUsed` and `creditLimit`. These two events share a body shape, so one can still be relabelled as the other until the API signs the event name.
- `verifyWebhook` refuses a timestamp header longer than 15 characters before parsing it.
- A path ID of `.` or `..` throws `UsageException` before any request is sent, like an empty one.
- When `downloadTo` is given a directory, it names the file `download` if the link's file name contains `:` or a control character.
- A plain `http` base URL to a host other than this machine logs a warning once, because the API key or auth headers would cross the network unencrypted.
- At most 64 KiB of an error response's body is read.
- The `httpClient` documentation says that streams don't use it: they open their own connection with the platform's proxy and certificate settings.

## 0.0.1

- `EchoNova(apiKey:)` for server-side Dart and `EchoNova.proxy(baseUrl:, auth:)` for Flutter apps, which call your own backend so the API key never ships in the app.
- Text to Speech: `generate`, `voices.list`, and `jobs.create`, `get`, `list`, `listAll`, `delete`, `wait`, `download`, `downloadTo` and `findCandidates`.
- Speech to Text: `transcribe`, and `jobs.create`, `get`, `list`, `listAll`, `delete`, `wait`, `export`, `exportJson` and `findCandidates`.
- Sound Cleaning: `clean`, and `jobs.get`, `list`, `listAll`, `delete`, `download` and `downloadTo`.
- Website widgets: `widgets.createTicket`.
- Agent sessions: `agents.sessions.start`, `get` and `end`. The room token is kept out of `toString()` and out of exceptions.
- Uploads from bytes, streams and (except on the web) paths, with the audio type named from the file extension or the file's first bytes.
- Typed, immutable results that keep the API's JSON in `raw` and the response's `requestId`. Unknown statuses and channels are kept as they are.
- `Page` results with `nextPage()`, and `listAll()` streams that skip jobs they already returned.
- Retries that never resend a request that may already have run, a shared throttle per endpoint, rate-limit preflight, per-call `RequestOptions` and a total `deadline`.
- Idempotency keys: `textToSpeech.generate`, `speechToText.transcribe` and `soundCleaning.clean` send an `Idempotency-Key` (a new UUID per call, or `RequestOptions(idempotencyKey:)`), the same on every retry, so they are retried safely after a lost response or a 500, 502, 503 or 504. Their exceptions carry `idempotencyKey`.
- `RequestInProgressException` (409): the first request with the same key is still running. The SDK sends the request again with the key every 5 s (or after a longer `Retry-After`), and throws it only when the wait runs out, or at once for an upload it can't send again. `retryDisabledReason` (`body_not_replayable`), on status and connection exceptions, says why a request wasn't sent again.
- A synchronous call the API answers with `202 Processing` waits for its job and returns the usual result. `RequestOptions(waitTimeout:)` bounds this wait and the in-progress one (default 20 minutes, never past the call's `deadline`).
- `textToSpeech.generate` reads for 240 s, so the API's `202` (at 220 s) can arrive.
- Speech to Text `language` is optional (`auto`, `ar` or `en`) on `transcribe`, `jobs.create`, `connect` and `transcribeStream`; left out, the API detects Arabic or English.
- `…WithResponse` methods returning `RawResponse` (status, headers, request ID, rate limit).
- Downloads of signed links without credentials; an expired link throws `DownloadExpiredException`.
- Webhook verification with `verifyWebhook`.
- Streaming Text to Speech (`textToSpeech.connect`, `speak`): synthesize, enqueue, `speakStream` for LLM text, cancel and interrupt, `Stream<Uint8List>` audio, and the final cost of every synthesis. `TtsSession.sampleRate` gives the rate of `speakStream` audio.
- `streamKeepalive` on `EchoNova` and `EchoNova.proxy`: the stream keepalive interval (default 30 s); `null` turns keepalive off.
- Streaming Speech to Text (`speechToText.connect`, `transcribeStream`): framed audio with backpressure, segments, terminology, `stop`, saved sessions (`SessionSaved`, `jobId`), and rollover past the session limit.
- Flutter web streaming through a proxy, authenticated with cookies or `EchoNova.proxy(streamQuery:)`. The `auth` hook isn't called for streams there, since a browser can't send its headers.
- Connection errors name the server they couldn't reach: `EchoNova`, or your proxy's host.
- `Audio` and WAV helpers.
