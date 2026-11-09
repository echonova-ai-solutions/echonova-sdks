/**
 * Parse EchoNova's response envelope: `{data, success, statusCode, errorMessage}`.
 *
 * Success responses carry `success: true` and `data`. Errors carry
 * `errorMessage`, usually `docs`, and may carry an `errorCode`.
 * Responses from the hosting proxy (for example an ingress 504) are not JSON.
 */

import { parseFloatStrict, strip, truncateCodePoints } from './text.js';

export const RAW_BODY_LIMIT = 4096;
export const NON_JSON_MESSAGE_LIMIT = 500;

/** Anything headers can arrive as: a Fetch `Headers`, a plain record (Node's `req.headers`) or entry pairs. */
export type HeadersLike =
  | { get(name: string): string | null | undefined; forEach?: unknown }
  | Readonly<Record<string, string | readonly string[] | null | undefined>>
  | Iterable<readonly [string, string]>;

/** Response bodies as the core receives them. */
export type BodyBytes = Uint8Array | ArrayBuffer | string;

/** A 2xx body that isn't a valid success envelope (internal; surfaced as `ProtocolError`). */
export class MalformedEnvelopeError extends Error {
  override name = 'MalformedEnvelopeError';
}

export interface ErrorBody {
  isJson: boolean;
  errorMessage: string | null;
  errorCode: string | null;
  docsUrl: string | null;
  rawBody: string | null;
}

function headerValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(String).join(', ');
  return null;
}

function isIterable(value: object): value is Iterable<readonly [string, string]> {
  return typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function';
}

/** Case-insensitive header lookup that works for `Headers`, plain records and entry pairs. */
export function header(headers: HeadersLike | null | undefined, name: string): string | null {
  if (headers == null) return null;
  const lowered = name.toLowerCase();
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const direct = headerValue((headers as { get(name: string): unknown }).get(name));
    if (direct !== null) return direct;
    if (!isIterable(headers)) return null;
  }
  if (isIterable(headers)) {
    for (const [key, candidate] of headers) {
      if (key.toLowerCase() === lowered) return candidate;
    }
    return null;
  }
  const record = headers as Readonly<Record<string, unknown>>;
  const direct = Object.hasOwn(record, name) ? headerValue(record[name]) : null;
  if (direct !== null) return direct;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === lowered) {
      const candidate = headerValue(record[key]);
      if (candidate !== null) return candidate;
    }
  }
  return null;
}

/** Copy headers into a plain record (keys as given; `Headers` yields lowercase keys). */
export function headersToRecord(headers: HeadersLike | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers == null) return out;
  if (isIterable(headers)) {
    for (const [key, value] of headers) out[key] = value;
    return out;
  }
  if (typeof (headers as { get?: unknown }).get === 'function') return out;
  for (const [key, value] of Object.entries(headers as Readonly<Record<string, unknown>>)) {
    const text = headerValue(value);
    if (text !== null) out[key] = text;
  }
  return out;
}

const encoder = new TextEncoder();
const lenientDecoder = new TextDecoder('utf-8', { ignoreBOM: true });

export function toBytes(body: BodyBytes): Uint8Array {
  if (typeof body === 'string') return encoder.encode(body);
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(body);
}

/** Decode strictly as UTF-8 for JSON parsing. A leading BOM is accepted. Returns null for invalid UTF-8. */
function decodeForJson(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return null;
  }
}

const NOT_JSON: unique symbol = Symbol('not-json');

function parseJson(bytes: Uint8Array): unknown {
  if (bytes.length === 0) return NOT_JSON;
  const text = decodeForJson(bytes);
  if (text === null) return NOT_JSON;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return NOT_JSON;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodePreview(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;
  return lenientDecoder.decode(bytes.subarray(0, RAW_BODY_LIMIT));
}

export function parseErrorBody(body: BodyBytes): ErrorBody {
  const bytes = toBytes(body);
  const preview = decodePreview(bytes);
  const parsed = parseJson(bytes);
  if (isPlainObject(parsed) && (Object.hasOwn(parsed, 'errorMessage') || Object.hasOwn(parsed, 'success'))) {
    const message = parsed['errorMessage'];
    const code = parsed['errorCode'];
    const docs = parsed['docs'];
    return {
      isJson: true,
      errorMessage: typeof message === 'string' ? message : null,
      errorCode: typeof code === 'string' ? code : null,
      docsUrl: typeof docs === 'string' ? docs : null,
      rawBody: preview,
    };
  }
  const text = preview === null ? null : truncateCodePoints(strip(preview), NON_JSON_MESSAGE_LIMIT);
  return { isJson: false, errorMessage: text || null, errorCode: null, docsUrl: null, rawBody: preview };
}

/** Return `data` from a success envelope. Throws `MalformedEnvelopeError` for anything else. */
export function unwrapSuccess(body: BodyBytes): unknown {
  const parsed = parseJson(toBytes(body));
  if (parsed === NOT_JSON) throw new MalformedEnvelopeError('response body is not JSON');
  if (!isPlainObject(parsed) || !Object.hasOwn(parsed, 'data')) {
    throw new MalformedEnvelopeError('response body is not an EchoNova envelope');
  }
  if (parsed['success'] === false) throw new MalformedEnvelopeError('2xx response with success=false');
  return parsed['data'];
}

/**
 * Parse `Retry-After`: delta-seconds (what EchoNova sends) or an HTTP date.
 * Returns seconds to wait (never negative), or null when absent or unreadable.
 */
export function parseRetryAfter(value: string | null | undefined, options: { now?: Date } = {}): number | null {
  if (value == null) return null;
  const text = strip(value);
  const seconds = parseFloatStrict(text);
  if (seconds !== null) return Number.isNaN(seconds) ? 0 : Math.max(0, seconds);
  const when = parseHttpDate(text);
  if (when === null) return null;
  const now = options.now ?? new Date();
  return Math.max(0, (when - now.getTime()) / 1000);
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
const ZONES: Readonly<Record<string, number>> = {
  ut: 0, utc: 0, gmt: 0, z: 0, ast: -4, adt: -3, est: -5, edt: -4, cst: -6, cdt: -5, mst: -7, mdt: -6,
  pst: -8, pdt: -7,
};
const HTTP_DATE =
  /^(?:[a-z]{3,},?\s+)?(\d{1,2})[\s-]+([a-z]{3})[a-z]*[\s-]+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s+([+-]\d{4}|[a-z]{1,5}))?$/i;

/**
 * Parse an RFC 5322 / RFC 9110 date ("Thu, 05 Nov 2026 12:00:45 GMT") to epoch
 * milliseconds. A missing or unknown zone is read as UTC.
 */
export function parseHttpDate(text: string): number | null {
  const match = HTTP_DATE.exec(strip(text));
  if (!match) return null;
  const [, day, monthName, yearText, hour, minute, second, zone] = match;
  const month = MONTHS[(monthName ?? '').toLowerCase()];
  if (month === undefined) return null;
  let year = Number(yearText);
  if (year < 100) year += year > 68 ? 1900 : 2000;
  let offsetMinutes = 0;
  if (zone) {
    if (/^[+-]\d{4}$/.test(zone)) {
      const sign = zone.startsWith('-') ? -1 : 1;
      offsetMinutes = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
    } else {
      offsetMinutes = (ZONES[zone.toLowerCase()] ?? 0) * 60;
    }
  }
  const utc = Date.UTC(year, month, Number(day), Number(hour), Number(minute), Number(second ?? 0));
  if (Number.isNaN(utc)) return null;
  return utc - offsetMinutes * 60_000;
}
