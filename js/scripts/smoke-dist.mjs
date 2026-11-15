// Smoke test of the built package as an ES module, imported by its own name
// (Node resolves "@echonova/ai" to this package through its "exports" map).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import EchoNova, { EchoNova as Named, RateLimitError, EchoNovaError, VERSION, verifyWebhook } from '@echonova/ai';

const require = createRequire(import.meta.url);
const cjs = require('@echonova/ai');

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

// The REST surface works from the built package, against a stand-in fetch.
const { Page, PagePromise, APIPromise, toFile } = await import('@echonova/ai');
const replies = [
  { items: [{ id: 'j1', status: 'completed' }], total: 1 },
  { jobId: 'j2', status: 'pending' },
];
const seen = [];
const rest = new EchoNova({
  apiKey: 'ek_REDACTED_smoke_0000000000000000c21d',
  fetch: async (url, init) => {
    seen.push({ url, init });
    const data = replies.shift();
    return new Response(JSON.stringify({ data, success: true, statusCode: 200, errorMessage: null }), {
      headers: { 'X-Request-Id': 'smoke-1' },
    });
  },
});
const listing = rest.textToSpeech.jobs.list({ limit: 1 });
assert.ok(listing instanceof PagePromise && listing instanceof APIPromise);
const page = await listing;
assert.ok(page instanceof Page);
assert.deepEqual(page.items, [{ id: 'j1', status: 'completed', requestId: 'smoke-1' }]);
const upload = toFile(new Uint8Array([...Buffer.from('RIFF\0\0\0\0WAVE')]), 'a.wav');
const created = await rest.speechToText.jobs.create({ file: upload, language: 'en' }).withResponse();
assert.equal(created.data.jobId, 'j2');
assert.equal(created.requestId, 'smoke-1');
assert.equal(seen[1].init.redirect, 'error');
assert.equal(seen[1].init.body.get('file').type, 'audio/wav');

// A browser bundle of the package needs no Node built-in: file paths load them only at run time.
const { build } = await import('esbuild');
const browser = await build({
  entryPoints: [new URL('../dist/index.js', import.meta.url).pathname],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  write: false,
  logLevel: 'silent',
});
const code = browser.outputFiles[0].text;
assert.ok(!/\bfrom\s*["']node:|require\(["'](node:)?(fs|path)["']\)/.test(code), 'no static Node built-in imports');

console.log('ESM REST surface and browser bundle OK');
