# EchoNova Python SDK

Official Python SDK for the [EchoNova API](https://echonova.ai/docs/developers): Text to Speech, Speech to Text and Sound Cleaning.

> **Status: pre-release.** Not yet published to PyPI; the first release will be `0.0.1`.

- Blocking (`EchoNova`) and asyncio (`AsyncEchoNova`) clients with the same methods.
- Typed results, with the API's JSON kept on every result as `.raw`.
- Retries that never charge you twice, client-side rate limiting, job polling and safe downloads.

## Install

```bash
pip install echonova          # or: uv add echonova
```

Python 3.11 or later.

## Quick start

```python
from echonova import EchoNova

client = EchoNova()  # reads ECHONOVA_API_KEY

voices = client.text_to_speech.voices.list()  # changes rarely: cache it
voice = next(v for v in voices if v.language == "ar")

speech = client.text_to_speech.generate("أهلاً بك في إيكونوفا", voice_id=voice.id)
print(speech.duration_seconds, speech.credits_consumed, speech.request_id)
client.download(speech.audio_url, to="speech.wav")
```

Create one client and reuse it: it keeps a connection pool and the rate-limit state. Close it with `client.close()`, or use it as a context manager (`with EchoNova() as client:`).

## Configuration

| Option | Default | |
|---|---|---|
| `api_key` | `ECHONOVA_API_KEY` | Surrounding whitespace is removed. |
| `base_url` | `ECHONOVA_BASE_URL`, else `https://api.echonova.ai` | The host only: request paths already start with `/v1`. |
| `auth` | none | A function returning headers, called before every request (proxy mode, below). |
| `timeout` | per operation | Seconds, or `Timeout(connect=, read=, write=, pool=)`. |
| `max_retries` | `2` | |
| `deadline` | none | Total seconds for one call, retries and waits included. |
| `rate_limit_preflight` | `True` | Wait for the rate-limit window instead of sending a request that would be refused. |
| `default_headers` | none | Sent with every API request. |
| `http_client` | SDK-owned | Your own `httpx.Client` / `httpx.AsyncClient` (proxies, mTLS, limits). |
| `download_http_client` | SDK-owned | The client used for signed download links. It must not add credentials. |
| `on_request`, `on_response` | none | Called with each `httpx.Request` / `httpx.Response`. |
| `stream_keepalive` | `30` | Seconds a stream may send nothing before it sends a keepalive ping. `None` turns keepalive and the connection checks off. |

Every API method also accepts `timeout`, `max_retries`, `deadline` and `extra_headers` for one call:

```python
from echonova import EchoNova

client = EchoNova()
job_id = "..."  # a job ID from jobs.create()

client.text_to_speech.jobs.get(job_id, timeout=5, max_retries=0)
fast = client.with_options(timeout=10)  # a copy that shares the connection pool
```

Default timeouts in seconds (connect is 10 everywhere):

| Operation | write | read |
|---|---|---|
| Get, list, delete | 10 | 30 |
| Transcript export | 10 | 60 |
| `text_to_speech.jobs.create`, `agents.sessions.start`, `agents.sessions.end` | 10 | 30 |
| `text_to_speech.generate` | 10 | 240 |
| `speech_to_text.jobs.create` | 60 | 120 |
| `speech_to_text.transcribe`, `sound_cleaning.clean` | 60 | 600 |

## Text to Speech

```python
from echonova import EchoNova

client = EchoNova()
text = "أهلاً بك في إيكونوفا"
voice_id = "..."  # a voice ID from client.text_to_speech.voices.list()

speech = client.text_to_speech.generate(text, voice_id=voice_id, speed=1.1, num_steps=64)

job = client.text_to_speech.jobs.create(text, voice_id=voice_id)
done = client.text_to_speech.jobs.wait(job)  # polls every 3 s, for up to 20 minutes
client.text_to_speech.jobs.download(done, to="job.wav")  # gets a fresh link first
client.text_to_speech.jobs.delete(done)
```

Options you don't pass are not sent, so the API's defaults apply.

### Streaming

One socket carries many syntheses, one at a time. Audio arrives as PCM16 mono chunks at `synth.sample_rate`.

```python
from echonova import EchoNova


def play(chunk: bytes) -> None: ...  # your audio output


client = EchoNova()
voice_id = "..."  # a voice ID from client.text_to_speech.voices.list()

with client.text_to_speech.connect(voice_id=voice_id) as tts:
    synth = tts.synthesize("مرحبا، كيف يمكنني مساعدتك؟")
    for chunk in synth:
        play(chunk)
    result = synth.result()
    print(result.outcome, result.credits_consumed)
```

A new `synthesize()` replaces the one that is running; `enqueue()` plays texts in order; `interrupt()` stops everything (barge-in). `speak_stream(texts)` speaks text as it is written (for example an LLM's reply), sentence by sentence, as one stream of audio chunks at `tts.sample_rate`, the rate of the latest synthesis to start. Streams send a keepalive ping after 30 s without sending anything; the client's `stream_keepalive` option changes that (`None` turns it off).

Billing: each synthesis is charged per character when it starts. One that stops after its audio started (a cancel, barge-in, or a speech service failure) costs only the share of audio sent, at least 1 credit; the rest is refunded. `result().credits_consumed` (also `synth.credits_consumed`) is the final cost the server reported, and `result().charged` is `False` for a synthesis cancelled before it was charged. A failed synthesis raises; its error carries `charge_state` (`"yes"`, `"no"` or `"unknown"`) and, when the server reported it, `credits_consumed`. The SDK never resends a synthesis that may have been charged.

Each synthesis on the stream is also a job: `TtsJob.stream` holds its `session_id`, its `synthesis_request_id` (the `Synthesis.request_id`), and whether it was `cancelled` early or its audio was dropped (`audio_dropped`).

## Speech to Text

`file` is a path, bytes, a binary file object, or `(filename, content[, content_type])`.

```python
from pathlib import Path

from echonova import EchoNova

client = EchoNova()

result = client.speech_to_text.transcribe(
    "call.mp3",
    language="ar",
    identify_speakers=True,
    terminology={"keywords": ["KYC", {"term": "Emirates NBD", "variants": ["امريتس ان بي دي"]}]},
)
print(result.transcription)
if result.terminology:
    print(result.terminology.corrected)
for segment in result.segments or ():
    print(f"{segment.start:6.2f} {segment.speaker}: {segment.text}")

job = client.speech_to_text.jobs.create(Path("meeting.wav"))  # no language: Arabic or English, detected
done = client.speech_to_text.jobs.wait(job)  # polls every 5 s
srt = client.speech_to_text.jobs.export(done, format="srt")  # str
data = client.speech_to_text.jobs.export(done, format="json")  # TranscriptExport
```

`language` is optional everywhere, on REST and on the stream: `"ar"`, `"en"` or `"auto"`. Left out, it isn't sent and the API detects Arabic or English (`auto`, its default). Results report the language as the API returns it, which can be `"auto"`.

The SDK names the audio type from the file extension (mp3, wav, flac, ogg, opus, m4a, aac, webm, amr) or, failing that, from the file's first bytes. If it can't tell, it raises `UsageError` before sending anything; pass `(filename, content, content_type)` to set the type yourself.

`TerminologyResult.raw_text` holds the API's `raw` field, because `.raw` is the JSON on every result.

### Streaming

Send PCM16 mono audio at the `sample_rate` you declare, and read transcripts as they arrive:

```python
from collections.abc import Iterator

from echonova import EchoNova
from echonova.types.streaming import Transcript


def microphone_chunks() -> Iterator[bytes]: ...  # your audio: PCM16 mono at 16 kHz


client = EchoNova()

with client.speech_to_text.connect(sample_rate=16000, language="ar") as stt:
    sending = stt.feed_from(microphone_chunks())  # sends on a thread, then calls stop()
    for event in stt:
        if isinstance(event, Transcript):
            print(event.text)
    summary = sending.result()

if summary.saved_status == "saved" and summary.job_id:
    job = client.speech_to_text.jobs.get(summary.job_id)
    client.download(job.audio_url, to="recording.wav")  # the session's recording
```

Each session is kept as a job. `stt.job_id` is its ID from the start; after `session.ended` the server sends `SessionSaved(job_id, status)`, where `status` is `saved`, `empty` (nothing was transcribed, so nothing is kept) or `failed`. `stop()` waits briefly for it, and `summary.job_id` and `summary.saved_status` are `None` if it didn't come. A job saved from the stream has `stream.session_id` and `audio_url`, a signed link to the recording.

`client.speech_to_text.transcribe_stream(source, sample_rate=)` handles audio of any length: it cuts segments itself, rolls over to a new session before the session limit, and reconnects after a dropped connection. Each session's `SessionSaved` is passed on with the transcripts.

## Sound Cleaning

```python
from echonova import EchoNova

client = EchoNova()

job = client.sound_cleaning.clean("noisy.wav", target_lufs=-16, sample_rate=48000, bit_depth=24)
print(job.credits_consumed)
if job.metrics:
    print(job.metrics.integrated_lufs)
client.download(job.output_url, to="clean.wav")
client.sound_cleaning.jobs.delete(job)
```

## Long synchronous calls

If `generate`, `transcribe` or `clean` is still running when the server stops waiting (after 220 s), the API answers `202 Processing` with the job's ID. The SDK then polls that job, every 3 s for Text to Speech and 5 s for Speech to Text and Sound Cleaning, within the same poll budget as `wait()`, and returns the result a `200` would have, with the last poll's `request_id`. The upload is never sent twice. Polls carry your `extra_headers`, but not the `Idempotency-Key`.

If an earlier request with the same key is still running (a `409`), the SDK sends the call again with the key every 5 s, or after `Retry-After` when that is longer, until the first request answers. These resends don't count against `max_retries`.

`wait_timeout` bounds both waits together: seconds, 1,200 by default, and never past the call's `deadline`. A failed job raises `JobFailedError`. Past the budget, a job still processing raises `JobWaitTimeoutError` with `job_id` and `last_job`, and waiting again is safe; a request still running raises `RequestInProgressError` with its `idempotency_key`.

```python
from echonova import EchoNova, JobWaitTimeoutError

client = EchoNova()

try:
    result = client.speech_to_text.transcribe("all-hands.mp3", wait_timeout=1800)
except JobWaitTimeoutError as e:
    job = client.speech_to_text.jobs.wait(e.job_id)
```

## Agent sessions

Start a live voice or chat session with an agent from your server. The key needs the `agents:talk` scope.

```python
from echonova import EchoNova


def send_to_your_client(ws_url: str | None, token: str) -> None: ...  # your app's own channel


client = EchoNova()
agent_id = "..."  # your agent's ID

session = client.agents.sessions.start(agent_id, channel="voice")  # or "chat"
send_to_your_client(session.ws_url, session.token)  # only the client that joins the room

status = client.agents.sessions.get(agent_id, session.id).status  # active, ended, failed, out_of_credits
client.agents.sessions.end(agent_id, session.id)  # ending one that already ended is fine
```

The room `token` is a secret, returned only by `start()`. Hand it only to the client that joins the room, and don't log or store it. It is left out of `repr()`; `to_dict()` and `.raw` include it. A chat session's first agent message is in `session.greeting`.

`start()` is never sent twice once it may have reached the server, because a retried start opens a second session: a lost response raises an error with `may_have_executed=True`. An agent at its call or chat limit raises `ConcurrencyLimitError`.

## Jobs, pages and downloads

- `get`, `wait`, `delete`, `download` and `export` accept a job ID or any job object.
- `jobs.list(offset=, limit=)` returns a `Page` with `.items`, `.total`, `has_next_page()` and `next_page()`. Iterating a page walks every following page and skips jobs it has already returned (a new job shifts later pages by one).
- `jobs.wait(job, poll_interval=None, timeout=1200, raise_on_failure=True)` raises `JobFailedError` for a failed job and `JobWaitTimeoutError` when it gives up; calling it again is safe. All `wait()` calls on one client share a budget of 80 polls a minute per endpoint.
- Download links are signed and expire. `client.download(url, to=None)` sends no API key, returns bytes or streams to a file, and raises `DownloadExpiredError` for an expired link. `jobs.download()` gets the job again for a fresh link.

## Errors and retries

```python
import uuid

import echonova

client = echonova.EchoNova()
text = "أهلاً بك في إيكونوفا"
voice_id = "..."  # a voice ID from client.text_to_speech.voices.list()
key = str(uuid.uuid4())  # optional: your own key, kept with the request, to retry it after a restart

try:
    client.text_to_speech.generate(text, voice_id=voice_id, idempotency_key=key)
except echonova.InvalidRequestError as e:
    print(e.error_message, e.request_id)
except echonova.SpendingLimitError:
    ...  # the key reached its Credit Limit: never retried
except echonova.RateLimitError as e:
    ...  # still limited after automatic retries; e.retry_after
except (echonova.APIConnectionError, echonova.RequestInProgressError) as e:
    ...  # retried already; send it again later with idempotency_key=e.idempotency_key
except echonova.APIStatusError as e:
    print(e.status_code, e.error_message, e.request_id)

try:
    job = client.text_to_speech.jobs.create(text, voice_id=voice_id)  # takes no key
except echonova.APIConnectionError as e:
    if e.may_have_executed is not False and e.sent_at:  # True or None (unknown): it may have run and been charged
        candidates = client.text_to_speech.jobs.find_candidates(e.sent_at, text=text)
```

The SDK retries connection failures, rate limits and temporary outages, with backoff.

`text_to_speech.generate`, `speech_to_text.transcribe` and `sound_cleaning.clean` send an `Idempotency-Key`: a new one for each call (or yours, from `idempotency_key=`), the same on every retry of that call. Within 24 hours, the API answers a repeated key with the first result and charges once, so the SDK also retries these calls after a lost response or a `500`, `502`, `503` or `504`. Their errors carry `idempotency_key`: sending the call again with it, from any process, returns the first result without a second charge. `RequestInProgressError` (`409`) means the first request with the key was still running when `wait_timeout` ran out ([Long synchronous calls](#long-synchronous-calls)): send it again later with the same key. A key already used for a different request raises `InvalidRequestError` (`409`), and is never retried.

Other POSTs take no key, so the SDK **never resends one that may already have run**: a second attempt could be charged again. That covers async job creation (`jobs.create`) and `agents.sessions.start`. Such errors carry `may_have_executed=True` and `sent_at`; `find_candidates()` lists the jobs created since then so you can decide (skipping jobs made on a stream). It never picks one for you.

After a `429` with `Retry-After`, the client holds further calls to that endpoint until the wait is over, instead of sending more.

## Response metadata

```python
from echonova import EchoNova

client = EchoNova()
job_id = "..."  # a job ID from jobs.create()

raw = client.with_raw_response.text_to_speech.jobs.get(job_id)
print(raw.status_code, raw.request_id, raw.rate_limit, raw.headers)
job = raw.parse()

client.rate_limits  # the last rate-limit headers seen, per operation
```

Every result has `.request_id` and `.raw`, and `to_dict()`.

## Async

```python
from echonova import AsyncEchoNova

text = "أهلاً بك في إيكونوفا"
voice_id = "..."  # a voice ID from client.text_to_speech.voices.list()

async with AsyncEchoNova() as client:
    job = await client.text_to_speech.jobs.create(text, voice_id=voice_id)
    done = await client.text_to_speech.jobs.wait(job)
    async for stt_job in client.speech_to_text.jobs.list(limit=100):
        print(stt_job.id, stt_job.status)
```

## Proxy mode

Never ship an API key in a browser or mobile app. Instead, run a small proxy on your backend that adds the key, and point the SDK at it:

```python
from echonova import EchoNova


def session_token() -> str: ...  # your app's own credentials


client = EchoNova(
    base_url="https://api.example.com/echonova", auth=lambda: {"Authorization": f"Bearer {session_token()}"}
)
```

With `auth` set, `ECHONOVA_API_KEY` is not read, so the key never reaches your proxy by accident.

## Logging

The SDK logs to the `echonova` logger: method, route, status, request ID, attempt and timing. It never logs your API key, request or response bodies, or the query string of a download link. Set `ECHONOVA_LOG=debug` to print these logs without configuring `logging` yourself.

## Examples

Runnable scripts are in [`examples/`](examples). They read `ECHONOVA_API_KEY`.

## Development

```bash
cd python
uv sync                 # create .venv with the dev tools
uv run pytest           # unit and conformance tests (no network, no API key)
uv run ruff check .
uv run ruff format --check .
uv run mypy
```

Tests read the shared contract in [`../spec`](../spec): the vendored API specs, the error rules and the test vectors every EchoNova SDK must pass.

## License

MIT. See [LICENSE](LICENSE).
