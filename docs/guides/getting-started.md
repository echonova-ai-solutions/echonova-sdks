# Getting started

Install an EchoNova SDK, put your API key in the environment, and turn text into a WAV file. It takes about five minutes.

## Supported runtimes

| SDK | Package | Requires | Runs on |
| --- | --- | --- | --- |
| Python | `echonova` on PyPI | CPython 3.11 or later | Any OS. A blocking client (`EchoNova`) and an asyncio client (`AsyncEchoNova`) with the same methods. |
| JavaScript / TypeScript | `@echonova/ai` on npm | Node.js 22 or later, Bun, or Deno 2 | ESM and CommonJS, with type definitions. Cloudflare Workers runs REST and streaming (file paths only with `nodejs_compat`); Vercel Edge runs REST only, without file paths. Browsers use [proxy mode](authentication.md#proxy-mode-for-web-and-mobile-apps) only. |
| Dart / Flutter | `echonova_ai` on pub.dev | Dart 3.5 or later (Flutter 3.24 or later) | Server-side Dart with an API key. Flutter apps on Android, iOS, desktop and the web use [proxy mode](authentication.md#proxy-mode-for-web-and-mobile-apps). |

Each SDK supports every language version that is still maintained upstream. A version that reaches end of life is dropped in a minor release, announced one release ahead in the changelog.

## Install

**Python**

```bash
pip install echonova          # or: uv add echonova
```

**TypeScript**

```bash
npm install @echonova/ai          # or: pnpm add @echonova/ai, yarn add @echonova/ai, bun add @echonova/ai
deno add npm:@echonova/ai         # Deno
```

**Dart**

```bash
dart pub add echonova_ai      # Flutter: flutter pub add echonova_ai
```

## Get an API key

1. In the EchoNova portal, open **Developers**, then the **API Keys** tab, and select **Create Key**.
2. Give the key access to **Text to Speech** (and any other service you will call). Setting a **Credit Limit** is a good habit for any key used by an unattended system.
3. Copy the secret. It starts with `ek_` and is shown only once.

The [Get an API key](https://echonova.ai/docs/developers/get-an-api-key) page has the details.

Every SDK reads the key from the `ECHONOVA_API_KEY` environment variable, so it never has to appear in your code:

```bash
export ECHONOVA_API_KEY="ek_..."              # macOS and Linux
$env:ECHONOVA_API_KEY = "ek_..."              # Windows PowerShell
```

Keep the key on your server. Never put it in a browser bundle, a mobile app or a public repository: see [Authentication](authentication.md).

## Your first audio

The program below lists the voices, picks an Arabic one, synthesizes a sentence and saves the WAV file. For English, pick a voice whose `language` is `en` and pass English text.

**Python**

```python
from echonova import EchoNova

with EchoNova() as client:  # reads ECHONOVA_API_KEY
    voices = client.text_to_speech.voices.list()  # changes rarely: cache it in real code
    for voice in voices:
        print(voice.id, voice.display_name or voice.name, voice.language)

    voice = next(v for v in voices if v.language == "ar")
    speech = client.text_to_speech.generate("أهلاً بك في إيكونوفا", voice_id=voice.id)
    path = client.download(speech.audio_url, to="hello.wav")  # the link expires: download it now
    print(f"saved {path}: {speech.duration_seconds} s, {speech.credits_consumed} credits")
```

Save it as `quickstart.py` and run `python quickstart.py`.

**TypeScript**

```ts
import EchoNova from '@echonova/ai';

const client = new EchoNova(); // reads ECHONOVA_API_KEY

const voices = await client.textToSpeech.voices.list(); // changes rarely: cache it in real code
for (const voice of voices) console.log(voice.id, voice.displayName ?? voice.name, voice.language);

const voice = voices.items.find((v) => v.language === 'ar');
if (!voice) throw new Error('no Arabic voice is available');
const speech = await client.textToSpeech.generate({ text: 'أهلاً بك في إيكونوفا', voiceId: voice.id });
const path = await client.download(speech.audioUrl, { to: 'hello.wav' }); // the link expires: download it now
console.log(`saved ${path}: ${speech.durationSeconds} s, ${speech.creditsConsumed} credits`);

await client.close();
```

Save it as `quickstart.ts` and run it with `bun quickstart.ts`, `npx tsx quickstart.ts` or `deno run -A quickstart.ts`. The code is also valid JavaScript: save it as `quickstart.mjs` and run `node quickstart.mjs` (top-level `await` needs an ES module).

**Dart**

```dart
import 'package:echonova_ai/echonova_ai.dart';

Future<void> main() async {
  final client = EchoNova(); // reads ECHONOVA_API_KEY
  try {
    final voices = await client.textToSpeech.voices.list(); // changes rarely: cache it in real code
    for (final voice in voices) {
      print('${voice.id} ${voice.displayName ?? voice.name} ${voice.language}');
    }

    final voice = voices.firstWhere((v) => v.language == 'ar');
    final speech = await client.textToSpeech.generate('أهلاً بك في إيكونوفا', voiceId: voice.id);
    final path = await client.downloadTo(speech.audioUrl!, 'hello.wav'); // the link expires: download it now
    print('saved $path: ${speech.durationSeconds} s, ${speech.creditsConsumed} credits');
  } finally {
    client.close();
  }
}
```

Save it as `bin/quickstart.dart` in a package that depends on `echonova_ai`, and run `dart run bin/quickstart.dart`.

### What just happened

- `generate` called the synchronous Text to Speech endpoint and waited for the audio. Its result carries the job's ID, its length, the credits it cost, the request ID, and `audio_url` / `audioUrl`: a signed link to the WAV file.
- The signed link expires, so download it soon. `download` sends no API key, because the link points at a storage host, not at EchoNova. To get a fresh link later, get the job again (see [Jobs](jobs.md)).
- If anything had failed, the SDK would have raised a typed error, such as `AuthenticationError` for a wrong key. Connection failures and rate limits are retried for you, but a paid request that may already have run is never sent twice. See [Errors](errors.md).

Create one client and reuse it for the life of your program: it keeps the connection pool and the rate-limit state that all calls share. Close it when you are done, as above.

## If it didn't work

| You see | Do this |
| --- | --- |
| `UsageError: No API key` (`UsageException` in Dart) | `ECHONOVA_API_KEY` is not set in the shell that runs the program. |
| `AuthenticationError` (401) | The key is mistyped, from another workspace, disabled or deleted. |
| `PermissionDeniedError` (403) | The key has no access to Text to Speech, or the workspace has no active subscription. |
| `InsufficientBalanceError` (402) | The workspace has no credits left. |
| `UnsupportedEnvironmentError` | You created a client with an API key in a browser. Use [proxy mode](authentication.md#proxy-mode-for-web-and-mobile-apps). |

[Troubleshooting](troubleshooting.md) covers these and more.

## Next steps

- [Text to Speech](text-to-speech.md): voices, options, async jobs and long text.
- [Speech to Text](speech-to-text.md) and [Sound Cleaning](sound-cleaning.md).
- [Streaming](streaming.md): low-latency speech and live transcription over WebSockets.
- [Authentication](authentication.md): key handling and proxy mode for web and Flutter apps.
- [Configuration](configuration.md): timeouts, retries, logging and custom HTTP clients.
