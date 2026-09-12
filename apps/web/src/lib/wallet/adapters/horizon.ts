/**
 * Horizon Wallet (Unspendable Labs) — `window.HorizonWalletProvider`.
 *
 * Verified against the shipped extension, v2.3.1. The provider registers
 * itself two ways: WBIP-004 discovery (`window.btc_providers.push({ id:
 * "HorizonWalletProvider", … })`) and a `window.HorizonWalletProvider` getter.
 * Everything goes through one `request(method, params)`.
 *
 * It speaks two dialects at once, and which one answers is decided by the
 * *shape of the params*, not the method name:
 *
 * - `getAddresses` with `purposes` → sats-connect; without → the house API.
 * - `signPsbt` with `psbt` (base64) → sats-connect; with `hex` → the house API.
 *
 * This adapter uses the **house API** throughout. It takes and returns hex,
 * which is what `@scure/btc-signer` produces and what the rest of this codebase
 * passes around; going through the sats-connect layer would mean base64 in both
 * directions for no gain. The house calls also resolve `{ result }` and reject
 * on failure, which is ordinary promise behaviour — the sats-connect layer
 * deliberately *resolves* errors as JSON-RPC envelopes instead.
 *
 * Two capabilities it does not have:
 *
 * - **No broadcast.** `sendTransfer` sends BTC to an address; there is no raw
 *   relay. Signed bytes go to Esplora instead.
 * - **No raw-transaction signing.** Only PSBTs, which is why every flow in this
 *   app builds one.
 *
 * It does handle `tapLeafScript` / `tapInternalKey`, so it can sign the reveal's
 * script-path spend — the thing that actually matters for minting a counter.
 */

import {
  NotConnectedError,
  UserRejectedError,
  type InscriptionContext,
  type WalletAccount,
  type WalletAdapter,
} from "@/lib/wallet/adapter";
import { broadcastTransaction } from "@/lib/wallet/broadcast";

interface HorizonProvider {
  request(method: string, params?: unknown): Promise<{ result: unknown }>;
}

interface HouseAddress {
  address: string;
  publicKey: string;
  /** `p2tr`, `p2wpkh`, `p2pkh`. */
  type: string;
}

declare global {
  interface Window {
    HorizonWalletProvider?: HorizonProvider;
    btc_providers?: { id: string; name: string; icon?: string; methods?: string[] }[];
  }
}

const INSTALL_URL =
  "https://chromewebstore.google.com/detail/horizon-wallet/bnmgkjlaommgappfckljlelgahnbngme";

function provider(): HorizonProvider {
  const p =
    typeof window !== "undefined"
      ? window.HorizonWalletProvider ??
        // Fall back to WBIP-004 discovery: a page that loaded before injection
        // may see the array populated even if the named getter is not yet set.
        (window.btc_providers?.some((x) => x.id === "HorizonWalletProvider")
          ? window.HorizonWalletProvider
          : undefined)
      : undefined;
  if (!p) throw new NotConnectedError("Horizon Wallet is not available on this page.");
  return p;
}

/**
 * Turn a house rejection into something typed.
 *
 * The provider rejects with the raw message envelope. A user cancellation
 * arrives as a plain-string `.error`; a validation failure arrives as an
 * object. That distinction is the extension's own convention, so it is the
 * only reliable way to tell "they said no" from "it broke".
 */
function translate(cause: unknown): Error {
  const e = cause as { error?: unknown; message?: string };
  if (e && typeof e === "object" && e.error != null) {
    if (typeof e.error === "string") return new UserRejectedError(e.error);
    const obj = e.error as { code?: number; message?: string };
    if (obj.code === -32000) return new UserRejectedError(obj.message);
    if (obj.code === -32002) return new NotConnectedError(obj.message);
    return new Error(obj.message ?? "Horizon Wallet rejected the request.");
  }
  return new Error(e?.message ?? "Horizon Wallet rejected the request.");
}

async function house<T>(method: string, params?: unknown): Promise<T> {
  try {
    const { result } = await provider().request(method, params);
    return result as T;
  } catch (cause) {
    throw translate(cause);
  }
}

/**
 * Prefer the taproot account.
 *
 * Horizon returns every derived address at once. Minting needs p2tr — the
 * commit pays a taproot script committing to this key — so that is what is
 * chosen when present, rather than whichever address happens to be first.
 */
function pick(addresses: HouseAddress[]): WalletAccount {
  const taproot = addresses.find((a) => a.type === "p2tr");
  const chosen = taproot ?? addresses[0];
  if (!chosen) throw new NotConnectedError("Horizon Wallet returned no addresses.");
  return { address: chosen.address, publicKey: chosen.publicKey, addressType: chosen.type };
}

export const horizonAdapter: WalletAdapter = {
  id: "horizon",
  name: "Horizon Wallet",
  installUrl: INSTALL_URL,

  detect: () =>
    typeof window !== "undefined" &&
    (window.HorizonWalletProvider != null ||
      (window.btc_providers?.some((p) => p.id === "HorizonWalletProvider") ?? false)),

  async connect() {
    const result = await house<{ addresses: HouseAddress[]; network: string }>("getAddresses");
    return pick(result.addresses);
  },

  /**
   * Horizon has no silent-account call in the house API — `getAddresses` is the
   * approval prompt. `wallet_getAccount` on the sats-connect side does answer
   * silently for an origin that has connected before, so that is what is used,
   * and a wallet that has never seen this origin simply reports nothing rather
   * than popping a prompt the user did not ask for.
   */
  async silentAccount() {
    try {
      const p = provider();
      const res = (await p.request("wallet_getAccount", { addresses: [] })) as unknown as {
        result?: { addresses?: { address: string; publicKey: string; addressType: string }[] };
        error?: unknown;
      };
      const addresses = res?.result?.addresses;
      if (!addresses?.length) return null;
      return pick(
        addresses.map((a) => ({ address: a.address, publicKey: a.publicKey, type: a.addressType })),
      );
    } catch {
      return null;
    }
  },

  async disconnect() {
    try {
      await provider().request("wallet_disconnect", {});
    } catch {
      // Disconnecting is best-effort; the app forgets the account either way.
    }
  },

  /** No gate on a commit: it is an ordinary PSBT to this wallet. */
  async signCommit(psbtHex, signInputs) {
    return horizonAdapter.signPsbt(psbtHex, signInputs);
  },

  async signPsbt(psbtHex, signInputs, _inscription?: InscriptionContext) {
    // Horizon needs no inscription context — it signs a commit as an ordinary
    // PSBT. The parameter is accepted so callers do not have to branch, and
    // deliberately not forwarded: an unrecognised field on the house call would
    // be passed straight through to the Dart signer.
    void _inscription;

    const result = await house<{ hex: string }>("signPsbt", {
      hex: psbtHex,
      signInputs,
      // The house side treats this as a whitelist of permitted sighash types.
      // Both are allowed so a PSBT mixing taproot (SIGHASH_DEFAULT, 0x00) and
      // segwit-v0 (SIGHASH_ALL, 0x01) inputs signs; omitting 0x01 makes any
      // non-taproot input throw "Sighash type is not allowed".
      sighashTypes: [0x00, 0x01],
    });
    if (!result?.hex) throw new Error("Horizon Wallet returned no signed PSBT.");
    return result.hex;
  },

  // No relay of its own — see lib/wallet/broadcast.ts.
  broadcast: (rawHex) => broadcastTransaction(rawHex),

  capabilities: {
    broadcasts: false,
    requiresInscriptionContext: false,
    // No gate at all, so nothing about the envelope reaches it.
    signsOrdEnvelopeOnly: false,
    bip322: false,
  },
};
