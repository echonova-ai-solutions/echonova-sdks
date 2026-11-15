# Jobs

Every Text to Speech, Speech to Text and Sound Cleaning call creates a job, the synchronous ones included. So does each synthesis on a Text to Speech stream, and each Speech to Text stream session that transcribed something. This guide covers waiting for async jobs, webhooks, listing, deleting and downloading. The job lifecycle is described on [Synchronous and asynchronous calls](https://echonova.ai/docs/developers/sync-vs-async).

## Job IDs and statuses

- Creating an async job returns `job_id` (`jobId`); a job object calls the same value `id`. The SDK keeps both names as the API sends them.
- In Python and TypeScript, `get()`, `wait()`, `delete()`, `download()` and `export()` take a job ID or any job object (the creation result, a job, a `generate()` result). In Dart they take the ID: `job.jobId` or `job.id`.
- A job is `pending`, `processing`, `completed` or `failed`, and it ends only once. Treat any other status as not finished; in Dart, `status.isTerminal` tells you.
- A failed job carries the reason in `error`, and its charge was refunded.
- Jobs belong to the workspace: any key in the workspace with access to that service can read, list and delete them. Jobs made in the portal are not listed.

## Wait for a job

`jobs.wait()` polls the job until it completes or fails, at the interval the API docs recommend: every 3 seconds for Text to Speech and every 5 seconds for Speech to Text, with a little jitter. You can choose another interval, but not under 1 second.

- A failed job raises `JobFailedError` (`JobFailedException`), which carries the job. Pass `raise_on_failure=False` (`raiseOnFailure: false`) to get the failed job back instead.
- After the timeout (20 minutes by default) it raises `JobWaitTimeoutError`. The job is untouched, and calling `wait()` again is safe.
- Every poll counts toward your [rate limit](https://echonova.ai/docs/developers/rate-limits), which is per key and per endpoint. All `wait()` calls on one client share a budget of 80 polls a minute per endpoint, below the API's limit, so many jobs waited on at once slow down instead of being refused. Use one client for the whole process.
- Polling more often doesn't finish a job sooner.

**Python**

```python
from echonova import EchoNova, JobWaitTimeoutError

client = EchoNova()
job_id = "..."  # from client.speech_to_text.jobs.create()

try:
    job = client.speech_to_text.jobs.wait(job_id, timeout=15 * 60, raise_on_failure=False)
    if job.status == "failed":
        print("failed:", job.error)  # the charge was refunded
    else:
        print(job.transcription)
except JobWaitTimeoutError:
    pass  # still running: call wait() again later
```

**TypeScript**

```ts
import EchoNova, { JobWaitTimeoutError } from '@echonova/ai';

const client = new EchoNova();
const jobId = '...'; // from client.speechToText.jobs.create()

try {
  const job = await client.speechToText.jobs.wait(jobId, { timeoutMs: 15 * 60_000, raiseOnFailure: false });
  if (job.status === 'failed') console.log('failed:', job.error); // the charge was refunded
  else console.log(job.transcription);
} catch (err) {
  if (!(err instanceof JobWaitTimeoutError)) throw err;
  // still running: call wait() again later
}
```

**Dart**

```dart
import 'package:echonova_ai/echonova_ai.dart';

final client = EchoNova();
const jobId = '...'; // from client.speechToText.jobs.create()

try {
  final job = await client.speechToText.jobs.wait(
    jobId,
    timeout: const Duration(minutes: 15),
    raiseOnFailure: false,
  );
  if (job.status == JobStatus.failed) {
    print('failed: ${job.error}'); // the charge was refunded
  } else {
    print(job.transcription);
  }
} on JobWaitTimeoutException {
  // still running: call wait() again later
}
client.close();
```

In TypeScript, `wait()` also takes a `signal` to stop waiting.

## Webhooks instead of polling

For batches, or anything where nobody is waiting on the result, let EchoNova call you: when an async job ends, the API sends `job.completed` (with the result: `audioUrl` or the transcription) or `job.failed` (with the error) to your webhook endpoint. No polls are spent. See [Webhooks](webhooks.md) for receiving and verifying them.

- Synchronous calls and Speech to Text stream sessions send no job webhook.
- A job that stays processing too long is marked failed **without** a `job.failed` webhook. The API docs suggest one `jobs.get()` for a job you have heard nothing about after 15 minutes.
- A Speech to Text `job.completed` carries the transcription but not the segments or speakers: get the job for those.

## List jobs

`jobs.list()` returns one page of jobs, newest first: `items`, `total`, and whether there is a next page. Iterating the result walks every page from there on, one request per page. A job created while you iterate shifts the later pages by one; the iterator skips jobs it has already returned, so none appears twice. The page size (`limit`) has a maximum in the [reference](https://echonova.ai/docs/reference/tts-list-jobs).

**Python**

```python
from echonova import EchoNova

client = EchoNova()

page = client.text_to_speech.jobs.list(limit=20)  # one page
print(page.total, len(page.items), page.has_next_page())
if page.has_next_page():
    page = page.next_page()

for job in client.text_to_speech.jobs.list(limit=100):  # every job, page after page
    print(job.id, job.status, job.created_at, job.stream is not None)
```

**TypeScript**

```ts
import EchoNova from '@echonova/ai';

const client = new EchoNova();

let page = await client.textToSpeech.jobs.list({ limit: 20 }); // one page
console.log(page.total, page.items.length, page.hasNextPage());
if (page.hasNextPage()) page = await page.nextPage();

for await (const job of client.textToSpeech.jobs.list({ limit: 100 })) {
  console.log(job.id, job.status, job.createdAt, job.stream !== undefined); // every job, page after page
}
```

**Dart**

```dart
import 'package:echonova_ai/echonova_ai.dart';

final client = EchoNova();

var page = await client.textToSpeech.jobs.list(limit: 20); // one page
print('${page.total} ${page.items.length} ${page.hasNextPage}');
if (page.hasNextPage) page = await page.nextPage();

await for (final job in client.textToSpeech.jobs.listAll(limit: 100)) {
  print('${job.id} ${job.status.value} ${job.createdAt} ${job.stream != null}'); // every job
}
client.close();
```

With `AsyncEchoNova`, `await` the call for one page, or `async for` over it for every job.

## Delete a job

`jobs.delete()` removes a finished job and its stored audio (for Sound Cleaning, the original and the cleaned file). A job still running can't be deleted: the API answers `InvalidRequestError`. An unknown job, or one of another workspace, raises `JobNotFoundError`.

A delete is safe to retry, and the SDK retries it after a lost response. When the retry finds the job already gone, because the first attempt deleted it, the result says `already_deleted` (`alreadyDeleted`) instead of raising.

**Python**

```python
from echonova import EchoNova

client = EchoNova()
job_id = "..."  # a finished Speech to Text job

result = client.speech_to_text.jobs.delete(job_id)
print(result.deleted, result.already_deleted)
```

**TypeScript**

```ts
import EchoNova from '@echonova/ai';

const client = new EchoNova();
const jobId = '...'; // a finished Speech to Text job

const result = await client.speechToText.jobs.delete(jobId);
console.log(result.deleted, result.alreadyDeleted);
```

**Dart**

```dart
import 'package:echonova_ai/echonova_ai.dart';

final client = EchoNova();
const jobId = '...'; // a finished Speech to Text job

final result = await client.speechToText.jobs.delete(jobId);
print('${result.deleted} ${result.alreadyDeleted}');
client.close();
```

## Download a job's audio

Audio links (`audio_url` on Text to Speech jobs and on Speech to Text jobs saved from a stream, `output_url` on Sound Cleaning jobs) are signed and expire. Don't store them: every `jobs.get()` returns a fresh one.

- `jobs.download()` (Text to Speech and Sound Cleaning) gets the job, then downloads its audio with the fresh link. It raises `JobFailedError` for a failed job, and `UsageError` when there is no audio yet: wait for the job first.
- `client.download(url)` downloads any of these links. It never sends your API key or proxy credentials, because the link points at a storage host. An expired link raises `DownloadExpiredError`.
- Python returns the bytes, or writes the file with `to=` (a path, or an existing folder to keep the link's file name). TypeScript resolves to a `Uint8Array`, or writes a file with `{ to }` in Node.js, Bun and Deno. Dart has `download()` for bytes and `downloadTo()` for a file (not on the web).

**Python**

```python
from echonova import EchoNova

client = EchoNova()

client.text_to_speech.jobs.download("...", to="speech.wav")  # a Text to Speech job ID
cleaned = client.sound_cleaning.jobs.download("...")  # a Sound Cleaning job ID: the bytes

session = client.speech_to_text.jobs.get("...")  # a job saved from a Speech to Text stream
if session.audio_url:
    client.download(session.audio_url, to="recordings/")  # an existing folder: keeps the link's file name
```

**TypeScript**

```ts
import EchoNova from '@echonova/ai';

const client = new EchoNova();

await client.textToSpeech.jobs.download('...', { to: 'speech.wav' }); // a Text to Speech job ID
const cleaned = await client.soundCleaning.jobs.download('...'); // a Sound Cleaning job ID: the bytes

const session = await client.speechToText.jobs.get('...'); // a job saved from a Speech to Text stream
if (session.audioUrl) await client.download(session.audioUrl, { to: 'recordings/' }); // an existing folder: keeps the link's file name
```

**Dart**

```dart
import 'package:echonova_ai/echonova_ai.dart';

final client = EchoNova();

await client.textToSpeech.jobs.downloadTo('...', 'speech.wav'); // a Text to Speech job ID
final cleaned = await client.soundCleaning.jobs.download('...'); // a Sound Cleaning job ID: the bytes

final session = await client.speechToText.jobs.get('...'); // a job saved from a Speech to Text stream
final url = session.audioUrl;
if (url != null) await client.downloadTo(url, 'recordings/'); // an existing folder: keeps the link's file name
client.close();
```

## If the response to a POST is lost

Creating a job is a paid POST, and the API has no idempotency key. When the request was sent but the response never came, the job may exist and be charged, so the SDK never sends it again by itself. The error says so: `may_have_executed` (`mayHaveExecuted`) is true, and `sent_at` (`sentAt`) is when the request finished sending.

To recover, look before you resend. `text_to_speech.jobs.find_candidates(sent_at, text=...)` and `speech_to_text.jobs.find_candidates(sent_at)` list the jobs created since shortly before `sent_at` (jobs made on a stream are left out). They return a list and never pick one for you, because another request can match too. Sound Cleaning has no such helper: look at the newest jobs from `jobs.list()`.

**Python**

```python
from echonova import APIConnectionError, EchoNova

client = EchoNova()
voice_id = "..."  # a voice ID from client.text_to_speech.voices.list()
text = "مرحبا بكم في إيكونوفا"

try:
    job_id = client.text_to_speech.jobs.create(text, voice_id=voice_id).job_id
except APIConnectionError as e:
    if not (e.may_have_executed and e.sent_at):
        raise
    candidates = client.text_to_speech.jobs.find_candidates(e.sent_at, text=text)
    print([job.id for job in candidates])  # decide: use one of them, or send the request again
```

**TypeScript**

```ts
import EchoNova, { APIConnectionError } from '@echonova/ai';

const client = new EchoNova();
const voiceId = '...'; // a voice ID from client.textToSpeech.voices.list()
const text = 'مرحبا بكم في إيكونوفا';

try {
  const { jobId } = await client.textToSpeech.jobs.create({ text, voiceId });
} catch (err) {
  if (!(err instanceof APIConnectionError && err.mayHaveExecuted && err.sentAt)) throw err;
  const candidates = await client.textToSpeech.jobs.findCandidates(err.sentAt, { text });
  console.log(candidates.map((job) => job.id)); // decide: use one of them, or send the request again
}
```

**Dart**

```dart
import 'package:echonova_ai/echonova_ai.dart';

final client = EchoNova();
const voiceId = '...'; // a voice ID from client.textToSpeech.voices.list()
const text = 'مرحبا بكم في إيكونوفا';

try {
  final job = await client.textToSpeech.jobs.create(text, voiceId: voiceId);
  print(job.jobId);
} on APIConnectionException catch (e) {
  final sentAt = e.sentAt;
  if (e.mayHaveExecuted != true || sentAt == null) rethrow;
  final candidates = await client.textToSpeech.jobs.findCandidates(sentAt, text: text);
  print(candidates.map((job) => job.id)); // decide: use one of them, or send the request again
}
client.close();
```

[Errors](errors.md) covers this and every other failure in detail.

## Jobs from streams

- Each synthesis on the Text to Speech stream is saved as a Text to Speech job, with a `stream` block: its `session_id`, the synthesis's request ID (`synthesis_request_id` in Python, `requestId` in TypeScript, `synthesisRequestId` in Dart), and whether it was `cancelled` early or its audio was dropped. A job stays `processing` until its audio is saved.
- Each Speech to Text stream session is saved as one Speech to Text job, with `stream.session_id`, the transcript and `audio_url`, a recording of the audio sent. The session's job ID is known from the start; see [Streaming](streaming.md#stop-and-the-session-summary).
