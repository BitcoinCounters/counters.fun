"use client";

import { useEffect, useRef, useState } from "react";
import { useWallet } from "@/lib/wallet/wallet-context";
import { trunc } from "@/lib/format";

/**
 * Connect, over either wallet.
 *
 * Two wallets speak Counterparty and the site works with both, so the button
 * opens a chooser rather than assuming one. An extension that is not installed
 * still gets a row — collapsing it to nothing makes the site look like it only
 * supports whatever the visitor already has, and the install link is the useful
 * thing to offer someone who has neither.
 */
export function WalletButton() {
  const { available, account, adapter, connect, disconnect, connecting, error } = useWallet();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  // Connected: show the address, and which wallet it came from.
  if (account && adapter) {
    return (
      <div className="relative" ref={box}>
        <button
          onClick={() => setOpen((v) => !v)}
          title={`${account.address} · ${adapter.name}`}
          className="flex items-center gap-2 rounded-lg border border-copper/50 px-3 py-1.5 font-mono text-[11px] text-copper2 transition-colors hover:border-copper"
        >
          <span className="hidden sm:inline text-faint">{adapter.name.split(" ")[0]}</span>
          {trunc(account.address, 6, 4)}
        </button>
        {open && (
          <Menu>
            <div className="border-b border-line2 px-3 py-2">
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                {adapter.name}
              </div>
              <div className="mt-0.5 break-all font-mono text-[10px] text-dim">
                {account.address}
              </div>
              {/* Minting needs taproot; saying which account is connected is
                  more useful than only complaining once they try. */}
              <div className="mt-1 font-mono text-[10px] text-faint">{account.addressType}</div>
            </div>
            <button
              onClick={() => {
                setOpen(false);
                void disconnect();
              }}
              className="w-full px-3 py-2 text-left font-mono text-[11px] text-dim hover:bg-bg2 hover:text-ink"
            >
              disconnect
            </button>
          </Menu>
        )}
      </div>
    );
  }

  return (
    <div className="relative" ref={box}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`rounded-lg border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors ${
          error
            ? "border-bad/50 text-bad"
            : "border-line text-dim hover:border-copper hover:text-ink"
        }`}
      >
        {connecting ? "connecting…" : error ? "retry" : "connect"}
      </button>

      {open && (
        <Menu>
          {available.map(({ adapter: a, installed }) => (
            <button
              key={a.id}
              onClick={() => {
                if (!installed) {
                  window.open(a.installUrl, "_blank", "noopener,noreferrer");
                  return;
                }
                setOpen(false);
                void connect(a.id);
              }}
              className="flex w-full items-center justify-between gap-4 px-3 py-2.5 text-left hover:bg-bg2"
            >
              <span className="font-mono text-xs text-ink">{a.name}</span>
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-faint">
                {connecting === a.id ? "…" : installed ? "connect" : "install"}
              </span>
            </button>
          ))}
          {error && (
            <div className="border-t border-line2 px-3 py-2 font-mono text-[10px] leading-relaxed text-bad">
              {error}
            </div>
          )}
        </Menu>
      )}
    </div>
  );
}

function Menu({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute right-0 top-full z-50 mt-2 w-60 overflow-hidden rounded-xl border border-line bg-card shadow-[0_10px_30px_-12px_#000]">
      {children}
    </div>
  );
}
