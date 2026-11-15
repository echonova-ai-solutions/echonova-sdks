# EchoNova SDKs

Official client libraries for the [EchoNova API](https://echonova.ai/docs/developers): Text to Speech, Speech to Text and Sound Cleaning, over REST and WebSocket streaming.

| SDK | Package | Status |
| --- | --- | --- |
| Python | `echonova-ai` on PyPI (import `echonova`) | REST and streaming, sync and async: feature complete |
| JavaScript / TypeScript | `@echonova/ai` on npm | REST and streaming (Node, Bun, Deno, Cloudflare Workers; browsers through a proxy): feature complete |
| Dart / Flutter | `echonova_ai` on pub.dev | REST and streaming (mobile, desktop, server; Flutter web through a proxy): feature complete |

Every SDK covers Text to Speech, Speech to Text, Sound Cleaning, widget tickets and agent sessions, plus webhook verification. None is published yet: the first release of each is `0.0.1` (see [Releasing](#releasing)).

## Repository layout

```text
spec/            The shared contract every SDK is tested against
  openapi.json, asyncapi.json   API specs, vendored from api.echonova.ai and pinned in spec-lock.json
  error-rules.json              error classification and retry rules, with test vectors
  webhooks.json                 webhook signing and event payloads
  mapping.json                  API field names and their name in each SDK (generated)
  fixtures/                     test vectors and recorded API traffic
python/          Python SDK
js/              JavaScript / TypeScript SDK
dart/            Dart / Flutter SDK
proxy-examples/  Reference backend proxies (FastAPI, Express) that keep the API key on your server
samples/flutter/ A Flutter app (Android, iOS, web) streaming Text to Speech and Speech to Text through a proxy
docs/            User guides, architecture decision records and contributor docs
tools/           Spec sync, fixture builders, rule generators, the traffic recorder, publishing checks
```

## How the SDKs stay consistent

- The API contract comes from EchoNova's published specs, never from hand-copied documentation. A nightly job compares the live specs with the pinned copies and opens an issue when they change.
- Error handling and retries are data (`spec/error-rules.json`), shared by every SDK. A POST that may already have been processed is never retried automatically, because the API has no idempotency key and a retry could be charged twice.
- Every SDK runs the same test vectors and recorded fixtures.

## Working on the repository

```bash
python3 tools/spec_sync.py --check      # do the pinned specs match the live API?
python3 tools/build_error_catalog.py    # regenerate fixtures from the specs
python3 tools/build_mapping.py
python3 tools/build_webhook_vectors.py
python3 tools/sync_sdk_data.py          # copy / generate the shared rules into every SDK
python3 tools/check_public.py           # make sure nothing private is about to be published
python3 tools/check_snippets.py         # type-check every code sample in the READMEs and guides

cd python && uv sync && uv run pytest           # Python SDK
cd js && npm ci && npm test                     # JavaScript / TypeScript SDK (Node 22+)
cd dart && dart pub get && dart test            # Dart SDK
cd proxy-examples/fastapi && uv run pytest      # reference proxies
cd proxy-examples/express && npm ci && npm test
cd samples/flutter && flutter test              # Flutter sample app
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full setup and [docs/adr](docs/adr) for the design decisions.

### Live API tests

Each SDK has a live suite that calls the real API. It never runs by default and costs credits, so use a key from a dedicated test workspace with a Credit Limit set:

```bash
cd python && ECHONOVA_LIVE=1 ECHONOVA_API_KEY=... uv run pytest -m live
cd js && ECHONOVA_LIVE=1 ECHONOVA_API_KEY=... npm run test:live
cd dart && ECHONOVA_LIVE=1 ECHONOVA_API_KEY=... dart test -t live
```

Without a key only the free checks run. CI runs all three nightly ([live.yml](.github/workflows/live.yml), which lists the optional variables). `tools/record/record.py` records live API traffic as scrubbed fixtures, with the same kind of key; see the script's help.

## Security

Never put an API key in client-side code (browsers, mobile apps). Keep keys on your server and read them from the environment. Report security issues privately to EchoNova rather than in a public issue.

## License

MIT. See [LICENSE](LICENSE).
