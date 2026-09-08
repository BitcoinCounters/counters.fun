"use client";

import type { ReactNode } from "react";
import { WalletProvider } from "@/lib/wallet/wallet-context";

/** The client boundary. Kept to one file so pages stay server components. */
export function AppProviders({ children }: { children: ReactNode }) {
  return <WalletProvider>{children}</WalletProvider>;
}
