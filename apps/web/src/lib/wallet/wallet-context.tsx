"use client";

/**
 * Wallet state, over whichever adapter the user picked.
 *
 * Deliberately thinner than the launchpad context this replaces. That one
 * carried a BIP-322 connection proof and verified it — a good design when
 * every wallet signs BIP-322, and unusable here: Horizon Wallet signs messages
 * with ECDSA/BIP-137 and explicitly refuses BIP-322
 * (`METHOD_NOT_SUPPORTED: "Horizon Wallet signs messages with ECDSA (BIP-137);
 * BIP322 is not supported"`). Requiring a proof would have meant supporting one
 * wallet and rejecting the other, so connection here is an address plus the
 * public key that backs it, and nothing is claimed about ownership that the
 * chain will not settle anyway.
 *
 * The chosen wallet is remembered so a reload reconnects silently. It is a
 * preference, not a credential — every adapter re-asks its extension on load
 * and simply reports nothing if the origin was never approved.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  UserRejectedError,
  type WalletAccount,
  type WalletAdapter,
  type WalletId,
} from "@/lib/wallet/adapter";
import { horizonAdapter } from "@/lib/wallet/adapters/horizon";
import { xcpAdapter } from "@/lib/wallet/adapters/xcp";

export const ADAPTERS: WalletAdapter[] = [xcpAdapter, horizonAdapter];

const REMEMBERED = "counters.fun:wallet";

interface WalletContextValue {
  /** The connected adapter, or null. */
  adapter: WalletAdapter | null;
  account: WalletAccount | null;
  address: string | null;
  publicKey: string | null;

  /** Every adapter, with whether its extension is present right now. */
  available: { adapter: WalletAdapter; installed: boolean }[];

  connecting: WalletId | null;
  error: string | null;

  connect: (id: WalletId) => Promise<void>;
  disconnect: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [adapter, setAdapter] = useState<WalletAdapter | null>(null);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [connecting, setConnecting] = useState<WalletId | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Which extensions are actually present.
   *
   * Both inject at document_start but a single render is still a race — the
   * XCP provider announces itself with an event, and Horizon's
   * `window.btc_providers` entry can land after hydration. Rather than resolve
   * that per-wallet, the roster is re-read a few times over the first couple of
   * seconds and then left alone.
   */
  const [installed, setInstalled] = useState<Record<WalletId, boolean>>({
    xcp: false,
    horizon: false,
  });

  useEffect(() => {
    let cancelled = false;
    const scan = () => {
      if (cancelled) return;
      // Same object when the answer has not changed: this state is a
      // dependency, and five fresh objects over two seconds would re-run
      // everything that watches it five times for no news.
      setInstalled((prev) => {
        const next = { xcp: xcpAdapter.detect(), horizon: horizonAdapter.detect() };
        return prev.xcp === next.xcp && prev.horizon === next.horizon ? prev : next;
      });
    };
    scan();
    const timers = [100, 400, 1000, 2000].map((ms) => setTimeout(scan, ms));
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, []);

  // Reconnect silently to the wallet last used, if this origin is still
  // approved there. Never prompts.
  const restored = useRef(false);
  // Set on mount, not merely initialised: React remounts a component in
  // development, and a ref that is only ever cleared stays cleared through the
  // second mount — which would discard every restore instead of the stale one.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (restored.current) return;
    const remembered = typeof localStorage === "undefined" ? null : localStorage.getItem(REMEMBERED);
    if (!remembered) return;

    const found = ADAPTERS.find((a) => a.id === remembered);
    if (!found || !found.detect()) return;

    found
      .silentAccount()
      .then((acct) => {
        // Only unmounting may discard this. The guard used to be per-run, and
        // the roster above re-ran this effect while the wallet was still
        // answering: the account arrived, was dropped as stale, and the ref
        // said the restore had already happened — so a connected wallet
        // rendered as "connect", every time the extension took longer to
        // answer than the gap between two detection passes.
        if (!mounted.current || !acct) return;
        restored.current = true;
        setAdapter(found);
        setAccount(acct);
      })
      .catch(() => {
        // A wallet that will not answer silently is simply not connected.
      });
  }, [installed]);

  const connect = useCallback(async (id: WalletId) => {
    const found = ADAPTERS.find((a) => a.id === id);
    if (!found) return;

    setConnecting(id);
    setError(null);
    try {
      const acct = await found.connect();
      setAdapter(found);
      setAccount(acct);
      try {
        localStorage.setItem(REMEMBERED, id);
      } catch {
        // A private window with storage disabled just will not reconnect.
      }
    } catch (cause) {
      // A cancellation is not an error worth shouting about.
      setError(cause instanceof UserRejectedError ? null : (cause as Error).message);
    } finally {
      setConnecting(null);
    }
  }, []);

  const disconnect = useCallback(async () => {
    await adapter?.disconnect();
    setAdapter(null);
    setAccount(null);
    setError(null);
    try {
      localStorage.removeItem(REMEMBERED);
    } catch {
      // Nothing to forget.
    }
  }, [adapter]);

  const value = useMemo<WalletContextValue>(
    () => ({
      adapter,
      account,
      address: account?.address ?? null,
      publicKey: account?.publicKey ?? null,
      available: ADAPTERS.map((a) => ({ adapter: a, installed: installed[a.id] })),
      connecting,
      error,
      connect,
      disconnect,
    }),
    [adapter, account, installed, connecting, error, connect, disconnect],
  );

  return <WalletContext value={value}>{children}</WalletContext>;
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}
