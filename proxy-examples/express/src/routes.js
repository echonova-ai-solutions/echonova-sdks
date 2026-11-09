// The allow-list: the only EchoNova routes the proxy forwards.
//
// These are the speech routes of the public API spec (Text to Speech, Speech to Text and Sound
// Cleaning). A test checks this table against spec/openapi.json and spec/asyncapi.json. Delete
// the rows your app doesn't use.
//
// Deliberately left out: POST /v1/widgets/{publicId}/tickets. Minting a widget ticket is a call
// your own backend makes directly with the API key, never something an app should reach.

/** @type {ReadonlyArray<readonly [string, string]>} */
export const REST_ROUTES = Object.freeze([
  ['POST', '/v1/text-to-speech'],
  ['POST', '/v1/text-to-speech/sync'],
  ['GET', '/v1/text-to-speech/voices'],
  ['GET', '/v1/text-to-speech/jobs'],
  ['GET', '/v1/text-to-speech/jobs/{jobId}'],
  ['DELETE', '/v1/text-to-speech/jobs/{jobId}'],
  ['POST', '/v1/speech-to-text'],
  ['POST', '/v1/speech-to-text/sync'],
  ['GET', '/v1/speech-to-text/jobs'],
  ['GET', '/v1/speech-to-text/jobs/{jobId}'],
  ['DELETE', '/v1/speech-to-text/jobs/{jobId}'],
  ['GET', '/v1/speech-to-text/jobs/{jobId}/export'],
  ['POST', '/v1/sound-cleaning'],
  ['GET', '/v1/sound-cleaning/jobs'],
  ['GET', '/v1/sound-cleaning/jobs/{jobId}'],
  ['DELETE', '/v1/sound-cleaning/jobs/{jobId}'],
]);

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
