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
