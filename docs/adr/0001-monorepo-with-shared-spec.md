# 1. One repository for every SDK, with a shared `spec/` contract

Date: 2026-11-09

## Status

Accepted

## Context

EchoNova ships official SDKs for Python, JavaScript/TypeScript and Dart/Flutter. All three wrap the same API: REST endpoints, two WebSocket streaming protocols and signed webhooks. They must behave the same way. A retry rule, an error class or a stream edge case that differs between languages becomes a support problem, and in the worst case a double charge.

Keeping each SDK in its own repository would copy the contract, the error rules and the test fixtures three times. Those copies drift. Nothing would stop one SDK from shipping a rule change the others never received.

## Decision

All SDKs live in one public repository:

```text
spec/             the shared contract (see below)
python/           Python SDK            (PyPI: echonova)
js/               JavaScript/TypeScript (npm: echonova)
dart/             Dart/Flutter SDK      (pub.dev: echonova)
proxy-examples/   reference backend proxies (ADR 0008)
tools/            spec sync, fixture builders, recorder, publishing checks
docs/             ADRs and shared guides
```

`spec/` is the single source of truth that every SDK is built and tested against:

- `openapi.json` and `asyncapi.json`: EchoNova's published API specs, vendored and pinned (ADR 0002);
- `error-rules.json`: the error class tree, the ordered classification rules, the retry table and their test vectors (ADRs 0004 and 0005);
- `webhooks.json`: the webhook signing scheme and event payloads, which the API specs don't cover;
- `mapping.json`: every operation, parameter and stream message with its name in each SDK (ADR 0006);
- `fixtures/`: shared test vectors and recorded, scrubbed API traffic (ADR 0011).

Rules:

- A change to `spec/` must pass every SDK's tests in the same pull request. It is reviewed by a maintainer of each affected SDK.
- SDKs read shared data from `spec/`, either directly in tests or through copies kept current by `tools/sync_sdk_data.py`. They never fork it.
- CI is path-filtered, so a Python-only change runs the Python jobs plus the shared `spec` checks.
- Each package is versioned and released on its own (ADR 0010).

## Consequences

- A behaviour change lands in one place and reaches every SDK, or fails their tests.
- A contributor can work on one SDK with one toolchain. Changing `spec/` needs every toolchain, or a CI run.
- One issue tracker and one set of contribution rules cover all SDKs. Issues must say which SDK they concern.
- Release tooling must handle several packages with independent versions and tags. release-please supports this (ADR 0010).
- The repository is public, so everything in it, including fixtures and tooling, follows the confidentiality rules in ADR 0012.
