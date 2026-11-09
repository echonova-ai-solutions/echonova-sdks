# EchoNova Dart and Flutter SDK

Official Dart and Flutter SDK for the [EchoNova API](https://echonova.ai/docs/developers): Text to Speech, Speech to Text and Sound Cleaning, plus website widget tickets and agent sessions.

> **Status: pre-release.** This package is under active development and is not yet published to pub.dev.

- One pure-Dart package for server-side Dart and for Flutter on Android, iOS, desktop and the web.
- Proxy mode for apps: your backend keeps the API key; the app never holds it.
- Typed results, with the API's JSON kept on every result as `raw`.
- Retries that never charge you twice, client-side rate limiting, job polling and safe downloads.

## Install

Until the package is on pub.dev, depend on a checkout of this repository:

```yaml
dependencies:
  echonova:
    path: ../echonova-sdks/dart # where you cloned the repository
```

Then `dart pub get` (or `flutter pub get`). Once it is published: `dart pub add echonova`.

Requires Dart 3.5 or later (Flutter 3.24 or later).

## Quick start: server-side Dart

```dart
import 'dart:io';

import 'package:echonova/echonova.dart';

Future<void> main() async {
  final client = EchoNova(); // reads ECHONOVA_API_KEY
  try {
    final voices = await client.textToSpeech.voices.list(); // changes rarely: cache it
    final voice = voices.firstWhere((v) => v.language == 'ar');

    final speech =
        await client.textToSpeech.generate('أهلاً بك في إيكونوفا', voiceId: voice.id);
    print('${speech.durationSeconds} s, ${speech.creditsConsumed} credits, '
        'request ${speech.requestId}');
    await client.downloadTo(speech.audioUrl!, 'speech.wav');
  } finally {
    client.close();
  }
}
```

Create one client and reuse it: it keeps the connection pool and the rate-limit state. Close it with `client.close()` when you are done.

## Quick start: Flutter (proxy mode)

**Never ship an API key in an app.** Anyone can extract it from the app bundle or, on the web, from the page. Instead, run a small proxy on your backend that checks your own user's session, adds the EchoNova key, and forwards the request to `https://api.echonova.ai`. Reference proxies (FastAPI and Express) are in [`../proxy-examples`](../proxy-examples).

Point the app at your proxy, with your app's own credentials:

```dart
final client = EchoNova.proxy(
  baseUrl: Uri.parse('https://api.example.com/echonova'),
  auth: () async => {'Authorization': 'Bearer ${await session.token()}'},
);

final job = await client.speechToText.jobs.create(
  AudioFile.fromBytes(recording, 'memo.m4a'),
  language: 'ar',
);
final done = await client.speechToText.jobs.wait(job.jobId);
print(done.transcription);
```

- API paths are appended to `baseUrl`: the job above is created with `POST https://api.example.com/echonova/v1/speech-to-text`.
- `auth` is called before every attempt, so it can return a fresh token. On the web you can also use cookies, with an `httpClient` that sends them.
- `EchoNova(apiKey: ...)` throws `UnsupportedEnvironmentException` in a browser unless you pass `dangerouslyAllowBrowser: true`.
- Paths (`AudioFile.fromPath`, `downloadTo`) need a file system, so they don't work on the web: use bytes there (`AudioFile.fromBytes`, `client.download`).

## Configuration

| Option | Default | |
|---|---|---|
| `apiKey` | `ECHONOVA_API_KEY` | `EchoNova()` only. Surrounding whitespace is removed. |
| `baseUrl` | `ECHONOVA_BASE_URL`, else `https://api.echonova.ai` | Required for `EchoNova.proxy`. Request paths already start with `/v1`. |
| `auth` | none | `EchoNova.proxy` only: returns your app's headers, before every attempt. |
| `timeout` | per operation | The time limit for each attempt of every call. |
| `deadline` | none | The total time for one call: attempts, retry delays and rate-limit waits. |
| `maxRetries` | `2` | |
| `rateLimitPreflight` | `true` | Wait for the rate-limit window instead of sending a request that would be refused. |
| `defaultHeaders` | none | Sent with every API request (not with downloads). |
| `httpClient` | SDK-owned | Your own `package:http` client (proxies, certificates, cookies). `close()` leaves it open. |
| `downloadHttpClient` | SDK-owned | The client for signed download links. It must not add credentials. |

Every API method also takes `options` for one call:

```dart
await client.textToSpeech.jobs.get(
  jobId,
  options: const RequestOptions(timeout: Duration(seconds: 5), maxRetries: 0, headers: {'X-Trace': 'abc'}),
);
final fast = client.withOptions(timeout: const Duration(seconds: 10)); // shares connections and rate limits
```

Default time limits per attempt (`package:http` has one deadline per request, so each is the connect, write and read limits added together):

| Operation | Limit |
|---|---|
| Get, list, delete; `textToSpeech.jobs.create`; widget tickets; agent sessions | 50 s |
| Transcript export | 80 s |
| `textToSpeech.generate` | 140 s |
| `speechToText.jobs.create` | 190 s, plus time for the upload's size |
| `speechToText.transcribe`, `soundCleaning.clean` | 670 s, plus time for the upload's size |

## Text to Speech

```dart
final speech = await client.textToSpeech.generate(text, voiceId: voiceId, speed: 1.1, numSteps: 64);

final job = await client.textToSpeech.jobs.create(text, voiceId: voiceId);
final done = await client.textToSpeech.jobs.wait(job.jobId); // polls every 3 s, for up to 20 minutes
final wav = await client.textToSpeech.jobs.download(done.id); // gets a fresh link first
await client.textToSpeech.jobs.delete(done.id);
```

Options you don't pass are not sent, so the API's defaults apply.

A job made on the Text to Speech stream has `stream`: its `sessionId`, its `synthesisRequestId`, and whether it was `cancelled` early or its audio was dropped.

## Speech to Text

Uploads are `AudioFile`s:

```dart
AudioFile.fromBytes(bytes, 'call.mp3');
AudioFile.fromPath('meeting.wav');                       // not on the web; File works via file.path
AudioFile.fromStream(stream, length, 'recording.ogg');   // sent once: not retried after it was read
AudioFile.fromBytes(bytes, 'clip', contentType: 'audio/webm');
```

The SDK names the audio type from the file extension (mp3, wav, flac, ogg, opus, m4a, aac, webm, amr) or, failing that, from the file's first bytes. If it can't tell, it throws `UsageException` before sending anything. It never sends `application/octet-stream`, which the API rejects.

```dart
final result = await client.speechToText.transcribe(
  AudioFile.fromPath('call.mp3'),
  language: 'ar',
  identifySpeakers: true,
  terminology: const Terminology([
    Keyword('KYC'),
    Keyword('Emirates NBD', variants: ['امريتس ان بي دي']),
  ]),
);
print(result.transcription);
print(result.terminology?.corrected);
for (final segment in result.segments ?? const <SttSegment>[]) {
  print('${segment.start} ${segment.speaker}: ${segment.text}');
}

final job = await client.speechToText.jobs.create(AudioFile.fromPath('meeting.wav'), language: 'en');
final done = await client.speechToText.jobs.wait(job.jobId); // polls every 5 s
final srt = await client.speechToText.jobs.export(done.id, format: ExportFormat.srt); // String
final data = await client.speechToText.jobs.exportJson(done.id); // TranscriptExport
```

`TerminologyResult.rawText` holds the API's `raw` field, because `raw` is the JSON on every result. A job saved from the Speech to Text stream has `stream.sessionId` and `audioUrl`, a signed link to the recording.

## Sound Cleaning

```dart
final job = await client.soundCleaning.clean(
  AudioFile.fromPath('noisy.wav'),
  targetLufs: -16,
  sampleRate: 48000,
  bitDepth: 24,
);
print('${job.metrics?.integratedLufs} LUFS, ${job.creditsConsumed} credits');
final cleaned = await client.download(job.outputUrl!);
await client.soundCleaning.jobs.delete(job.id);
```

## Widgets and agent sessions

Call these from your server.

```dart
final ticket = await client.widgets.createTicket(
  'wdg_a1B2c3D4e5F6g7H8i9J0',
  user: const WidgetUser(id: 'user_8431', name: 'Sara'),
  ttlSeconds: 300,
); // hand ticket.ticket to that visitor's browser

final session = await client.agents.sessions.start(agentId, channel: AgentChannel.voice);
sendToYourClient(session.wsUrl, session.token); // only the client that joins the room
final status = (await client.agents.sessions.get(agentId, session.id)).status;
await client.agents.sessions.end(agentId, session.id);
```

The room `token` is a secret, returned only by `start()`. Hand it only to the client that joins the room, and don't log or store it. It is left out of `toString()`, and a response that carries it is never copied into an exception. `start()` is never sent twice once it may have reached the server, because a retried start opens a second session: a lost response throws with `mayHaveExecuted == true`. An agent at its call or chat limit throws `ConcurrencyLimitException`.

## Jobs, pages and downloads

- `jobs.list(offset:, limit:)` returns a `Page` with `items`, `total`, `hasNextPage` and `nextPage()`.
- `jobs.listAll(limit:)` is a `Stream` of every job. It fetches pages as you read and skips jobs it already returned (a new job shifts later pages by one).
- `jobs.wait(jobId, pollInterval:, timeout:, raiseOnFailure:)` throws `JobFailedException` for a failed job and `JobWaitTimeoutException` when it gives up; calling it again is safe. Unknown statuses count as not finished. All `wait` calls on one client share a budget of 80 polls a minute per endpoint.
- Download links are signed and expire. `client.download(url)` returns the bytes and `client.downloadTo(url, path)` writes a file (not on the web). Neither sends your API key or proxy credentials. An expired link throws `DownloadExpiredException`. `jobs.download(jobId)` gets the job again for a fresh link.

## Errors and retries

Every error is an `EchoNovaException`, a sealed class, so a `switch` over it is exhaustive:

```dart
try {
  await client.textToSpeech.generate(text, voiceId: voiceId);
} on InvalidRequestException catch (e) {
  print('${e.errorMessage} (request ${e.requestId})');
} on SpendingLimitException {
  // The key reached its Credit Limit: never retried.
} on RateLimitException catch (e) {
  // Still limited after the automatic retries; e.retryAfter.
} on APIConnectionException catch (e) {
  if (e.mayHaveExecuted ?? true) {
    // Sent, but the response was lost: it may have run and been charged.
    final candidates = await client.textToSpeech.jobs.findCandidates(e.sentAt!, text: text);
  }
} on APIStatusException catch (e) {
  print('${e.statusCode} ${e.errorMessage} ${e.requestId}');
}
```

The SDK retries connection failures, rate limits and temporary outages, with backoff. It **never resends a request that may already have run**, because the API has no idempotency key and a second attempt could be charged again. Such errors have `mayHaveExecuted == true` and `sentAt`; `findCandidates()` lists the jobs created since then (skipping jobs made on a stream) so you can decide. It never picks one for you.

After a `429` with `Retry-After`, the client holds further calls to that endpoint until the wait is over, instead of sending more. A wait longer than 60 s, or past the call's `deadline`, throws `RateLimitException` without sending.

## Response metadata

Every method has a `…WithResponse` twin that returns a `RawResponse`:

```dart
final raw = await client.textToSpeech.jobs.getWithResponse(jobId);
print('${raw.statusCode} ${raw.requestId} ${raw.rateLimit} ${raw.headers}');
final job = raw.parse();

client.rateLimits; // the last rate-limit headers seen, per operation
```

Every result has `requestId` and `raw` (the API's JSON, including fields this version doesn't model yet).

## Streaming

Streaming Text to Speech and Speech to Text (`connect`, `speak`, `transcribeStream`) are being added to this package and will be documented here.

## Webhooks

```dart
final event = verifyWebhook(rawBody, request.headers, [webhookSecret]);
switch (event) {
  case JobCompleted(:final jobId, :final service):
    print('$service job $jobId finished');
  case JobFailed(:final jobId, :final error):
    print('job $jobId failed: $error');
  case SpendingWarning() || SpendingExhausted() || UnknownWebhookEvent():
    break;
}
```

Pass the body bytes exactly as received.

## Example

[`example/echonova_example.dart`](example/echonova_example.dart) runs Text to Speech and Speech to Text against the API. It reads `ECHONOVA_API_KEY`.

## Development

```bash
cd dart
dart pub get
dart test                                        # unit and conformance tests (no network, no API key)
dart analyze --fatal-infos
dart format --output=none --set-exit-if-changed .
```

Tests read the shared contract in [`../spec`](../spec): the vendored API specs, the error rules, the parameter mapping and the test vectors every EchoNova SDK must pass.

## License

To be decided before the first release.
