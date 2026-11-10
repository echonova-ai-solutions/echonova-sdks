# EchoNova SDK guides

Task-oriented guides for the official EchoNova SDKs: Python, TypeScript / JavaScript and Dart / Flutter. Each example is shown in all three languages. The [EchoNova API docs](https://echonova.ai/docs/developers) remain the reference for endpoints, parameters and limits.

## Start here

- [Getting started](getting-started.md): install an SDK, set your API key, and save your first audio file in five minutes.
- [Authentication](authentication.md): keeping keys on your server, rotating them, and proxy mode for web and Flutter apps.

## Services

- [Text to Speech](text-to-speech.md): voices, synchronous speech, async jobs, options and long text.
- [Speech to Text](speech-to-text.md): audio formats, languages, speakers, terminology and transcript export.
- [Sound Cleaning](sound-cleaning.md): cleaning audio, tuning the options and reading the metrics.
- [Jobs](jobs.md): async jobs, `wait()`, listing, downloads and deleting.
- [Streaming](streaming.md): low-latency speech and live transcription over WebSockets.
- [Agents and widgets](agents-and-widgets.md): live agent sessions and website widget tickets, from your server.

## Building for production

- [Configuration](configuration.md): timeouts, retries, deadlines, custom HTTP clients, hooks, logging and raw responses.
- [Errors](errors.md): the error classes, what the SDK retries and why, recovering from lost responses, and request IDs.
- [Webhooks](webhooks.md): verifying deliveries, handling each event once, and recipes for FastAPI, Flask, Express, Next.js and shelf.
- [Migrating from raw HTTP](migrating.md): what changes when you replace direct API calls with an SDK.
- [Troubleshooting](troubleshooting.md): 401, 402, 403 and 429, garbled transcripts, file types, expired links, stream limits and corporate proxies.

## Conventions

- Examples read the API key from the `ECHONOVA_API_KEY` environment variable. A placeholder such as `voice_id = "..."` marks a value you supply.
- Some Python and TypeScript examples use top-level `await`: run them inside an async function, in a notebook, or as an ES module.
- Error classes are named as in Python and TypeScript (`RateLimitError`). In Dart they end in `Exception` (`RateLimitException`).
- Each SDK's README has the full option tables: [Python](../../python/README.md), [TypeScript](../../js/README.md), [Dart](../../dart/README.md). The design decisions behind the SDKs are in [`docs/adr`](../adr/README.md).
