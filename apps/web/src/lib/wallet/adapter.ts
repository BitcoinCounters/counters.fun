/**
 * One interface over the two wallets that speak Counterparty.
 *
 * They are less alike than they look, and the differences decide the shape of
 * this file:
 *
 * | | XCP Wallet | Horizon Wallet |
 * |---|---|---|
 * | global | `window.xcpwallet` | `window.HorizonWalletProvider` (+ WBIP-004 `window.btc_providers`) |
 * | call style | `request({method, params})` | `request(method, params)` |
 * | raw-tx signing | `xcp_signTransaction` | **none** — PSBT only |
 * | broadcast | `xcp_broadcastTransaction` | **none** — the dApp must relay |
 * | inscription commit | an `inscription` context (ord envelopes only) or a declared Bitcoin payment | signs it as an ordinary PSBT |
 * | message signing | BIP-322 | ECDSA / BIP-137 |
 *
 * Two consequences run through the whole app:
 *
 * 1. **Everything is a PSBT.** Counterparty's composes return a finished raw
 *    transaction, and the XCP path signed that directly. Horizon cannot, so
 *    every flow now builds a PSBT from the compose (`buildPlainPsbt`) and signs
 *    that. It works identically on both wallets, so there is one path rather
 *    than two.
 * 2. **Broadcast is a capability, not an assumption.** When a wallet cannot
 *    relay, the adapter falls back to Esplora. The caller never has to know
 *    which happened.
 *
 * The inscription context is passed whenever we have one; XCP Wallet requires
 * it to approve a commit at all, and Horizon ignores an unknown field.
 */

import { Address } from "@scure/btc-signer";

export type WalletId = "xcp" | "horizon";

export interface WalletAccount {
  address: string;
  /** Compressed public key, hex. The envelope leaf is re-keyed to its x-only half. */
  publicKey: string;
  /** `p2tr`, `p2wpkh`, `p2pkh`… Minting requires `p2tr`. */
  addressType: string;
}

export interface InscriptionContext {
  /** The re-keyed tapleaf, hex. */
  revealScript: string;
  /** The BIP-341 NUMS internal key, hex. */
  tapInternalKey: string;
}

/**
 * A commit, as the wallet needs to see it: the envelope it funds, and the
 * single output it pays.
 *
 * Both halves are here because the wallets check different ones, and XCP
 * Wallet checks a different one depending on the envelope — see
 * {@link WalletAdapter.signCommit}.
 */
export interface CommitContext extends InscriptionContext {
  /** The commit address the leaf derives to. */
  address: string;
  /** Exactly what that output is paid, in satoshis. */
  valueSats: number;
  /** The asset being inscribed, for the wallet's own dialog. */
  asset: string;
}

export interface WalletCapabilities {
  /** Can relay a signed transaction itself. When false, the adapter uses Esplora. */
  broadcasts: boolean;
  /** Requires an inscription context before it will sign a commit. */
  requiresInscriptionContext: boolean;
  /**
   * The wallet's inscription check can only read an **ord** envelope.
   *
   * Its verifier is an ord-envelope parser: it requires the leaf to open
   * `OP_FALSE OP_IF "ord"`, and reads the metaprotocol (tag 7), the MIME type
   * (tag 1) and the Counterparty message out of ord's CBOR metadata (tag 5).
   * Core's native envelope goes straight to its data after `OP_IF`, so that
   * parser gives up at the third opcode.
   *
   * This is not a limit on what can be minted — a native commit goes through
   * the wallet's plain-payment door instead ({@link WalletAdapter.signCommit})
   * — but it does decide how much the wallet can verify for itself, so the
   * form says which of the two the person is about to approve.
   */
  verifiesOrdEnvelopeOnly: boolean;
  /** Proves address ownership on connect (BIP-322). Horizon signs BIP-137 instead. */
  bip322: boolean;
}

export interface WalletAdapter {
  readonly id: WalletId;
  readonly name: string;
  /** Where to get it, for the not-installed state. */
  readonly installUrl: string;

  /** Whether the extension is present in this page right now. */
  detect(): boolean;

  /** Prompt for access. Resolves the account the user approved. */
  connect(): Promise<WalletAccount>;

  /** The approved account without prompting, or null if there is none. */
  silentAccount(): Promise<WalletAccount | null>;

  disconnect(): Promise<void>;

  /**
   * Sign a PSBT and return the signed PSBT as hex, unfinalized.
   *
   * `signInputs` maps an address to the input indices it should sign, which is
   * the shape both wallets take.
   */
  signPsbt(
    psbtHex: string,
    signInputs: Record<string, number[]>,
    inscription?: InscriptionContext,
  ): Promise<string>;

  /**
   * Sign the commit.
   *
   * A commit is the one transaction in a mint that carries no Counterparty
   * message: it pays an address, and everything that makes it a counter is in
   * the reveal it commits to. Each wallet has its own way of being satisfied
   * about that, and this is where that difference lives.
   *
   * XCP Wallet has two doors. For an **ord** envelope its inscription check
   * reads the leaf and proves the commit itself — the best case, and the only
   * one where the wallet can tell the person what they are inscribing. For
   * Core's **native** envelope that parser reads nothing, so the commit goes
   * through the plain-payment door instead: the site declares the address and
   * the exact satoshis, and the wallet refuses anything that does not match
   * that declaration to the satoshi. Less is proven — the wallet cannot see
   * the envelope — but the payment is still checked against a statement made
   * before it was signed, and the leaf names the signer's own key either way.
   *
   * Horizon Wallet has no such gate and signs the PSBT.
   */
  signCommit(psbtHex: string, signInputs: Record<string, number[]>, commit: CommitContext): Promise<string>;

  /** Relay a finalized raw transaction. Returns the txid. */
  broadcast(rawHex: string): Promise<string>;

  readonly capabilities: WalletCapabilities;
}

/** Thrown when the user declines, so callers can tell it from a real failure. */
export class UserRejectedError extends Error {
  constructor(message = "You cancelled the request in your wallet.") {
    super(message);
    this.name = "UserRejectedError";
  }
}

/** Thrown when the wallet is present but the site is not connected to it. */
export class NotConnectedError extends Error {
  constructor(message = "The wallet is locked, or this site is not connected.") {
    super(message);
    this.name = "NotConnectedError";
  }
}

/**
 * Minting needs a taproot address: the commit output pays a taproot script
 * whose leaf names the signer's own key, and only a p2tr account can produce
 * that key. Checked before anything is composed, because the alternative is a
 * failure after the user has already approved a payment.
 */
export function requiresTaproot(account: WalletAccount | null): string | null {
  if (!account) return "Connect a wallet first.";
  if (account.addressType !== "p2tr") {
    return `Minting needs a taproot address; this one is ${account.addressType}. Switch to a taproot account in your wallet.`;
  }
  return null;
}

/**
 * The x-only taproot OUTPUT key behind a bc1p address — what the envelope leaf
 * must name.
 *
 * It has to come from the address, not from the public key the wallet reports.
 * Both wallets report the *derived* key for the account (BIP86's internal
 * key); the address's witness program is that key **tweaked**, and the two are
 * different 32 bytes. XCP Wallet verifies the leaf against exactly this value
 * — `Address().decode(signerAddress).pubkey` — before it will approve a commit
 * that moves BTC for a reason the bytes alone cannot prove, and it signs the
 * reveal with the tweaked private key that matches it. A leaf naming the
 * untweaked key is refused as "not spendable by your key", and under the
 * blanket block that follows it reads as "Not a Counterparty Transaction".
 */
export function taprootOutputKey(address: string): Uint8Array | null {
  try {
    const decoded = Address().decode(address) as { type: string; pubkey?: Uint8Array };
    return decoded.type === "tr" && decoded.pubkey?.length === 32 ? decoded.pubkey : null;
  } catch {
    return null;
  }
}
