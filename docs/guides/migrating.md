# Migrating from raw HTTP

If you call the EchoNova API directly, with `requests`, `fetch`, `package:http` or `curl`, most of the code around each call can go: the auth header, the envelope, multipart bodies, polling loops, retries and signature checks. This guide maps each piece to the SDK.

| With raw HTTP you… | With the SDK |
| --- | --- |
| add `Authorization: Bearer …` to every request | `EchoNova()` reads `ECHONOVA_API_KEY` and adds it, only for EchoNova |
| unwrap `{ data, statusCode, success, errorMessage }` | methods return `data` as a typed result, and raise an exception for errors |
| remember which endpoint uses camelCase JSON and which uses snake_case form fields | one naming convention per language; the SDK sends the API's spelling |
| build `multipart/form-data` with an `audio/…` content type | pass a path, bytes or a file |
| poll `GET …/jobs/{jobId}` in a loop | `jobs.wait(job)` |
| write retry logic, and hope it never resends a paid `POST` | retries are built in: synchronous calls retry with an idempotency key, and other paid requests are never sent twice |
| `GET` the signed `audioUrl` without the auth header | `client.download(url)`, or `jobs.download(job)` for a fresh link |
| compute an HMAC over the webhook body | `webhooks.verify()` / `verifyWebhook()` |

## Endpoints and methods

Each endpoint is one method. Python names are shown; TypeScript and Dart use the same names in camelCase (`textToSpeech.jobs.create`).

| Endpoint | Method |
| --- | --- |
| `POST /v1/text-to-speech/sync` | `text_to_speech.generate` |
| `POST /v1/text-to-speech` | `text_to_speech.jobs.create` |
| `GET /v1/text-to-speech/voices` | `text_to_speech.voices.list` |
| `GET /v1/text-to-speech/jobs` | `text_to_speech.jobs.list` |
| `GET`, `DELETE /v1/text-to-speech/jobs/{jobId}` | `text_to_speech.jobs.get`, `text_to_speech.jobs.delete` |
| `POST /v1/speech-to-text/sync` | `speech_to_text.transcribe` |
| `POST /v1/speech-to-text` | `speech_to_text.jobs.create` |
| `GET /v1/speech-to-text/jobs` | `speech_to_text.jobs.list` |
| `GET`, `DELETE /v1/speech-to-text/jobs/{jobId}` | `speech_to_text.jobs.get`, `speech_to_text.jobs.delete` |
| `GET /v1/speech-to-text/jobs/{jobId}/export` | `speech_to_text.jobs.export` |
| `POST /v1/sound-cleaning` | `sound_cleaning.clean` |
| `GET /v1/sound-cleaning/jobs`, `GET`, `DELETE …/jobs/{jobId}` | `sound_cleaning.jobs.list`, `.get`, `.delete` |
| `POST /v1/widgets/{publicId}/tickets` | `widgets.create_ticket` |
| `POST /v1/agents/{agentId}/sessions`, `GET …/{sessionId}`, `POST …/{sessionId}/end` | `agents.sessions.start`, `.get`, `.end` |
| `wss://…/v1/text-to-speech/stream` | `text_to_speech.connect()` (and `speak()`) |
| `wss://…/v1/speech-to-text/stream` | `speech_to_text.connect()` (and `transcribe_stream()`) |

The SDK adds helpers with no endpoint of their own: `jobs.wait()`, `jobs.download()`, `jobs.find_candidates()` and `client.download()`.

## The envelope is unwrapped

Every API response is wrapped in an envelope:

```json
{
  "data": { "jobId": "…", "status": "completed", "audioUrl": "https://…", "durationSeconds": 2.4, "creditsConsumed": 21 },
  "statusCode": 200,
  "success": true,
  "errorMessage": null
}
```

The SDK checks it and returns `data` as a typed object, with the response's request ID attached:

**Python**

```python
from echonova import EchoNova

client = EchoNova()
voice_id = "..."  # a voice ID from client.text_to_speech.voices.list()

speech = client.text_to_speech.generate("أهلاً بك", voice_id=voice_id)
print(speech.job_id, speech.audio_url, speech.credits_consumed, speech.request_id)
print(speech.raw)  # the API's JSON, exactly as received
```

**TypeScript**

```ts
import EchoNova from '@echonova/ai';

const client = new EchoNova();
const voiceId = '...'; // a voice ID from client.textToSpeech.voices.list()

const speech = await client.textToSpeech.generate({ text: 'أهلاً بك', voiceId });
console.log(speech.jobId, speech.audioUrl, speech.creditsConsumed, speech.requestId);
```

**Dart**

```dart
import 'package:echonova_ai/echonova_ai.dart';

final client = EchoNova();
const voiceId = '...'; // a voice ID from client.textToSpeech.voices.list()

final speech = await client.textToSpeech.generate('أهلاً بك', voiceId: voiceId);
print('${speech.jobId} ${speech.audioUrl} ${speech.creditsConsumed} ${speech.requestId}');
print(speech.raw); // the API's JSON, exactly as received
client.close();
```

Results keep fields the SDK version doesn't know yet: in `raw` (Python, Dart), or on the object itself (TypeScript, whose results mirror the JSON). A field the API leaves out reads as `None`, `undefined` or `null`.

An error envelope (`"success": false`) becomes an exception instead, chosen by status and message: `"statusCode": 404, "errorMessage": "Voice not found"` raises `VoiceNotFoundError`, whose `error_message` is the server's text and whose `docs_url` is the envelope's `docs` link. Replace `if response.status == …` branches with `except` clauses; see [Errors](errors.md).

## Naming

The API mixes conventions: JSON bodies and responses use camelCase (`voiceId`, `numSteps`), Speech to Text form fields use snake_case (`identify_speakers`), and Sound Cleaning form fields use camelCase (`cutoffFreq`). The SDKs use one convention per language and send each parameter under the API's own name:

| API | Python | TypeScript, Dart |
| --- | --- | --- |
| `voiceId` (JSON) | `voice_id` | `voiceId` |
| `identify_speakers` (form) | `identify_speakers` | `identifySpeakers` |
| `cutoffFreq` (form) | `cutoff_freq` | `cutoffFreq` |
| `audioUrl` (response) | `audio_url` | `audioUrl` |

Response fields keep the API's names, converted only to the language's case, so the [API reference](https://echonova.ai/docs/reference/tts-generate-sync) stays accurate for SDK users. Two consequences:

- **`jobId` and `id` stay distinct.** Creating a job returns `jobId`; a job object has `id`. Methods that take a job accept either the ID or any job object in Python and TypeScript (`jobs.wait(job)`). Dart methods take the ID: `jobs.wait(job.jobId)`.
- **`raw` means the JSON.** Because every result's `raw` holds the API's JSON, the terminology result's own `raw` field (the transcript before corrections) is `raw_text` in Python and `rawText` in Dart. TypeScript keeps it as `terminology.raw`.

Parameters you don't pass are not sent, so the API's defaults apply. The SDK doesn't copy the server's validation either: a text that is too long reaches the API and comes back as `InvalidRequestError` with the API's exact message.

## Multipart uploads

Speech to Text and Sound Cleaning take `multipart/form-data`, with a `file` part whose content type must start with `audio/`, and options as text fields. Terminology goes in as a JSON string. With `curl`:

```bash
curl https://api.echonova.ai/v1/speech-to-text/sync \
  -H "Authorization: Bearer $ECHONOVA_API_KEY" \
  -F "file=@call.mp3;type=audio/mpeg" \
  -F language=ar \
  -F identify_speakers=true \
  -F 'terminology={"keywords":["KYC"]}'
```

With the SDK, you pass the file and typed options:

**Python**

```python
from echonova import EchoNova

client = EchoNova()

result = client.speech_to_text.transcribe(
    "call.mp3",  # or bytes, a binary file object, or (filename, content, content_type)
    language="ar",
    identify_speakers=True,
    terminology={"keywords": ["KYC"]},
)
print(result.transcription)
```

**TypeScript**

```ts
import EchoNova from '@echonova/ai';

const client = new EchoNova();

const result = await client.speechToText.transcribe({
  file: 'call.mp3', // or a Blob, bytes, a stream, or toFile(content, name, { type })
  language: 'ar',
  identifySpeakers: true,
  terminology: { keywords: ['KYC'] },
});
console.log(result.transcription);
```

**Dart**

```dart
import 'package:echonova_ai/echonova_ai.dart';

final client = EchoNova();

final result = await client.speechToText.transcribe(
  AudioFile.fromPath('call.mp3'), // or AudioFile.fromBytes, AudioFile.fromStream
  language: 'ar',
  identifySpeakers: true,
  terminology: const Terminology([Keyword('KYC')]),
);
print(result.transcription);
client.close();
```

The SDK:

- names the content type from the file extension or, failing that, from the file's first bytes, and never sends `application/octet-stream`, which the API rejects. When it can't tell, it raises `UsageError` before sending anything; pass the type yourself (see [Troubleshooting](troubleshooting.md#unsupported-file-type-and-other-content-type-errors));
- streams a file from disk instead of reading it into memory, and reopens it if the request is retried;
- serializes terminology as the JSON string the form field expects.

## Polling becomes `wait()`

With raw HTTP, an async job means a loop: `GET …/jobs/{jobId}` every few seconds until `status` is `completed` or `failed`, with your own handling of `429`, timeouts, and jobs that never finish. `jobs.wait()` replaces the loop:

**Python**

```python
from echonova import EchoNova, JobFailedError, JobWaitTimeoutError

client = EchoNova()
voice_id = "..."  # a voice ID from client.text_to_speech.voices.list()

job = client.text_to_speech.jobs.create("أهلاً بك", voice_id=voice_id)
try:
    done = client.text_to_speech.jobs.wait(job)  # accepts the job or its ID
    client.text_to_speech.jobs.download(done, to="speech.wav")
except JobFailedError as err:
    print(f"the job failed: {err.job.error}")  # its credits are refunded
except JobWaitTimeoutError as err:
    print(f"still running: call wait({err.job_id!r}) again later")
```

**TypeScript**

```ts
import EchoNova, { JobFailedError, JobWaitTimeoutError, type TtsJob } from '@echonova/ai';

const client = new EchoNova();
const voiceId = '...'; // a voice ID from client.textToSpeech.voices.list()

const job = await client.textToSpeech.jobs.create({ text: 'أهلاً بك', voiceId });
try {
  const done = await client.textToSpeech.jobs.wait(job); // accepts the job or its ID
  await client.textToSpeech.jobs.download(done, { to: 'speech.wav' });
} catch (err) {
  if (err instanceof JobFailedError) console.error(`the job failed: ${(err.job as TtsJob).error}`); // credits refunded
  else if (err instanceof JobWaitTimeoutError) console.error(`still running: call wait('${err.jobId}') again later`);
  else throw err;
}
```

**Dart**

```dart
import 'package:echonova_ai/echonova_ai.dart';

final client = EchoNova();
const voiceId = '...'; // a voice ID from client.textToSpeech.voices.list()

final job = await client.textToSpeech.jobs.create('أهلاً بك', voiceId: voiceId);
try {
  final done = await client.textToSpeech.jobs.wait(job.jobId);
  await client.textToSpeech.jobs.downloadTo(done.id, 'speech.wav');
} on JobFailedException catch (error) {
  print('the job failed: ${(error.job as TtsJob).error}'); // its credits are refunded
} on JobWaitTimeoutException catch (error) {
  print('still running: call wait(${error.jobId}) again later');
} finally {
  client.close();
}
```

`wait()`:

- polls at the intervals the API docs recommend (3 seconds for Text to Speech, 5 for Speech to Text) with a little jitter, and refuses intervals under a second;
- shares one polling budget among all `wait()` calls on a client, below the rate limit, so a hundred concurrent waits don't get throttled;
- treats a status it doesn't know as "not finished", and gives up after `timeout` (20 minutes by default). Calling it again is safe.

Webhooks avoid polling altogether: see [Webhooks](webhooks.md) and [Jobs](jobs.md).

## Retries

If your HTTP code has a retry wrapper, remove it from EchoNova calls. The SDK already retries what is safe to retry, waits for `Retry-After` on a `429`, and coordinates rate limits across calls. A generic wrapper would also resend `POST` requests that may already have run, and each one is charged again. When the SDK can't tell whether a `POST` ran, it raises with `may_have_executed` set; [Errors](errors.md#recovering-from-a-post-that-may-have-run) shows how to check before resending.

## Downloads

Signed links (`audioUrl`, `outputUrl`) are plain `GET`s to a storage host, without the `Authorization` header, and they expire. `client.download(url, to=...)` fetches one without your key, retries transient failures, writes the file only when it is complete, and raises `DownloadExpiredError` for an expired link. `jobs.download(job)` gets the job again first, so the link is always fresh. Don't store the links: store the job ID.

## Streams and webhooks

- **Streams.** Instead of managing a WebSocket, its JSON control messages, binary PCM frames, keepalive pings and close codes, open a session with `connect()`. Close codes become the same exceptions as REST errors (`4002` is `InsufficientBalanceError`, `4029` is `SpendingLimitError`). See [Streaming](streaming.md).
- **Webhooks.** Instead of computing `HMAC-SHA256(secret, timestamp + "." + body)` and comparing in constant time, call the SDK's `verify` with the raw body and the headers. See [Webhooks](webhooks.md).

## Checklist

- [ ] Read the key from `ECHONOVA_API_KEY` (or pass it from your secrets manager), and delete the code that builds auth headers.
- [ ] Replace envelope parsing with the SDK's results, and status checks with exception classes.
- [ ] Rename parameters and fields to your language's convention.
- [ ] Replace multipart building with a path, bytes or a file.
- [ ] Replace polling loops with `wait()`, or with webhooks.
- [ ] Remove retry wrappers around `POST` calls.
- [ ] Keep logging the request ID and job ID of each call: they are on every result.
