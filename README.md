# EchoNova SDKs

Official client libraries for the [EchoNova API](https://echonova.ai/docs/developers): Text to Speech, Speech to Text and Sound Cleaning, over REST and WebSocket streaming.

| SDK | Package | Status |
|---|---|---|
| Python | `echonova` on PyPI | In development: REST and streaming clients |
| JavaScript / TypeScript | `echonova` on npm | In development: core and transport |
| Dart / Flutter | `echonova` on pub.dev | In development: core and transport |

None is published yet. The first betas will be `0.9.x`.

## Repository layout

```
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
docs/            Architecture decision records and contributor docs
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

cd python && uv sync && uv run pytest           # Python SDK
cd js && npm ci && npm test                     # JavaScript / TypeScript SDK (Node 22+)
cd dart && dart pub get && dart test            # Dart SDK
cd proxy-examples/fastapi && uv run pytest      # reference proxies
cd proxy-examples/express && npm ci && npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full setup and [docs/adr](docs/adr) for the design decisions.

`tools/record/record.py` records live API traffic as scrubbed fixtures. It needs a key from a dedicated test workspace and costs credits; see the script's help.

## Security

Never put an API key in client-side code (browsers, mobile apps). Keep keys on your server and read them from the environment. Report security issues privately to EchoNova rather than in a public issue.
