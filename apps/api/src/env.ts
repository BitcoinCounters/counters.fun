export interface Env {
  DB: D1Database;
  /**
   * Cache for on-chain bytes. Content-addressed by sha256, so an object is
   * written once and never invalidated — the bytes are in a Bitcoin block.
   */
  CONTENT: R2Bucket;

  /** Counterparty Core v2 API, e.g. https://api.counterparty.io:4000 */
  COUNTERPARTY_API_BASE: string;
  /** `counters server`, e.g. https://www.bitcoincounters.com */
  COUNTERS_API_BASE: string;
  /**
   * The only origin allowed to frame a counter's content. Defaults to 'self'
   * when unset, which is right for local development and wrong for
   * production — set it in wrangler.toml [vars].
   */
  WEB_ORIGIN: string;

  /** Guards the manual resync route. Secret; absent in dev. */
  ADMIN_TOKEN?: string;
}
