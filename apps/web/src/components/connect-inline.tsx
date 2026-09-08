"use client";

import { useWallet } from "@/lib/wallet/wallet-context";
import { copy } from "@content/copy";

/**
 * The connect step, where the action is.
 *
 * Both forms used to show a *disabled* "connect a wallet first" button, which
 * states the problem and offers no way out of it — the only fix was in the
 * header, which is not where the person is looking. This puts the wallets in
 * the place they are already trying to press.
 */
export function ConnectInline() {
  const { available, connect, connecting, error } = useWallet();

  return (
    <div className="rounded-2xl border border-line bg-card p-5">
      <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
        {copy.wallet.chooseLabel}
      </div>
      <div className="flex flex-col gap-2">
        {available.map(({ adapter, installed }) => (
          <button
            key={adapter.id}
            onClick={() =>
              installed
                ? void connect(adapter.id)
                : window.open(adapter.installUrl, "_blank", "noopener,noreferrer")
            }
            disabled={connecting !== null}
            className="flex items-center justify-between gap-4 rounded-xl border border-line px-4 py-3 text-left transition-colors hover:border-copper disabled:opacity-50"
          >
            <span className="font-mono text-sm text-ink">{adapter.name}</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-copper2">
              {connecting === adapter.id ? copy.wallet.connecting : installed ? copy.wallet.connect : copy.wallet.install}
            </span>
          </button>
        ))}
      </div>
      {error && <p className="mt-3 font-mono text-[11px] leading-relaxed text-bad">{error}</p>}
      <p className="mt-3 text-[11px] leading-relaxed text-faint">{copy.wallet.chooseNote}</p>
    </div>
  );
}
