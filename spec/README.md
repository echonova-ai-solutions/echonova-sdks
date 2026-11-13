# Shared contract

Every EchoNova SDK is built and tested against the files in this folder. They are the same for Python, TypeScript and Dart.

| File | What it is | Maintained by |
|---|---|---|
| `openapi.json` | REST API spec (OpenAPI 3.0), from `https://api.echonova.ai/openapi.json` | `tools/spec_sync.py`; never edit by hand |
| `asyncapi.json` | Streaming API spec (AsyncAPI 3.0), from `https://api.echonova.ai/asyncapi.json` | `tools/spec_sync.py`; never edit by hand |
| `spec-lock.json` | SHA-256 of the vendored specs (over canonical JSON) and when they were fetched | `tools/spec_sync.py` |
| `error-rules.json` | Error class tree, ordered classification rules, the retry table and test vectors | by hand, with its vectors |
| `webhooks.json` | Webhook signing scheme and event payloads (not covered by the API specs) | by hand |
| `mapping.json` | Every operation, parameter and stream message, with its name in each SDK | `tools/build_mapping.py` |
| `fixtures/errors/catalog.json` | Every error example documented in `openapi.json` | `tools/build_error_catalog.py` |
| `fixtures/webhooks/vectors.json` | Webhook signature vectors (valid and invalid) | `tools/build_webhook_vectors.py` |
| `fixtures/rest/`, `fixtures/ws/` | Recorded, scrubbed API traffic | `tools/record/record.py` |
| `fixtures/expected.json` | What every SDK must do with each recorded fixture; each SDK's replay tests read it | by hand: a new recording needs an entry |

## Updating after an API change

1. `python3 tools/spec_sync.py` and review the diff of `openapi.json` / `asyncapi.json`.
2. Regenerate: `build_error_catalog.py`, `build_mapping.py` (it fails if a new operation has no SDK method yet).
3. Update `error-rules.json` if errors changed, then `tools/sync_sdk_data.py`. It copies the rules into the Python package and regenerates the Dart (`tools/gen_dart_rules.py`) and TypeScript (`tools/gen_ts_rules.py`) rule files.
4. Run every SDK's tests.
