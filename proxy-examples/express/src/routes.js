// The allow-list: the only EchoNova routes the proxy forwards.
//
// These are the speech routes of the public API spec (Text to Speech, Speech to Text and Sound
// Cleaning). A test checks this table against spec/openapi.json and spec/asyncapi.json. Delete
// the rows your app doesn't use.
//
// Deliberately left out: POST /v1/widgets/{publicId}/tickets. Minting a widget ticket is a call
// your own backend makes directly with the API key, never something an app should reach.
//
// Also left out: the three job lists (GET /v1/{text-to-speech,speech-to-text,sound-cleaning}/jobs).
// Every user's calls go upstream with the same workspace key, so a list would show each user every
// other user's jobs. To offer a list in your app, list the jobs your own database records for the
// user (see JobOwners in hooks.js). The single-job routes below are checked against the job's owner.

/** @type {ReadonlyArray<readonly [string, string]>} */
export const REST_ROUTES = Object.freeze([
  ['POST', '/v1/text-to-speech'],
  ['POST', '/v1/text-to-speech/sync'],
  ['GET', '/v1/text-to-speech/voices'],
  ['GET', '/v1/text-to-speech/jobs/{jobId}'],
  ['DELETE', '/v1/text-to-speech/jobs/{jobId}'],
  ['POST', '/v1/speech-to-text'],
  ['POST', '/v1/speech-to-text/sync'],
  ['GET', '/v1/speech-to-text/jobs/{jobId}'],
  ['DELETE', '/v1/speech-to-text/jobs/{jobId}'],
  ['GET', '/v1/speech-to-text/jobs/{jobId}/export'],
  ['POST', '/v1/sound-cleaning'],
  ['GET', '/v1/sound-cleaning/jobs/{jobId}'],
  ['DELETE', '/v1/sound-cleaning/jobs/{jobId}'],
]);

/**
 * Routes whose successful answer creates a job (data.jobId, or data.id for a Sound Cleaning job that
 * finished in the call). The proxy records the job as the calling user's.
 * @type {ReadonlySet<string>}
 */
export const JOB_CREATING_ROUTES = new Set([
  'POST /v1/text-to-speech',
  'POST /v1/text-to-speech/sync',
  'POST /v1/speech-to-text',
  'POST /v1/speech-to-text/sync',
  'POST /v1/sound-cleaning',
]);

// The stream whose session.started and session.saved messages carry the job id of the session.
export const JOB_CREATING_STREAM = '/v1/speech-to-text/stream';

// What the API answers for an unknown job. The proxy answers the same for another user's job, so a
// caller can't tell whether the id exists.
/** @type {Readonly<Record<string, string>>} */
export const JOB_NOT_FOUND = Object.freeze({
  'text-to-speech': 'TTS Job not found',
  'speech-to-text': 'STT Job not found',
  'sound-cleaning': 'Clean Job not found',
});

/**
 * WebSocket streams, with the query parameters forwarded upstream (everything else is dropped).
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const STREAM_ROUTES = Object.freeze({
  '/v1/text-to-speech/stream': [],
  '/v1/speech-to-text/stream': ['sample_rate', 'language', 'encoding'],
});

/** @param {string} path */
export function isStreamRoute(path) {
  return Object.hasOwn(STREAM_ROUTES, path);
}

// A path parameter is one plain segment. Anything else (percent-encoding, dots, slashes)
// doesn't match, so a crafted ID can never steer the request to another upstream path.
const PARAM = '[A-Za-z0-9_-]{1,128}';
const JOB_ID = new RegExp(`^${PARAM}$`);

/**
 * The product of a speech route: 'text-to-speech' for /v1/text-to-speech/jobs/{jobId}.
 * @param {string} path
 */
export function productOf(path) {
  return path.split('/')[2] ?? '';
}

/**
 * The job a matched route acts on, or null for a route that isn't about one job.
 * @param {string} template
 * @param {string} path the concrete path the template matched
 */
export function jobIdOf(template, path) {
  return template.includes('{jobId}') ? (path.split('/')[4] ?? null) : null;
}

/**
 * A job id the proxy can record: one that its job routes would match.
 * @param {unknown} id
 * @returns {id is string}
 */
export function isJobId(id) {
  return typeof id === 'string' && JOB_ID.test(id);
}

/**
 * The job a job-creating answer names, or null.
 * @param {Buffer} body
 */
export function createdJobId(body) {
  let data;
  try {
    data = JSON.parse(body.toString('utf8'))?.data;
  } catch {
    return null;
  }
  const id = data?.jobId ?? data?.id;
  return isJobId(id) ? id : null;
}

/**
 * The job id in a Speech to Text stream's session.started or session.saved message, or null.
 * @param {Buffer} frame a text frame from EchoNova
 */
export function sessionJobId(frame) {
  if (frame.length > 64 * 1024 || !frame.includes('"session.')) return null;
  let message;
  try {
    message = JSON.parse(frame.toString('utf8'));
  } catch {
    return null;
  }
  if (message?.type !== 'session.started' && message?.type !== 'session.saved') return null;
  return isJobId(message.jobId) ? message.jobId : null;
}

/** @param {string} template */
function compile(template) {
  const body = template
    .split(/(\{[A-Za-z]+\})/)
    .map((part) => (part.startsWith('{') ? PARAM : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`);
}

const PATTERNS = REST_ROUTES.map(([method, template]) => ({ method, template, pattern: compile(template) }));

/**
 * Match a raw (still percent-encoded) path such as /v1/text-to-speech/sync.
 * @param {string} method
 * @param {string} path
 * @returns {{ template: string | null, allowed: string[] }} allowed is empty when the path is unknown
 */
export function matchRest(method, path) {
  /** @type {string[]} */
  const allowed = [];
  let template = null;
  for (const route of PATTERNS) {
    if (route.pattern.test(path)) {
      allowed.push(route.method);
      if (route.method === method) template = route.template;
    }
  }
  return { template, allowed };
}
