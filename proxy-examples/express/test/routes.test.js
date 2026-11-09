// The allow-list matches the public API spec, and path matching can't be steered elsewhere.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { REST_ROUTES, STREAM_ROUTES, matchRest } from '../src/routes.js';
import { mintStreamToken, verifyStreamToken } from '../src/tokens.js';

const SPEC = fileURLToPath(new URL('../../../spec/', import.meta.url));
const skip = existsSync(`${SPEC}openapi.json`) ? false : 'run inside the SDK repo (needs spec/)';
const SPEECH_PREFIXES = ['/v1/text-to-speech', '/v1/speech-to-text', '/v1/sound-cleaning'];

/** @param {string} name */
const readSpec = (name) => JSON.parse(readFileSync(`${SPEC}${name}`, 'utf8'));

test('the REST allow-list is exactly the speech routes of the spec', { skip }, () => {
  const spec = readSpec('openapi.json');
  const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.keys(/** @type {object} */ (item))
      .filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m))
      .map((m) => `${m.toUpperCase()} ${path}`),
  );
  const speech = operations.filter((op) => SPEECH_PREFIXES.some((p) => op.split(' ')[1].startsWith(p)));
  assert.deepEqual(new Set(REST_ROUTES.map(([m, p]) => `${m} ${p}`)), new Set(speech));
  assert.equal(REST_ROUTES.length, 16);
  // Everything else in the spec (the widget ticket route) stays server-side only.
  assert.deepEqual(
    operations.filter((op) => !speech.includes(op)),
    ['POST /v1/widgets/{publicId}/tickets'],
  );
});

test('the stream allow-list matches the asyncapi channels and their query', { skip }, () => {
  const spec = readSpec('asyncapi.json');
  const channels = new Map(Object.values(spec.channels).map((c) => [c.address, c]));
  assert.deepEqual(new Set(Object.keys(STREAM_ROUTES)), new Set(channels.keys()));
  for (const [address, params] of Object.entries(STREAM_ROUTES)) {
    const query = channels.get(address)?.bindings?.ws?.query?.properties ?? {};
    assert.deepEqual(new Set(params), new Set(Object.keys(query)));
  }
});

test('routes match their templates', () => {
  assert.equal(matchRest('POST', '/v1/text-to-speech/sync').template, '/v1/text-to-speech/sync');
  assert.equal(
    matchRest('GET', '/v1/speech-to-text/jobs/65a1b2c3d4e5f60718293a4b/export').template,
    '/v1/speech-to-text/jobs/{jobId}/export',
  );
  assert.equal(matchRest('DELETE', '/v1/sound-cleaning/jobs/abc').template, '/v1/sound-cleaning/jobs/{jobId}');
});

test('unknown or crafted paths do not match', () => {
  for (const path of [
    '/v1/widgets/w1/tickets',
    '/v1/text-to-speech/jobs/..%2F..%2Fwidgets%2Fw1%2Ftickets',
    '/v1/text-to-speech/jobs/%2e%2e',
    '/v1/text-to-speech/jobs/a/b',
    '/v1/text-to-speech/sync/',
    '/v1//text-to-speech/sync',
    '/v2/text-to-speech/sync',
    `/v1/text-to-speech/jobs/${'a'.repeat(129)}`,
  ]) {
    assert.deepEqual(matchRest('GET', path).allowed, [], path);
    assert.deepEqual(matchRest('POST', path).allowed, [], path);
  }
});

test('a wrong method reports the allowed ones', () => {
  const result = matchRest('PUT', '/v1/text-to-speech/jobs/abc');
  assert.equal(result.template, null);
  assert.deepEqual(result.allowed, ['GET', 'DELETE']);
});

test('stream tokens round-trip, and match the FastAPI proxy vector', () => {
  const secret = Buffer.from('vector-secret');
  const token = mintStreamToken('user-42', secret, 60, 1_700_000_000);
  assert.equal(token, 'dXNlci00Mg.1700000060.Ezl3zLWTzcJfGhuqAcZyIvWhytL4KhcAwd-1sBKasUg');
  assert.equal(verifyStreamToken(token, secret, 1_700_000_059), 'user-42');
  assert.equal(verifyStreamToken(token, secret, 1_700_000_060), null); // expired
  assert.equal(verifyStreamToken(token, Buffer.from('other-secret'), 1_700_000_000), null); // forged
  assert.equal(verifyStreamToken(token.replace('dXNlci00Mg', 'dXNlci00Mw'), secret, 0), null);
  assert.equal(verifyStreamToken('garbage', secret), null);
});
