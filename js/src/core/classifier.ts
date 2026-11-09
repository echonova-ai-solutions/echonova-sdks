/** Turn an HTTP error response (REST or WebSocket handshake) into an SDK error. */

import { APIStatusError, ERROR_CLASSES, type Transport } from '../errors.js';
import { header, headersToRecord, parseErrorBody, parseRetryAfter, type BodyBytes, type HeadersLike } from './envelope.js';
import { loadRules, type Executed, type Rule, type RuleSet } from './rules.js';

/** `mayHaveExecuted` for an error: only a POST can have run and been charged. */
export function executedFlag(value: Executed, method: string): boolean | null {
  if (method.toUpperCase() !== 'POST') return false;
  return value === 'yes' ? true : value === 'no' ? false : null;
}

export interface Classification {
  rule: Rule;
  /** Seconds from `Retry-After`, or null when absent. */
  retryAfter: number | null;
}

export function classifyResponse(
  status: number,
  headers: HeadersLike,
  body: BodyBytes,
  options: { rules?: RuleSet | undefined } = {},
): Classification {
  const rules = options.rules ?? loadRules();
  const parsed = parseErrorBody(body);
  const retryAfter = parseRetryAfter(header(headers, 'retry-after'));
  const rule = rules.classify(status, {
    isJson: parsed.isJson,
    message: parsed.isJson ? parsed.errorMessage : null,
    hasRetryAfter: retryAfter !== null,
  });
  return { rule, retryAfter };
}

export interface BuildStatusErrorOptions {
  /** `GET`, `POST`, `DELETE`, or `WS` for a WebSocket handshake. */
  method: string;
  transport?: Transport | undefined;
  sentAt?: Date | null | undefined;
  /** Used as the error message when the body has none (e.g. `statusText`). */
  reasonPhrase?: string | null | undefined;
  retryDisabledReason?: string | null | undefined;
  rules?: RuleSet | undefined;
}

export function buildStatusError(
  status: number,
  headers: HeadersLike,
  body: BodyBytes,
  options: BuildStatusErrorOptions,
): APIStatusError {
  const parsed = parseErrorBody(body);
  const { rule, retryAfter } = classifyResponse(status, headers, body, { rules: options.rules });
  const ErrorClass = (ERROR_CLASSES as Readonly<Record<string, unknown>>)[rule.error];
  const isStatusClass =
    typeof ErrorClass === 'function' &&
    (ErrorClass === APIStatusError || ErrorClass.prototype instanceof APIStatusError);
  if (!isStatusClass) {
    throw new TypeError(`error rule ${rule.id} maps to ${rule.error}, which is not an APIStatusError`);
  }
  const StatusError = ErrorClass as typeof APIStatusError;
  return new StatusError({
    statusCode: status,
    errorMessage: (parsed.errorMessage || options.reasonPhrase) ?? null,
    errorCode: parsed.errorCode,
    requestId: header(headers, 'x-request-id'),
    docsUrl: parsed.docsUrl,
    headers: headersToRecord(headers),
    rawBody: parsed.rawBody,
    transport: options.transport ?? 'http',
    retryAfter,
    mayHaveExecuted: executedFlag(rule.mayHaveExecuted, options.method),
    rule: rule.id,
    sentAt: options.sentAt ?? null,
    fromProxy: rule.fromProxy,
    retryDisabledReason: options.retryDisabledReason ?? null,
  });
}
