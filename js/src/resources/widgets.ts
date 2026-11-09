/** Agents widget tickets, minted on your server for one visitor at a time. */

import type { APIPromise } from '../core/api-promise.js';
import { OPS } from '../core/operations.js';
import type { WidgetTicket } from '../types/models.js';
import type { CreateTicketParams, RequestOptions } from '../types/params.js';
import { APIResource, compact, model } from './resource.js';

export class Widgets extends APIResource {
  /**
   * Mint a ticket that lets one visitor open a private widget. Call it from your
   * server; `publicId` is the widget ID from its settings (it starts with `wdg_`).
   */
  createTicket(publicId: string, params: CreateTicketParams = {}, options?: RequestOptions): APIPromise<WidgetTicket> {
    const body = compact({ user: params.user ? compact({ ...params.user }) : undefined, channel: params.channel, ttlSeconds: params.ttlSeconds });
    return this._request(
      OPS.widgetsCreateTicket,
      { path: { publicId }, json: body, parse: model<WidgetTicket>('WidgetTicket', ['ticket']) },
      options,
    );
  }
}
