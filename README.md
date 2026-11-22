<div align="center">

<img src="docs/assets/banner.svg" alt="EchoNova SDKs: Text to Speech, Speech to Text and Sound Cleaning for Python, TypeScript and Dart" width="100%">

<p>
  <a href="https://pypi.org/project/echonova/"><img src="https://img.shields.io/pypi/v/echonova?label=PyPI&color=6E665C&labelColor=171310" alt="PyPI: echonova"></a>
  <a href="https://www.npmjs.com/package/@echonova/ai"><img src="https://img.shields.io/npm/v/@echonova/ai?label=npm&color=6E665C&labelColor=171310" alt="npm: @echonova/ai"></a>
  <a href="https://pub.dev/packages/echonova_ai"><img src="https://img.shields.io/pub/v/echonova_ai?label=pub.dev&color=6E665C&labelColor=171310" alt="pub.dev: echonova_ai"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-6E665C?labelColor=171310" alt="License: MIT"></a>
  <a href="https://github.com/echonova-ai-solutions/echonova-sdks/actions/workflows/ci.yml"><img src="https://github.com/echonova-ai-solutions/echonova-sdks/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

<p>
  <b>⚡ <a href="#-quick-start">Quick start</a></b> &nbsp;·&nbsp;
  <b>📦 <a href="#-packages">Packages</a></b> &nbsp;·&nbsp;
  <b>✨ <a href="#-features">Features</a></b> &nbsp;·&nbsp;
  <b>📚 <a href="docs/guides/README.md">Guides</a></b> &nbsp;·&nbsp;
  <b>🔌 <a href="proxy-examples/README.md">Proxy mode</a></b> &nbsp;·&nbsp;
  <b>🚀 <a href="#-releasing">Releasing</a></b>
</p>

<b>Official SDKs for the EchoNova speech API: Text to Speech, Speech to Text and Sound Cleaning, over REST and real-time streaming.</b>

<p dir="rtl">
المكتبات البرمجية الرسمية لواجهة إيكونوڤا الصوتية بلغات Python وTypeScript وDart: تحويل النص إلى كلام، وتحويل الكلام إلى نص، وتنقية الصوت، عبر REST والبث المباشر.
</p>

</div>

Three SDKs, one behaviour. Each wraps every endpoint of the [EchoNova API](https://echonova.ai/docs/developers) with typed results, streaming sessions and retries that never charge you twice, and all three are tested against the same contract and the same recorded API traffic.

## 📦 Packages

| SDK | Install | Import | Runs on |
| :--- | :--- | :--- | :--- |
| 🐍 [Python](python/README.md) | `pip install echonova` | `from echonova import EchoNova` | Python 3.11+, blocking and asyncio |
| 🟦 [TypeScript / JavaScript](js/README.md) | `npm install @echonova/ai` | `import EchoNova from '@echonova/ai'` | Node.js 22+, Bun, Deno, Cloudflare Workers; browsers through a proxy |
| 🎯 [Dart / Flutter](dart/README.md) | `dart pub add echonova_ai` | `import 'package:echonova_ai/echonova_ai.dart';` | Dart 3.5+: server, mobile, desktop; Flutter web through a proxy |

## ⚡ Quick start

Create an API key in the EchoNova portal and set it as `ECHONOVA_API_KEY`. Then synthesize Arabic speech and save it:

**Python**

```python
from echonova import EchoNova

client = EchoNova()  # reads ECHONOVA_API_KEY

voices = client.text_to_speech.voices.list()  # changes rarely: cache it
voice = next(v for v in voices if v.language == "ar")

speech = client.text_to_speech.generate("أهلاً بك في إيكونوفا", voice_id=voice.id)
print(speech.duration_seconds, speech.credits_consumed, speech.request_id)
client.download(speech.audio_url, to="speech.wav")
```

**TypeScript**

```ts
import EchoNova from '@echonova/ai';

const client = new EchoNova(); // reads ECHONOVA_API_KEY

const voices = await client.textToSpeech.voices.list(); // changes rarely: cache it
const voice = voices.items.find((v) => v.language === 'ar')!;

const speech = await client.textToSpeech.generate({ text: 'أهلاً بك في إيكونوفا', voiceId: voice.id });
console.log(speech.durationSeconds, speech.creditsConsumed, speech.requestId);
await client.download(speech.audioUrl, { to: 'speech.wav' });
```

**Dart**

```dart
import 'package:echonova_ai/echonova_ai.dart';

Future<void> main() async {
  final client = EchoNova(); // reads ECHONOVA_API_KEY
  try {
    final voices = await client.textToSpeech.voices.list(); // changes rarely: cache it
    final voice = voices.firstWhere((v) => v.language == 'ar');

    final speech =
        await client.textToSpeech.generate('أهلاً بك في إيكونوفا', voiceId: voice.id);
    print('${speech.durationSeconds} s, ${speech.creditsConsumed} credits');
    await client.downloadTo(speech.audioUrl!, 'speech.wav');
  } finally {
    client.close();
  }
}
```

The [getting-started guide](docs/guides/getting-started.md) continues with Speech to Text, streaming and proxy mode, in all three languages.

## ✨ Features

- **Every service.** Text to Speech (one call, background jobs, live streaming), Speech to Text (files, jobs with TXT/SRT/JSON export, live streaming with terminology), Sound Cleaning, agent sessions and website widget tickets, plus webhook verification.
- **Real-time streaming.** Low-latency speech as PCM chunks, with cancel and barge-in for voice agents, and live transcription that keeps long sessions going past the server's limit.
- **Never charged twice.** Synchronous calls carry an idempotency key, so they are retried safely and long ones are waited for; other paid requests are never resent blindly. Errors say whether a request may have run (`may_have_executed`), and carry the key to retry it with.
- **Keys stay on your server.** Browsers and Flutter apps use proxy mode: they call your backend, which adds the key. Reference proxies for [FastAPI and Express](proxy-examples/README.md) are included, and a [Flutter sample app](samples/flutter/README.md) streams through them.
- **Typed and transparent.** Typed results that keep the API's JSON, a request ID on every result and error, rate-limit awareness, and logs that never contain keys, audio or transcripts.
- **One behaviour in three languages.** The same error classes, retry rules and test vectors everywhere, and every SDK replays the same 73 recordings of real API traffic in CI.

## 🔗 Resources

| Resource | Link |
| :--- | :--- |
| EchoNova API documentation | [echonova.ai/docs/developers](https://echonova.ai/docs/developers) |
| Guides (Python, TypeScript and Dart side by side) | [docs/guides](docs/guides/README.md): authentication, Text to Speech, Speech to Text, Sound Cleaning, jobs, streaming, errors, webhooks, configuration, troubleshooting |
| SDK references | [Python](python/README.md) · [TypeScript](js/README.md) · [Dart](dart/README.md), each with runnable examples |
| Proxy mode for web and mobile apps | [proxy-examples](proxy-examples/README.md) (FastAPI, Express) · [Flutter sample](samples/flutter/README.md) |
| Why the SDKs work the way they do | [Architecture decision records](docs/adr/README.md) |
| Security and key handling | [SECURITY.md](SECURITY.md) |
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md) |

## 🗂️ Repository layout

```text
python/          Python SDK                      (PyPI: echonova)
js/              TypeScript / JavaScript SDK      (npm: @echonova/ai)
dart/            Dart / Flutter SDK               (pub.dev: echonova_ai)
spec/            The shared contract every SDK is tested against
  openapi.json, asyncapi.json   API specs, vendored from api.echonova.ai and pinned in spec-lock.json
  error-rules.json              error classification and retry rules, with test vectors
  webhooks.json                 webhook signing and event payloads
  mapping.json                  API field names and their name in each SDK (generated)
  fixtures/                     test vectors and recorded API traffic, with expected.json
proxy-examples/  Reference backend proxies (FastAPI, Express) that keep the API key on your server
samples/flutter/ A Flutter app (Android, iOS, web) streaming Text to Speech and Speech to Text through a proxy
docs/            User guides, architecture decision records and contributor docs
tools/           Spec sync, fixture builders, rule generators, the traffic recorder, publishing checks
```

## 🧪 How the SDKs stay consistent

- The API contract comes from EchoNova's published specs, never from hand-copied documentation. A nightly job compares the live specs with the pinned copies and opens an issue when they change.
- Error handling and retries are data (`spec/error-rules.json`), shared by every SDK.
- Real API traffic is recorded, scrubbed of keys and IDs, and replayed by every SDK in CI against one list of expected outcomes (`spec/fixtures/expected.json`).
- Each SDK's live suite runs against the real API every night.

## 🛠️ Working on the repository

```bash
python3 tools/spec_sync.py --check      # do the pinned specs match the live API?
python3 tools/build_error_catalog.py    # regenerate fixtures from the specs
python3 tools/build_mapping.py
python3 tools/build_webhook_vectors.py
python3 tools/sync_sdk_data.py          # copy / generate the shared rules into every SDK
python3 tools/check_public.py           # make sure nothing private is about to be published
python3 tools/check_snippets.py         # type-check every code sample in the READMEs and guides

cd python && uv sync && uv run pytest           # Python SDK
cd js && npm ci && npm test                     # TypeScript / JavaScript SDK (Node 22+)
cd dart && dart pub get && dart test            # Dart SDK
cd proxy-examples/fastapi && uv run pytest      # reference proxies
cd proxy-examples/express && npm ci && npm test
cd samples/flutter && flutter test              # Flutter sample app
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full setup.

**Live API tests.** Each SDK has a live suite that calls the real API. It never runs by default and costs credits, so use a key from a dedicated test workspace with a Credit Limit set:

```bash
cd python && ECHONOVA_LIVE=1 ECHONOVA_API_KEY=... uv run pytest -m live
cd js && ECHONOVA_LIVE=1 ECHONOVA_API_KEY=... npm run test:live
cd dart && ECHONOVA_LIVE=1 ECHONOVA_API_KEY=... dart test -t live
```

Without a key only the free checks run. CI runs all three nightly ([live.yml](.github/workflows/live.yml), which lists the optional variables). `tools/record/record.py` records live API traffic as scrubbed fixtures; [record.yml](.github/workflows/record.yml) runs it in GitHub.

## 🚀 Releasing

Each SDK is published by pushing its tag; the [publish workflow](.github/workflows/publish.yml) checks the version, runs the tests and publishes with OIDC trusted publishing (no tokens). npm releases are staged and go public once a maintainer approves them with 2FA. Details and the one-time registry setup: [docs/RELEASING.md](docs/RELEASING.md).

| SDK | Bump the version in | Then |
| :--- | :--- | :--- |
| Python (`echonova`) | `python/src/echonova/_version.py` | `git tag py-vX.Y.Z && git push origin py-vX.Y.Z` |
| npm (`@echonova/ai`) | `js/package.json` and `js/src/version.ts` | `git tag js-vX.Y.Z && git push origin js-vX.Y.Z` |
| Dart (`echonova_ai`) | `dart/pubspec.yaml`, `dart/lib/src/version.dart` and `dart/CHANGELOG.md` | `git tag dart-vX.Y.Z && git push origin dart-vX.Y.Z` |

## 🛡️ Security

Never put an API key in client-side code (browsers, mobile apps): keep keys on your server and read them from the environment. Report vulnerabilities privately through [GitHub's reporting form](https://github.com/echonova-ai-solutions/echonova-sdks/security/advisories/new), as described in [SECURITY.md](SECURITY.md).

## ⚖️ License

MIT. See [LICENSE](LICENSE).
