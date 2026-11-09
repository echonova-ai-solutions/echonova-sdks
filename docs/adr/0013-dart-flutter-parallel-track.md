# 13. The Dart/Flutter SDK is built in parallel with the TypeScript SDK

Date: 2026-11-09

## Status

Accepted

## Context

The SDKs were planned in sequence: Python, then JavaScript/TypeScript, then Dart/Flutter. Built one after another by one engineer, the Dart SDK would arrive months after the others, while mobile developers are among those who most need a safe way to use the API (ADR 0008).

Building Dart in parallel brings risks:

- two SDKs under construction at once can drift apart;
- there is no finished TypeScript SDK to port from;
- Flutter adds its own problems: WebSocket handshakes, a browser transport for Flutter web, and audio capture and playback.

## Decision

- **A second engineer builds the Dart/Flutter SDK, starting in week 12 of the project, in parallel with the TypeScript SDK.** By then, the Python core has proven the design and the shared fixtures are recorded. The Dart SDK ports a working design against shared tests, instead of being designed at the same time as everything else.
- The Dart track starts with short spikes on the riskiest parts:
  - a manual `dart:io` WebSocket upgrade that exposes handshake errors;
  - Flutter web streaming through a proxy with cookie authentication;
  - microphone capture and PCM playback latency in a throwaway app.
- **Architecture:**
  - a pure-Dart package, `echonova`, with no Flutter dependency, usable from Flutter and from server-side Dart;
  - `EchoNova(apiKey:)` for servers, and `EchoNova.proxy(baseUrl:, auth:)` for apps (ADR 0008);
  - `package:http` with an injectable `Client`;
  - WebSockets through a manual `dart:io` upgrade, and a browser transport for Flutter web, which supports proxy mode only;
  - sealed event and exception types, and audio as `Stream<Uint8List>`;
  - the same core design as the other SDKs (ADR 0003), ported from the Python core.
- **Shared rules data is compiled in.** Flutter apps can't read package data files at runtime, so `error-rules.json` is compiled into a generated Dart source file, and CI checks that it is current.
- **Audio plugins stay out of the SDK.** Microphone and playback plugins belong to the sample app, so the SDK has no platform plugin dependencies.
- **The reference proxies** (ADR 0008) are part of this track. They ship with the Python and TypeScript SDKs too, so web apps benefit from them as well.

### Keeping the TypeScript and Dart SDKs aligned

- `spec/` has one owner. Every change to it is reviewed by both tracks, and CI runs every SDK's tests on it (ADR 0001).
- The cross-SDK naming map (ADR 0006) already includes the Dart names. A short weekly API sync keeps the two surfaces aligned while both are being built.
- The Dart SDK must pass the same shared vectors and conformance fixtures as the others (ADR 0011).

## Consequences

- The Dart SDK ships at about the same time as the TypeScript SDK, instead of after it.
- The project needs the second engineer in place by week 12. A late start delays only the Dart SDK.
- The shared `spec/` and conformance suite carry more weight, because they are the main guard against drift between two SDKs built at the same time.
- Dart-specific acceptance adds `dart pub publish --dry-run`, a pana score of at least 130, and a sample app that streams Text to Speech and Speech to Text through the reference proxy on Android, iOS and web.
