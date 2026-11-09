// Structured (JSON lines) logging.
//
// Log lines carry the route template, status, user id, timings and request ids. They never
// carry the API key, request or response bodies, query strings, cookies, tokens or headers.

/**
 * @typedef {'info' | 'warning' | 'error'} Level
 * @typedef {(event: string, fields?: Record<string, unknown>, level?: Level) => void} Logger
 */

/**
 * @param {(line: string) => void} [write]
 * @returns {Logger}
 */
export function createLogger(write = (line) => process.stdout.write(`${line}\n`)) {
  return (event, fields = {}, level = 'info') => {
    /** @type {Record<string, unknown>} */
    const line = { ts: new Date().toISOString(), level, logger: 'echonova_proxy', event };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null) line[key] = value;
    }
    write(JSON.stringify(line));
  };
}

/**
 * The error's type only: messages can quote request data.
 * @param {unknown} err
 */
export function errorName(err) {
  const cause = /** @type {{ cause?: unknown }} */ (err)?.cause;
  const source = /** @type {{ code?: unknown, name?: unknown } | undefined} */ (cause ?? err);
  return String(source?.code ?? source?.name ?? 'Error');
}

/**
 * warning for a 5xx outcome, info otherwise.
 * @param {unknown} status
 * @returns {Level}
 */
export function levelFor(status) {
  return typeof status === 'number' && status >= 500 ? 'warning' : 'info';
}
