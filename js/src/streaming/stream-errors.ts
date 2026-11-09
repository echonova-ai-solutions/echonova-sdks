/**
 * Map stream error frames and close codes to SDK errors.
 *
 * The close frame decides whether a stream is over. An `error` frame on its own
 * is never fatal; when one arrives just before a close, its code and message
 * are attached to the error raised for that close.
 */

import {
  APIStatusError,
  InsufficientBalanceError,
  InvalidRequestError,
  ProtocolError,
  ServerRestartingError,
  SessionExpiredError,
  SpendingLimitError,
  StreamClosedError,
  StreamConnectionLostError,
  UpstreamError,
  VoiceNotFoundError,
  type EchoNovaError,
} from '../errors.js';
import type { ChargeState, RawEvent } from './types.js';

type StatusErrorClass = typeof APIStatusError;

const ERROR_FRAME_CLASSES: Readonly<Record<string, StatusErrorClass>> = {
  validation_failed: InvalidRequestError,
  voice_not_found: VoiceNotFoundError,
  insufficient_balance: InsufficientBalanceError,
  spending_limit: SpendingLimitError,
  upstream_error: UpstreamError,
  invalid_message: ProtocolError,
  frame_too_large: ProtocolError,
};

/** Closes after which the session can't continue and reconnecting won't help. */
export const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([1002, 1007, 1008, 1009, 4002, 4029]);
/** Closes after which `transcribeStream` reconnects. */
export const RECONNECT_CLOSE_CODES: ReadonlySet<number> = new Set([1001, 1006, 1011]);

const RAW_LIMIT = 4096;

/** How a socket ended. `lostReason` is set when the SDK gave up on an unresponsive connection. */
export class CloseInfo {
  constructor(
    readonly code: number,
    readonly reason: string = '',
    /** The SDK closed it (`close()`, rotation). */
    readonly local: boolean = false,
    readonly lostReason: string | null = null,
  ) {}

  /** No clean close: the connection dropped, timed out, or the server is restarting. */
  get abnormal(): boolean {
    return this.lostReason !== null || this.code === 1001 || this.code === 1006;
  }
}

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function rawText(event: RawEvent): string {
  try {
    return JSON.stringify(event).slice(0, RAW_LIMIT);
  } catch {
    return String(event).slice(0, RAW_LIMIT);
  }
}

/** The error for an `error` frame (`{type, code, message, requestId?}`). */
export function errorFromFrame(event: RawEvent, options: { sessionId?: string | null } = {}): APIStatusError {
  const code = str(event['code']);
  const message = event['message'];
  const ErrorClass = (code !== null && Object.hasOwn(ERROR_FRAME_CLASSES, code) ? ERROR_FRAME_CLASSES[code] : undefined) ?? APIStatusError;
  return new ErrorClass({
    errorMessage: typeof message === 'string' ? message : null,
    errorCode: code,
    requestId: str(event['requestId']),
    sessionId: options.sessionId ?? null,
    rawBody: rawText(event),
    transport: 'websocket',
  });
}

export interface CloseErrorOptions {
  /** Speech to Text sent `session.ended` before the close. */
  endedNormally?: boolean | undefined;
  /** An `error` frame that arrived just before the close. */
  lastError?: RawEvent | null | undefined;
  sessionId?: string | null | undefined;
  mayHaveExecuted?: boolean | null | undefined;
}

const PROTOCOL_DEFAULTS: Readonly<Record<number, string>> = {
  1002: 'protocol error',
  1007: 'invalid frame data',
  1008: 'policy violation',
  1009: 'frame too big',
};

/** The error for a close, or `null` when the close is a normal end. */
export function closeError(info: CloseInfo, options: CloseErrorOptions = {}): EchoNovaError | null {
  const { code } = info;
  const reason = info.reason || null;
  const last = options.lastError ?? null;
  const errorMessage = last && typeof last['message'] === 'string' ? last['message'] : null;
  const errorCode = last ? str(last['code']) : null;
  const requestId = last ? str(last['requestId']) : null;
  const sessionId = options.sessionId ?? null;

  const status = (ErrorClass: StatusErrorClass, fallback: string): APIStatusError =>
    new ErrorClass({
      errorMessage: errorMessage || reason || fallback,
      errorCode,
      closeCode: code,
      requestId,
      sessionId,
      rawBody: last ? rawText(last) : null,
      transport: 'websocket',
    });

  if (info.lostReason !== null || code === 1006) {
    const detail = info.lostReason ?? 'closed without a close frame (1006)';
    return new StreamConnectionLostError(`stream connection lost: ${detail}`, {
      mayHaveExecuted: options.mayHaveExecuted === undefined ? null : options.mayHaveExecuted,
    });
  }
  if (info.local) return null;
  const suffix = reason ? `: ${reason}` : '';
  switch (code) {
    case 1000:
      if (options.endedNormally) return null;
      return new StreamClosedError(`the server closed the stream (1000${suffix})`, { closeCode: code, reason, sessionId });
    case 1001:
      return new ServerRestartingError('the server is restarting (1001); reconnect', { closeCode: code, reason, sessionId });
    case 1002:
    case 1007:
    case 1008:
    case 1009:
      return status(ProtocolError, PROTOCOL_DEFAULTS[code] ?? 'protocol error');
    case 1011:
      return status(UpstreamError, 'the speech service failed');
    case 4002:
      return status(InsufficientBalanceError, 'insufficient balance');
    case 4029:
      return status(SpendingLimitError, 'spending limit reached');
    case 4008:
      if (options.endedNormally) return null;
      return new SessionExpiredError(`the stream session expired (${reason ?? 'timeout'})`, {
        closeCode: code,
        reason,
        sessionId,
      });
    default:
      return new StreamClosedError(`the stream closed with code ${code}${suffix}`, { closeCode: code, reason, sessionId });
  }
}

/** Record whether a lost or failed synthesis was charged on its error (`error.chargeState`). */
export function attachChargeState<E extends EchoNovaError>(error: E, state: ChargeState): E {
  Object.defineProperty(error, 'chargeState', { value: state, enumerable: true, configurable: true, writable: true });
  return error;
}

/** Whether the synthesis behind a stream error was charged (`yes`, `no`, `unknown`), when the error says. */
export function chargeStateOf(error: unknown): ChargeState | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = (error as { chargeState?: unknown }).chargeState;
  return value === 'yes' || value === 'no' || value === 'unknown' ? value : null;
}
