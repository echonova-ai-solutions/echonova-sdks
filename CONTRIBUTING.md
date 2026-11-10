# Contributing to the EchoNova SDKs

Thank you for helping. This repository holds the official EchoNova SDKs for Python, JavaScript/TypeScript and Dart/Flutter, the shared contract they are tested against (`spec/`), reference backend proxies and the tooling around them.

For a bug fix or a small improvement, open a pull request. For anything larger, such as a new feature or a change to how retries, errors or streaming behave, open an issue first so we can agree on the approach.

## Ground rules

- **Never put an API key, a webhook secret or a signed download link in code, tests, fixtures, issues, pull requests or logs.** Use made-up values in tests, such as `whsec_TEST0000…`. If you expose a real key by accident, delete it in the EchoNova portal straight away and create a new one.
- **Report security problems privately**, as described in [`SECURITY.md`](SECURITY.md), not in a public issue.
- **The SDKs expose only what the EchoNova API supports.** A request for a new API capability belongs with EchoNova support, not here.
- **Shared behaviour follows the architecture decision records** in [`docs/adr/`](docs/adr/README.md). To change a decision, propose a new ADR in your pull request.
- **This repository is public.** Follow the confidentiality rules in [ADR 0012](docs/adr/0012-public-repo-confidentiality.md), and run `tools/check_public.py` before you push.

## Repository layout

```text
spec/             the shared contract: vendored API specs, error rules, mapping, fixtures
python/           Python SDK (PyPI: echonova)
js/               JavaScript/TypeScript SDK (npm: echonova)
dart/             Dart/Flutter SDK (pub.dev: echonova)
proxy-examples/   reference backend proxies (FastAPI, Express)
tools/            spec sync, generators, the traffic recorder, publishing checks
docs/             architecture decision records and shared guides
```

## Development setup

You only need the toolchain for the SDK you're working on. The scripts in `tools/` need Python 3.10 or later and use only the standard library, except the recorder, which runs through `uv`.

### Python

Requires Python 3.11 or later and [uv](https://docs.astral.sh/uv/).

```bash
cd python
uv sync                       # creates .venv with the dev tools
uv run pytest                 # unit and conformance tests: no network, no API key
uv run ruff check .
uv run ruff format --check .
uv run mypy
```

### JavaScript/TypeScript

Requires Node.js 22 or later and npm.

```bash
cd js
npm ci
npm test                      # vitest
npm run typecheck
npm run build
npm run lint:package          # package checks on the built output
```

### Dart

Requires the Dart SDK 3.5 or later. Flutter isn't needed for the SDK itself.

```bash
cd dart
dart pub get
dart test
dart analyze
dart format --output=none --set-exit-if-changed .
```

### Reference proxies

```bash
cd proxy-examples/fastapi
uv sync
uv run pytest
```

```bash
cd proxy-examples/express
npm ci
npm test
```

## Working with the shared spec

Everything in `spec/` is shared by every SDK. See [`spec/README.md`](spec/README.md) for what each file is.

### Files you must not edit by hand

| File | Produced by |
| --- | --- |
| `spec/openapi.json`, `spec/asyncapi.json`, `spec/spec-lock.json` | `tools/spec_sync.py` |
| `spec/mapping.json` | `tools/build_mapping.py` |
| `spec/fixtures/errors/catalog.json` | `tools/build_error_catalog.py` |
| `spec/fixtures/webhooks/vectors.json` | `tools/build_webhook_vectors.py` |
| `spec/fixtures/rest/`, `spec/fixtures/ws/` | `tools/record/record.py` |
| each SDK's copy of `error-rules.json` | `tools/sync_sdk_data.py` and the `tools/gen_*_rules.py` generators |

To change a generated file, change its source or its tool, then regenerate.

### Updating the vendored API specs

When EchoNova publishes a new version of its API specs, the nightly drift job opens an issue. To update:

```bash
python3 tools/spec_sync.py               # fetch the live specs, update spec-lock.json
git diff spec/openapi.json spec/asyncapi.json   # review what changed
python3 tools/build_error_catalog.py     # regenerate error examples
python3 tools/build_mapping.py           # regenerate the name mapping
python3 tools/build_webhook_vectors.py   # regenerate webhook vectors
```

- `build_mapping.py` fails if the spec has a new operation or stream message that no SDK method covers. Add its SDK names to `tools/build_mapping.py`, or add it to the exclusion list with a reason, and implement it in every SDK.
- If the documented errors changed, update `spec/error-rules.json` and its `vectors` together.
- Then refresh each SDK's copy of the rules:

  ```bash
  python3 tools/sync_sdk_data.py          # copies the JSON into the Python package
  python3 tools/gen_ts_rules.py           # compiles it into the TypeScript SDK
  ```

  The Dart SDK gets a matching generator in `tools/`. Each of these tools has a `--check` mode, which CI runs.
- Finally, run every SDK's tests.

`python3 tools/spec_sync.py --check` compares the live specs with the pinned copies without writing anything.

### Changes to `spec/` must pass every SDK's tests

A pull request that changes anything in `spec/` must pass the tests of **every** SDK, not only the one you're working on. CI runs them all. A maintainer of each SDK reviews the change. If you can't run a toolchain locally, say so in the pull request and rely on CI.

### Recording fixtures (maintainers)

`tools/record/record.py` records live API traffic and scrubs it into fixtures. It calls the real API, so it **costs credits**, and it needs keys from a **dedicated test workspace** with a Credit Limit set. Never use a production workspace.

```bash
uv run tools/record/record.py --help
uv run tools/record/record.py rest       # for example: REST success and error fixtures
uv run tools/record/record.py promote    # leak-check the output and copy it into spec/fixtures/
```

Output goes to the git-ignored `tools/record/out/`. Review it before running `promote`. Contributors without test-workspace keys don't need to record anything: describe the case you need in your pull request, and a maintainer will record it.

## Tests

- Unit and conformance tests run without network access or an API key. They must pass before a pull request is merged.
- New behaviour needs tests. A bug fix needs a test that fails without the fix.
- Behaviour shared between SDKs, such as error classification, retry decisions and webhook verification, is tested through the shared vectors in `spec/`. Add a vector instead of a one-off test where you can.

### Live tests

Live tests (marked `live` in Python) call the real EchoNova API.

- **They cost credits.** Use a key from a dedicated test workspace, with a Credit Limit set on the key as a hard cap. Never use a production key.
- Provide the key through the `ECHONOVA_API_KEY` environment variable, ideally from a password manager or secrets tool, so it doesn't end up in your shell history or in a file in the repository.
- Run them explicitly: `cd python && uv run pytest -m live`. The TypeScript and Dart SDKs follow the same rules.
- CI runs the live suites nightly and before releases with its own test-workspace key. They never run on pull requests from forks, and you don't need to run them to contribute.

## Code samples and the API reference

`tools/check_snippets.py` type-checks every Python, TypeScript and Dart code block in the READMEs, `docs/guides/` and the proxy READMEs against the SDK source, with mypy, `tsc` and `dart analyze`. It needs no network or API key, only each SDK's toolchain (and `npm ci` in `js/`).

```bash
python3 tools/check_snippets.py              # every block
python3 tools/check_snippets.py --lang dart  # one language: python, ts or dart
```

Write each block so it stands on its own: its own imports, and a client created from the environment (`EchoNova()` reads `ECHONOVA_API_KEY`). Top-level `await` is fine. For a block that can't be checked, such as one that needs Flutter, put `<!-- snippet: skip (the reason) -->` on the line before it.

### API reference

Each SDK's reference is built from its doc comments into a git-ignored folder:

```bash
cd python && uv run --group docs pdoc echonova echonova.resources echonova.types.streaming -o build/docs
cd js && npm run docs     # TypeDoc, into build/docs
cd dart && dart doc       # into doc/api
```

- Python uses [pdoc](https://pdoc.dev) from the `docs` dependency group, which `uv sync` doesn't install. Only public modules get a page. `echonova.resources` and `echonova.types.streaming` are named in the command because the package's `__all__` doesn't list them.
- TypeDoc documents the `echonova` and `echonova/streaming` entry points and treats warnings as errors. If a public signature uses a type the package doesn't export, export it, or add it to `intentionallyNotExported` in `js/typedoc.json`.
- `dart doc` must report 0 warnings.

## Checking that nothing private is published

Before you push, run this from the repository root:

```bash
python3 tools/check_public.py
```

It must print `nothing private found`. It checks every file git would publish for secrets (API keys, webhook secrets, bearer tokens, signed storage links) and, when a private term list is available, for internal names. Without that list it prints a warning and checks secrets only; that's expected for most contributors, and CI runs the full check. If it reports a problem, remove the content. Don't work around the check.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/). release-please reads them to choose each package's next version and to write its changelog (ADR 0010), so never edit a `CHANGELOG.md` by hand.

```text
<type>(<scope>): <summary>
```

- **Types:** `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`.
- **Scopes:** `python`, `js`, `dart`, `spec`, `tools`, `proxy`, `docs`, `ci`.
- **Breaking changes:** add `!` after the scope, and explain in a `BREAKING CHANGE:` footer. See ADR 0010 for what counts as breaking.

Examples:

```text
fix(python): keep the server's error message whole when it contains commas
feat(js): add jobs.findCandidates for lost POST responses
docs: explain proxy mode for Flutter web
```

A breaking change:

```text
feat(dart)!: <summary>

BREAKING CHANGE: <what changed, and how to update calling code>
```

Use the same format for the pull request title.

## Pull requests

- Keep a pull request to one change. Split unrelated changes.
- Fill in the pull request template and its checklist.
- Update docs and examples with the code. Every code sample in the READMEs and guides is type-checked in CI (`tools/check_snippets.py`), because a sample that no longer compiles goes stale unnoticed.
- Describe API behaviour only as the EchoNova docs and published specs describe it. Where the SDK is more cautious than the docs require, describe that as SDK policy (ADR 0012).
