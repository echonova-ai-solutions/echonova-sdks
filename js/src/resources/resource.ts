/**
 * Base class for the service namespaces (`textToSpeech`, `speechToText`,
 * `soundCleaning`). They are added once their API is final.
 *
 * A resource builds requests and parses models; it never calls `fetch`
 * itself. Retries, rate limits, timeouts and error mapping all happen in the
 * transport, so every operation behaves the same way.
 */

import type { HttpTransport } from '../core/http.js';

export abstract class APIResource {
  protected readonly _transport: HttpTransport;

  constructor(transport: HttpTransport) {
    this._transport = transport;
  }
}
