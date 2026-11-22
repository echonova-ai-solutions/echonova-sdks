// REST relay: allow-list, end-user auth, quota, job ownership, key injection, streaming both ways.

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// undici's fetch, not the global one: the dispatcher (app.js) comes from the same undici, so
// the two always agree on the dispatcher API. Node's built-in fetch is a bundled undici whose
// version depends on the Node release (undici 6 on Node 22), and undici 8's Agent refuses its
// handlers ("invalid onRequestStart method").
import { fetch } from 'undici';

import {
  FORWARDED_REQUEST_HEADERS,
  MESSAGES,
  UNEXPECTED_REDIRECT,
  errorBody,
  failedToConnect,
  requestId,
  safeResponseHeaders,
  scopedIdempotencyKey,
  splitUrl,
  stripPrefix,
  timedOut,
  userAgent,
} from './common.js';
import { errorName, levelFor } from './log.js';
import {
  JOB_CREATING_ROUTES,
  JOB_NOT_FOUND,
  createdJobId,
  isStreamRoute,
  jobIdOf,
  matchRest,
  productOf,
} from './routes.js';

class BodyTooLarge extends Error {}

// A job-creating answer is read whole before it is relayed, to record its job for the user before
// the app can ask for it. These answers are small JSON; a longer one is relayed unrecorded.
const MAX_JOB_RESPONSE = 8 * 1024 * 1024;

/**
 * @typedef {import('./app.js').ProxyContext} ProxyContext
 * @typedef {import('node:http').IncomingMessage} IncomingMessage
 * @typedef {import('node:http').ServerResponse} ServerResponse
 */

/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {string} rid
 * @param {string} [message]
 * @param {Record<string, string>} [headers]
 */
export function sendError(res, status, rid, message, headers = {}) {
  const body = errorBody(status, message ?? MESSAGES[status]);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'x-request-id': rid,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

/** The API's own answer to a successful job delete. @param {ServerResponse} res @param {string} rid */
function sendDeleted(res, rid) {
  const body = '{"success":true,"statusCode":200,"errorMessage":null,"data":{"deleted":true}}';
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'x-request-id': rid,
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {ProxyContext} ctx
 */
export async function handleHttp(req, res, ctx) {
  const { settings, log } = ctx;
  const started = performance.now();
  const rid = requestId(req.headers['x-request-id']);
  /** @type {Record<string, unknown>} */
  const fields = { method: req.method, request_id: rid };
  /** @param {number} status @param {Record<string, unknown>} [extra] */
  const done = (status, extra = {}) =>
    log('http', { ...fields, ...extra, status, ms: Math.round(performance.now() - started) }, levelFor(status));
  /**
   * @param {number} status
   * @param {{ message?: string, headers?: Record<string, string>, extra?: Record<string, unknown> }} [options]
   */
  const fail = (status, { message, headers, extra } = {}) => {
    sendError(res, status, rid, message, headers);
    done(status, extra);
  };
  // Stop waiting for EchoNova if the app hangs up first. EchoNova still finishes (and charges)
  // work it has started; there is just no one left to relay the answer to.
  const hangup = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) hangup.abort();
  });

  const [rawPath, query] = splitUrl(/** @type {any} */ (req).originalUrl ?? req.url ?? '/');
  const path = stripPrefix(rawPath, settings.prefix);
  if (path === null) return fail(404);
  if (isStreamRoute(path)) {
    fields.route = path;
    return fail(426);
  }
  const method = req.method ?? 'GET';
  const route = matchRest(method, path);
  if (!route.allowed.length) return fail(404);
  if (!route.template) {
    fields.route = path;
    return fail(405, { headers: { allow: route.allowed.join(', ') } });
  }
  fields.route = route.template;

  const user = await ctx.authenticate(req);
  if (!user) return fail(401);
  fields.user = user;
  const retryAfter = await ctx.quota.allowRequest(user);
  if (retryAfter !== null) return fail(429, { headers: { 'retry-after': String(retryAfter) } });

  // One workspace key serves every user: a job is only its creator's to read, export or delete.
  // Someone else's job gets the API's own answer for an unknown job, so its existence stays hidden.
  const product = productOf(path);
  const jobId = jobIdOf(route.template, path);
  if (jobId !== null && !(await ctx.jobs.isOwner(product, jobId, user))) {
    return fail(404, { message: JOB_NOT_FOUND[product], extra: { outcome: 'not_owner' } });
  }
  const createsJob = JOB_CREATING_ROUTES.has(`${method} ${route.template}`);
  const deletesJob = jobId !== null && method === 'DELETE';
  if (deletesJob && (await ctx.jobs.hasOtherOwners(product, jobId, user))) {
    // Another user owns this job too (the API returned it for the same input), so it stays at
    // EchoNova for them. For this user it is gone, as if the API had deleted it.
    await ctx.jobs.release(product, jobId, user);
    sendDeleted(res, rid);
    return done(200, { outcome: 'released' });
  }

  /** @type {Record<string, string>} */
  const headers = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  if (headers['idempotency-key'] !== undefined) {
    headers['idempotency-key'] = scopedIdempotencyKey(headers['idempotency-key'], user, settings.streamTokenSecret);
  }
  Object.assign(headers, {
    authorization: `Bearer ${settings.apiKey}`,
    'user-agent': userAgent(req.headers['user-agent']),
    'x-request-id': rid,
    'accept-encoding': 'identity',
  });

  /** @type {AsyncIterable<Uint8Array> | undefined} */
  let body;
  const length = req.headers['content-length'];
  if (method === 'POST' && (length !== undefined || req.headers['transfer-encoding'] !== undefined)) {
    if (length !== undefined) {
      if (!/^\d+$/.test(length)) return fail(400, { message: 'Invalid Content-Length' });
      if (Number(length) > settings.maxUploadBytes) return fail(413);
      headers['content-length'] = length; // streamed as-is; otherwise chunked
    }
    body = limited(req, settings.maxUploadBytes);
  }

  /** @type {import('undici').Response} */
  let upstream;
  // fetch streams an async-iterable body with duplex: 'half', through the proxy's dispatcher.
  // redirect: 'error' (with window: null) matters: with any other mode, fetch keeps a copy of
  // the request for redirects, which holds every uploaded chunk in memory until the call ends.
  const init = {
    method,
    headers,
    body,
    duplex: 'half',
    dispatcher: ctx.dispatcher,
    redirect: /** @type {const} */ ('error'),
    window: null,
    signal: hangup.signal,
  };
  try {
    upstream = await fetch(settings.upstreamUrl + path + (query ? `?${query}` : ''), /** @type {any} */ (init));
  } catch (err) {
    if (hangup.signal.aborted) return done(499, { outcome: 'client_closed' });
    if (/** @type {any} */ (err)?.cause instanceof BodyTooLarge) return fail(413);
    const extra = { upstream_error: errorName(err) };
    if (/** @type {any} */ (err)?.cause?.message === 'unexpected redirect') {
      return fail(502, { message: UNEXPECTED_REDIRECT, extra });
    }
    if (failedToConnect(err)) return fail(503, { extra });
    if (timedOut(err)) return fail(504, { extra });
    return fail(502, { extra });
  }

  const ok = upstream.status >= 200 && upstream.status < 300;
  /** @type {Buffer[] | null} the start of a job-creating answer, read before anything is relayed */
  let kept = null;
  let complete = false;
  /** @type {AsyncIterator<Uint8Array> | null} */
  let rest = null;
  if (createsJob && ok && upstream.body) {
    kept = [];
    rest = Readable.fromWeb(/** @type {any} */ (upstream.body))[Symbol.asyncIterator]();
    let size = 0;
    try {
      for (;;) {
        const next = await rest.next();
        if (next.done) {
          complete = true;
          break;
        }
        kept.push(Buffer.from(next.value));
        size += next.value.length;
        if (size > MAX_JOB_RESPONSE) break;
      }
    } catch (err) {
      if (hangup.signal.aborted) return done(499, { outcome: 'client_closed' });
      return fail(502, { extra: { upstream_error: errorName(err) } });
    }
    const created = complete ? createdJobId(Buffer.concat(kept)) : null;
    if (created) await ctx.jobs.record(product, created, user);
    else log('job.unrecorded', { route: fields.route, request_id: rid }, 'warning');
  }
  if (deletesJob && ok) await ctx.jobs.release(product, jobId, user);

  const responseHeaders = safeResponseHeaders(upstream.headers.entries());
  const upstreamRid = upstream.headers.get('x-request-id');
  if (upstreamRid === null) responseHeaders.push(['x-request-id', rid]);
  responseHeaders.push(['cache-control', 'no-store']);
  for (const [name, value] of responseHeaders) res.setHeader(name, value);
  res.statusCode = upstream.status;
  done(upstream.status, { upstream_request_id: upstreamRid ?? undefined });

  if (kept && complete) {
    res.end(Buffer.concat(kept));
    return;
  }
  if (!upstream.body) {
    res.end();
    return;
  }
  const keptChunks = kept ?? [];
  const remaining = rest;
  const source = remaining
    ? async function* () {
        yield* keptChunks;
        for (let next = await remaining.next(); !next.done; next = await remaining.next()) yield next.value;
      }
    : Readable.fromWeb(/** @type {any} */ (upstream.body));
  try {
    await pipeline(source, res);
  } catch (err) {
    if (!hangup.signal.aborted) {
      log('http.upstream_cut', { route: fields.route, request_id: rid, error: errorName(err) }, 'warning');
    }
    // pipeline has destroyed res: the app sees a failed download, never a shortened body
    // that looks complete.
    res.destroy();
  }
}

/**
 * The app's request body, chunk by chunk, never held in memory as a whole.
 * @param {IncomingMessage} req
 * @param {number} limit
 * @returns {AsyncGenerator<Uint8Array>}
 */
async function* limited(req, limit) {
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new BodyTooLarge();
    if (chunk.length) yield chunk;
  }
}
