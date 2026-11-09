# 10. Releases: SemVer from 0.9 betas, release-please, OIDC trusted publishing

Date: 2026-11-09

## Status

Accepted

## Context

Three packages (`echonova` on PyPI, npm and pub.dev) are released from one repository (ADR 0001), each on its own schedule. Users need versions that tell them what an upgrade will do. Releases must also be hard to tamper with: a compromised package that holds API keys is a serious supply-chain risk.

The API is versioned by its path (`/v1`) and changes additively within a version.

## Decision

### Semantic Versioning, per package

- Each SDK follows [SemVer](https://semver.org/). Its version is independent of the API's `v1` and of the other SDKs' versions.
- **Betas start at 0.9:** `0.9.0b1` on PyPI (PEP 440), `0.9.0-beta.1` on npm (under the `beta` dist-tag) and on pub.dev. A beta period lasts at least two weeks with early users. `1.0.0` ships once no high-priority bugs are open.
- **A breaking change**, which needs a major release, is any of:
  - removing or renaming a public class, method or parameter;
  - changing a return type or an exception type, including moving an error class to another parent (ADR 0005);
  - raising a minimum runtime version outside the runtime policy (ADR 0009).
- **An additive API change** (new endpoint, field or option) leads to an SDK **minor** release. **A breaking API change** (a new path version) leads to an SDK **major** release.
- **Deprecation:** a deprecated feature warns (`DeprecationWarning`, `@deprecated`, `@Deprecated`) for at least one minor release before it is removed in a major release.

### release-please and Conventional Commits

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/), with the SDK as the scope where it applies (`fix(python): …`, `feat(js): …`). See `CONTRIBUTING.md`.
- release-please runs per package. It keeps a release pull request open for each package with the next version and a generated `CHANGELOG.md` in Keep a Changelog style. Merging that pull request tags the release with a per-package tag and creates a GitHub Release.
- Changelogs are never edited by hand. The commit messages are the source.

### Publishing with OIDC trusted publishing and provenance

- **No long-lived publishing tokens exist.** Packages are published from GitHub Actions through each registry's OIDC trusted publishing:
  - PyPI Trusted Publishing, with PEP 740 attestations;
  - npm trusted publishing, with provenance;
  - pub.dev automated publishing from GitHub Actions.
- Publishing runs in a protected `release` environment that needs maintainer approval.
- The release workflow **builds once**, installs the built artifact in a clean environment, runs a live smoke test, verifies attestations and provenance, and only then publishes.
- Registry organisations and the GitHub organisation require two-factor authentication. Actions are pinned by commit SHA and kept current by Renovate.

## Consequences

- Users can tell the impact of an upgrade from the version number, and can check where a package was built.
- Three packages mean three release pull requests and three changelogs. That is the cost of independent versions.
- Good commit messages are required, because they become the changelog. Pull request review checks them.
- A beta that needs a breaking change can still take one before `1.0.0`. After that, the SemVer rules above apply.
