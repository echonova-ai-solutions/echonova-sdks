/**
 * Download a signed link (`audioUrl`, `outputUrl`) without credentials.
 *
 * Links point at third-party storage, so the request carries no API key, no
 * `auth` hook headers and no default headers. Logs and errors show the link
 * without its query string, which holds the signature.
 */

import { APIConnectionError, APITimeoutError, DownloadExpiredError, UsageError } from '../errors.js';
import { buildStatusError, classifyResponse } from './classifier.js';
import { abortable, attemptSignal, failurePhase, phaseMessage, type FetchLike } from './http.js';
import type { Logger } from './logger.js';
import type { RetryPolicy } from './retry.js';
import type { Runtime } from './runtime.js';
import { nodeFs, nodePath, type FileHandleLike } from '../runtime/node.js';

export interface DownloadOptions {
  /**
   * Save to this file path (or into this directory, keeping the link's file
   * name) and resolve to the path written. Node.js, Bun and Deno only. Without
   * it, the download resolves to the bytes.
   */
  to?: string | undefined;
  signal?: AbortSignal | undefined;
  /** Give up on an attempt when no data arrives for this many milliseconds. Default 60000. */
  timeout?: number | undefined;
}

export interface DownloadContext {
  fetch: FetchLike;
  userAgent: string | null;
  policy: RetryPolicy;
  runtime: Runtime;
  logger: Logger;
  closeSignal?: AbortSignal | undefined;
}

const CONNECT_MS = 10_000;
const IDLE_MS = 60_000;

/** The link without its query string or fragment, which carry the signature. */
export function redactURL(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '<invalid url>';
  }
}

/** Where the bytes go: memory, or a temporary file renamed into place on success. */
interface Sink {
  write(chunk: Uint8Array): Promise<void>;
  reset(): Promise<void>;
  finish(): Promise<Uint8Array | string>;
  discard(): Promise<void>;
}

function memorySink(): Sink {
  let chunks: Uint8Array[] = [];
  return {
    write: async (chunk) => void chunks.push(chunk),
    reset: async () => void (chunks = []),
    finish: async () => {
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
      }
      return out;
    },
    discard: async () => void (chunks = []),
  };
}

async function fileSink(to: string, url: string): Promise<Sink> {
  const why = 'saving a download to a file';
  const fs = await nodeFs(why);
  const path = await nodePath(why);
  let target = to;
  const stats = await fs.promises.stat(to).catch(() => null);
  if (stats?.isDirectory()) {
    let name = '';
    try {
      name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    } catch {
      // keep the default name
    }
    target = path.join(to, name || 'download');
  }
  const random = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${random}.part`);
  const handle: FileHandleLike = await fs.promises.open(temp, 'w');
  let open = true;
  const close = async (): Promise<void> => {
    if (open) {
      open = false;
      await handle.close();
    }
  };
  return {
    write: async (chunk) => void (await handle.write(chunk)),
    reset: () => handle.truncate(0),
    finish: async () => {
      await close();
      await fs.promises.rename(temp, target);
      return target;
    },
    discard: async () => {
      await close().catch(() => undefined);
      await fs.promises.unlink(temp).catch(() => undefined);
    },
  };
}

export async function download(ctx: DownloadContext, url: string | null | undefined, options: DownloadOptions = {}): Promise<Uint8Array | string> {
  if (!url || typeof url !== 'string') throw new UsageError('no download URL: the job has no output yet');
  const shown = redactURL(url);
  if (!/^https?:\/\//i.test(url) || shown === '<invalid url>') throw new UsageError(`not an http(s) URL: ${shown}`);
  if (ctx.closeSignal?.aborted) throw new UsageError('the client is closed; the download was not started');
  const { policy, runtime, logger, signal } = { ...ctx, signal: options.signal };
  const idle = options.timeout ?? IDLE_MS;
  const what = `download ${shown}`;
  const sink = options.to === undefined ? memorySink() : await fileSink(options.to, url);
  const headers: Record<string, string> = { Accept: '*/*' };
  if (ctx.userAgent) headers['User-Agent'] = ctx.userAgent;

  let retriesDone = 0;
  const retry = async (delay: number, reason: string): Promise<void> => {
    logger.info(`retrying ${what} in ${delay.toFixed(2)} s (attempt ${retriesDone + 1} failed: ${reason})`);
    await runtime.sleep(delay * 1000, signal);
    retriesDone += 1;
  };
  try {
    for (;;) {
      signal?.throwIfAborted();
      await sink.reset();
      const attempt = attemptSignal([signal, ctx.closeSignal], CONNECT_MS + idle);
      const started = runtime.clock();
      let status: number;
      let response: Response;
      try {
        response = await abortable(ctx.fetch(url, { method: 'GET', headers, redirect: 'follow', signal: attempt.signal }), attempt.signal);
        status = response.status;
        if (status >= 200 && status < 300 && response.body) {
          const reader = response.body.getReader();
          const stop = (): void => void reader.cancel(attempt.signal.reason).catch(() => undefined);
          attempt.signal.addEventListener('abort', stop, { once: true });
          try {
            for (;;) {
              attempt.reset(idle);
              const { value, done } = await abortable(reader.read(), attempt.signal);
              if (done) break;
              await sink.write(value);
            }
          } finally {
            attempt.signal.removeEventListener('abort', stop);
          }
        } else {
          await response.body?.cancel().catch(() => undefined);
        }
      } catch (error) {
        attempt.done();
        if (signal?.aborted) throw signal.reason ?? error;
        if (ctx.closeSignal?.aborted) throw new APIConnectionError(`${what} was cancelled because the client was closed`, { cause: error });
        const timedOut = attempt.timedOut();
        const phase = timedOut ? 'no_response' : failurePhase(error);
        const name = (error as { name?: string } | null)?.name ?? 'Error';
        logger.debug(`GET ${shown} failed: ${timedOut ? 'timeout' : name} (attempt ${retriesDone + 1})`);
        const decision = policy.decideTransport('GET', phase, { retriesDone });
        if (decision.retry) {
          await retry(decision.delay, name);
          continue;
        }
        // Only the error's name: a fetch error message may repeat the signed link.
        const message = `${phaseMessage(phase, shown)}: ${timedOut ? `no data for ${idle} ms` : name}`;
        throw timedOut
          ? new APITimeoutError(message, { kind: 'read', mayHaveExecuted: false, cause: error })
          : new APIConnectionError(message, { mayHaveExecuted: false, cause: error });
      }
      attempt.done();
      const elapsed = Math.round((runtime.clock() - started) * 1000);
      logger.debug(`GET ${shown} -> ${status} attempt=${retriesDone + 1} elapsed=${elapsed}ms`);
      if (status >= 200 && status < 300) return await sink.finish();
      if (status === 403) {
        throw new DownloadExpiredError(
          `the download link was refused (HTTP 403); it has probably expired. Get the job again for a fresh link: ${shown}`,
          { url: shown },
        );
      }
      // The storage body is not kept: it can echo details of the signed link.
      const { rule, retryAfter } = classifyResponse(status, response.headers, '', { rules: policy.rules });
      const decision = policy.decideStatus('GET', rule, { retriesDone, retryAfter });
      if (decision.retry) {
        await retry(decision.delay, `HTTP ${status}`);
        continue;
      }
      throw buildStatusError(status, response.headers, '', {
        method: 'GET',
        reasonPhrase: `${what} failed: ${response.statusText || `HTTP ${status}`}`,
        rules: policy.rules,
      });
    }
  } catch (error) {
    await sink.discard();
    throw error;
  }
}
