/**
 * Text and number helpers shared by the core.
 *
 * Every EchoNova SDK must classify the same response the same way, so these
 * follow the reference rules exactly: the whitespace set used for trimming, the
 * accepted number syntax, rounding and the number format used in dedupe keys.
 */

// The whitespace characters the reference implementation trims (JavaScript's
// trim() differs slightly: it also removes U+FEFF and keeps U+001C-U+001F, U+0085).
const WS = '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const SPACE = new RegExp(`[${WS}]`);

/**
 * Trim leading and trailing whitespace. A loop over single characters, not a
 * `^[…]+|[…]+$` regex: that one is quadratic on a long whitespace run, and this
 * runs on webhook headers before the signature is checked.
 */
export function strip(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && SPACE.test(text[start]!)) start += 1;
  while (end > start && SPACE.test(text[end - 1]!)) end -= 1;
  return text.slice(start, end);
}

const DIGITS = '[0-9](?:_?[0-9])*';
const FLOAT = new RegExp(
  `^[+-]?(?:(?:(?:${DIGITS})?\\.${DIGITS}|${DIGITS}\\.?)(?:[eE][+-]?${DIGITS})?|inf(?:inity)?|nan)$`,
  'i',
);
const INT = new RegExp(`^[+-]?${DIGITS}$`);

/**
 * Parse a decimal number as text ("30", " 1.5 ", "1e3", "inf"). Returns null when
 * it isn't one. An empty string is not a number (unlike `Number("")`).
 */
export function parseFloatStrict(text: string): number | null {
  const value = strip(text);
  if (!FLOAT.test(value)) return null;
  const lower = value.toLowerCase().replace(/_/g, '');
  const unsigned = lower.replace(/^[+-]/, '');
  const negative = lower.startsWith('-');
  if (unsigned.startsWith('inf')) return negative ? -Infinity : Infinity;
  if (unsigned === 'nan') return Number.NaN;
  return Number(lower);
}

/** Parse an integer as text (" 42 ", "+7"). Returns null for anything else, including "7.5". */
export function parseIntStrict(text: string): number | null {
  const value = strip(text);
  if (!INT.test(value)) return null;
  return Number(value.replace(/_/g, ''));
}

/** Round half to even ("banker's rounding"): 80.5 -> 80, 81.5 -> 82. */
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Format a number for a dedupe key: integers without a decimal point or exponent
 * ("10000"), other numbers in shortest round-trip form with a two-digit exponent
 * below 1e-4 ("0.25", "1e-05"). Every SDK produces the same key for the same event.
 */
export function numberKey(value: number | null): string {
  if (value === null) return '-';
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return BigInt(value).toString();
  const [mantissa, exponentText] = value.toExponential().split('e') as [string, string];
  const exponent = Number(exponentText);
  if (exponent < -4 || exponent >= 16) {
    const sign = exponent < 0 ? '-' : '+';
    return `${mantissa}e${sign}${String(Math.abs(exponent)).padStart(2, '0')}`;
  }
  return String(value);
}

/** Truncate to at most `limit` Unicode code points (never splits a surrogate pair). */
export function truncateCodePoints(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let count = 0;
  let index = 0;
  while (index < text.length && count < limit) {
    const high = text.charCodeAt(index);
    const low = text.charCodeAt(index + 1); // NaN past the end
    index += high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? 2 : 1;
    count += 1;
  }
  return text.slice(0, index);
}
