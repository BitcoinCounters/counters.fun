/**
 * Client for the `counters server` JSON API (the one behind
 * bitcoincounters.com). Reference implementation:
 * `/home/node/counters/counters/counters/server/app.py`.
 *
 * Surface: /status, /counters, /counter/<number|asset>, /block/<h>,
 * /content/<n>, /preview/<n>, /stamp/<n>.
 */

import type { Counter } from "@counters/core/counter";

export interface CountersStatus {
  /** Height the counters indexer has reached. */
  indexed: number;
  /** Total counters numbered so far. */
  count: number;
  genesis: number;
  version: string;
  commit: string;
  updated: string | null;
}

export class CountersServer {
  constructor(private readonly base: string) {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      headers: { accept: "application/json" },
      // Upstream sets immutable caching on /content; the JSON routes are
      // uncached, so let Cloudflare hold them briefly between sync ticks.
      cf: { cacheTtl: 15, cacheEverything: true },
    });
    if (!res.ok) {
      throw new Error(`counters server ${path} → ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  status(): Promise<CountersStatus> {
    return this.get<CountersStatus>("/status");
  }

  /**
   * One page of counters, newest first.
   *
   * Pagination is `before=<number>`, *not* `offset`. An `offset` parameter is
   * accepted and silently ignored, so an offset loop re-reads page one
   * forever — the first thing to check if a sync never terminates.
   */
  async page(limit = 100, before?: number): Promise<Counter[]> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (before !== undefined) query.set("before", String(before));
    const body = await this.get<{ counters: Counter[] }>(`/counters?${query}`);
    return body.counters ?? [];
  }

  /** Walk the whole index newest → oldest. Bounded by `max` pages. */
  async *walk(limit = 100, max = 200): AsyncGenerator<Counter[]> {
    let before: number | undefined;
    for (let i = 0; i < max; i += 1) {
      const batch = await this.page(limit, before);
      if (batch.length === 0) return;
      yield batch;
      const last = batch[batch.length - 1]!;
      if (last.number <= 0) return;
      before = last.number;
    }
  }

  /** One counter by number or asset name. Null when unknown. */
  async counter(id: string | number): Promise<Counter | null> {
    try {
      return await this.get<Counter>(`/counter/${encodeURIComponent(String(id))}`);
    } catch {
      return null;
    }
  }

  /** The raw on-chain bytes, passed through unread. */
  content(n: number, request?: Request): Promise<Response> {
    return this.passthrough(`/content/${n}`, request);
  }

  /** The sandboxed render the reference explorer uses on its cards. */
  preview(n: number, request?: Request): Promise<Response> {
    return this.passthrough(`/preview/${n}`, request);
  }

  private passthrough(path: string, request?: Request): Promise<Response> {
    const headers = new Headers();
    // Forward Range so a client can seek inside a multi-megabyte inscription
    // (a PDF page, a point in an audio file) instead of pulling all of it.
    const range = request?.headers.get("range");
    if (range) headers.set("range", range);
    return fetch(`${this.base}${path}`, { headers });
  }
}
