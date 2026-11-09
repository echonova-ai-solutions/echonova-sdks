# Changelog

## Unreleased

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
- `…WithResponse` methods returning `RawResponse` (status, headers, request ID, rate limit).
- Downloads of signed links without credentials; an expired link throws `DownloadExpiredException`.
- Webhook verification with `verifyWebhook`.
- Streaming Text to Speech (`textToSpeech.connect`, `speak`): synthesize, enqueue, `speakStream` for LLM text, cancel and interrupt, `Stream<Uint8List>` audio, and the final cost of every synthesis.
- Streaming Speech to Text (`speechToText.connect`, `transcribeStream`): framed audio with backpressure, segments, terminology, `stop`, saved sessions (`SessionSaved`, `jobId`), and rollover past the session limit.
- Flutter web streaming through a proxy, authenticated with cookies or `EchoNova.proxy(streamQuery:)`.
- `Audio` and WAV helpers.
