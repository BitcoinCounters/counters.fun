# counters.fun

The market layer for [Bitcoin Counters](https://www.bitcoincounters.com) — and the
only place that shows a token's art *because it is on Bitcoin*, never because a
server hosts it.

A **counter** is a Counterparty asset whose description *is* a file, carried
into Bitcoin's witness data by a v11 taproot envelope and numbered gap-free
from zero. Counterparty Core v11.1's `amm_pools` gate gave those assets a native
constant-product AMM; v11.2's `fairmint_pool` gate (mainnet block 961,100) let a
fairminter seed one at soft cap with every satoshi it raised, minting the LP
tokens straight to the unspendable address. This site is the intersection: the
counters that have XCP pools, the ones on their way to having one, and the pages
to mint or pool one yourself.

## The one rule

**Only counters whose file is on Bitcoin are displayed.**

A counter's description does not have to be a file — it can be a URL, and for
98 of the 168 counters indexed today it is: 64 bytes of `ipfs://…` or
`https://…`. Those are valid counters and this site does not render them.
Following one means fetching bytes from someone else's server, which is exactly
what counters.fun exists not to do.

The rule is structural, not a setting:

- every statement in `apps/api/src/queries/counters.ts` carries
  `is_pointer_like = 0` — there is no route parameter that relaxes it;
- the content proxy returns `415` for a pointer rather than fetching it;
- `tests/on-chain-rule.test.ts` asserts the split across the whole live index;
- `scripts/smoke.mjs` re-checks it after every deploy.

A deep link to a pointer counter is not a 404. It renders an honest refusal
showing the raw description as text, deliberately not as a link.

## Layout

```
apps/web/           Next.js 16 + React 19 + Tailwind v4 → OpenNext → Cloudflare Workers
apps/api/           Hono + D1 + R2 + cron               → Cloudflare Workers
packages/counters/  shared types, the on-chain predicate, pool + fairminter math
```

### `apps/api` — the join

Neither upstream can answer the question this site is built on. The counters
server knows about files and numbers and nothing about markets; Counterparty
knows about pools and nothing about counter numbers. A `*/5` cron pulls both
into D1 and rolls up depth, 24h volume and price change.

| Route | |
|---|---|
| `GET /counters` | the home page in one call: `{ pooled, minting, unpooled }` |
| `GET /counters/:id` | one counter by number or asset, with its pool and reinscriptions |
| `GET /counters/:id/pool` | reserves plus the lock proof — what share of LP supply sits at the burn address |
| `GET /counters/:id/history` | reserve snapshots, for the chart |
| `GET /activity` | swaps against counter pools |
| `GET /stats` | index totals and the chain tip |
| `GET /content/:n`, `/preview/:n` | on-chain bytes, re-served sandboxed |

**Why the content proxy exists.** `bitcoincounters.com` sends
`X-Frame-Options: DENY`. Images are fine in an `<img>`, but the HTML,
JavaScript, SVG and PDF counters — including `MEMENOME`, the only counter with
a pool today, which is 69 KB of on-chain JavaScript — cannot be framed
cross-origin at all. Re-serving them here makes them same-origin, sandboxes
them (`default-src 'none'`, `sandbox allow-scripts`, no `allow-same-origin`),
and caches them in R2 keyed by sha256. Counter bytes are in a Bitcoin block, so
the cache is write-once and never invalidated.

### `apps/web` — the pages

- `/` — Pooled, Minting, and on-chain counters with **no pool yet**. That last
  section is not filler: with 70 on-chain counters and one pool, it is where
  the first section comes from.
- `/c/[id]` — the counter itself, its pool, and provenance (sha256, rolling
  hash, block, reveal size, miner fee) verifiable against the chain.
- `/mint` — inscribe a file and issue the asset that owns it. Freeform.
- `/pool/create` — open an XCP pool, or add to one.
- `/activity`, `/docs`.

## Wallets

Both Counterparty browser wallets are supported, through one adapter interface
(`apps/web/src/lib/wallet/adapter.ts`). They are less alike than they look:

| | XCP Wallet | Horizon Wallet |
|---|---|---|
| global | `window.xcpwallet` | `window.HorizonWalletProvider` (+ WBIP-004 `window.btc_providers`) |
| call style | `request({method, params})` | `request(method, params)` |
| raw-tx signing | `xcp_signTransaction` | **none** — PSBT only |
| broadcast | `xcp_broadcastTransaction` | **none** — the dApp relays |
| inscription commit | refuses without an `inscription` context | signs it as an ordinary PSBT |
| message signing | BIP-322 | ECDSA / BIP-137 (BIP-322 explicitly unsupported) |

Two consequences run through the app. **Everything is signed as a PSBT** —
Counterparty returns a finished raw transaction and the XCP path could sign that
directly, but Horizon cannot, so every flow rebuilds the compose with
`buildPlainPsbt` and there is one path rather than two. And **broadcast is a
capability, not an assumption**: when a wallet cannot relay, the adapter falls
back to Esplora (`lib/wallet/broadcast.ts`) and the caller never learns which
happened.

Connection carries no ownership proof. The launchpad context this replaced
verified a BIP-322 proof on connect, which cannot work across both wallets —
Horizon answers BIP-322 with `METHOD_NOT_SUPPORTED`. Requiring it would have
meant supporting one wallet and rejecting the other.

The Horizon surface here was read out of the shipped extension (v2.3.1), not
guessed, because its provider speaks two dialects and picks between them **by
the shape of the params**: `signPsbt({hex, …})` is its house API and returns
`{hex}`; `signPsbt({psbt, …})` is the sats-connect layer and returns base64.
Sending the wrong one routes silently to the wrong dialect.

## Running it locally

```bash
npm install
npm run migrate:api:local
npm run local            # dev server + API + a sync loop
npm run local -- --prod  # production build instead of dev
```

`scripts/local.mjs` does the three things that are easy to get wrong by hand:
waits for the API before the web app renders against it, rewrites
`apps/api/.dev.vars` so `WEB_ORIGIN` matches the port actually in use, and pokes
the scheduled handler every ten minutes — `wrangler dev` registers the cron but
never fires it, so a local index otherwise freezes at whatever it last held.
`npm run sync` forces one.

  http://localhost:3010 — the site
  http://localhost:8787 — the API

**Use `localhost`, not `127.0.0.1`.** Next's dev server treats them as
different origins and blocks its own chunks across them, so the page renders
server-side and silently never hydrates. `allowedDevOrigins` in
`next.config.ts` now covers both, but the failure mode is worth knowing: it
looks exactly like a browser with JavaScript turned off.

## Running the parts separately

```bash
npm install                    # .npmrc sets legacy-peer-deps; see below
npm run migrate:api:local
npm run dev:api                # :8787
npm run dev:web                # :3000
```

`apps/api/.dev.vars` sets `WEB_ORIGIN` for local development — it becomes the
content proxy's `frame-ancestors`, and the production value would stop the dev
server framing an HTML counter, which looks exactly like a broken renderer
rather than a policy difference.

```bash
npm run test                   # unit + live-index assertions
npm run check                  # tests + both typechecks
node scripts/smoke.mjs         # the deploy gate, against a running API
```

Before the first deploy: `wrangler d1 create counters-db` and
`wrangler r2 bucket create counters-content`, then fill in `database_id` in
`apps/api/wrangler.toml` and set `WEB_ORIGIN` to the real origin.

## Editing the text

All of the site's prose lives in `apps/web/content/`, outside the components:

| file | what |
|---|---|
| `docs.md` | the whole `/docs` page, as markdown. Edit and reload. |
| `copy.ts` | every headline, label, button and footnote on every other page. |
| `fill.ts` | the `{{TOKEN}}` list (client-safe — no Node imports). |
| `docs.ts` | reads the markdown at render time (server only). |

`{{TOKEN}}` is substituted from `lib/constants.ts`, so protocol facts —
activation heights, the 50 bps pool fee, the 400,000 WU relay cap — cannot go
stale in the prose. An unknown token is left visible as `{{TOKEN}}` rather than
blanked, so a typo shows up in the page instead of silently deleting a number
from a sentence about consensus rules.

`fill` and `docsHtml` are deliberately in separate files. Client components use
`fill`, and a module that reaches `node:fs` — even transitively, even for a
function they never call — fails the browser bundle with *"the chunking context
does not support external modules"*. `docs.ts` imports `server-only` so that
mistake becomes a clear error rather than that one.

## Things that will bite you

- **`/counters` paginates with `before=<number>`, not `offset`.** An `offset`
  parameter is accepted and silently ignored, so an offset loop re-reads page
  one forever.
- **Quantities exceed 2^53.** A 100M divisible supply is 10^16 raw, and
  `JSON.parse` rounds it *during* parsing — there is no recovering the digits
  afterwards. Upstream JSON goes through `parseJsonLossless`; D1 stores raw
  quantities as decimal TEXT.
- **`soft_cap_deadline_block` is rewritten on a sell-out.** On a `closed`
  fairminter it holds the settlement block, not the composed deadline. A
  countdown may only trust it while the status is `open`.
- **LP tokens can themselves be counters.** Counter #163 is
  `A18189972090142917414`, MEMENOME's own LP token carrying 30 bytes of text.
  Listings exclude any asset that appears as a pool's `lp_asset`.
- **Minting requires a taproot account** in either wallet — the commit pays a
  taproot script whose leaf names the signer's own key. Checked before
  composing, not after the user approves a payment.
- **The mint broadcasts the commit before signing the reveal.** This looks
  backwards and is not: XCP Wallet cannot complete a signature for an input
  whose parent it cannot find, and Chrome idles out the extension's MV3 worker
  while it tries. The envelope is re-keyed to the user's own key first, so an
  unsigned reveal is recoverable — unlike Core's, whose key is discarded.
- **`npm install` needs `legacy-peer-deps`.** npm 10's peer resolver crashes on
  vitest 4's peer graph (`Cannot read properties of null (reading 'edgesOut')`)
  when building a tree from scratch. `.npmrc` sets it.

## Credit

The inscription mechanics in `apps/web/src/lib/inscribe/` are ported from
`mintapp2`, the wallet SDK and component grammar from the `launchpad`
(xcp.fun), and the protocol, palette and odometer from the `counters` reference
implementation.
