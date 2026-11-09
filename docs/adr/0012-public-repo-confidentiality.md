# 12. Confidentiality rules for a public repository

Date: 2026-11-09

## Status

Accepted

## Context

This repository is public. Its maintainers sometimes have access to information about the EchoNova service that is not public: internal systems, infrastructure, and conversations with the API team.

Publishing that information would expose internals that EchoNova hasn't chosen to share. It would also present undocumented behaviour as if it were part of the API contract. Users would rely on it, and EchoNova could not change it freely.

Recorded API traffic, used as test fixtures, can contain keys, secrets, signed links and identifying data if it isn't cleaned.

## Decision

### What may be published

- the API specs EchoNova publishes, vendored as-is (ADR 0002);
- SDK code, tests and tools;
- documentation based on EchoNova's public documentation;
- fixtures recorded from the public API and scrubbed.

### What must never be published

- source code, tests or configuration from any non-public EchoNova system;
- internal names: project and repository names, hostnames, internal routes, environment variables, cloud resource and storage names, commit hashes;
- names or contact details of people, apart from public maintainer accounts;
- internal discussions, question-and-answer logs and bug lists;
- API keys, webhook secrets, signed links and customer data.

### Behaviour known only from non-public sources

- It may shape the SDK's code **defensively**. For example, the SDK doesn't retry a request, or it reports a charge state as unknown.
- In public documentation, including ADRs, it is described **as SDK policy**, never as a fact about the server. Write "the SDK never resends a synthesis that was sent but not started, because it may already have been charged", not a statement about how the server bills.
- It is documented as API behaviour only after EchoNova documents it publicly.

### Fixtures are scrubbed and reviewed

- `tools/record/scrub.py` replaces keys and webhook secrets, strips the host and query string from signed links, replaces IDs with stable placeholders, replaces identifying fields such as key and workspace names, and keeps only allow-listed headers.
- The recorder writes to the git-ignored `tools/record/out/`. A maintainer reviews the output. Then `record.py promote` runs the leak check again and copies the output into `spec/fixtures/`.

### Automated checks

- `tools/check_public.py` scans every file git would publish (tracked, or untracked and not ignored) for:
  - secrets: API keys, webhook secrets, bearer tokens and signed storage links;
  - **private terms**: a list that is itself private. It is read from the `ECHONOVA_DENYLIST` CI secret, or from the git-ignored `.internal/denylist.txt`.
- CI runs it with the full list on every pull request and push. Without the list, it checks secrets only and prints a warning.
- The repository enables GitHub secret scanning with push protection.
- Private working notes stay in the git-ignored `.internal/` folder and are never committed.

**When in doubt, leave it out** and ask a maintainer.

## Consequences

- Some decisions in these ADRs are stated as SDK policy without the evidence behind them. That's deliberate.
- External contributors can run `check_public.py` for secrets only. CI runs the full check.
- Maintainers must review fixtures, docs and comments for internal details, not just code.
- If something private is published by mistake, a maintainer removes it, rewrites history if needed, and rotates any exposed secret. Secrets and vulnerabilities are reported through `SECURITY.md`.
