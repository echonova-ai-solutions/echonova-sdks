// Pagination, jobs.wait() on a fake clock, and jobs.findCandidates().
import { describe, expect, it } from 'vitest';
import { Page, PagePromise } from '../src/core/pagination.js';
import { PollLimiter } from '../src/core/polling.js';
import * as errors from '../src/errors.js';
import { caught, fail, FakeTime, JOB_ID, makeClient, ok, reset, type Captured } from './rest-support.js';

// --- Pagination ---------------------------------------------------------------------------------

/** Serves `ids` as jobs, `pageSize` per page; `drift` inserts a new job before page 2 is read. */
function jobsServer(ids: string[], options: { drift?: string; total?: boolean } = {}) {
  let list = [...ids];
  let pagesServed = 0;
  return (request: Captured): Response => {
    const offset = Number(request.url.searchParams.get('offset') ?? 0);
    const limit = Number(request.url.searchParams.get('limit') ?? 20);
    if (options.drift && pagesServed === 1) list = [options.drift, ...list];
    pagesServed += 1;
    const items = list.slice(offset, offset + limit).map((id) => ({ id, status: 'completed' }));
    return ok(options.total === false ? { items } : { items, total: list.length });
  };
}

describe('pagination', () => {
  it('a page has items, total, hasNextPage() and nextPage()', async () => {
    const { client, requests } = makeClient(jobsServer(['a', 'b', 'c', 'd', 'e']));
    const listing = client.textToSpeech.jobs.list({ limit: 2 });
    expect(listing).toBeInstanceOf(PagePromise);
    const page = await listing;
    expect(page).toBeInstanceOf(Page);
    expect(page.items.map((j) => j.id)).toEqual(['a', 'b']);
    expect(page.total).toBe(5);
    expect(page.offset).toBe(0);
    expect(page.hasNextPage()).toBe(true);
    const next = await page.nextPage();
    expect(next.items.map((j) => j.id)).toEqual(['c', 'd']);
    expect(next.offset).toBe(2);
    const last = await next.nextPage();
    expect(last.hasNextPage()).toBe(false);
    expect(() => last.nextPage()).toThrow(errors.UsageError);
    expect(requests.map((r) => r.url.search)).toEqual(['?limit=2', '?offset=2&limit=2', '?offset=4&limit=2']);
  });

  it('for await walks every page and skips jobs it already returned (offset drift)', async () => {
    const { client, requests } = makeClient(jobsServer(['a', 'b', 'c', 'd', 'e'], { drift: 'new' }));
    const seen: string[] = [];
    for await (const job of client.speechToText.jobs.list({ limit: 2 })) seen.push(job.id);
    // 'new' shifted page 2 by one, so 'b' came back again and was skipped.
    expect(seen).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(requests).toHaveLength(3);
  });

  it('iterating a page continues from that page', async () => {
    const { client } = makeClient(jobsServer(['a', 'b', 'c']));
    const first = await client.soundCleaning.jobs.list({ limit: 2 });
    const all: string[] = [];
    for await (const job of first) all.push(job.id);
    expect(all).toEqual(['a', 'b', 'c']);
    const pages: number[] = [];
    for await (const page of first.iterPages()) pages.push(page.items.length);
    expect(pages).toEqual([2, 1]);
  });

  it('an empty list has no next page', async () => {
    const { client, requests } = makeClient(jobsServer([]));
    const items = [];
    for await (const job of client.textToSpeech.jobs.list()) items.push(job);
    expect(items).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it('without a total, a full page means there may be more', async () => {
    const { client } = makeClient(jobsServer(['a', 'b', 'c', 'd'], { total: false }));
    const page = await client.textToSpeech.jobs.list({ limit: 2 });
    expect(page.total).toBeNull();
    expect(page.hasNextPage()).toBe(true);
    const ids: string[] = [];
    for await (const job of page) ids.push(job.id);
    expect(ids).toEqual(['a', 'b', 'c', 'd']);
  });

  it('later pages keep the per-call options', async () => {
    const { client, requests } = makeClient(jobsServer(['a', 'b', 'c']));
    for await (const _ of client.textToSpeech.jobs.list({ limit: 1 }, { headers: { 'X-Trace': 't1' } })) void _;
    expect(requests.map((r) => r.headers.get('x-trace'))).toEqual(['t1', 't1', 't1']);
  });
});

// --- wait() -------------------------------------------------------------------------------------

/** GET answers walk through `values`; the last one repeats. */
function statuses(...values: Array<string | Response | Error>) {
  const pending = [...values];
  return (request: Captured): Response | Error => {
    const next = pending.length > 1 ? pending.shift()! : pending[0]!;
    if (next instanceof Response) return next.clone(); // a body can be read only once
    if (typeof next !== 'string') return next;
    const id = request.url.pathname.split('/').pop();
    return ok({ id, status: next, text: 'hi', voiceId: 'v', ...(next === 'failed' ? { error: 'voice unavailable' } : {}) });
  };
}

describe('jobs.wait()', () => {
  it('polls every 3 s for Text to Speech', async () => {
    const { client, requests, time } = makeClient(statuses('processing', 'processing', 'completed'));
    const job = await client.textToSpeech.jobs.wait(JOB_ID);
    expect(job.status).toBe('completed');
    expect(requests).toHaveLength(3);
    expect(time.sleeps).toEqual([3000, 3000]); // ±10% jitter; random 0.5 gives the exact interval
  });

  it('polls every 5 s for Speech to Text and accepts a job object', async () => {
    const { client, time } = makeClient(statuses('pending', 'completed'));
    const job = await client.speechToText.jobs.wait({ jobId: JOB_ID, status: 'processing' } as { jobId: string });
    expect(job.id).toBe(JOB_ID);
    expect(time.sleeps).toEqual([5000]);
  });

  it.each([
    [0, 2700],
    [0.9999999, 3300],
  ])('jitter stays within ±10%% (random %d)', async (random, expected) => {
    const time = new FakeTime();
    time.random = random;
    const { client } = makeClient(statuses('processing', 'completed'), { time });
    await client.textToSpeech.jobs.wait(JOB_ID);
    expect(time.sleeps[0]).toBeCloseTo(expected, 0);
  });

  it('takes a custom interval of at least 1 s', async () => {
    const { client, time } = makeClient(statuses('processing', 'completed'));
    await client.textToSpeech.jobs.wait(JOB_ID, { pollInterval: 10_000 });
    expect(time.sleeps).toEqual([10_000]);
    await expect(client.textToSpeech.jobs.wait(JOB_ID, { pollInterval: 500 })).rejects.toThrow(errors.UsageError);
    await expect(client.textToSpeech.jobs.wait('')).rejects.toThrow(errors.UsageError);
  });

  it('treats unknown statuses as not finished', async () => {
    const { client, requests } = makeClient(statuses('queued', 'transcoding', 'completed'));
    expect((await client.textToSpeech.jobs.wait(JOB_ID)).status).toBe('completed');
    expect(requests).toHaveLength(3);
  });

  it('throws JobFailedError for a failed job, or returns it', async () => {
    const { client } = makeClient(statuses('processing', 'failed'));
    const error = (await caught(client.textToSpeech.jobs.wait(JOB_ID))) as errors.JobFailedError;
    expect(error).toBeInstanceOf(errors.JobFailedError);
    expect(error.message).toContain('voice unavailable');
    expect((error.job as { status: string }).status).toBe('failed');
    const returned = await makeClient(statuses('failed')).client.textToSpeech.jobs.wait(JOB_ID, { raiseOnFailure: false });
    expect(returned.status).toBe('failed');
  });

  it('gives up after timeoutMs with the last job; waiting again is safe', async () => {
    const { client, time } = makeClient(statuses('processing'));
    const error = (await caught(client.textToSpeech.jobs.wait(JOB_ID, { timeoutMs: 10_000 }))) as errors.JobWaitTimeoutError;
    expect(error).toBeInstanceOf(errors.JobWaitTimeoutError);
    expect(error.jobId).toBe(JOB_ID);
    expect((error.lastJob as { status: string }).status).toBe('processing');
    expect(error.message).toContain('still processing after 10 s');
    expect(time.monotonic - 1000).toBeLessThanOrEqual(10);
  });

  it('waits 20 minutes by default', async () => {
    const { client, time } = makeClient(statuses('processing'));
    await caught(client.speechToText.jobs.wait(JOB_ID));
    expect(time.monotonic - 1000).toBeGreaterThan(1195);
    expect(time.monotonic - 1000).toBeLessThanOrEqual(1200);
  });

  it('keeps polling through transient errors', async () => {
    const { client, requests } = makeClient(
      statuses(reset(), reset(), reset(), fail(502, 'Bad Gateway'), fail(502, 'Bad Gateway'), fail(502, 'Bad Gateway'), 'completed'),
    );
    expect((await client.textToSpeech.jobs.wait(JOB_ID)).status).toBe('completed');
    expect(requests).toHaveLength(7);
  });

  it('sleeps out a throttle and continues', async () => {
    const throttled = () => fail(429, 'ThrottlerException: Too Many Requests', { 'Retry-After': '30' });
    const { client, time } = makeClient(statuses(throttled(), throttled(), throttled(), 'completed'));
    expect((await client.textToSpeech.jobs.wait(JOB_ID)).status).toBe('completed');
    expect(Math.max(...time.sleeps)).toBeGreaterThanOrEqual(30_000);
  });

  it.each([
    [fail(401, 'Invalid API key'), errors.AuthenticationError],
    [fail(403, 'No active subscription'), errors.PermissionDeniedError],
    [fail(404, 'TTS Job not found'), errors.JobNotFoundError],
  ])('throws %s at once', async (reply, ErrorClass) => {
    const { client, requests } = makeClient(statuses(reply));
    expect(await caught(client.textToSpeech.jobs.wait(JOB_ID))).toBeInstanceOf(ErrorClass);
    expect(requests).toHaveLength(1);
  });

  it('keeps the last transient error as the cause of a timeout', async () => {
    const { client } = makeClient(statuses(fail(500, 'Something went wrong')));
    const error = (await caught(client.textToSpeech.jobs.wait(JOB_ID, { timeoutMs: 5000 }))) as errors.JobWaitTimeoutError;
    expect(error.cause).toBeInstanceOf(errors.ServerError);
  });

  it('can be cancelled with a signal', async () => {
    const controller = new AbortController();
    const { client } = makeClient((request) => {
      controller.abort(new Error('stop waiting'));
      return statuses('processing')(request);
    });
    expect(await caught(client.textToSpeech.jobs.wait(JOB_ID, { signal: controller.signal }))).toMatchObject({ message: 'stop waiting' });
  });

  it('the limiter allows 80 polls a minute per job-get endpoint', () => {
    const time = new FakeTime();
    const limiter = new PollLimiter({ clock: () => time.monotonic });
    const delays = Array.from({ length: 81 }, () => limiter.reserve('textToSpeech.jobs.get'));
    expect(delays.slice(0, 80)).toEqual(Array(80).fill(0));
    expect(delays[80]).toBeCloseTo(60);
    expect(limiter.reserve('speechToText.jobs.get')).toBe(0); // each endpoint has its own budget
    time.monotonic += 61;
    expect(limiter.reserve('textToSpeech.jobs.get')).toBeCloseTo(0);
  });

  it('many concurrent waiters on one client share the budget', async () => {
    const time = new FakeTime();
    const sent: number[] = [];
    const { client } = makeClient(
      (request) => {
        sent.push(time.monotonic);
        return ok({ id: request.url.pathname.split('/').pop(), status: 'processing' });
      },
      { time },
    );
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) => client.textToSpeech.jobs.wait(`job${i}`, { timeoutMs: 60_000 })),
    );
    expect(results.every((r) => r.status === 'rejected' && r.reason instanceof errors.JobWaitTimeoutError)).toBe(true);
    sent.sort((a, b) => a - b);
    for (let i = 0; i < sent.length; i += 1) {
      const window = sent.slice(i).filter((t) => t < sent[i]! + 60);
      expect(window.length).toBeLessThanOrEqual(80);
    }
  });

  it('withOptions() copies for the same key share the budget', async () => {
    const { client } = makeClient(statuses('processing'));
    const copy = client.withOptions({ maxRetries: 5 });
    expect(copy._rateLimitTracker).toBe(client._rateLimitTracker);
    const other = client.withOptions({ apiKey: 'ek_REDACTED_other_key_0000000000000000' });
    expect(other._rateLimitTracker).not.toBe(client._rateLimitTracker);
  });
});

// --- findCandidates() ---------------------------------------------------------------------------

const SENT_AT = new Date('2026-11-09T12:00:00.000Z');

/** Jobs as [id, seconds relative to SENT_AT, text, stream?], served newest first, 2 per page. */
function listing(created: Array<[string, number, string, boolean?]>) {
  const jobs = [...created]
    .sort((a, b) => b[1] - a[1])
    .map(([id, s, text, fromStream]) => ({
      id,
      status: 'completed',
      text,
      createdAt: new Date(SENT_AT.getTime() + s * 1000).toISOString(),
      ...(fromStream ? { stream: { sessionId: 'sess', requestId: 'r1' } } : {}),
    }));
  return (request: Captured): Response => {
    const offset = Number(request.url.searchParams.get('offset') ?? 0);
    expect(request.url.searchParams.get('limit')).toBe('100');
    return ok({ items: jobs.slice(offset, offset + 2), total: jobs.length });
  };
}

const JOBS: Array<[string, number, string, boolean?]> = [
  ['a', 30, 'hello'],
  ['b', 2, 'other'],
  ['s', 1, 'hello', true],
  ['c', -1, 'hello '],
  ['d', -4.5, 'hello'],
  ['e', -6, 'hello'],
];

describe('jobs.findCandidates()', () => {
  it('returns jobs from sentAt minus 5 s, newest first, skipping jobs made on a stream', async () => {
    const { client, requests } = makeClient(listing(JOBS));
    const found = await client.textToSpeech.jobs.findCandidates(SENT_AT);
    expect(found.map((j) => j.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(requests).toHaveLength(3); // stops at the first page that reaches older jobs
  });

  it('filters by text', async () => {
    const found = await makeClient(listing(JOBS)).client.textToSpeech.jobs.findCandidates(SENT_AT, { text: 'hello' });
    expect(found.map((j) => j.id)).toEqual(['a', 'c', 'd']);
  });

  it('works for Speech to Text and accepts ISO strings and epoch milliseconds', async () => {
    expect((await makeClient(listing(JOBS)).client.speechToText.jobs.findCandidates(SENT_AT.toISOString())).map((j) => j.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    expect((await makeClient(listing(JOBS)).client.speechToText.jobs.findCandidates(SENT_AT.getTime())).length).toBe(4);
    await expect(makeClient(listing(JOBS)).client.speechToText.jobs.findCandidates('yesterday')).rejects.toThrow(errors.UsageError);
  });

  it('scans at most 10 pages of 100', async () => {
    const { client, requests } = makeClient((request) => {
      const offset = Number(request.url.searchParams.get('offset') ?? 0);
      const items = Array.from({ length: 100 }, (_, i) => ({ id: `j${offset + i}`, status: 'completed', createdAt: SENT_AT.toISOString() }));
      return ok({ items, total: 5000 });
    });
    expect(await client.textToSpeech.jobs.findCandidates(SENT_AT)).toHaveLength(1000);
    expect(requests).toHaveLength(10);
  });

  it('finds the job a lost POST created', async () => {
    const { client, time } = makeClient((request) => (request.method === 'POST' ? reset() : listing([['x', 1, 'hi']])(request)));
    const error = (await caught(client.textToSpeech.generate({ text: 'hi', voiceId: 'v' }))) as errors.APIConnectionError;
    expect(error.mayHaveExecuted).toBe(true);
    expect(error.sentAt).toEqual(time.start);
    const found = await client.textToSpeech.jobs.findCandidates(error.sentAt!, { text: 'hi' });
    expect(found.map((j) => j.id)).toEqual(['x']);
  });
});
