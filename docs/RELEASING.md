# Releasing

Each SDK is released on its own, by pushing a tag. The [publish workflow](../.github/workflows/publish.yml) checks that the tag matches the package version, runs the tests, builds the package and publishes it with the registry's OIDC trusted publishing, so no registry token is stored in the repository or in GitHub secrets.

| SDK | Tag | Registry package | Version lives in | GitHub environment |
| --- | --- | --- | --- | --- |
| Python | `py-vX.Y.Z` | PyPI `echonova` | `python/src/echonova/_version.py` (read by `pyproject.toml`) | `pypi` |
| JavaScript / TypeScript | `js-vX.Y.Z` | npm `@echonova/ai` | `js/package.json` (and `src/version.ts`) | `npm` |
| Dart / Flutter | `dart-vX.Y.Z` | pub.dev `echonova_ai` | `dart/pubspec.yaml` (and `lib/src/version.dart`), plus `dart/CHANGELOG.md` | `pubdev` |

Versions follow [SemVer](https://semver.org) ([ADR 0010](adr/0010-releases-and-versioning.md)). Each package starts at `0.0.1`. A test keeps each version file in step with its manifest.

## One-time setup

Done once by a maintainer with admin rights on the GitHub organization and each registry account. Use company-owned accounts with two-factor authentication, keep their recovery codes in the company password manager, and give each registry a second owner so access never depends on one person. Every registry trusts the same workflow file, `publish.yml`, in `echonova-ai-solutions/echonova-sdks`.

1. **GitHub:** the environments `pypi`, `npm` and `pubdev` (Settings → Environments) each allow only their own tag pattern (`py-v*`, `js-v*`, `dart-v*`) to deploy. Add required reviewers (the code owners) once the repository is public: the free plan doesn't offer them on private repositories.
2. **PyPI:** a trusted publisher for the project `echonova`: owner `echonova-ai-solutions`, repository `echonova-sdks`, workflow `publish.yml`, environment `pypi`. For a project that doesn't exist yet this is a pending publisher, which doesn't reserve the name: the first tagged release creates the project.
3. **npm:** the `echonova` organization owns the `@echonova` scope. On the `@echonova/ai` package, a trusted publisher: GitHub Actions, `echonova-ai-solutions`, `echonova-sdks`, workflow `publish.yml`, environment `npm`; and under Publishing access, require two-factor authentication and disallow tokens. If npm only allows that on a package that exists, publish `0.0.1` by hand once: `cd js && npm ci && npm run build && npm publish --access public`. npm adds provenance only when the repository is public.
4. **pub.dev:** the package `echonova_ai`, owned by the `echonova.ai` verified publisher, with automated publishing from GitHub Actions: repository `echonova-ai-solutions/echonova-sdks`, tag pattern `dart-v{{version}}`, required environment `pubdev`. Automated publishing is set up on a package that exists, so its first version may need to go up by hand: `cd dart && dart pub publish`. A pub.dev version can't be deleted, only retracted within 7 days.
5. **After the repository was made public** (done on 2026-11-19, except where noted):
   - Private vulnerability reporting is on. [SECURITY.md](../SECURITY.md) sends every report there.
   - The "Protect main" ruleset requires a pull request with an approving review from a code owner ([CODEOWNERS](../.github/CODEOWNERS)) and the CI checks (all but the iOS build, which can queue for a long time). It also blocks force pushes and deletion. Repository admins may merge their own pull requests without a second approval, but can't push to `main` directly.
   - Still to do, optionally: required reviewers on the three environments (step 1), so each release waits for an approval.

## Releasing a version

1. Make sure `main` is green, including the nightly spec-drift and live API jobs.
2. Bump the version (table above). For Dart, add the version's entry to `dart/CHANGELOG.md`. Commit it on `main`.
3. Tag that commit and push the tag:

   ```bash
   git tag py-v0.0.1   && git push origin py-v0.0.1     # Python
   git tag js-v0.0.1   && git push origin js-v0.0.1     # JavaScript / TypeScript
   git tag dart-v0.0.1 && git push origin dart-v0.0.1   # Dart / Flutter
   ```

4. Watch the run under Actions → **Publish SDKs** (approve the environment once reviewers are required). Only the job for that tag's SDK runs.
5. Check the registry page: PyPI's attestation, npm's provenance (once the repository is public), pub.dev's verified publisher and automated-publishing marks.

A failed run publishes nothing. Fix the problem, delete the tag (`git push --delete origin <tag>` and `git tag -d <tag>`), and tag again. A version that did reach a registry can't be published again: bump the version instead.
