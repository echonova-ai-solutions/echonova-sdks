# 11. Testing: shared vectors, conformance fixtures, a nightly live suite and spec drift checks

Date: 2026-11-09

## Status

Accepted

## Context

Three SDKs must behave identically, and the most important behaviour is the hardest to observe by hand: which errors are retried, what a dropped stream reports, whether a key ever reaches a log.

Calling the live API in every pull request would be slow and flaky, and it costs credits. Tests that use only mocks can drift away from what the API really does. The API also changes over time, so tests have to notice when it does.

## Decision

Testing has four layers. The first three run on every pull request without network access or an API key.

### 1. Unit tests on the sans-IO core

The core is pure (ADR 0003), so it's tested directly, with fake clocks and seeded randomness:

- request building, envelope parsing, error classification and retry decisions;
- the rate-limit tracker, the `wait()` limiter and backoff;
- the PCM framer, with property-based tests (Hypothesis in Python, fast-check in TypeScript);
- the stream state machines;
- redaction: tests capture log output and assert that no key, body or signed-link query string appears in it.

### 2. Shared vectors

Every SDK must pass the same data-driven checks from `spec/`:

| What is checked | Source | Built by |
| --- | --- | --- |
| Error classification and retry decisions | `spec/error-rules.json` (`vectors`) | by hand, with the rules |
| Every error example in the published spec | `spec/fixtures/errors/catalog.json` | `tools/build_error_catalog.py` |
| Webhook signatures, valid and invalid | `spec/fixtures/webhooks/vectors.json` | `tools/build_webhook_vectors.py` |
| Names of every operation and parameter | `spec/mapping.json` | `tools/build_mapping.py` |

CI regenerates the built files and fails if the committed copies differ. It also fails if an SDK's copy of the shared data is stale (`tools/sync_sdk_data.py --check`).

### 3. Conformance fixtures

- `spec/fixtures/rest/` and `spec/fixtures/ws/` hold **traffic recorded from the live API** by `tools/record/record.py` and scrubbed of keys, secrets, signed-link queries and identifying values.
- Every SDK replays them: REST through a mocked transport, and WebSocket transcripts through a scripted mock server.
- The WebSocket transcripts cover normal runs, cancellation, supersede, errors and every close code the SDKs handle.
- **Any behaviour the SDKs rely on that the published specs don't spell out gets a recorded fixture.** If the API changes that behaviour, the next recording or the nightly live suite shows it.
- Fixtures are reviewed before they are committed, and `tools/check_public.py` checks them for leaks (ADR 0012).

### 4. The nightly live suite

- Each SDK has a small live suite (marked `live` in Python) that makes one small call per endpoint and stream against the real API.
- It runs nightly and before every release, using a key from a **dedicated test workspace**. The key's Credit Limit is a hard cap on spending.
- It never runs on pull requests from forks. The key is a GitHub environment secret.
- Every runnable example in the READMEs and guides also runs nightly, because a doc that can't be run goes stale.

### Spec drift and coverage

- A nightly workflow compares the live published specs with the pinned copies (`tools/spec_sync.py --check`) and opens an issue when they differ.
- `tools/build_mapping.py` fails when the spec gains an operation or stream message that no SDK covers (ADR 0002).

### Quality gates

- Python: ruff (lint and format), mypy `--strict`, pytest on every supported version, plus the lowest dependency versions.
- TypeScript: eslint, `tsc --strict`, vitest, type tests, and package checks (`publint`, Are the Types Wrong).
- Dart: `dart analyze`, `dart format`, `package:test`, and pana.
- A coverage target of at least 90% on the core and streaming code.

## Consequences

- Most behaviour is checked quickly and deterministically, without credits or network.
- The SDKs can't silently diverge: a change to shared behaviour fails every SDK until all of them agree.
- Recording fixtures needs test-workspace keys and costs credits, so maintainers do it, not every contributor.
- The live suite has a running cost, capped by the key's Credit Limit.
- A changed API shows up as a nightly issue or a failing live test, usually before users notice.
