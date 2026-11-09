// Smoke test of the built package as CommonJS, required by its own name.
'use strict';
const assert = require('node:assert/strict');
const pkg = require('echonova');

assert.equal(typeof pkg.EchoNova, 'function');
assert.equal(pkg.default, pkg.EchoNova, 'require("echonova").default is the client');
assert.equal(pkg.EchoNova.InvalidRequestError, pkg.InvalidRequestError);
assert.equal(typeof pkg.verifyWebhook, 'function');
const error = new pkg.SpendingLimitError({ statusCode: 429 });
assert.ok(error instanceof pkg.BillingError);
assert.ok(!(error instanceof pkg.RateLimitError));
assert.equal(error.name, 'SpendingLimitError');

console.log(`CJS build OK (echonova ${pkg.VERSION})`);

// The REST surface works from the CommonJS build too.
(async () => {
  const client = new pkg.EchoNova({
    apiKey: 'ek_REDACTED_smoke_0000000000000000c21d',
    fetch: async () =>
      new Response(JSON.stringify({ data: { id: 's1', status: 'active', token: 't', wsUrl: 'wss://x' }, success: true }), {
        headers: { 'X-Request-Id': 'cjs-1' },
      }),
  });
  const session = await client.agents.sessions.start('agent-1', { channel: 'chat' });
  assert.equal(session.id, 's1');
  assert.equal(session.requestId, 'cjs-1');
  assert.equal(typeof pkg.toFile, 'function');
  console.log('CJS REST surface OK');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
