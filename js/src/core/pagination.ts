/**
 * Offset pagination for job lists.
 *
 * `await jobs.list()` gives one page. `for await (const job of jobs.list())`
 * walks every page. Lists are newest first, so a job created while you iterate
 * shifts later pages by one; the iterator skips IDs it has already returned.
 * Each page is one request and counts toward the rate limit.
 */

import { UsageError } from '../errors.js';
import { APIPromise } from './api-promise.js';

export interface PageInit<T extends { readonly id?: unknown }> {
  items: T[];
  total: number | null;
  offset: number;
  limit: number | null;
  requestId: string | null;
  fetch: (offset: number) => PagePromise<T>;
}

/** One page of results. `for await (const item of page)` continues through the following pages. */
export class Page<T extends { readonly id?: unknown }> implements AsyncIterable<T> {
  readonly items: T[];
  /** Jobs in the whole list, when the API reports it. */
  readonly total: number | null;
  readonly offset: number;
  readonly limit: number | null;
  readonly requestId: string | null;
  readonly #fetch: (offset: number) => PagePromise<T>;

  constructor(init: PageInit<T>) {
    this.items = init.items;
    this.total = init.total;
    this.offset = init.offset;
    this.limit = init.limit;
    this.requestId = init.requestId;
    this.#fetch = init.fetch;
  }

  hasNextPage(): boolean {
    if (this.items.length === 0) return false;
    if (this.total !== null) return this.offset + this.items.length < this.total;
    return this.limit !== null && this.items.length >= this.limit;
  }

  /** The offset of the next page. */
  get nextOffset(): number {
    return this.offset + this.items.length;
  }

  nextPage(): PagePromise<T> {
    if (!this.hasNextPage()) throw new UsageError('there is no next page; check hasNextPage() first');
    return this.#fetch(this.nextOffset);
  }

  /** This page and every following one. */
  async *iterPages(): AsyncGenerator<Page<T>, void, undefined> {
    let page: Page<T> = this;
    for (;;) {
      yield page;
      if (!page.hasNextPage()) return;
      page = await page.nextPage();
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    const seen = new Set<unknown>();
    for await (const page of this.iterPages()) {
      for (const item of page.items) {
        const id = item.id;
        if (id != null) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        yield item;
      }
    }
  }
}

/** `await` it for the first page, or `for await` over it to walk every page. */
export class PagePromise<T extends { readonly id?: unknown }> extends APIPromise<Page<T>> implements AsyncIterable<T> {
  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    yield* await this;
  }
}
