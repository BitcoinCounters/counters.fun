/**
 * Counterparty Core v2 API client — the pool and fairminter slice.
 *
 * Read-only. Composes are never proxied through this worker: the browser
 * talks to Counterparty directly (via apps/web's relay) so an unsigned
 * transaction never takes a detour through infrastructure that could alter
 * it.
 */

import { parseJsonLossless } from "@counters/core/numeric";
import type { Fairminter } from "@counters/core/fairminter";
import type { Pool } from "@counters/core/pool";

interface Envelope<T> {
  result: T;
  next_cursor?: number | string | null;
  result_count?: number;
}

export interface PoolMatch {
  id?: string;
  tx_hash?: string;
  tx0_hash?: string;
  tx1_hash?: string;
  block_index: number;
  block_time?: number;
  source?: string;
  asset_a?: string;
  asset_b?: string;
  give_asset?: string;
  give_quantity?: string | number;
  get_asset?: string;
  get_quantity?: string | number;
}

export interface PriceHistoryEntry {
  block_index: number;
  block_time?: number;
  reserve_a: string | number;
  reserve_b: string | number;
  price?: number;
}

export class Counterparty {
  constructor(private readonly base: string) {}

  private async get<T>(path: string): Promise<Envelope<T>> {
    const res = await fetch(`${this.base}${path}`, {
      headers: { accept: "application/json" },
      cf: { cacheTtl: 15, cacheEverything: true },
    });
    if (!res.ok) {
      throw new Error(`counterparty ${path} → ${res.status} ${res.statusText}`);
    }
    // Lossless: supplies and caps run past 2^53 (a 100M divisible supply is
    // 10^16 raw), and JSON.parse rounds those during parsing, not after —
    // there is no recovering the digits once it has.
    return parseJsonLossless<Envelope<T>>(await res.text());
  }

  /** Server info, including the height the ledger has reached. */
  async tip(): Promise<{ counterparty_height: number; backend_height: number; version: string }> {
    const body = await this.get<{
      counterparty_height: number;
      backend_height: number;
      version: string;
    }>("/v2/");
    return body.result;
  }

  /** Every AMM pool. Thirty rows on mainnet today — one page. */
  async pools(limit = 1000): Promise<Pool[]> {
    const out: Pool[] = [];
    let cursor: string | number | null | undefined;

    for (let i = 0; i < 20; i += 1) {
      const query = new URLSearchParams({ limit: String(limit), verbose: "true" });
      if (cursor != null) query.set("cursor", String(cursor));
      const body = await this.get<Pool[]>(`/v2/pools?${query}`);
      out.push(...body.result);
      cursor = body.next_cursor;
      if (cursor == null) break;
    }
    return out;
  }

  /** One pair's pool, or null when none exists yet. */
  async pool(asset1: string, asset2: string): Promise<Pool | null> {
    try {
      const body = await this.get<Pool | null>(
        `/v2/pools/${encodeURIComponent(asset1)}/${encodeURIComponent(asset2)}?verbose=true`,
      );
      return body.result ?? null;
    } catch {
      return null;
    }
  }

  /** Reserve snapshots at each state change — the chart and 24h change. */
  async priceHistory(asset: string, limit = 500): Promise<PriceHistoryEntry[]> {
    const body = await this.get<PriceHistoryEntry[]>(
      `/v2/pools/${encodeURIComponent(asset)}/XCP/price_history?limit=${limit}`,
    );
    return body.result ?? [];
  }

  /** Swaps executed against a pool. */
  async poolMatches(asset: string, limit = 200): Promise<PoolMatch[]> {
    const body = await this.get<PoolMatch[]>(
      `/v2/pools/${encodeURIComponent(asset)}/XCP/matches?limit=${limit}&verbose=true`,
    );
    return body.result ?? [];
  }

  /** Fairminters in one status. Core has no filter beyond status. */
  async fairminters(status: "open" | "pending" | "closed"): Promise<Fairminter[]> {
    const body = await this.get<Fairminter[]>(
      `/v2/fairminters?status=${status}&limit=500&verbose=true`,
    );
    return body.result ?? [];
  }

  /** Holders of an asset — used to prove an LP balance sits at the burn address. */
  async assetBalances(asset: string, limit = 100): Promise<
    { address: string | null; utxo: string | null; quantity: string | number }[]
  > {
    const body = await this.get<{ address: string | null; utxo: string | null; quantity: string | number }[]>(
      `/v2/assets/${encodeURIComponent(asset)}/balances?limit=${limit}`,
    );
    return body.result ?? [];
  }
}
