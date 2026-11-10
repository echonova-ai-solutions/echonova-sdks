# Documentation

This folder holds documentation shared by every EchoNova SDK. The API itself is documented in the [EchoNova developer docs](https://echonova.ai/docs/developers), which stay the reference for endpoints, parameters and limits.

## Guides

The [guides](guides/README.md) cover every SDK, with each example in Python, TypeScript and Dart: getting started, authentication and proxy mode, Text to Speech, Speech to Text, Sound Cleaning, jobs, streaming, agents and widgets, errors, webhooks, configuration, migrating from raw HTTP, and troubleshooting. Every code sample in them is type-checked against the SDK source in CI (`tools/check_snippets.py`).

## In this repository

| Where | What |
| --- | --- |
| [`guides/`](guides/README.md) | User guides for all three SDKs |
| [`adr/`](adr/README.md) | Architecture decision records: why the SDKs are built the way they are |
| [`RELEASING.md`](RELEASING.md) | Tags, trusted publishing and the one-time registry setup |
| [`../spec/README.md`](../spec/README.md) | The shared contract every SDK is tested against |
| [`../python/README.md`](../python/README.md) | The Python SDK |
| [`../js/README.md`](../js/README.md) | The JavaScript / TypeScript SDK |
| [`../dart/README.md`](../dart/README.md) | The Dart / Flutter SDK |
| [`../proxy-examples/README.md`](../proxy-examples/README.md) | Reference backend proxies that keep the API key on your server |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | Development setup, the spec workflow, commit and testing rules |
| [`../SECURITY.md`](../SECURITY.md) | Reporting vulnerabilities, supported versions and key handling |

## API reference

Each SDK's reference is generated from its doc comments: pdoc for Python, TypeDoc for TypeScript and `dart doc` for Dart. CI builds all three on every change and keeps them as a build artifact; [CONTRIBUTING.md](../CONTRIBUTING.md#api-reference) has the commands. Runnable examples live in each SDK's examples folder (`python/examples`, `js/examples`, `dart/example`) and in `proxy-examples/`.
