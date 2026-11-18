// The allow-list matches the public API spec, and path matching can't be steered elsewhere.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  JOB_CREATING_ROUTES,
  REST_ROUTES,
  STREAM_ROUTES,
  createdJobId,
  jobIdOf,
  matchRest,
  productOf,
  sessionJobId,
} from '../src/routes.js';
import { mintStreamToken, verifyStreamToken } from '../src/tokens.js';

const SPEC = fileURLToPath(new URL('../../../spec/', import.meta.url));
const skip = existsSync(`${SPEC}openapi.json`) ? false : 'run inside the SDK repo (needs spec/)';
const SPEECH_PREFIXES = ['/v1/text-to-speech', '/v1/speech-to-text', '/v1/sound-cleaning'];

/** @param {string} name */
const readSpec = (name) => JSON.parse(readFileSync(`${SPEC}${name}`, 'utf8'));

// Left out on purpose: with one workspace key behind every user, a list would show everyone's jobs.
const JOB_LISTS = ['GET /v1/text-to-speech/jobs', 'GET /v1/speech-to-text/jobs', 'GET /v1/sound-cleaning/jobs'];

test('the REST allow-list is exactly the speech routes of the spec, without the job lists', { skip }, () => {
  const spec = readSpec('openapi.json');
  const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.keys(/** @type {object} */ (item))
      .filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m))
      .map((m) => `${m.toUpperCase()} ${path}`),
  );
  const SERVER_SIDE_ONLY = [
    'POST /v1/widgets/{publicId}/tickets',
    'POST /v1/agents/{agentId}/sessions',
    'GET /v1/agents/{agentId}/sessions/{sessionId}',
    'POST /v1/agents/{agentId}/sessions/{sessionId}/end',
  ];
  const speech = operations.filter((op) => SPEECH_PREFIXES.some((p) => op.split(' ')[1].startsWith(p)));
  for (const op of JOB_LISTS) assert.ok(speech.includes(op), op);
  assert.deepEqual(
    new Set(REST_ROUTES.map(([m, p]) => `${m} ${p}`)),
    new Set(speech.filter((op) => !JOB_LISTS.includes(op))),
  );
  assert.equal(REST_ROUTES.length, 13);
  // Everything else in the spec stays server-side only: widget tickets and agent sessions, which your
  // backend calls for the app, and the agent-management API, which only your backend uses.
  const MANAGEMENT = ['/v1/agents', '/v1/agent-voices', '/v1/tools', '/v1/secrets', '/v1/auth-connections', '/v1/llm/'];
  const others = operations.filter((op) => !speech.includes(op));
  for (const op of SERVER_SIDE_ONLY) assert.ok(others.includes(op), op);
  const rest = others.filter((op) => !SERVER_SIDE_ONLY.includes(op));
  assert.deepEqual(
    rest.filter((op) => !MANAGEMENT.some((p) => op.split(' ')[1].startsWith(p))),
    [],
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

test('the job lists are not routes', () => {
  for (const path of ['/v1/text-to-speech/jobs', '/v1/speech-to-text/jobs', '/v1/sound-cleaning/jobs']) {
    assert.deepEqual(matchRest('GET', path).allowed, [], path);
  }
});

test('every job-creating route is an allowed POST', () => {
  const allowed = new Set(REST_ROUTES.map(([m, p]) => `${m} ${p}`));
  for (const route of JOB_CREATING_ROUTES) assert.ok(allowed.has(route) && route.startsWith('POST '), route);
});

test('job ids are read from routes, answers and stream messages', () => {
  assert.equal(productOf('/v1/speech-to-text/jobs/abc/export'), 'speech-to-text');
  assert.equal(jobIdOf('/v1/speech-to-text/jobs/{jobId}/export', '/v1/speech-to-text/jobs/abc/export'), 'abc');
  assert.equal(jobIdOf('/v1/text-to-speech/voices', '/v1/text-to-speech/voices'), null);
  const answer = (/** @type {unknown} */ data) => Buffer.from(JSON.stringify({ data, success: true }));
  assert.equal(createdJobId(answer({ jobId: 'job-1', status: 'processing' })), 'job-1');
  assert.equal(createdJobId(answer({ id: 'clean-1', status: 'completed' })), 'clean-1');
  assert.equal(createdJobId(answer({ jobId: '../widgets' })), null);
  assert.equal(createdJobId(answer(null)), null);
  assert.equal(createdJobId(Buffer.from('not json')), null);
  const message = (/** @type {object} */ m) => Buffer.from(JSON.stringify(m));
  assert.equal(sessionJobId(message({ type: 'session.started', jobId: 'stt-1' })), 'stt-1');
  assert.equal(sessionJobId(message({ type: 'session.saved', jobId: 'stt-1', status: 'saved' })), 'stt-1');
  assert.equal(sessionJobId(message({ type: 'transcript.final', jobId: 'stt-1', text: 'session.' })), null);
  assert.equal(sessionJobId(message({ type: 'session.started' })), null);
});
