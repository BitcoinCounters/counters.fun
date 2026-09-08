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
    title: "counters.fun",
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

  about: { label: "about" },
  search: { placeholder: "search counters", none: "no on-chain counter matches" },
  prices: {
    xcpDispenser: "XCP: the cheapest open dispenser on Counterparty that can still dispense, in BTC at the local mempool backend's BTC/USD. On-chain, from this node.",
    xcpDex: "XCP: the best open sell order on Counterparty's DEX, in BTC at the local BTC/USD.",
  },

  home: {
    eyebrow: "trade counters",
    /** The second half renders in a dimmer colour. */
    headline: "Counterparty Inscriptions",
    headlineDim: "Marketplace",
    lede: "A [**counter**](https://bitcoincounters.com) is an on chain inscription attached to a Counterparty Asset. Every image, text, audio, video or other file you see below is stored and read directly off the Bitcoin Blockchain.\n\nEvery counter is assigned an inscription number at birth",

    stats: {
      pooled: "pooled",
      minting: "minting",
      counters: "counters",
      bytes: "on bitcoin",
    },
    /** The line under the stats — the label before the block height. */
    chainLine: "block",

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
    modes: {
      label: "what you are minting",
      counter: "a counter",
      counterHint: "A file in Bitcoin, owned by a new asset. Name it, or let a free numeric name be drawn.",
      reinscribe: "reinscribe an existing asset",
      reinscribeHint: "Replace the description of an asset you already own with a new file. Supply is untouched.",
      fairminter: "fairminter deploy",
      fairminterHint:
        "Launch a sale. The file is the deploy's permanent description, so the deploy is itself the counter. XCP-69 fixes every parameter to xcp.fun's template; custom opens them all.",
    },
    presets: {
      label: "the sale",
      xcp69: "XCP-69",
      xcp69Hint: "69M sold at 0.01 XCP per 1,000, 31M paired with the raised XCP to open the pool, LP burned by consensus. Listed by xcp.fun.",
      custom: "custom",
      customHint: "Every parameter yours. Starts from the XCP-69 numbers.",
    },
    fairminter: {
      lotPrice: "xcp per lot",
      lotSize: "tokens per lot",
      hardCap: "hard cap",
      softCap: "soft cap",
      poolQuantity: "pool reserve",
      maxMintPerAddress: "max per address",
      maxMintPerTx: "max per mint",
      premint: "premint to you",
      commission: "commission %",
      burnPayment: "burn the xcp paid",
      lockQuantity: "lock supply",
      lockDescription: "lock description",
      divisible: "divisible",
      startLead: "starts in",
      window: "mint window",
      endAfter: "ends after",
      blocks: "blocks",
      zeroIsNone: "0 means none",
      noneNow: "0 opens the sale in the deploy's own block",
      poolHint: "With a reserve, every satoshi of XCP raised seeds a pool at soft cap and the LP tokens go to the unspendable address.",
      summary: {
        raise: (xcp: string) => `Sells out at ${xcp} XCP`,
        free: "Free mint",
        pool: (tokens: string) => `${tokens} tokens + all raised XCP open the pool at soft cap`,
        noPool: "No pool — raised XCP goes to you",
        burn: "Raised XCP is burned",
      },
      problems: "cannot be composed:",
    },
    asset: {
      label: "the asset",
      namePlaceholder: "leave empty for a free numeric asset",
      namePlaceholderRequired: "ASSET NAME",
      named: (burn: number) => `A named asset costs ${burn} XCP, burned.`,
      numeric:
        "A free numeric asset (A + a large number) costs no XCP. It is a counter either way — the number is what identifies it.",
      numericAuto: "Leave it empty and a free numeric name is drawn for you at mint time.",
      subasset: (parent: string) => `A subasset of ${parent}. Free — and only ${parent}'s owner can issue it.`,
      invalid: "A named asset is 4–12 letters and cannot start with A.",
      reasons: {
        reserved: "That name is reserved by the protocol.",
        "numeric-out-of-range": "A numeric name is A followed by an integer between 26^12 and 2^64.",
        "named-shape": "A named asset is 4–12 uppercase letters and cannot start with A.",
        "subasset-parent": "The part before the dot must be a valid named or numeric asset.",
        "subasset-child": "After the dot: letters, digits and . - _ @ ! only.",
        "subasset-length": "The whole name is capped at 250 characters.",
      } as Record<string, string>,
      checking: "checking the name…",
      lookupFailed: "Could not check whether this asset exists. The node did not answer.",
      existsYours: "You already own this asset. Switch to reinscribe to give it a new file.",
      existsOther: (owner: string) => `Already issued, owned by ${owner}. Pick another name.`,
      existsLockedDescription: "This asset's description is locked. It cannot be reinscribed.",
      reinscribeNeedsExisting: "Name an asset you already own.",
      reinscribeNotYours: (owner: string) => `${owner} owns this asset, not the connected address.`,
      reinscribeReady: (mime: string | null) =>
        `Yours. Its current description is ${mime ?? "on chain"}; the new file replaces it.`,
      xcp69Exists: "A launch needs a name nobody has issued yet.",
    },
    lockDescription: {
      label: "lock description",
      hint: "After the reveal confirms, a follow-up issuance locks the file in place forever.",
    },
    xcp69: {
      label: "the launch",
      lead: "starts in",
      leadUnit: "blocks",
      leadHint:
        "xcp.fun requires the deploy to confirm before the start block, so the window cannot open the moment you broadcast. One block is the minimum; a few is safer.",
      schedule: (start: string, deadline: string) =>
        `Start block ${start} · soft cap deadline ${deadline} (1,000 blocks later).`,
      tipUnknown: "Waiting for the node to report the current block…",
      lines: {
        sale: "69M for sale at 0.01 XCP per 1,000 — 690 XCP to sell out",
        pool: "31M + every raised XCP opens the pool at soft cap",
        lp: "LP tokens minted to the unspendable address",
        caps: "1M per address · supply and description locked · no premint",
        fail: "If the soft cap is not reached in 1,000 blocks, minters are refunded and nothing is issued",
      },
      lpAsset: "lp token",
      listed:
        "Any conforming launch is indexed by xcp.fun without being submitted. It appears in their Minting list once it has at least one mint.",
    },
    preflight: {
      label: "before you sign",
      xcpShort: (need: string, have: string) => `Needs ${need} XCP to burn for the name; this address holds ${have}.`,
      xcpOk: (need: string) => `${need} XCP will be burned for the name.`,
      btc: (have: string) => `${have} BTC spendable at this address.`,
      btcShort: (have: string, need: string) =>
        `About ${need} sat needed for both transactions; ${have} spendable here.`,
      checking: "checking balances…",
      unavailable: "Balances could not be checked — the node did not answer. The compose will still refuse a short wallet.",
    },
    estimate: {
      onChain: "on chain",
      revealWeight: "reveal weight",
      revealWeightExact: "reveal weight (exact)",
      revealFee: "reveal fee (est.)",
      commitFee: "commit fee",
      total: "total fee",
      effective: (rate: string) => `${rate} sat/vB`,
      dustFloor: "The reveal is small enough that the 330-sat commit minimum, not the rate, sets its fee.",
    },
    pending: {
      label: "unfinished mint",
      body: (asset: string, commit: string) =>
        `The commit for ${asset} (${commit}…) is on chain but its reveal was never broadcast. The envelope names your key, so the reveal can still be signed.`,
      resume: "sign the reveal",
      discard: "discard",
      wrongAddress: (source: string) => `It belongs to ${source}. Connect that address to finish it.`,
    },
    envelope: {
      label: "how it is carried",
      ord: "counterparty + ord",
      ordHint: "Numbered by ordinals indexers as well. About 39% of the index.",
      native: "counterparty native",
      nativeHint: "Counterparty's own envelope. Smaller by a few bytes.",
    },
    nonStandard:
      "Past the {{STANDARD_WITNESS_LIMIT_WU}} WU standard relay cap. The public network will not carry this reveal at any fee rate, so it goes straight to a miner through Slipstream — which is how the multi-megabyte counters were mined.",
    route: {
      label: "reveal route",
      public: "this node",
      publicHint: "Relayed by your own bitcoind to the public network. Free, and the usual path.",
      publicBlocked: "Not available: this reveal is past the standard relay cap.",
      slipstream: "Slipstream (MARA)",
      slipstreamHint:
        "Handed directly to MARA's pool. The only route past 400k WU, and an option for any reveal. MARA cannot price the reveal until the commit is mined, so this tab hands the signed reveal to this server, which finishes it.",
      rates: (floor: string, mineable: string) => `Slipstream accepts from ${floor} sat/vB and is mining at ${mineable} sat/vB.`,
      belowFloor: (floor: string) => `Below Slipstream's ${floor} sat/vB acceptance floor. Raise the fee rate.`,
      ratesUnknown: "Slipstream's current rates could not be read.",
      job: {
        label: "slipstream reveal",
        "awaiting-commit": "waiting for the commit to be mined",
        probing: "commit mined — finding a submission window",
        watching: "submitted to MARA — waiting for it to be mined",
        confirmed: "mined",
        rejected: "MARA refused it",
        dead: "given up",
      } as Record<string, string>,
      jobNote: "This page can be closed. The server keeps working on it, and the job can be checked by commit txid.",
    },
    footnote:
      "Two transactions: a commit that funds the envelope, then a reveal that spends it and puts the file in Bitcoin. The commit is broadcast before the reveal is signed — a browser wallet cannot sign an input whose parent it cannot find. If the reveal signature fails, nothing is lost: the envelope names your key, so it can be signed again.",

    stages: {
      checking: "Checking balances…",
      composing: "Composing the envelope…",
      "signing-commit": "Approve the commit in your wallet",
      "broadcasting-commit": "Broadcasting the commit…",
      "signing-reveal": "Approve the reveal in your wallet",
      "awaiting-commit":
        "Waiting for the commit to be mined — Slipstream cannot price the reveal before then",
      "broadcasting-reveal": "Broadcasting the reveal…",
      done: "Done",
    },
    cta: "mint counter",
    ctaReinscribe: "reinscribe",
    ctaFairminter: "deploy",
    ctaTaproot: "taproot account required",

    receipt: {
      label: "minted",
      labelReinscribed: "reinscribed",
      labelLaunched: "launched",
      body: "The file is in Bitcoin. The counters indexer assigns its number once the reveal confirms — gap-free, in the order it reached the chain, and permanent.",
      bodyFairminter: (start: string | null, xcp69: boolean) =>
        `The deploy is in Bitcoin. Minting opens ${start ? `at block ${start}` : "as soon as it confirms"}.${
          xcp69 ? " Sell out within 1,000 blocks and the pool opens by consensus. It appears on xcp.fun once it has a mint." : ""
        }`,
      xcpFun: "view on xcp.fun",
      lockDescription: {
        cta: "lock the description",
        waiting: "waiting for the reveal to confirm…",
        signing: "approve the lock in your wallet",
        done: "description locked",
        hint: "A second, tiny transaction. Available once the reveal has confirmed.",
      },
    },
  },

  swap: {
    label: "swap",
    buy: "buy",
    sell: "sell",
    youPay: "you pay",
    youReceive: "you receive (est.)",
    youReceiveExact: "you receive — pay amount computed",
    minimum: (amount: string, asset: string) => `at least ${amount} ${asset}, or the order expires`,
    price: "effective price",
    impact: "price impact",
    poolFee: "pool fee",
    slippage: "slippage",
    expiry: "expires after",
    blocks: "blocks",
    expiryHint:
      "A swap is an order. The pool fills it at once, up to your limit; anything it cannot fill at that price waits on the order book for this many blocks, then comes back to you.",
    remainder: (amount: string, asset: string) =>
      `${amount} ${asset} of this cannot be filled by the pool at whole-unit precision and would wait on the book.`,
    highImpact: (pct: string) => `${pct}% price impact — this trade moves the pool noticeably.`,
    wholeUnits: (units: string, asset: string, cost: string) =>
      `${asset} is indivisible: this buys ${units} whole ${asset} for ${cost} XCP. The pool takes only what those cost; the rest of the order comes back at expiry.`,
    useExact: "pay exactly that",
    noPool: "No pool to swap against.",
    quoting: "quoting…",
    cta: "swap",
    confirm: (give: string, giveAsset: string, min: string, getAsset: string) =>
      `Give ${give} ${giveAsset} for at least ${min} ${getAsset}?`,
    receipt: "swap sent",
    receiptBody: "It fills when the transaction confirms. If the pool has moved past your limit by then, the unfilled part waits on the book until expiry and is returned.",
  },

  fee: {
    label: "fee rate",
    presets: { fast: "fast", normal: "normal", economy: "economy" } as Record<string, string>,
    source: (source: string) =>
      source === "node" ? "from your node" : source === "none" ? "no estimate available" : `from ${source}`,
    invalid: {
      empty: "",
      nan: "Enter a number, like 0.5.",
      zero: "The rate must be above zero — the node would compose a fee-less transaction.",
      "too-high": "That is far above any fee the network has ever needed.",
    } as Record<string, string>,
    belowMempoolMin: (min: string) => `Below this node's current mempool minimum of ${min} sat/vB. It would not relay right now.`,
    belowRelayMin: (min: string) => `Below the node's relay minimum of ${min} sat/vB. It would be refused.`,
    subOne:
      "Under 1 sat/vB. Nodes on Bitcoin Core 29.1 or newer relay down to 0.1; older nodes drop it, and confirmation can take a long time.",
    subOneXcpWallet: "XCP Wallet relays through its own backend, which may refuse it; if so, the transaction is retried through this site's node.",
  },

  errors: {
    cancelled: () => "Cancelled in the wallet. Nothing was sent.",
    notConnected: () => "The wallet is locked or disconnected. Connect it and try again.",
    notFound: () => "The node has no record of that.",
    insufficientBtc: () => "Not enough BTC at this address to pay for the transaction.",
    noUtxos: () => "This address has no spendable coins — or they are still unconfirmed from the last transaction. Wait a block, or send some BTC here.",
    insufficientAsset: (asset?: string) => `Not enough ${asset ?? "of that asset"} at this address.`,
    slippage: () => "The pool moved past your slippage tolerance. Re-quote and try again, or widen the tolerance.",
    badMime: () => "That MIME type is not on Counterparty's list. Pick one the node accepts.",
    numericRange: () => "A numeric name is A followed by an integer between 26^12 and 2^64.",
    badAssetName: () => "That is not a valid asset name.",
    notParentOwner: () => "Only the parent asset's owner can issue a subasset of it.",
    notOwner: () => "This asset is owned by another address.",
    descriptionLocked: () => "This asset's description is locked and cannot be changed.",
    supplyLocked: () => "This asset's supply is locked.",
    lpAssetTaken: () => "That LP token name is already taken. A new one was drawn — try again.",
    badHex: () => "The file could not be encoded for the node. Check the MIME type: binary types go across as hex.",
    unreachable: () => "The Counterparty node is unreachable.",
    notProxied: () => "That request is not one this site relays.",
    startBlock: () => "The start block must be ahead of the current block.",
    relayRejected: () => "Bitcoin rejected the transaction. It is signed, so it can be submitted again once the reason is fixed.",
  } as Record<string, (arg?: string) => string>,

  pool: {
    eyebrow: "liquidity",
    headline: "Give it a market.",
    lede: "Counterparty's AMM is native — constant product, {{XCP_POOL_FEE_BPS}} bps on an XCP pair, no contract to deploy and nothing for this site to custody. A counter with a pool can be traded by anyone, in either direction, forever.",

    tabs: { deposit: "deposit", withdraw: "withdraw" },
    counterLabel: "counter",
    checking: "checking for a pool…",
    couldNotCheck: "could not check for a pool — the node did not answer",
    noAsset: "no such asset",
    noPool: "no pool exists — this deposit sets the price",
    xcp69Note:
      "This counter's pool was opened by its fairminter at soft cap, and consensus sent those LP tokens to the unspendable address. Anything added here is yours to withdraw; the original liquidity is not.",
    eitherSide: "Type either side; the other is priced by the pool.",
    slippageCustom: "custom",
    lpAsset: {
      label: "lp token name",
      auto: "drawn at random",
      custom: "choose",
      hint: "A numeric asset. Random is safer — a predictable name can be issued out from under you.",
    },
    confirmAdd: (asset: string, tokenAmount: string, xcpAmount: string) =>
      `Add up to ${tokenAmount} ${asset} and ${xcpAmount} XCP? Consensus takes the proportional share.`,
    confirmAddCta: "add liquidity",
    withdraw: {
      label: "you withdraw",
      lpBalance: (amount: string) => `you hold ${amount} LP`,
      none: "This address holds no LP tokens for this pool.",
      receive: "you receive (min.)",
      cta: "withdraw",
      confirm: (lp: string, token: string, xcp: string) =>
        `Burn ${lp} LP for at least ${token} and ${xcp} XCP?`,
      receipt: "liquidity withdrawn",
      receiptBody: "The LP tokens are destroyed and the reserves are returned when the transaction confirms.",
    },
    lock: {
      label: "lock liquidity",
      hint: "Send your LP tokens to the unspendable address. The liquidity stays in the pool forever, and so do you.",
      cta: "lock forever",
      confirmLabel: "I understand this cannot be undone",
      confirm: (lp: string, asset: string) => `Send ${lp} ${asset} LP to 1CounterpartyXXXXXXXXXXXXXXXUWLpVr?`,
      receipt: "liquidity locked",
      receiptBody: "Once it confirms, nobody — you included — can withdraw that share.",
    },
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
