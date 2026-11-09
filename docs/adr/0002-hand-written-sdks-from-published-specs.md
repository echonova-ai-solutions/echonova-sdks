# 2. Hand-written SDKs driven by the published API specs

Date: 2026-11-09

## Status

Accepted

## Context

EchoNova publishes machine-readable specs for its API:

- `https://api.echonova.ai/openapi.json` (OpenAPI 3.0) for REST;
- `https://api.echonova.ai/asyncapi.json` (AsyncAPI 3.0) for the two WebSocket streams.

The REST surface is small: under twenty operations. Most of the work in a good SDK is where code generators are weakest:

- two custom WebSocket protocols with their own state machines;
- mapping the JSON envelope and error messages to typed errors;
- multipart uploads with correct content types;
- polling jobs to completion;
- retries that can never charge a customer twice.

Generated clients also tend to expose the spec's naming quirks directly, and they change shape whenever the spec's structure changes, even when the API itself doesn't.

## Decision

- **The public surface of every SDK is written by hand.** We do not generate clients, models or method signatures from the specs.
- **The published specs are the contract.** `tools/spec_sync.py` vendors them into `spec/` and pins each one in `spec/spec-lock.json` with a SHA-256 over canonical JSON (sorted keys, no whitespace), so the hash changes only when the content does.
- **The vendored files are never edited by hand.** Data the SDKs need that the specs don't carry lives beside them: `error-rules.json`, `webhooks.json` and `mapping.json`.
- **The specs drive the tests:**
  - `tools/build_error_catalog.py` extracts every documented error example from `openapi.json` into `spec/fixtures/errors/catalog.json`. Every SDK must classify each one.
  - `tools/build_mapping.py` builds `mapping.json` and **fails when the spec has an operation or stream message that no SDK method covers** and that isn't on an explicit exclusion list with a reason. A new endpoint can't slip past the SDKs.
  - CI regenerates these files and fails if the committed copies differ.
- **Drift is detected nightly.** A scheduled workflow runs `tools/spec_sync.py --check` against the live specs and opens an issue when they change.
- **Generating data is allowed; generating API surface isn't.** For example, the TypeScript and Dart SDKs compile `error-rules.json` into generated source files: TypeScript so the package works in every bundler without JSON imports, and Dart because Flutter apps can't read package data files at runtime (ADR 0013).
- **When the published docs and the live API appear to differ,** the SDK takes the safer reading (for example, not retrying), and the difference is reported to EchoNova. The public surface and the SDK docs follow the published docs and specs.

## Consequences

- The SDKs can be idiomatic in each language while staying faithful to the API (ADR 0006).
- Covering a new endpoint takes deliberate work: a hand-written method plus an entry in `tools/build_mapping.py`. The coverage gate makes sure nobody forgets.
- A spec change shows up as a nightly issue and as failing vectors, not as a surprise in production.
- Hand-written code can drift from the spec in ways a generator wouldn't. The coverage gate, the error catalog and the recorded fixtures (ADR 0011) are the guard against that.
