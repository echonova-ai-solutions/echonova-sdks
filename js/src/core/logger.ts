/**
 * Opt-in logging. Off by default.
 *
 * The SDK only ever logs the method, route, status, request id, attempt number
 * and elapsed time. Never the API key, headers, request or response bodies,
 * or signed URLs.
 */

export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug';

export interface Logger {
  error(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

const RANK: Readonly<Record<LogLevel, number>> = { off: 0, error: 1, warn: 2, info: 3, debug: 4 };

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && Object.hasOwn(RANK, value);
}

const noop = (): void => {};

/** A logger that drops messages below `level` and prefixes the rest with `[echonova]`. */
export function makeLogger(level: LogLevel, target: Logger = console): Logger {
  const rank = RANK[level];
  const emit = (name: Exclude<LogLevel, 'off'>) =>
    rank >= RANK[name] ? (message: string, ...args: unknown[]) => target[name](`[echonova] ${message}`, ...args) : noop;
  return { error: emit('error'), warn: emit('warn'), info: emit('info'), debug: emit('debug') };
}
