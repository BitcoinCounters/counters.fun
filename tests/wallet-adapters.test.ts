/**
 * The two wallets, against the contract.
 *
 * Both are browser extensions, so nothing here can prove a real signature. What
 * it can pin is the wire shape each adapter speaks — and that is precisely
 * where a two-wallet integration breaks, silently, in a way you only discover
 * after a user has approved a payment.
 *
 * The Horizon expectations are read from the shipped extension (v2.3.1,
 * `horizon-provider.js`), not guessed: its house RPC takes `signPsbt({hex,
 * signInputs, sighashTypes})` and returns `{hex}`, while its sats-connect layer
 * takes `{psbt}` in base64. Sending the wrong one silently routes to the wrong
 * dialect.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { requiresTaproot, taprootOutputKey } from "../apps/web/src/lib/wallet/adapter";
import { bytesToHex } from "../apps/web/src/lib/inscribe/envelope";

/* -------------------------------------------------------------------- */
/* Shared contract                                                      */
/* -------------------------------------------------------------------- */

describe("the adapter contract", () => {
  /**
   * BIP-86's own test vector, and the reason the leaf key comes from the
   * address. The wallet reports the derived (internal) key; the address's
   * witness program is that key tweaked, and XCP Wallet checks the envelope
   * leaf against the tweaked one before it will approve a commit.
   */
  it("reads the taproot OUTPUT key out of a bc1p address, not the internal one", () => {
    const address = "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr";
    const internalKey = "cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115";

    const key = taprootOutputKey(address);
    expect(key).not.toBeNull();
    expect(key).toHaveLength(32);
    expect(bytesToHex(key!)).toBe("a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c");
    expect(bytesToHex(key!)).not.toBe(internalKey);
  });

  it("has no output key for an address that is not taproot", () => {
    expect(taprootOutputKey("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toBeNull();
    expect(taprootOutputKey("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2")).toBeNull();
    expect(taprootOutputKey("not an address")).toBeNull();
  });

  it("refuses to mint from a non-taproot account", () => {
    expect(requiresTaproot(null)).toMatch(/connect/i);
    expect(
      requiresTaproot({ address: "bc1q…", publicKey: "02".padEnd(66, "a"), addressType: "p2wpkh" }),
    ).toMatch(/taproot/i);
    expect(
      requiresTaproot({ address: "1abc", publicKey: "02".padEnd(66, "a"), addressType: "p2pkh" }),
    ).toMatch(/taproot/i);
    expect(
      requiresTaproot({ address: "bc1p…", publicKey: "02".padEnd(66, "a"), addressType: "p2tr" }),
    ).toBeNull();
  });
});

/* -------------------------------------------------------------------- */
/* Horizon                                                              */
/* -------------------------------------------------------------------- */

describe("Horizon Wallet", () => {
  let calls: { method: string; params: unknown }[];

  beforeEach(() => {
    calls = [];
    vi.resetModules();
    // The provider surface the real extension defines on window.
    (globalThis as Record<string, unknown>).window = {
      HorizonWalletProvider: {
        request(method: string, params?: unknown) {
          calls.push({ method, params });
          if (method === "getAddresses") {
            return Promise.resolve({
              result: {
                addresses: [
                  { address: "bc1qpay", publicKey: "02" + "11".repeat(32), type: "p2wpkh" },
                  { address: "bc1ptap", publicKey: "02" + "22".repeat(32), type: "p2tr" },
                ],
                network: "mainnet",
              },
            });
          }
          if (method === "signPsbt") {
            return Promise.resolve({ result: { hex: "70736274ff00" } });
          }
          return Promise.resolve({ result: null });
        },
      },
    };
  });

  it("is detected through the named getter and through WBIP-004 discovery", async () => {
    const { horizonAdapter } = await import("../apps/web/src/lib/wallet/adapters/horizon");
    expect(horizonAdapter.detect()).toBe(true);

    (globalThis as Record<string, unknown>).window = {
      btc_providers: [{ id: "HorizonWalletProvider", name: "Horizon Wallet" }],
    };
    expect(horizonAdapter.detect()).toBe(true);

    (globalThis as Record<string, unknown>).window = {};
    expect(horizonAdapter.detect()).toBe(false);
  });

  it("prefers the taproot account, which is the only one that can mint", async () => {
    const { horizonAdapter } = await import("../apps/web/src/lib/wallet/adapters/horizon");
    const account = await horizonAdapter.connect();

    // Not simply the first address returned.
    expect(account.address).toBe("bc1ptap");
    expect(account.addressType).toBe("p2tr");
    expect(requiresTaproot(account)).toBeNull();
  });

  it("signs through the house API — hex in, hex out, never the base64 dialect", async () => {
    const { horizonAdapter } = await import("../apps/web/src/lib/wallet/adapters/horizon");
    const signed = await horizonAdapter.signPsbt("70736274ff", { "bc1ptap": [0] });

    expect(signed).toBe("70736274ff00");

    const call = calls.find((c) => c.method === "signPsbt")!;
    const params = call.params as Record<string, unknown>;
    // `hex` routes to the house API; `psbt` would route to sats-connect and
    // come back base64.
    expect(params.hex).toBe("70736274ff");
    expect(params.psbt).toBeUndefined();
    expect(params.signInputs).toEqual({ "bc1ptap": [0] });
    // Without 0x01 any non-taproot input throws "Sighash type is not allowed".
    expect(params.sighashTypes).toEqual([0x00, 0x01]);
  });

  it("does not send the inscription context — that is an XCP Wallet concept", async () => {
    const { horizonAdapter } = await import("../apps/web/src/lib/wallet/adapters/horizon");
    await horizonAdapter.signPsbt(
      "70736274ff",
      { "bc1ptap": [0] },
      { revealScript: "00", tapInternalKey: "11" },
    );

    const params = calls.find((c) => c.method === "signPsbt")!.params as Record<string, unknown>;
    expect(params.inscription).toBeUndefined();
  });

  it("declares that it cannot broadcast, so the caller falls back", async () => {
    const { horizonAdapter } = await import("../apps/web/src/lib/wallet/adapters/horizon");
    expect(horizonAdapter.capabilities.broadcasts).toBe(false);
    expect(horizonAdapter.capabilities.requiresInscriptionContext).toBe(false);
    // Horizon signs ECDSA/BIP-137 and refuses BIP-322 outright, which is why
    // connection here carries no ownership proof.
    expect(horizonAdapter.capabilities.bip322).toBe(false);
  });

  it("tells a user cancellation apart from a wallet failure", async () => {
    const { horizonAdapter } = await import("../apps/web/src/lib/wallet/adapters/horizon");

    // The extension sends a plain-string `.error` only for a user rejection.
    (globalThis as Record<string, unknown>).window = {
      HorizonWalletProvider: {
        request: () => Promise.reject({ error: "User rejected the request" }),
      },
    };
    await expect(horizonAdapter.signPsbt("00", {})).rejects.toThrow(/rejected/i);
    await expect(horizonAdapter.signPsbt("00", {})).rejects.toHaveProperty(
      "name",
      "UserRejectedError",
    );

    // An object `.error` is a real failure, not a cancellation.
    (globalThis as Record<string, unknown>).window = {
      HorizonWalletProvider: {
        request: () => Promise.reject({ error: { code: -32603, message: "boom" } }),
      },
    };
    await expect(horizonAdapter.signPsbt("00", {})).rejects.toHaveProperty("name", "Error");
  });
});

/* -------------------------------------------------------------------- */
/* Esplora relay                                                        */
/* -------------------------------------------------------------------- */

describe("the Esplora fallback Horizon depends on", () => {
  beforeEach(() => {
    vi.resetModules();
    (globalThis as Record<string, unknown>).window = {};
  });

  it("relays through the local node, treating an already-known transaction as success", async () => {
    const { broadcastViaNode, txidOf } = await import("../apps/web/src/lib/wallet/broadcast");
    // MEMENOME's own deploy — long confirmed. Bitcoin Core answers
    // "Transaction outputs already in utxo set" and the txid is recomputed.
    const CP = process.env.COUNTERPARTY_API_BASE ?? "http://127.0.0.1:4000";
    const txid = "5dfbc6ffaae2939838c411edcb99952c768f9375a3fa090f42ebe6e";
    const info = await (await fetch(`${CP}/v2/assets/MEMENOME/fairminters`)).json();
    const hash: string = info.result[0].tx_hash;
    const raw = (await (await fetch(`${CP}/v2/bitcoin/transactions/${hash}?result_format=hex`)).json()).result;
    expect(txidOf(raw)).toBe(hash);
    await expect(broadcastViaNode(raw, `${CP}/v2`)).resolves.toBe(hash);
    void txid;
  });

  it("refuses bytes that are not a transaction, with the node's reason", async () => {
    const { broadcastViaNode } = await import("../apps/web/src/lib/wallet/broadcast");
    const CP = process.env.COUNTERPARTY_API_BASE ?? "http://127.0.0.1:4000";
    await expect(broadcastViaNode("deadbeef", `${CP}/v2`)).rejects.toThrow(/could not relay/i);
  });

  it("declares the capabilities the mint flow branches on", async () => {
    const { xcpAdapter } = await import("../apps/web/src/lib/wallet/adapters/xcp");
    // It relays its own transactions, and it will not sign a commit without
    // the inscription context.
    expect(xcpAdapter.capabilities.broadcasts).toBe(true);
    expect(xcpAdapter.capabilities.requiresInscriptionContext).toBe(true);
    // And that context is only read for an ord envelope, so the native one is
    // not a smaller choice here — it is an unsignable commit.
    expect(xcpAdapter.capabilities.ordEnvelopeOnly).toBe(true);
    expect(xcpAdapter.detect()).toBe(false);

    const { horizonAdapter } = await import("../apps/web/src/lib/wallet/adapters/horizon");
    expect(horizonAdapter.capabilities.ordEnvelopeOnly).toBe(false);
  });
});
