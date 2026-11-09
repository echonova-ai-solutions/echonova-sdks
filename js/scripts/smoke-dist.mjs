// Smoke test of the built package as an ES module, imported by its own name
// (Node resolves "echonova" to this package through its "exports" map).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import EchoNova, { EchoNova as Named, RateLimitError, EchoNovaError, VERSION, verifyWebhook } from 'echonova';

const require = createRequire(import.meta.url);
const cjs = require('echonova');

assert.equal(EchoNova, Named, 'default export is the client');
assert.equal(typeof verifyWebhook, 'function');
assert.equal(EchoNova.RateLimitError, RateLimitError);
assert.equal(cjs.VERSION, VERSION);
assert.notEqual(cjs.RateLimitError, RateLimitError, 'the CJS and ESM builds are separate copies');

// An error thrown by one build is an instance of the other build's classes.
const fromCjs = new cjs.RateLimitError({ statusCode: 429, retryAfter: 1 });
assert.ok(fromCjs instanceof RateLimitError);
assert.ok(fromCjs instanceof EchoNovaError);
assert.ok(fromCjs instanceof EchoNova.APIStatusError);
assert.ok(!(fromCjs instanceof EchoNova.SpendingLimitError));
assert.ok(new RateLimitError() instanceof cjs.RateLimitError);
assert.equal(fromCjs.name, 'RateLimitError');

const client = new EchoNova({ apiKey: 'ek_REDACTED_smoke_0000000000000000c21d', fetch: async () => new Response('{}') });
assert.equal(String(client), "EchoNova(baseURL='https://api.echonova.ai', apiKey='ek_…c21d')");

console.log(`ESM build OK (echonova ${VERSION})`);
