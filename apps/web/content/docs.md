<!-- The /docs page. Edit freely; save and reload.

     This is prose, not code — change any of it without touching a component.

     Two conventions:
       "## Title" starts a section.
       "{{TOKEN}}" is substituted at render time from lib/constants.ts, so
       protocol facts stay correct when they change. The available tokens are
       listed in content/index.ts; an unknown one is left visible as
       {{TOKEN}} rather than silently blanked, so a typo is obvious. -->

# How it works.

## A counter is a file in Bitcoin

A counter is a Counterparty asset whose *description is a file*, carried into Bitcoin's witness data by a v11 taproot envelope. The counters indexer numbers them gap-free from zero, in order of block height and then position in the block — the same ordering ordinals use. Counter #0 is `XDUALS`, at block 902,005, and always will be.

Witness data is the cheapest place on Bitcoin to put bytes: the SegWit discount makes it four times cheaper than an output, and it never enters the UTXO set. That is the whole reason counters live there rather than where Bitcoin Stamps put theirs.

Ownership is Counterparty's. Whoever holds the asset balance owns the counter, and transferring it is an ordinary send — the file never moves, because it is pinned to the asset rather than to a coin.

## Why some counters are not shown here

A counter's description does not have to be a file. It can be a URL, and for well over half the counters indexed so far it is — 64 bytes of `ipfs://…` or `https://…` pointing at a server somewhere.

Those are valid counters and this site does not show them. Rendering one means fetching bytes from whoever operates that server, and asking you to trust that what comes back is what was inscribed. Everything on counters.fun is read out of a Bitcoin block, so the rule is enforced in the database query rather than in a filter you can turn off: a pointer-like counter cannot appear in any listing, and asking for its content returns a refusal rather than a fetch.

## How a counter gets a pool

Counterparty has a native AMM — constant product, {{XCP_POOL_FEE_BPS}} basis points on an XCP pair, activated at block {{AMM_POOLS_ACTIVATION_BLOCK}}. There is no contract to deploy and nothing for this site to hold. Two ways to reach one:

- **Deposit into it.** [Open the pool](/pool/create) with any counter and any amount of XCP. The first deposit sets the price; later ones must match the ratio. You hold the LP token and can withdraw whenever you like.
- **Let consensus open it.** A fairminter composed with a `pool_quantity` — available since block {{FAIRMINT_POOL_ACTIVATION_BLOCK}} — pairs those tokens with *every satoshi of XCP the sale raised* the moment it reaches its soft cap, and mints the LP tokens directly to the unspendable address. The creator receives none of the raise and nobody can withdraw the liquidity, ever. Miss the soft cap and every minter is refunded automatically in the same block.

The second is stronger, and it is stronger because of consensus rather than because of a promise. On any pool's page this site shows what share of the LP supply actually sits at the unspendable address, so "liquidity locked" is a number you can check rather than a badge.

## Minting one

[Minting](/mint) is two transactions. A commit funds a taproot output whose script carries your file; a reveal spends it, putting the bytes on chain and issuing the asset in the same message. Counterparty composes both.

The commit is broadcast before the reveal is signed, which looks backwards and is not: a browser wallet cannot complete a signature for an input whose parent transaction it cannot find. If the reveal never gets signed, nothing is lost — the envelope is re-keyed to your own key before signing, so the reveal can be rebuilt and signed again at any point.

Reveals above {{STANDARD_WITNESS_LIMIT_WU}} weight units are non-standard. The public network will not relay them at any fee rate, which is a policy limit rather than a price; the multi-megabyte counters in the index were mined through a direct-to-miner route instead.

## Wallets

Two browser wallets speak Counterparty, and counters.fun works with both: [XCP Wallet](https://chromewebstore.google.com/detail/xcp-wallet/nicpjdbehgcjbjfjkobcidnfmfpijohg) and [Horizon Wallet](https://chromewebstore.google.com/detail/horizon-wallet/bnmgkjlaommgappfckljlelgahnbngme). They differ in ways that matter, and the site absorbs the differences rather than passing them on:

- **Everything is signed as a PSBT.** Counterparty composes a finished raw transaction, and XCP Wallet will sign that directly — Horizon has no raw-transaction signing at all. Every flow here rebuilds the compose as a PSBT, so there is one path rather than two.
- **Relaying.** XCP Wallet broadcasts what it signs. Horizon hands the bytes back, so those go to a public Esplora relay instead. Either way you get a txid.
- **Minting needs a taproot account.** The commit pays a taproot script whose leaf names your own key; only a `p2tr` address can produce it. Both wallets are asked for their taproot address, and the mint page says so plainly rather than failing after you have approved a payment.

Connecting proves nothing cryptographically here. XCP Wallet signs BIP-322 and Horizon signs ECDSA/BIP-137 and refuses BIP-322, so requiring a proof would have meant supporting one wallet and locking out the other. Nothing on this site depends on it — the chain settles ownership.

## Where the data comes from

Counter numbers, content and provenance come from the [counters server](https://www.bitcoincounters.com), the protocol's reference indexer, which scans from block {{COUNTERS_GENESIS_BLOCK}}. Pools, balances and quotes come from Counterparty Core. This site joins the two, because the question it is built on — which counters have a pool — spans both and neither can answer it alone. Composing, signing and broadcasting stay between your wallet and the node.
