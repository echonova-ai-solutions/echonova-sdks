import { readFileSync } from 'node:fs';

/** The shared contract at the repository root. */
export const SPEC_DIR = new URL('../../spec/', import.meta.url);

export function loadSpec<T = any>(relative: string): T {
  return JSON.parse(readFileSync(new URL(relative, SPEC_DIR), 'utf8')) as T;
}

/** An EchoNova error envelope as bytes. */
export function envelope(status: number, message: string | null, extra: Record<string, unknown> = {}): Uint8Array {
  const body = { data: null, statusCode: status, success: false, errorMessage: message, ...extra };
  return new TextEncoder().encode(JSON.stringify(body));
}

/** A success envelope as a JSON string. */
export function success(data: unknown): string {
  return JSON.stringify({ data, success: true, statusCode: 200, errorMessage: null });
}

/** A test key: looks real in length, but marked so the publishing checks never flag it. */
export const TEST_KEY = 'ek_REDACTED_0000000000000000000000000000000000000000000000000000c21d';
