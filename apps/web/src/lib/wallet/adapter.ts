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
 * | inscription commit | requires an `inscription` context, and can only read an ord envelope | signs it as an ordinary PSBT |
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

export interface WalletCapabilities {
  /** Can relay a signed transaction itself. When false, the adapter uses Esplora. */
  broadcasts: boolean;
  /** Requires an inscription context before it will sign a commit. */
  requiresInscriptionContext: boolean;
  /**
   * The wallet can only sign a commit whose envelope is the **ord** style.
   *
   * Not a preference — its inscription verifier is an ord-envelope parser. It
   * requires the leaf to open `OP_FALSE OP_IF "ord"`, reads the metaprotocol
   * (tag 7), the MIME type (tag 1) and the Counterparty message out of ord's
   * CBOR metadata (tag 5), and returns nothing for anything else. Core's own
   * native envelope goes straight to its data after `OP_IF`, so the parser
   * refuses it at the third opcode, and the refusal surfaces as the blanket
   * "Blocked: Not a Counterparty Transaction" — a commit carries no
   * Counterparty message of its own to fall back on.
   *
   * So for such a wallet `counterparty native` is not a smaller envelope, it
   * is an unsignable one, and the form offers only `counterparty + ord`.
   */
  ordEnvelopeOnly: boolean;
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
