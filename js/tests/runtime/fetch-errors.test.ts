// How `fetch` failures from each runtime are classified: a failure before anything was
// sent can be retried for any method; one after sending may have run (ADR 0004).
import { describe, expect, it } from 'vitest';
import { failurePhase } from '../../src/core/http.js';
import * as errors from '../../src/errors.js';
import { caught, JOB_ID, makeClient, ok, type Handler } from '../rest-support.js';

/** Deno's fetch rejects with `TypeError('fetch failed')` and a cause with no `code`, only a message. */
function denoError(detail: string): TypeError {
  return new TypeError('fetch failed', { cause: new Error(detail) });
}

const DENO_REFUSED = denoError(
  'error sending request for url (http://127.0.0.1:40123/v1/text-to-speech): client error (Connect): tcp connect error: Connection refused (os error 111)',
);
const DENO_DNS = denoError(
  'error sending request for url (https://api.example.invalid/v1/text-to-speech): client error (Connect): dns error: failed to lookup address information: Name or service not known',
);
const DENO_TLS = denoError(
  'error sending request for url (https://127.0.0.1:40123/): client error (Connect): received corrupt message of type InvalidContentType',
);
const DENO_AFTER_SEND = denoError(
  'error sending request from 127.0.0.1:41138 for http://127.0.0.1:40123/ (127.0.0.1:40123): client error (SendRequest): connection closed before message completed',
);
const DENO_RESET = denoError('Connection reset by peer (os error 104)');

/** Bun puts the code on the error itself. */
const BUN_REFUSED = Object.assign(new TypeError('ECONNREFUSED: Unable to connect. Is the computer able to access the url?'), {
  code: 'ECONNREFUSED',
});

function sequence(...replies: Array<Response | Error>): Handler {
  return () => replies.shift() ?? ok({ jobId: JOB_ID, status: 'pending' });
}

describe('failurePhase across runtimes', () => {
  it.each([
    ['Deno: connection refused', DENO_REFUSED, 'connect'],
    ['Deno: DNS failure', DENO_DNS, 'connect'],
    ['Deno: TLS failure', DENO_TLS, 'connect'],
    ['Deno: failed after sending', DENO_AFTER_SEND, 'no_response'],
    ['Deno: connection reset', DENO_RESET, 'no_response'],
    ['Bun: connection refused', BUN_REFUSED, 'connect'],
  ] as const)('%s -> %s', (_name, error, phase) => {
    expect(failurePhase(error)).toBe(phase);
  });

  it('only the exact Deno marker counts: a message that merely mentions connecting does not', () => {
    expect(failurePhase(denoError('client error (SendRequest): could not Connect'))).toBe('no_response');
    expect(failurePhase(new TypeError('Failed to connect'))).toBe('no_response');
  });
});

describe('a POST on Deno', () => {
  it('is retried after a refused connection, which certainly did not run', async () => {
    const { client, requests } = makeClient(sequence(DENO_REFUSED, DENO_DNS));
    const job = await client.textToSpeech.jobs.create({ text: 'hi', voiceId: 'v' });
    expect(job.jobId).toBe(JOB_ID);
    expect(requests).toHaveLength(3);
  });

  it('is not sent again after a failure once the request was sent', async () => {
    const { client, requests } = makeClient(sequence(DENO_AFTER_SEND));
    const error = (await caught(client.textToSpeech.jobs.create({ text: 'hi', voiceId: 'v' }))) as errors.APIConnectionError;
    expect(error).toBeInstanceOf(errors.APIConnectionError);
    expect(error.mayHaveExecuted).toBe(true);
    expect(requests).toHaveLength(1);
  });
});
