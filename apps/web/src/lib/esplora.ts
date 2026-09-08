/**
 * Fee context, from nodes on this machine only.
 *
 * Everything the browser learns about fees comes through `/api/fees`, a
 * server route that asks the site's own bitcoind (floors, `estimatesmartfee`
 * at three targets) and falls back to the local mempool backend's precise
 * estimates. No public estimator, no public relay: the operator's node is
 * the only RPC this site speaks to.
 */

export interface FeePreset {
  rate: number;
  blocks: number;
}

export interface FeeContext {
  presets: { fast: FeePreset | null; normal: FeePreset | null; economy: FeePreset | null };
  /** sat/vB the relaying node refuses below. 0 on this site's node. */
  floor: { minRelay: number; mempoolMin: number };
  source: "node" | "mempool" | "none";
}

const NO_CONTEXT: FeeContext = {
  presets: { fast: null, normal: null, economy: null },
  floor: { minRelay: 0, mempoolMin: 0 },
  source: "none",
};

export async function fetchFeeContext(): Promise<FeeContext> {
  try {
    const res = await fetch("/api/fees", { cache: "no-store" });
    const body = (await res.json()) as Partial<FeeContext> & { source: string };
    if ((body.source === "node" || body.source === "mempool") && body.presets) {
      return {
        presets: {
          fast: body.presets.fast ?? null,
          normal: body.presets.normal ?? null,
          economy: body.presets.economy ?? null,
        },
        floor: body.floor ?? { minRelay: 0, mempoolMin: 0 },
        source: body.source,
      };
    }
  } catch {
    // The route answered with nothing usable, or not at all.
  }
  return NO_CONTEXT;
}

/** A ~30-minute rate in sat/vB, or null if nobody would say. */
export async function fetchHalfHourFeeRate(): Promise<number | null> {
  const ctx = await fetchFeeContext();
  return ctx.presets.normal?.rate ?? ctx.presets.fast?.rate ?? null;
}
