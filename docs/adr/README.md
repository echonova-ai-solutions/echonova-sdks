# Architecture decision records

These records explain the main design decisions behind the EchoNova SDKs, and why they were made. Read them before proposing a change to shared behaviour, such as retries, errors, streaming or key handling.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-monorepo-with-shared-spec.md) | One repository for every SDK, with a shared `spec/` contract | Accepted |
| [0002](0002-hand-written-sdks-from-published-specs.md) | Hand-written SDKs driven by the published API specs | Accepted |
| [0003](0003-sans-io-core.md) | A sans-IO core with thin I/O drivers | Accepted |
| [0004](0004-retries-and-idempotency.md) | Retries and idempotency: never resend a POST that may have run | Accepted |
| [0005](0005-error-taxonomy.md) | An error taxonomy grouped by meaning | Accepted |
| [0006](0006-naming-and-response-models.md) | Naming across languages, faithful responses and lenient parsing | Accepted |
| [0007](0007-streaming-design.md) | Streaming: charge-aware Text to Speech, Speech to Text sessions that never reconnect on their own | Accepted |
| [0008](0008-keys-stay-on-servers.md) | Keys stay on servers: the browser guard, proxy mode and reference proxies | Accepted |
| [0009](0009-runtime-support-policy.md) | Runtime support policy | Accepted |
| [0010](0010-releases-and-versioning.md) | Releases: SemVer from 0.9 betas, release-please, OIDC trusted publishing | Accepted |
| [0011](0011-testing-strategy.md) | Testing: shared vectors, conformance fixtures, a nightly live suite and spec drift checks | Accepted |
| [0012](0012-public-repo-confidentiality.md) | Confidentiality rules for a public repository | Accepted |
| [0013](0013-dart-flutter-parallel-track.md) | The Dart/Flutter SDK is built in parallel with the TypeScript SDK | Accepted |

## Format

Each record follows Michael Nygard's format:

- **Title:** a short statement of the decision, numbered.
- **Date** and **Status:** Proposed, Accepted, Deprecated, or Superseded by a later ADR.
- **Context:** the forces at play and the problem being solved.
- **Decision:** what we will do.
- **Consequences:** what becomes easier or harder as a result.

## Changing a decision

ADRs are not edited to reverse a decision. To change one:

1. Copy the format into a new file with the next number, for example `0014-short-title.md`, with Status "Proposed".
2. Explain what changed and why, and link the ADR it replaces.
3. Open a pull request. Once it is merged, set the new ADR to "Accepted" and the old one to "Superseded by ADR 0014".

Fixing typos, broken links or outdated file paths in an existing ADR is fine without a new record.

ADRs are public. Follow the confidentiality rules in [ADR 0012](0012-public-repo-confidentiality.md): describe behaviour that EchoNova hasn't documented as SDK policy, not as a fact about the server.
