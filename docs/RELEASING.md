# Releasing

Each SDK is released on its own, by pushing a tag. The [release workflow](../.github/workflows/release.yml) tests the package, builds it and publishes it with the registry's OIDC trusted publishing, so no registry token is stored in the repository or in GitHub secrets.

| SDK | Tag | Registry | Version lives in |
| --- | --- | --- | --- |
| Python | `python-v<version>` | PyPI `echonova` | `python/src/echonova/_version.py` |
| JavaScript / TypeScript | `js-v<version>` | npm `echonova` | `js/package.json` |
| Dart / Flutter | `dart-v<version>` | pub.dev `echonova` | `dart/pubspec.yaml` (and `lib/src/version.dart`) |

Versions follow [SemVer](https://semver.org) ([ADR 0010](adr/0010-releases-and-versioning.md)). Betas come first: `0.9.0b1` on PyPI, `0.9.0-beta.1` on npm (published under the `beta` dist-tag) and pub.dev.

## One-time setup

Done once by a maintainer with admin rights on the GitHub organization and each registry account. Use company-owned accounts with two-factor authentication, keep their recovery codes in the company password manager, and give each registry a second owner so access never depends on one person.

1. **GitHub:** the `release` environment (Settings → Environments) allows only tags matching `python-v*`, `js-v*` and `dart-v*` to deploy. Add required reviewers (the code owners) once the repository is public: the free plan doesn't offer them on private repositories.
2. **PyPI:** in your account, Publishing → Add a new pending publisher → GitHub: project name `echonova`, owner `echonova-ai-solutions`, repository `echonova-sdks`, workflow `release.yml`, environment `release`. The first tagged release creates the project. A pending publisher doesn't reserve the name: until that release, anyone can register it. Do the same on TestPyPI first if you want a dry run.
3. **npm:** create the `echonova` organization (free plan, public packages), which reserves the `@echonova` scope. Trusted publishing can only be set up on a package that exists, so publish the first version by hand: `cd js && npm ci && npm run build && npm publish --access public --tag beta` (pre-release versions need a `--tag`). Then, in the package's settings, add a trusted publisher (GitHub Actions: `echonova-ai-solutions`, `echonova-sdks`, workflow `release.yml`, environment `release`), and under Publishing access require two-factor authentication and disallow tokens. Provenance needs a public repository, so the workflow publishes only once the repository is public.
4. **pub.dev:** sign in with a company Google account, verify `echonova.ai` in Google Search Console (a DNS TXT record), and create the `echonova.ai` verified publisher. Automated publishing can only be set up on a package that exists, so publish the first version by hand: remove `publish_to: none` from `dart/pubspec.yaml`, then `cd dart && dart pub publish`. A pub.dev version can't be deleted, only retracted within 7 days. Then, on the package's admin page, transfer it to the `echonova.ai` publisher and enable automated publishing from GitHub Actions: repository `echonova-ai-solutions/echonova-sdks`, tag pattern `dart-v{{version}}`, required environment `release`.
5. **When the repository is made public:**
   - Turn on private vulnerability reporting in the repository settings, or with `gh api -X PUT repos/echonova-ai-solutions/echonova-sdks/private-vulnerability-reporting`. [SECURITY.md](../SECURITY.md) sends every report there, and GitHub offers it only on public repositories.
   - Protect `main` with a ruleset: require a pull request with an approving review from a code owner ([CODEOWNERS](../.github/CODEOWNERS)), require the CI checks to pass, and block force pushes and deletion. The free plan offers rulesets only on public repositories too.
   - Add the required reviewers to the `release` environment (step 1).

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
