# Releasing

Each SDK is released on its own, by pushing a tag. The [release workflow](../.github/workflows/release.yml) tests the package, builds it and publishes it with the registry's OIDC trusted publishing, so no registry token is stored in the repository or in GitHub secrets.

| SDK | Tag | Registry | Version lives in |
| --- | --- | --- | --- |
| Python | `python-v<version>` | PyPI `echonova` | `python/src/echonova/_version.py` |
| JavaScript / TypeScript | `js-v<version>` | npm `echonova` | `js/package.json` |
| Dart / Flutter | `dart-v<version>` | pub.dev `echonova` | `dart/pubspec.yaml` (and `lib/src/version.dart`) |

Versions follow [SemVer](https://semver.org) ([ADR 0010](adr/0010-releases-and-versioning.md)). Betas come first: `0.9.0b1` on PyPI, `0.9.0-beta.1` on npm (published under the `beta` dist-tag) and pub.dev.

## One-time setup

Done once by a maintainer with admin rights on the GitHub organization and each registry account.

1. **GitHub:** create an environment named `release` (Settings → Environments) with required reviewers, and allow only tags matching `python-v*`, `js-v*` and `dart-v*` to deploy to it.
2. **PyPI:** on the `echonova` project, add a trusted publisher (Publishing → Add a GitHub publisher): this repository, workflow `release.yml`, environment `release`. Do the same on TestPyPI first if you want a dry run.
3. **npm:** on the `echonova` package settings, add a trusted publisher: GitHub Actions, this repository, workflow `release.yml`, environment `release`. Enable two-factor authentication for every maintainer of the package and the `@echonova` organization.
4. **pub.dev:** on the `echonova` package admin page, enable automated publishing from GitHub Actions: this repository, tag pattern `dart-v{{version}}`, environment `release`. The package must belong to the `echonova.ai` verified publisher.
5. **Before the first public release:** remove `publish_to: none` from `dart/pubspec.yaml`.
6. **When the repository is made public:**
   - Turn on private vulnerability reporting in the repository settings, or with `gh api -X PUT repos/echonova-ai-solutions/echonova-sdks/private-vulnerability-reporting`. [SECURITY.md](../SECURITY.md) sends every report there, and GitHub offers it only on public repositories.
   - Protect `main` with a ruleset: require a pull request with an approving review from a code owner ([CODEOWNERS](../.github/CODEOWNERS)), require the CI checks to pass, and block force pushes and deletion. The free plan offers rulesets only on public repositories too.

## Releasing a version

1. Make sure `main` is green, including the nightly spec-drift job.
2. Update the version (table above) and the package's changelog in a pull request, and merge it.
3. Tag the merge commit and push the tag, for example:

   ```bash
   git tag python-v0.9.0b1
   git push origin python-v0.9.0b1
   ```

4. Approve the `release` environment deployment in the Actions run. The job checks that the tag matches the package version, runs the tests, builds, and publishes.
5. Check the registry page: the PyPI attestation, the npm provenance badge, or the pub.dev "verified publisher" and automated-publishing marks.

A failed release publishes nothing. Fix the problem, delete the tag (`git push --delete origin <tag>`), and tag again.
