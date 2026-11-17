# Sound Cleaning

Sound Cleaning removes low rumble, compresses the dynamics, evens out the loudness and caps the peaks of a recording, and returns a cleaned WAV file. It answers in the same call: there is no async endpoint. The parameters, limits and errors are in the [API reference](https://echonova.ai/docs/reference/clean-create).

## Clean a file

`clean()` uploads the file, waits for the cleaner and returns the job: a link to the cleaned file, the credits charged and what the cleaner measured. The link is signed and expires, so download the file soon.

**Python**

```python
from echonova import EchoNova

client = EchoNova()

job = client.sound_cleaning.clean("noisy.wav", target_lufs=-16, sample_rate=48000, bit_depth=24)
print(job.id, job.duration_seconds, job.credits_consumed)
if job.metrics:
    print(job.metrics.integrated_lufs, job.metrics.true_peak_dbfs, job.metrics.sample_rate, job.metrics.bit_depth)
client.download(job.output_url, to="clean.wav")
```

**TypeScript**

```ts
import EchoNova from '@echonova/ai';

const client = new EchoNova();

const job = await client.soundCleaning.clean({ file: 'noisy.wav', targetLufs: -16, sampleRate: 48000, bitDepth: 24 });
console.log(job.id, job.durationSeconds, job.creditsConsumed);
console.log(job.metrics?.integratedLufs, job.metrics?.truePeakDbfs, job.metrics?.sampleRate, job.metrics?.bitDepth);
await client.download(job.outputUrl, { to: 'clean.wav' });
```

**Dart**

```dart
import 'package:echonova_ai/echonova_ai.dart';

final client = EchoNova();

final job = await client.soundCleaning.clean(
  AudioFile.fromPath('noisy.wav'),
  targetLufs: -16,
  sampleRate: 48000,
  bitDepth: 24,
);
print('${job.id} ${job.durationSeconds} ${job.creditsConsumed}');
final metrics = job.metrics;
if (metrics != null) {
  print('${metrics.integratedLufs} ${metrics.truePeakDbfs} ${metrics.sampleRate} ${metrics.bitDepth}');
}
await client.downloadTo(job.outputUrl!, 'clean.wav');
client.close();
```

The file can be MP3, WAV, FLAC or OGG (Opus). The API reads the file's content to find its format, but the upload must still carry an audio content type, which the SDK sets from the file extension (see [Files and content types](speech-to-text.md#files-and-content-types); a Dart upload is an `AudioFile`). Duration and size are limited per file; the [reference](https://echonova.ai/docs/reference/clean-create) has the current limits. Cut longer recordings into pieces.

Cleaning a long file can take minutes. The SDK gives `clean()` a long default timeout for that reason (see [Configuration](configuration.md)); make sure anything between your code and the API, such as a load balancer or [proxy](../../proxy-examples/README.md), allows it too.

## Options

All options are optional: those you leave out aren't sent, and the cleaner uses its defaults. The job's `options` records the tuning values you sent.

| Python | TypeScript and Dart | What it sets |
|---|---|---|
| `cutoff_freq` | `cutoffFreq` | High-pass cutoff, in Hz: rumble below it is removed. |
| `q_factor` | `qFactor` | How smooth the high-pass filter is. |
| `target_lufs` | `targetLufs` | Target loudness, in LUFS. |
| `true_peak_dbfs` | `truePeakDbfs` | Peak ceiling, in dBFS. |
| `comp_thresh_db` | `compThreshDb` | Compressor threshold, in dBFS. |
| `comp_ratio` | `compRatio` | Compressor ratio. |
| `comp_attack_ms` | `compAttackMs` | Compressor attack, in milliseconds. |
| `comp_release_ms` | `compReleaseMs` | Compressor release, in milliseconds. |
| `sample_rate` | `sampleRate` | Sample rate of the cleaned WAV, one of a few fixed values. |
| `bit_depth` | `bitDepth` | Bits per sample of the cleaned WAV: 16 or 24. |

The ranges, allowed values and defaults are in the [reference](https://echonova.ai/docs/reference/clean-create). The SDK doesn't check them: a value out of range comes back as `InvalidRequestError` with the API's message, and nothing is charged.

## Metrics

`metrics` holds what the cleaner measured on the result, when it reports it, so each field may be missing:

| Python | TypeScript and Dart | |
|---|---|---|
| `sample_rate` | `sampleRate` | Sample rate of the cleaned file, in Hz. |
| `bit_depth` | `bitDepth` | Bits per sample of the cleaned file. |
| `integrated_lufs` | `integratedLufs` | Measured loudness, in LUFS. |
| `true_peak_dbfs` | `truePeakDbfs` | Measured true peak, in dBFS. |

The cleaned file is always a mono WAV, at the sample rate and bit depth you asked for (or the defaults). `duration_seconds` is rounded; `credits_consumed` is what was charged.

## Download, list and delete

- `output_url` (`outputUrl`) expires. `jobs.get()` returns the job with a fresh link, and `jobs.download()` gets one and downloads the file. `client.download()` sends no API key, and an expired link raises `DownloadExpiredError`.
- `jobs.list()` lists the API jobs of your workspace, newest first, whichever key made them; iterating the result (or `listAll()` in Dart) walks every page. See [Jobs](jobs.md#list-jobs).
- `jobs.delete()` deletes the job with its original and cleaned files.

**Python**

```python
from echonova import EchoNova

client = EchoNova()

for job in client.sound_cleaning.jobs.list(limit=100):  # every page, newest first
    print(job.id, job.file_name, job.status, job.created_at)

job_id = "..."  # a Sound Cleaning job ID
client.sound_cleaning.jobs.download(job_id, to="clean.wav")  # gets a fresh link first
client.sound_cleaning.jobs.delete(job_id)  # removes the original and the cleaned file
```

**TypeScript**

```ts
import EchoNova from '@echonova/ai';

const client = new EchoNova();

for await (const job of client.soundCleaning.jobs.list({ limit: 100 })) {
  console.log(job.id, job.fileName, job.status, job.createdAt); // every page, newest first
}

const jobId = '...'; // a Sound Cleaning job ID
await client.soundCleaning.jobs.download(jobId, { to: 'clean.wav' }); // gets a fresh link first
await client.soundCleaning.jobs.delete(jobId); // removes the original and the cleaned file
```

**Dart**

```dart
import 'package:echonova_ai/echonova_ai.dart';

final client = EchoNova();

await for (final job in client.soundCleaning.jobs.listAll(limit: 100)) {
  print('${job.id} ${job.fileName} ${job.status.value} ${job.createdAt}'); // every page, newest first
}

const jobId = '...'; // a Sound Cleaning job ID
await client.soundCleaning.jobs.downloadTo(jobId, 'clean.wav'); // gets a fresh link first
await client.soundCleaning.jobs.delete(jobId); // removes the original and the cleaned file
client.close();
```

## When something goes wrong

- **Unsupported format** (for example an M4A file renamed to `.mp3`), a file that is too long, or an option out of range: `InvalidRequestError`, with the API's message. Nothing is charged. Convert the audio rather than renaming it.
- **The cleaner is temporarily unavailable:** the API refunds the charge, so the SDK retries the call by itself, and raises `ServiceUnavailableError` if it keeps failing.
- **The response is lost** after the upload was sent: the SDK sends it again with the same idempotency key, and the API answers with the first result, charged once. If it still fails, the error carries the key (`idempotency_key` / `idempotencyKey`); send the request again with it. See [Errors](errors.md#idempotency-keys).
- **A long file** still processing after 220 seconds: the SDK waits for the cleaning to finish and returns the same result.

## See also

- [Jobs](jobs.md): listing, deleting and downloads.
- [Sound Cleaning quickstart](https://echonova.ai/docs/developers/clean-quickstart), with the tuning ranges and pricing.
