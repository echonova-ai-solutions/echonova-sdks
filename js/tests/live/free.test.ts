// Live, free, with keys: voices, job lists and paging, not-found and validation errors,
// keys without access, and widget tickets. Nothing here is charged.
import { afterAll, describe, expect } from 'vitest';
import type EchoNova from '../../src/index.js';
import {
  AuthenticationError,
  InvalidRequestError,
  JobNotFoundError,
  NotFoundError,
  PermissionDeniedError,
  type Voice,
} from '../../src/index.js';
import { clientFor, from, liveTest, note, pickVoice, rejection, required, scrubbing, since, type Service } from './support.js';

const clients = new Map<string, EchoNova>();
const clientWith = (variable: 'ECHONOVA_API_KEY' | 'ECHONOVA_TTS_ONLY_KEY' | 'ECHONOVA_DISABLED_KEY'): EchoNova => {
  let client = clients.get(variable);
  if (!client) clients.set(variable, (client = clientFor(required(variable))));
  return client;
};
const api = (): EchoNova => clientWith('ECHONOVA_API_KEY');

let voice: Voice | null = null;
const SERVICES: readonly Service[] = ['textToSpeech', 'speechToText', 'soundCleaning'];
const MISSING_JOB = '0'.repeat(24);

afterAll(() =>
  scrubbing(async () => {
    for (const client of clients.values()) await client.close();
  }),
);

describe('with the test key (free)', () => {
  liveTest('(3) voices.list returns voices; an English one is picked', ['ECHONOVA_API_KEY'], async () => {
    const started = performance.now();
    const voices = await api().textToSpeech.voices.list();
    note(`voices.list: ${voices.items.length} voices in ${since(started)}, request ${voices.requestId}`);
    expect(voices.items.length).toBeGreaterThanOrEqual(1);
    expect(voices.requestId).toBeTruthy();
    expect([...voices].length).toBe(voices.items.length); // iterable
    for (const item of voices.items) {
      expect(typeof item.id).toBe('string');
      expect(typeof item.language).toBe('string');
    }
    voice = pickVoice(voices.items) ?? null;
    expect(voice).not.toBeNull();
  });

  for (const service of SERVICES) {
    liveTest(`(4) ${service}.jobs.list gives a page, and paging stops when asked`, ['ECHONOVA_API_KEY'], async () => {
      const jobs = api()[service].jobs;
      const started = performance.now();
      const page = await jobs.list({ limit: 1 });
      note(`${service}.jobs.list: total ${page.total} in ${since(started)}, request ${page.requestId}`);
      expect(typeof page.total).toBe('number');
      const total = page.total ?? -1;
      expect(total).toBeGreaterThanOrEqual(0);
      expect(page.items.length).toBeLessThanOrEqual(1);
      expect(page.items.length).toBeLessThanOrEqual(total);
      expect(page.offset).toBe(0);
      expect(page.hasNextPage()).toBe(total > 1);

      let seen = 0;
      for await (const job of jobs.list({ limit: 1 })) {
        expect(typeof job.id).toBe('string');
        expect(typeof job.status).toBe('string');
        if (++seen === 2) break;
      }
      expect(seen).toBeLessThanOrEqual(2);
      if (total >= 3) expect(seen).toBe(2); // the second item came from a second page
    });
  }

  for (const service of SERVICES) {
    liveTest(`(5) ${service}.jobs.get of a job that doesn't exist throws JobNotFoundError`, ['ECHONOVA_API_KEY'], async () => {
      const error = await rejection(api()[service].jobs.get(MISSING_JOB), JobNotFoundError);
      note(`${service}.jobs.get of a missing job: ${error.statusCode}, request ${error.requestId}`);
      expect(error instanceof NotFoundError).toBe(true);
      expect(error.statusCode).toBe(404);
      expect(error.requestId).toBeTruthy();
    });
  }

  liveTest('(6) textToSpeech.generate with 501 characters throws InvalidRequestError', ['ECHONOVA_API_KEY'], async (ctx) => {
    const { id: voiceId } = from(ctx, voice, 'the voice from test (3)');
    const error = await rejection(api().textToSpeech.generate({ text: 'a'.repeat(501), voiceId }), InvalidRequestError);
    note(`generate with 501 characters: ${error.statusCode}, request ${error.requestId}`);
    expect(error.statusCode).toBe(400);
    expect(error.errorMessage).toBeTruthy();
    expect(error.requestId).toBeTruthy();
    expect(error.mayHaveExecuted).toBe(false);
  });
});

describe('keys without access (free)', () => {
  liveTest('(7) a Text to Speech-only key listing Speech to Text jobs throws PermissionDeniedError', ['ECHONOVA_TTS_ONLY_KEY'], async () => {
    const error = await rejection(clientWith('ECHONOVA_TTS_ONLY_KEY').speechToText.jobs.list({ limit: 1 }), PermissionDeniedError);
    note(`Speech to Text with a Text to Speech-only key: ${error.statusCode}, request ${error.requestId}`);
    expect(error.statusCode).toBe(403);
    expect(error.requestId).toBeTruthy();
  });

  liveTest('(7) a disabled key throws AuthenticationError', ['ECHONOVA_DISABLED_KEY'], async () => {
    const error = await rejection(clientWith('ECHONOVA_DISABLED_KEY').textToSpeech.voices.list(), AuthenticationError);
    note(`a disabled key: ${error.statusCode}, request ${error.requestId}`);
    expect(error.statusCode).toBe(401);
    expect(error.requestId).toBeTruthy();
  });
});

describe('widgets (free)', () => {
  liveTest('(8) widgets.createTicket mints a ticket for a private widget', ['ECHONOVA_API_KEY', 'ECHONOVA_WIDGET_PUBLIC_ID'], async () => {
    const before = Date.now();
    const result = await api().widgets.createTicket(required('ECHONOVA_WIDGET_PUBLIC_ID'), {
      user: { id: 'sdk-live-test', name: 'SDK live test' },
      ttlSeconds: 60,
    });
    note(`widgets.createTicket: request ${result.requestId}`); // never the ticket itself
    expect(typeof result.ticket).toBe('string');
    expect(result.ticket.length).toBeGreaterThan(0);
    const expiresAt = Date.parse(result.expiresAt);
    expect(Number.isNaN(expiresAt)).toBe(false);
    // 60 s from now, give or take clock skew.
    expect(expiresAt).toBeGreaterThan(before);
    expect(expiresAt).toBeLessThan(before + 16 * 60_000);
  });
});
