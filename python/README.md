# EchoNova Python SDK

Official Python SDK for the [EchoNova API](https://echonova.ai/docs/developers): Text to Speech, Speech to Text and Sound Cleaning.

> **Status: pre-release.** This package is under active development and is not yet published to PyPI. The first beta will be `0.9.0b1`.

- Blocking (`EchoNova`) and asyncio (`AsyncEchoNova`) clients with the same methods.
- Typed results, with the API's JSON kept on every result as `.raw`.
- Retries that never charge you twice, client-side rate limiting, job polling and safe downloads.

## Requirements

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

Every API method also accepts `timeout`, `max_retries`, `deadline` and `extra_headers` for one call:

```python
client.text_to_speech.jobs.get(job_id, timeout=5, max_retries=0)
fast = client.with_options(timeout=10)  # a copy that shares the connection pool
```

Default timeouts in seconds (connect is 10 everywhere):

| Operation | write | read |
|---|---|---|
| Get, list, delete | 10 | 30 |
| Transcript export | 10 | 60 |
| `text_to_speech.jobs.create` | 10 | 30 |
| `text_to_speech.generate` | 10 | 120 |
| `speech_to_text.jobs.create` | 60 | 120 |
| `speech_to_text.transcribe`, `sound_cleaning.clean` | 60 | 600 |

## Text to Speech

```python
speech = client.text_to_speech.generate(text, voice_id=voice_id, speed=1.1, num_steps=64)

job = client.text_to_speech.jobs.create(text, voice_id=voice_id)
done = client.text_to_speech.jobs.wait(job)  # polls every 3 s, for up to 20 minutes
client.text_to_speech.jobs.download(done, to="job.wav")  # gets a fresh link first
client.text_to_speech.jobs.delete(done)
```

Options you don't pass are not sent, so the API's defaults apply.

## Speech to Text

`file` is a path, bytes, a binary file object, or `(filename, content[, content_type])`.

```python
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

job = client.speech_to_text.jobs.create(Path("meeting.wav"), language="en")
done = client.speech_to_text.jobs.wait(job)  # polls every 5 s
srt = client.speech_to_text.jobs.export(done, format="srt")  # str
data = client.speech_to_text.jobs.export(done, format="json")  # TranscriptExport
```

The SDK names the audio type from the file extension (mp3, wav, flac, ogg, opus, m4a, aac, webm, amr) or, failing that, from the file's first bytes. If it can't tell, it raises `UsageError` before sending anything; pass `(filename, content, content_type)` to set the type yourself.

`TerminologyResult.raw_text` holds the API's `raw` field, because `.raw` is the JSON on every result.

## Sound Cleaning

```python
job = client.sound_cleaning.clean("noisy.wav", target_lufs=-16, sample_rate=48000, bit_depth=24)
print(job.metrics.integrated_lufs, job.credits_consumed)
client.download(job.output_url, to="clean.wav")
client.sound_cleaning.jobs.delete(job)
```

## Jobs, pages and downloads

- `get`, `wait`, `delete`, `download` and `export` accept a job ID or any job object.
- `jobs.list(offset=, limit=)` returns a `Page` with `.items`, `.total`, `has_next_page()` and `next_page()`. Iterating a page walks every following page and skips jobs it has already returned (a new job shifts later pages by one).
- `jobs.wait(job, poll_interval=None, timeout=1200, raise_on_failure=True)` raises `JobFailedError` for a failed job and `JobWaitTimeoutError` when it gives up; calling it again is safe. All `wait()` calls on one client share a budget of 80 polls a minute per endpoint.
- Download links are signed and expire. `client.download(url, to=None)` sends no API key, returns bytes or streams to a file, and raises `DownloadExpiredError` for an expired link. `jobs.download()` gets the job again for a fresh link.

## Errors and retries

```python
import echonova

try:
    client.text_to_speech.generate(text, voice_id=voice_id)
except echonova.InvalidRequestError as e:
    print(e.error_message, e.request_id)
except echonova.SpendingLimitError:
    ...  # the key reached its Credit Limit: never retried
except echonova.RateLimitError as e:
    ...  # still limited after automatic retries; e.retry_after
except echonova.APIConnectionError as e:
    if e.may_have_executed:  # sent, but the response was lost: it may have run and been charged
        candidates = client.text_to_speech.jobs.find_candidates(e.sent_at, text=text)
except echonova.APIStatusError as e:
    print(e.status_code, e.error_message, e.request_id)
```

The SDK retries connection failures, rate limits and temporary outages, with backoff. It **never resends a request that may already have run**, because the API has no idempotency key and a second attempt could be charged again. Such errors carry `may_have_executed=True` and `sent_at`; `find_candidates()` lists the jobs created since then so you can decide. It never picks one for you.

After a `429` with `Retry-After`, the client holds further calls to that endpoint until the wait is over, instead of sending more.

## Response metadata

```python
raw = client.with_raw_response.text_to_speech.jobs.get(job_id)
print(raw.status_code, raw.request_id, raw.rate_limit, raw.headers)
job = raw.parse()

client.rate_limits  # the last rate-limit headers seen, per operation
```

Every result has `.request_id` and `.raw`, and `to_dict()`.

## Async

```python
from echonova import AsyncEchoNova

async with AsyncEchoNova() as client:
    job = await client.text_to_speech.jobs.create(text, voice_id=voice_id)
    done = await client.text_to_speech.jobs.wait(job)
    async for job in client.speech_to_text.jobs.list(limit=100):
        print(job.id, job.status)
```

## Proxy mode

Never ship an API key in a browser or mobile app. Instead, run a small proxy on your backend that adds the key, and point the SDK at it:

```python
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
