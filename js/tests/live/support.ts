/**
 * Helpers for the live suite: tests that call the real EchoNova API.
 *
 * Nothing runs unless ECHONOVA_LIVE=1. Some tests cost credits, so the
 * full-access key must come from a dedicated test workspace with a Credit Limit
 * set (docs/adr/0011-testing-strategy.md).
 *
 * Never print a key, ticket, room token, signed link or response body. Tests
 * assert on derived values (lengths, flags, numbers), and every failure is
 * rethrown through `scrubbed()`, so a secret in an error message can't reach the log.
 */

import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test, type TestContext } from 'vitest';
import EchoNova, { APIStatusError, InvalidRequestError, JobNotFoundError, type Voice } from '../../src/index.js';

export type EnvName =
  | 'ECHONOVA_API_KEY'
  | 'ECHONOVA_TTS_ONLY_KEY'
  | 'ECHONOVA_DISABLED_KEY'
  | 'ECHONOVA_AGENT_ID'
  | 'ECHONOVA_WIDGET_PUBLIC_ID';

/** An environment variable, or null when it is unset or blank (CI passes missing secrets as ""). */
export function env(name: EnvName | 'ECHONOVA_LIVE'): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

/** The variable's value. Only call it in a test that lists the variable in `needs`. */
export function required(name: EnvName): string {
  const value = env(name);
  if (value === null) throw new Error(`${name} is not set`);
  return value;
}

export const LIVE = env('ECHONOVA_LIVE') === '1';

/** Per test: a hung call fails the run instead of stalling it. */
export const TIMEOUT = 5 * 60_000;

/** A well-formed key that can't exist, made fresh for each run. The API rejects it with 401, for free. */
export function madeUpKey(): string {
  return `ek_${randomBytes(20).toString('hex')}`;
}

/** A client for `apiKey`. `ECHONOVA_BASE_URL` applies when it is set. */
export function clientFor(apiKey: string): EchoNova {
  return new EchoNova({ apiKey });
}

/**
 * A live test. It is skipped, with the reason, unless ECHONOVA_LIVE=1 and every
 * variable in `needs` is set, and its failures are scrubbed of anything secret.
 */
export function liveTest(name: string, needs: readonly EnvName[], body: (ctx: TestContext) => Promise<void>): void {
  test(name, { timeout: TIMEOUT }, async (ctx) => {
    if (!LIVE) ctx.skip('set ECHONOVA_LIVE=1 to call the real API');
    for (const variable of needs) if (env(variable) === null) ctx.skip(`${variable} is not set`);
    try {
      await body(ctx);
    } catch (error) {
      throw scrubbed(error);
    }
  });
}

/** `value`, made by an earlier test in the file; when that test failed or didn't run, this one is skipped. */
export function from<T>(ctx: TestContext, value: T | null, what: string): T {
  if (value === null) return ctx.skip(`needs ${what}, which failed or did not run`);
  return value;
}

/** Run a hook body, scrubbing its failure. */
export async function scrubbing(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    throw scrubbed(error);
  }
}

// --- Keeping secrets out of the log -----------------------------------------------------------

const SECRETS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(ek|whsec|wtk)_[A-Za-z0-9_-]{4,}/g, '$1_[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*){0,2}/g, '[token]'],
  [/((?:https?|wss?):\/\/[^\s"'<>?#]*)[?#][^\s"'<>]*/g, '$1?[redacted]'],
  [/(bearer\s+)\S+/gi, '$1[redacted]'],
];

/** Remove keys, tokens, tickets and signed-link queries from text. */
export function scrub(text: string): string {
  return SECRETS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

/** One line about an error: its class, status, code, request ID and message. No headers or body. */
export function summarize(error: unknown): string {
  if (error instanceof APIStatusError) {
    const parts = [
      error.statusCode !== null ? `status ${error.statusCode}` : null,
      error.closeCode !== null ? `close ${error.closeCode}` : null,
      error.errorCode ? `code ${error.errorCode}` : null,
      `"${error.errorMessage ?? ''}"`,
      `request ${error.requestId ?? '-'}`,
    ];
    return scrub(`${error.name}: ${parts.filter(Boolean).join(', ')}`);
  }
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (cause: ${error.cause.name}: ${error.cause.message})` : '';
    return scrub(`${error.name}: ${error.message}${cause}`);
  }
  return scrub(String(error));
}

/**
 * The error to report for a failure. Vitest's own errors (assertions, which only
 * ever compare non-secret values here, and skips) pass through; anything else is
 * replaced by a plain error holding its scrubbed summary and stack.
 */
export function scrubbed(error: unknown): unknown {
  if (typeof error === 'object' && error !== null) {
    const { code, name } = error as { code?: unknown; name?: unknown };
    if (code === 'VITEST_PENDING' || name === 'AssertionError') return error;
  }
  const failure = new Error(summarize(error));
  const frames = error instanceof Error ? (error.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line)) : [];
  failure.stack = scrub([`Error: ${failure.message}`, ...frames].join('\n'));
  return failure;
}

/** Print a progress line: request IDs and durations only. */
export function note(message: string): void {
  console.log(`[live] ${scrub(message)}`);
}

/** Seconds since `started` (a `performance.now()` value), for `note()`. */
export function since(started: number): string {
  return `${((performance.now() - started) / 1000).toFixed(2)} s`;
}

/** Await `promise`, which must reject with `Class`, and return the error. */
export async function rejection<E extends Error>(
  promise: PromiseLike<unknown>,
  Class: new (...args: never[]) => E,
): Promise<E> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Class) return error;
    throw new Error(`expected ${Class.name}, got ${summarize(error)}`);
  }
  throw new Error(`expected ${Class.name}, but the call succeeded`);
}

// --- Data -------------------------------------------------------------------------------------

/** An English voice, or the first voice when there is none. */
export function pickVoice(voices: readonly Voice[]): Voice | undefined {
  return voices.find((voice) => typeof voice.language === 'string' && voice.language.toLowerCase().startsWith('en')) ?? voices[0];
}

/** The first bytes as ASCII, for checking a file's magic number. */
export function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

export function isWav(bytes: Uint8Array): boolean {
  return bytes.length > 44 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE';
}

// --- Cleanup ----------------------------------------------------------------------------------

export type Service = 'textToSpeech' | 'speechToText' | 'soundCleaning';

/** Jobs a test file created. `run()` deletes the ones the tests didn't delete themselves. */
export class JobCleanup {
  readonly #jobs = new Map<string, Service>();

  track(service: Service, id: string | null | undefined): void {
    if (id) this.#jobs.set(id, service);
  }

  forget(id: string): void {
    this.#jobs.delete(id);
  }

  /** Delete every tracked job. Jobs already gone are fine; anything else fails the file once all were tried. */
  async run(client: EchoNova): Promise<void> {
    const failures: string[] = [];
    for (const [id, service] of [...this.#jobs]) {
      try {
        await deleteJob(client, service, id);
      } catch (error) {
        if (!(error instanceof JobNotFoundError)) failures.push(`${service} job: ${summarize(error)}`);
      }
      this.#jobs.delete(id);
    }
    if (failures.length > 0) throw new Error(`could not delete ${failures.length} job(s): ${failures.join('; ')}`);
  }
}

/** Delete a job. One that hasn't finished yet is waited for (up to 2 minutes) first. */
async function deleteJob(client: EchoNova, service: Service, id: string): Promise<void> {
  try {
    await client[service].jobs.delete(id);
    return;
  } catch (error) {
    if (!(error instanceof InvalidRequestError) || service === 'soundCleaning') throw error;
  }
  const wait = { timeoutMs: 120_000, raiseOnFailure: false };
  if (service === 'textToSpeech') await client.textToSpeech.jobs.wait(id, wait);
  else await client.speechToText.jobs.wait(id, wait);
  await client[service].jobs.delete(id);
}

/**
 * The Text to Speech jobs a stream saved: those of the given syntheses, and every
 * other synthesis on the same stream sessions. Saving can lag the stream a little,
 * so this polls the newest jobs until `expected` are found or `timeoutMs` passes.
 */
export async function findStreamJobs(
  client: EchoNova,
  requestIds: ReadonlySet<string>,
  options: { expected: number; since: number; timeoutMs?: number },
): Promise<string[]> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  for (;;) {
    const recent = [];
    for await (const job of client.textToSpeech.jobs.list({ limit: 50 })) {
      if (Date.parse(job.createdAt) < options.since - 60_000 || recent.length >= 200) break; // newest first
      recent.push(job);
    }
    const sessions = new Set(recent.flatMap((job) => (job.stream && requestIds.has(job.stream.requestId) ? [job.stream.sessionId] : [])));
    const ours = recent.filter((job) => job.stream && (requestIds.has(job.stream.requestId) || sessions.has(job.stream.sessionId)));
    if (ours.length >= options.expected || Date.now() >= deadline) return ours.map((job) => job.id);
    await sleep(3_000);
  }
}
