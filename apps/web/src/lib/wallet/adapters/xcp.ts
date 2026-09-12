/**
 * XCP Wallet — `window.xcpwallet`.
 *
 * Wraps the SDK already in this repo (`lib/wallet/sdk`), which carries the
 * detection race, the MV3 idle-worker retries and the error codes. This file
 * only maps that surface onto the shared adapter.
 *
 * The one thing that has no Horizon equivalent is the inscription context. XCP
 * Wallet refuses to sign BTC movement it cannot account for, and its escape
 * hatch for a commit demands the BIP-341 NUMS internal key plus the signer's
 * own taproot output key in the leaf — which is exactly why the envelope is
 * re-keyed before signing. Without it a commit is simply rejected.
 */

import { broadcastTransaction } from "@/lib/wallet/broadcast";
import { XcpWallet, detectProvider, getProvider } from "@/lib/wallet/sdk";
import {
  NotConnectedError,
  UserRejectedError,
  type WalletAccount,
  type WalletAdapter,
} from "@/lib/wallet/adapter";

const INSTALL_URL =
  "https://chromewebstore.google.com/detail/xcp-wallet/nicpjdbehgcjbjfjkobcidnfmfpijohg";

async function sdk(): Promise<XcpWallet> {
  const provider = getProvider() ?? (await detectProvider(3000));
  if (!provider) throw new NotConnectedError("XCP Wallet is not available on this page.");
  return new XcpWallet(provider);
}

function translate(cause: unknown): Error {
  const code = (cause as { code?: number })?.code;
  if (code === 4001) return new UserRejectedError();
  if (code === 4100) return new NotConnectedError();
  return cause instanceof Error ? cause : new Error(String(cause));
}

/**
 * Reshape the wallet's address list.
 *
 * `xcp_getAddresses` returns the active address always, and the paired legacy
 * and segwit ones only when the site has permission. Taproot is preferred for
 * the same reason as in the Horizon adapter — it is the only account that can
 * hold an inscription commit.
 */
async function account(wallet: XcpWallet, address: string): Promise<WalletAccount> {
  const addresses = await wallet.getAddresses().catch(() => null);
  const candidates = [addresses?.active, addresses?.segwit, addresses?.legacy].filter(
    (a): a is NonNullable<typeof a> => a != null,
  );

  const match =
    candidates.find((a) => a.address === address) ??
    candidates.find((a) => a.type === "p2tr") ??
    candidates[0];

  if (!match) {
    // Connected, but the wallet would not say which key backs the address. The
    // envelope cannot be re-keyed without it, so minting will refuse later —
    // better to carry an honest empty publicKey than to invent one.
    return { address, publicKey: "", addressType: "unknown" };
  }
  return { address: match.address, publicKey: match.publicKey, addressType: match.type };
}

export const xcpAdapter: WalletAdapter = {
  id: "xcp",
  name: "XCP Wallet",
  installUrl: INSTALL_URL,

  detect: () => typeof window !== "undefined" && window.xcpwallet != null,

  async connect() {
    try {
      const wallet = await sdk();
      const { accounts } = await wallet.connect();
      const address = accounts[0];
      if (!address) throw new NotConnectedError("XCP Wallet returned no accounts.");
      return await account(wallet, address);
    } catch (cause) {
      throw translate(cause);
    }
  },

  async silentAccount() {
    try {
      const wallet = await sdk();
      const accounts = await wallet.getAccounts();
      const address = accounts[0];
      return address ? await account(wallet, address) : null;
    } catch {
      return null;
    }
  },

  async disconnect() {
    try {
      const wallet = await sdk();
      await wallet.disconnect();
    } catch {
      // Best effort; the app forgets the account either way.
    }
  },

  async signPsbt(psbtHex, signInputs, inscription) {
    try {
      const wallet = await sdk();
      // `sighashTypes` is deliberately not sent: the wallet rejects `[0]`
      // outright, and every input in these PSBTs already declares SIGHASH_ALL.
      return await wallet.signPsbt(psbtHex, signInputs, undefined, inscription);
    } catch (cause) {
      throw translate(cause);
    }
  },

  async broadcast(rawHex) {
    try {
      const wallet = await sdk();
      return await wallet.broadcastTransaction(rawHex);
    } catch (cause) {
      // The wallet relays through its own backend, whose fee policy is not
      // ours. A sub-1 sat/vB transaction it refuses is still fine for this
      // site's node; anything else is a real failure.
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/min relay fee|mempool min fee|fee.*too low|insufficient fee/i.test(message)) {
        return broadcastTransaction(rawHex);
      }
      throw translate(cause);
    }
  },

  capabilities: {
    broadcasts: true,
    requiresInscriptionContext: true,
    // Its `verifyInscriptionCommit` parses ord envelopes only.
    ordEnvelopeOnly: true,
    bip322: true,
  },
};
