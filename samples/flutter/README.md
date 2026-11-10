# EchoNova Flutter sample

A Flutter app for Android, iOS and the web that uses the [EchoNova Dart SDK](../../dart) in **proxy mode**:

- **Text to Speech:** pick a voice, type up to 500 characters, and hear it while it is still being synthesized, over the Text to Speech stream. **Stop** cancels at once; **Speak** again replaces what is playing (barge-in). After each synthesis the app shows how it ended, the time to the first audio and the credits it cost.
- **Speech to Text:** the microphone streams PCM16 mono at 16 kHz into a Speech to Text session. Each time you pause, the app cuts a segment (`endSegment()`) and its transcript appears. **Stop** transcribes the rest and shows the session summary, including the job the session was saved as.

The app never holds an EchoNova API key. It calls **your proxy**, which checks your user, adds the key and forwards the call. Run one of the [reference proxies](../../proxy-examples) to try it.

## Why the key never ships in the app

An EchoNova API key (`ek_...`) spends your workspace's credits. Anything inside an app can be extracted from it: from the APK or IPA, or from the JavaScript of a web page. So the key stays on your server:

```
app ──(your user's credentials)──► your proxy ──(API key)──► api.echonova.ai
```

- The app is created with `EchoNova.proxy(baseUrl: <your proxy>, auth: ...)`. `auth` returns **your app's** credentials, such as the signed-in user's access token. The proxy checks them, removes them, adds the key and forwards the request.
- Browsers can't send headers on a WebSocket. On the web the app first gets a short-lived stream token from the proxy (`POST <proxy>/stream-token`, with the usual credentials) and the SDK adds it to the stream URL (`streamQuery`). The proxy removes it before forwarding. On Android and iOS the `auth` headers are sent on the stream upgrade, as on REST calls.
- The app refuses to start if the token it was given looks like an API key, if it is pointed at `api.echonova.ai` instead of a proxy, or, in a release build, if the proxy isn't on `https` (localhost excepted).

## Run it

You need Flutter 3.44 or later (tested with 3.47.9), and for each platform its usual toolchain: Android SDK, Xcode, or Chrome.

### 1. Start a reference proxy

The [Express](../../proxy-examples/express) or the [FastAPI](../../proxy-examples/fastapi) proxy, on your computer:

```bash
cd proxy-examples/express
npm ci
export ECHONOVA_API_KEY=ek_...                         # your key: it stays here
export PROXY_DEMO_TOKEN=change-me                      # demo sign-in shared by the app
export PROXY_ALLOWED_ORIGINS=http://localhost:3000     # for the web app below
npm start                                              # http://127.0.0.1:8080/echonova
```

FastAPI: same variables, then `cd proxy-examples/fastapi && uv sync && uv run python -m echonova_proxy`.

### 2. Run the app

```bash
cd samples/flutter
flutter pub get
```

Then, for the platform you want (`PROXY_DEMO_TOKEN` is the proxy's demo token above; `-d` takes the start of a device name, see `flutter devices`):

| Platform | Command |
|---|---|
| Web (Chrome) | `flutter run -d chrome --web-port 3000 --dart-define=PROXY_DEMO_TOKEN=change-me` |
| Android emulator | `flutter run -d emulator --dart-define=PROXY_DEMO_TOKEN=change-me` |
| iOS simulator | `flutter run -d iPhone --dart-define=PROXY_DEMO_TOKEN=change-me` |
| Android device | `adb reverse tcp:8080 tcp:8080`, then add `--dart-define=ECHONOVA_PROXY_URL=http://127.0.0.1:8080/echonova` |
| iOS device | Run the proxy where the phone can reach it (for example `HOST=0.0.0.0`, on the same network) and add `--dart-define=ECHONOVA_PROXY_URL=http://<your computer's address>:8080/echonova` |

Without `ECHONOVA_PROXY_URL`, the app uses the proxy on your computer: `http://localhost:8080/echonova` on the web, `http://10.0.2.2:8080/echonova` on the Android emulator (its address for your computer), `http://127.0.0.1:8080/echonova` elsewhere. The URL in use is shown under the title.

For a deployed proxy, pass its `https` URL: `--dart-define=ECHONOVA_PROXY_URL=https://api.example.com/echonova`. You can keep the values in a file and pass `--dart-define-from-file=dart_defines.json` (git-ignored here).

On the web, the page's origin must be listed in the proxy's `PROXY_ALLOWED_ORIGINS`. That is why the command above fixes the port to 3000.

### Configuration

| `--dart-define` | Default | |
|---|---|---|
| `ECHONOVA_PROXY_URL` | the proxy on your computer (see above) | Your proxy's base URL. The SDK appends API paths, such as `/v1/text-to-speech/voices`, to it. |
| `PROXY_DEMO_TOKEN` | none | **Demo only.** The reference proxy's `PROXY_DEMO_TOKEN`, sent as `Authorization: Bearer ...`. It is *not* an EchoNova API key. Replace it with your sign-in (below). |

## Plug in your own sign-in

[`lib/src/proxy_auth.dart`](lib/src/proxy_auth.dart) has the one hook to replace, `ProxyAuth`:

```dart
final class MyAuth implements ProxyAuth {
  @override
  Future<Map<String, String>> headers() async =>
      {'Authorization': 'Bearer ${await mySignIn.currentAccessToken()}'};
}
```

Use it instead of `DemoTokenAuth` in [`lib/main.dart`](lib/main.dart), and replace the proxy's demo `authenticate` hook with a check of the same token (see the proxy READMEs). The SDK calls `headers()` before every request and every stream connection, so it can return a refreshed token. A web app that signs in with a session cookie can use it for streams too, instead of stream tokens: see *WebSockets in browsers* in the [proxy overview](../../proxy-examples/README.md#websockets-in-browsers).

## How it is built

| File | What it does |
|---|---|
| [`lib/main.dart`](lib/main.dart) | Reads the configuration and creates the one SDK client for the app's lifetime. |
| [`lib/src/proxy_auth.dart`](lib/src/proxy_auth.dart) | The sign-in hook, web stream tokens, and `EchoNova.proxy(...)`. |
| [`lib/src/config.dart`](lib/src/config.dart) | `--dart-define` values and the safety checks. |
| [`lib/src/speech_service.dart`](lib/src/speech_service.dart) | Every SDK call the app makes, behind small interfaces the tests replace with fakes. |
| [`lib/src/tts/tts_controller.dart`](lib/src/tts/tts_controller.dart) | Voices, speak, stop. One Text to Speech stream, opened on the first speak and reused. |
| [`lib/src/stt/stt_controller.dart`](lib/src/stt/stt_controller.dart) | Microphone to `sendAudio`, `endSegment` at pauses, `stop()` for the summary. |
| [`lib/src/audio/`](lib/src/audio) | PCM16 playback and capture (below). |
| [`lib/src/errors.dart`](lib/src/errors.dart) | Turns the SDK's exceptions (`AuthenticationException`, `BillingException`, `ConcurrencyLimitException`, ...) into messages. |

The controllers are `ChangeNotifier`s. They close the stream sessions, cancel subscriptions and release the microphone and the audio device when they are disposed; closing the app closes the SDK client.

### Audio plugins

Audio stays in the app: the SDK has no plugin dependencies.

- **Microphone: [`record`](https://pub.dev/packages/record).** Streams raw PCM16 (`AudioEncoder.pcm16bits`) on Android, iOS and the web, at the sample rate you ask for (in a browser it resamples in an AudioWorklet).
- **Playback on Android and iOS: [`flutter_pcm_sound`](https://pub.dev/packages/flutter_pcm_sound).** Plays raw PCM16 as it is fed, with no files and no decoding, so playback starts with the first chunk. The app sets it up at the sample rate from each synthesis's `start` event and releases it when the synthesis stops. Its latest release (3.3.3) compiles against Android API 33, below the 34 that current AndroidX libraries need, so `android/build.gradle.kts` compiles plugins like it against API 36. That only changes which APIs the plugin's code is checked against, not the devices the app runs on.
- **Playback on the web: Web Audio, in [`pcm_player_web.dart`](lib/src/audio/pcm_player_web.dart)** (`package:web`, picked by a conditional import). Each chunk becomes an `AudioBuffer` at the synthesis's sample rate, scheduled to start exactly when the previous one ends. **Stop** stops every scheduled buffer at once.

Plugins that also cover the web were considered: `flutter_soloud` builds a C++ engine with build hooks and loads a WebAssembly module on the web, which is a lot for this sample; `mp_audio_stream` takes float samples and silently drops a chunk when its buffer is full, so it needs pacing.

## Notes

- **Stream slots.** The Text to Speech stream stays open between syntheses so that later ones start faster, and a Speech to Text session holds a second stream while you record. The reference proxy's demo quota allows 2 concurrent streams per user (`PROXY_MAX_STREAMS_PER_USER`), and a workspace allows 10 in total. Leaving a screen stops what it was doing.
- **Browser audio.** Browsers only start audio from a user gesture, so the player is unlocked in the **Speak** tap handler, before anything is awaited.
- **Pauses.** A pause is 0.7 s of quiet after at least 0.3 s of sound: a simple loudness gate, fine for a demo in a quiet room. Without pauses, the server still cuts a segment every 15 seconds.
- **One synthesis takes 1 to 500 characters.** For longer text, or text that streams in (an LLM's reply), use the SDK's `TtsSession.speakStream`, which splits it into sentences.

## Develop

```bash
flutter analyze
flutter test                  # controllers and a widget smoke test, on fakes: no network, no audio
flutter build web --release
```
