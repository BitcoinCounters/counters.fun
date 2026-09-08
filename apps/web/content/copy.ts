/**
 * Every word the site says, in one place. Edit freely.
 *
 * This is copy, not code. Nothing here is parsed, matched on, or depended upon
 * by any logic — change any string and the only thing that changes is what a
 * reader sees. It lives outside the components for the same reason the counters
 * explorer keeps its docs in a markdown file: prose gets edited far more often
 * than layout, and hunting for a sentence inside JSX is a bad way to spend an
 * afternoon.
 *
 * Long-form prose lives in `content/docs.md` instead — this file is for the
 * short strings that sit inside layout.
 *
 * Two things to know before editing:
 *
 * - `{{TOKEN}}` is substituted at render time from `lib/constants.ts` (see
 *   `content/index.ts` for the list). An unknown token is left visible rather
 *   than blanked, so a typo shows up immediately instead of silently deleting
 *   a number.
 * - A few strings take a value the page computes — a count, an asset name.
 *   Those are functions rather than plain strings, and their parameter names
 *   say what they receive.
 */

export const copy = {
  site: {
    title: "counters.fun — counters with XCP liquidity",
    description:
      "Counters are files in Bitcoin witness data, owned through Counterparty assets. This is where they get markets. Nothing here is hosted: every image is read out of a Bitcoin block.",
    ogTitle: "counters.fun",
    ogDescription: "Counters with XCP liquidity pools. On-chain files only.",
  },

  nav: [
    { href: "/", label: "Pools" },
    { href: "/mint", label: "Mint" },
    { href: "/pool/create", label: "Create LP" },
    { href: "/activity", label: "Activity" },
    { href: "/docs", label: "Docs" },
    { href: "https://bitcoincounters.com", label: "BitcoinCounters" },
  ],

  home: {
    eyebrow: "trade counters",
    /** The second half renders in a dimmer colour. */
    headline: "Counterparty Inscriptions",
    headlineDim: "Marketplace",
    lede: "A [**counter**](https://bitcoincounters.com) is an on chain inscription attached to a Counterparty Asset. Every image, text, audio, video or other file you see below is stored and read directly off the Bitcoin Blockchain.\n\nEvery counter is assigned an inscription number at birth",

    stats: {
      pooled: "pooled",
      minting: "minting",
      onChain: "on-chain counters",
      bytes: "committed to bitcoin",
    },
    /** The line under the stats. `hidden` is the count of pointer counters. */
    chainLine: (hidden: number) => ({
      before: "block",
      middle: `${hidden}`,
      after: "counters hidden as off-chain pointers",
    }),

    pooled: {
      title: "Pooled",
      meta: (depth: string) => `${depth} XCP of liquidity`,
      empty: "No counter has an XCP pool yet. The first one is a",
      emptyLink: "deposit",
      emptyAfter: "away.",
    },
    minting: {
      title: "Minting",
      meta: "all-or-nothing · pool opened by consensus at soft cap",
    },
    unpooled: {
      title: "No pool yet",
      meta: (count: number) => `${count} on-chain counters without one`,
    },
  },

  counter: {
    /** Under the asset name. */
    summary: (size: string, mime: string, block: string) =>
      `${size} of ${mime} in Bitcoin witness data, block ${block}.`,
    poolTitle: (a: string, b: string) => `${a}/${b} pool`,
    liquidityLocked: "liquidity locked",
    lockedAll: " — every LP token is unspendable.",
    lockedSome: " — the remainder can be withdrawn by whoever holds it.",
    addLiquidity: "add liquidity",

    noPool: {
      label: "no pool",
      body: "Nobody has opened an XCP pool for this counter. The first deposit sets the price — there is no ratio to match until one exists.",
      cta: "create the pool",
    },

    provenance: {
      title: "Provenance",
      meta: "verifiable against the chain",
    },
    reinscriptions: {
      title: "Reinscriptions",
      meta: (count: number) => `${count} on this asset`,
      body: "One asset can carry many counters. Each reinscription earns its own permanent number; the lowest is the original. Nothing is renumbered, ever.",
    },

    /** The refusal state for a counter whose description is a URL. */
    pointer: {
      label: "off-chain pointer",
      body: (number: number) =>
        `Counter #${number} is real, numbered and permanent. Its description is not a file — it is an address somewhere else, so there is nothing in Bitcoin to show you.`,
      inscribedLabel: "what was inscribed",
      footerBefore: "counters.fun does not fetch it. Most of the index's counters are pointers like this one; the",
      footerLink: "ones that are files",
      footerAfter: "are what this site is for.",
    },
  },

  mint: {
    eyebrow: "mint",
    headline: "Put a file in Bitcoin.",
    lede: "A counter is a Counterparty asset whose description is a file, carried in a v11 taproot envelope. The indexer numbers it gap-free from zero, in the order it reached the chain. Nothing here is uploaded anywhere — the bytes go into a Bitcoin block, and that is the only place they will ever live.",

    file: {
      label: "the file",
      choose: "choose a file",
      hint: "its bytes become the asset's description, permanently",
      mimeNote: "Committed to by the envelope — it cannot be corrected later.",
      mimeText: "Textual: the bytes go on chain as UTF-8.",
      mimeBinary: "Binary: the bytes go on chain as hex.",
    },
    asset: {
      label: "the asset",
      namePlaceholder: "leave empty for a free numeric asset",
      named: (burn: number) => `A named asset costs ${burn} XCP, burned.`,
      numeric:
        "A free numeric asset (A + a large number) costs no XCP. It is a counter either way — the number is what identifies it.",
      invalid: "A named asset is 4–12 letters and cannot start with A.",
    },
    envelope: {
      label: "how it is carried",
      ord: "counterparty + ord",
      ordHint: "Numbered by ordinals indexers as well. About 39% of the index.",
      native: "counterparty native",
      nativeHint: "Counterparty's own envelope. Smaller by a few bytes.",
    },
    nonStandard:
      "Past the {{STANDARD_WITNESS_LIMIT_WU}} WU standard relay cap. The public network will not carry this reveal at any fee rate — it needs a direct-to-miner route, which is how the multi-megabyte counters were mined.",
    footnote:
      "Two transactions: a commit that funds the envelope, then a reveal that spends it and puts the file in Bitcoin. The commit is broadcast before the reveal is signed — a browser wallet cannot sign an input whose parent it cannot find. If the reveal signature fails, nothing is lost: the envelope names your key, so it can be signed again.",

    stages: {
      composing: "Composing the envelope…",
      "signing-commit": "Approve the commit in your wallet",
      "broadcasting-commit": "Broadcasting the commit…",
      "signing-reveal": "Approve the reveal in your wallet",
      "broadcasting-reveal": "Broadcasting the reveal…",
      done: "Done",
    },
    cta: "mint counter",
    ctaTaproot: "taproot account required",

    receipt: {
      label: "minted",
      body: "The file is in Bitcoin. The counters indexer assigns its number once the reveal confirms — gap-free, in the order it reached the chain, and permanent.",
    },
  },

  pool: {
    eyebrow: "liquidity",
    headline: "Give it a market.",
    lede: "Counterparty's AMM is native — constant product, {{XCP_POOL_FEE_BPS}} bps on an XCP pair, no contract to deploy and nothing for this site to custody. A counter with a pool can be traded by anyone, in either direction, forever.",

    counterLabel: "counter",
    checking: "checking for a pool…",
    noPool: "no pool exists — this deposit sets the price",
    existing: (price: string, depth: string) => `pool at ${price} XCP · ${depth} XCP deep`,

    depositLabel: "you deposit",
    depositLabelFirst: "you deposit — this is the opening price",
    openingPriceLabel: "opening price you are setting",
    priceLabel: "price",
    /** The single most consequential sentence on the page. */
    firstDepositWarning:
      "Nothing anchors this number. Whatever you put in is what the counter is worth to the next buyer, and a later deposit at a different ratio will not correct it — an arbitrageur takes the difference instead.",
    maximumsNote:
      "These amounts are maximums. Consensus debits only the proportional share, so an oversupplied side is left untouched rather than moving the price.",

    confirmFirst: (asset: string, price: string) =>
      `Open ${asset}/XCP at ${price} XCP per ${asset}?`,
    confirmCta: "set this price",
    ctaOpen: "open the pool",
    ctaAdd: "add liquidity",

    footnote:
      "The pool is Counterparty's, not this site's. Liquidity you deposit is represented by an LP token you hold and can withdraw at any time — unlike a pool seeded by a fairminter at soft cap, whose LP tokens consensus sends to the unspendable address.",

    receiptOpened: "pool opened",
    receiptAdded: "liquidity added",
    receiptBody: "It takes effect when the transaction confirms. Until then the pool is unchanged.",
  },

  activity: {
    eyebrow: "activity",
    headline: "Every swap.",
    lede: (pooled: number) =>
      `Trades against counter pools, straight from the chain. With ${pooled} pooled ${
        pooled === 1 ? "counter" : "counters"
      } this is a short list — it gets longer as counters get markets.`,
    empty: "Nothing has traded yet.",
  },

  wallet: {
    connect: "connect",
    connecting: "connecting…",
    retry: "retry",
    disconnect: "disconnect",
    install: "install",
    chooseLabel: "connect a wallet",
    chooseNote: "Both wallets speak Counterparty. Minting needs a taproot account in either.",
  },

  notFound: {
    headline: "No counter here.",
    body: "Counters are numbered gap-free from zero, so every number below the tip exists — this one is either past it, or not a number at all.",
    cta: "back to the pools",
  },
} as const;
