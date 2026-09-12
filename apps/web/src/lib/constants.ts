/**
 * The three places counters.fun gets data from, and nothing else.
 *
 * Note what is absent: no CDN, no IPFS gateway, no image host. A counter's
 * art comes from `/content/<n>` on this site's own API, which re-serves bytes
 * that are in a Bitcoin block. If a URL for artwork ever appears in this file,
 * something has gone wrong with the premise.
 */

/**
 * Counterparty Core v2 — balances, quotes, composes, fee estimates, relay.
 * Read only by the same-origin proxy in `app/api/cp`, so this is a server-side
 * setting: `COUNTERPARTY_API_BASE` in the environment, and the node on this
 * machine when unset. Point it at `https://api.counterparty.io:4000/v2` to
 * use the public node instead.
 */
export const COUNTERPARTY_API_BASE = (
  process.env.COUNTERPARTY_API_BASE ?? "http://127.0.0.1:4000/v2"
).replace(/\/+$/, "");

/**
 * This site's own public origin. Only metadata needs it — Open Graph and
 * Twitter cards are read by crawlers that cannot resolve a relative path, so
 * the absolute URL has to be stated rather than inferred from the request.
 */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://counters.fun").replace(
  /\/+$/,
  "",
);

/** This site's own worker: the counters × pools join and the content proxy. */
export const COUNTERS_API_BASE =
  process.env.NEXT_PUBLIC_COUNTERS_API_BASE ?? "http://localhost:8787";

/** Counterparty's canonical unspendable address. LP tokens here are locked forever. */
export const BURN_ADDRESS = "1CounterpartyXXXXXXXXXXXXXXXUWLpVr";

/** Where a counter's on-chain bytes are read from. Same-origin via the rewrite
 *  in next.config.ts, so an HTML counter can be framed and sandboxed. */
export const contentUrl = (number: number) => `/content/${number}`;
export const previewUrl = (number: number) => `/preview/${number}`;
/**
 * A stamp counter's decoded image. Still the same premise as `contentUrl` —
 * these bytes are base64 that came out of a Bitcoin block, decoded by the
 * protocol's own indexer. No server supplies the picture; one only unwraps it.
 */
export const stampUrl = (number: number) => `/stamp/${number}`;

/** `amm_pools` (Core v11.1.0) — pools cannot exist before this block. */
export const AMM_POOLS_ACTIVATION_BLOCK = 952_500;
/** `fairmint_pool` (Core v11.2.0) — consensus-seeded pools start here. */
export const FAIRMINT_POOL_ACTIVATION_BLOCK = 961_100;
/** Counterparty taproot support — no counter can exist before it. */
export const COUNTERS_GENESIS_BLOCK = 902_000;

/** Swap fee consensus charges on an XCP pair, in basis points. */
export const XCP_POOL_FEE_BPS = 50;

/** Named-asset issuance burn, in XCP. A free numeric asset costs nothing. */
export const NAMED_ASSET_XCP_BURN = 0.5;

/**
 * Standard relay caps a transaction's witness at 400,000 weight units.
 * A reveal above it is non-standard and needs a direct-to-miner route
 * (Slipstream), which is how the multi-megabyte counters got mined.
 */
export const STANDARD_WITNESS_LIMIT_WU = 400_000;

export const mempoolTxUrl = (txid: string) => `https://mempool.space/tx/${txid}`;
export const mempoolBlockUrl = (height: number) => `https://mempool.space/block/${height}`;
export const xcpAssetUrl = (asset: string) => `https://www.xcp.io/asset/${asset}`;
/** The protocol's own explorer — the record of what a counter is. */
export const countersExplorerUrl = (number: number) =>
  `https://www.bitcoincounters.com/c/${number}`;
