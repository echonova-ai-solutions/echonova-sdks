/**
 * The promise every API method returns. `await` it for the result, or call
 * `.withResponse()` for the result together with the HTTP response metadata.
 */

import type { APIResponse } from './http.js';
import type { RateLimitInfo } from './ratelimit.js';

/** A result with the response it came from. */
export interface WithResponse<T> {
  data: T;
  /** The HTTP response. The SDK has already read its body. */
  response: Response;
  /** The `X-Request-Id`. Quote it when contacting support. */
  requestId: string | null;
  /** This operation's rate-limit headers, when the response had them. */
  rateLimit: RateLimitInfo | null;
}

/**
 * The request is sent as soon as the method is called, like any promise. Awaiting
 * it and calling `withResponse()` share that one request.
 */
export class APIPromise<T> implements PromiseLike<T> {
  readonly #response: Promise<APIResponse<T>>;
  #data: Promise<T> | undefined;

  constructor(response: Promise<APIResponse<T>>) {
    this.#response = response;
  }

  /** The result plus the HTTP response, its request ID and rate-limit headers. */
  withResponse(): Promise<WithResponse<T>> {
    return this.#response.then(({ data, response, requestId, rateLimit }) => ({ data, response, requestId, rateLimit }));
  }

  #parsed(): Promise<T> {
    this.#data ??= this.#response.then((result) => result.data);
    return this.#data;
  }

  then<A = T, B = never>(
    onfulfilled?: ((value: T) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return this.#parsed().then(onfulfilled, onrejected);
  }

  catch<B = never>(onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<T | B> {
    return this.#parsed().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<T> {
    return this.#parsed().finally(onfinally);
  }

  get [Symbol.toStringTag](): string {
    return 'APIPromise';
  }
}
