# Documentation

This folder holds documentation shared by every EchoNova SDK. The API itself is documented in the [EchoNova developer docs](https://echonova.ai/docs/developers), which stay the reference for endpoints, parameters and limits.

## In this repository

| Where | What |
| --- | --- |
| [`adr/`](adr/README.md) | Architecture decision records: why the SDKs are built the way they are |
| [`../spec/README.md`](../spec/README.md) | The shared contract every SDK is tested against |
| [`../python/README.md`](../python/README.md) | The Python SDK |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | Development setup, the spec workflow, commit and testing rules |
| [`../SECURITY.md`](../SECURITY.md) | Reporting vulnerabilities, supported versions and key handling |

## Planned guides

These user guides will be written as the SDKs reach beta. Each guide will cover every SDK, with a tab per language, and every code sample in them will run in CI.

- **Install and supported runtimes**
- **Quickstart:** from install to first audio in under five minutes
- **Authentication:** keys in environment variables or a secrets manager, key rotation, why keys never go into browsers or mobile apps, and proxy mode
- **Text to Speech:** voices, choosing between sync, async jobs and streaming, options, and splitting long text
- **Speech to Text:** audio formats, choosing the language, numbers, speaker identification, terminology, and exporting transcripts
- **Sound Cleaning:** tuning the options and reading the metrics
- **Batch and async jobs:** polling or webhooks, `wait()`, and recovering when a POST's response was lost
- **Streaming:**
  - the session lifecycle, PCM audio formats and keepalive;
  - barge-in, and `speak_stream` for voice agents;
  - microphone and playback recipes;
  - session length limits and rollover;
  - billing notes: a cancelled synthesis is still charged, and how the limit of 10 open streams per workspace affects concurrent voice calls
- **Error handling:** the error classes, what the SDK retries and why, and using request IDs with support
- **Webhooks:** verifying signatures, deduplicating events, and acknowledging quickly
- **Configuration:** timeouts, retries, HTTP proxies, custom HTTP clients, hooks and logging
- **Migrating from raw HTTP**
- **Troubleshooting and FAQ**

Each SDK will also have a generated API reference: mkdocs-material with mkdocstrings for Python, TypeDoc for TypeScript and dartdoc for Dart. Runnable examples will live in each SDK's `examples/` folder and in `proxy-examples/`.
