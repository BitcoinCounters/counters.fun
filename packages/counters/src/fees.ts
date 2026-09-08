/**
 * Fee arithmetic, in the units the node uses.
 *
 * Counterparty takes `sat_per_vbyte` as a float and applies `ceil(rate ×
 * vsize)` to the commit; for the reveal it funds `max(ceil(rate × vsize) +
 * outputs, 330)` into the commit output, 330 being the segwit dust floor. It
 * will happily compose at 0 sat/vB — so the floor against zero lives here,
 * not in the node. Rates below 1 sat/vB are legitimate: Bitcoin Core 29.1+
 * defaults `minrelaytxfee` to 0.1 sat/vB, this site's node runs 0, and the
 * public relays used as fallback accept 0.1.
 */

export const SEGWIT_DUST = 330;
export const REGULAR_DUST = 546;
/** Three decimals is plenty: the node multiplies by a vsize in the hundreds. */
export const RATE_DECIMALS = 3;
/** Never zero — Core would compose a 0-fee commit. */
export const HARD_MIN_RATE = 0.001;
export const HARD_MAX_RATE = 10_000;

export const vbytesOf = (weight: number): number => Math.ceil(weight / 4);
export const feeFor = (vbytes: number, rate: number): number => Math.ceil(vbytes * rate);
export const effectiveRate = (fee: number, vbytes: number): number => (vbytes > 0 ? fee / vbytes : 0);

/**
 * What a reveal pays. `weight` is the reveal's true weight (Core's plus the
 * SIGHASH_ALL flag byte, see `revealWeightOf`); `revealOutputs` the value of
 * its outputs (0 for the native envelope, 546 for the ord one). Small
 * reveals at low rates land on the 330-sat commit floor and pay more per
 * vbyte than asked — never less.
 */
export function revealFeeFor(weight: number, rate: number, revealOutputs: number): number {
  const commitValue = Math.max(feeFor(vbytesOf(weight), rate) + revealOutputs, SEGWIT_DUST);
  return commitValue - revealOutputs;
}

export type ParsedRate = { ok: true; rate: number } | { ok: false; reason: "empty" | "nan" | "zero" | "too-high" };

const RATE_SHAPE = /^\d*\.?\d*$/;

export function parseFeeRate(text: string): ParsedRate {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === ".") return { ok: false, reason: "empty" };
  if (!RATE_SHAPE.test(trimmed)) return { ok: false, reason: "nan" };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { ok: false, reason: "nan" };
  const factor = 10 ** RATE_DECIMALS;
  const rate = Math.round(value * factor) / factor;
  if (rate < HARD_MIN_RATE) return { ok: false, reason: "zero" };
  if (rate > HARD_MAX_RATE) return { ok: false, reason: "too-high" };
  return { ok: true, rate };
}

/** Up to three decimals, trailing zeros dropped, never exponent notation. */
export function formatFeeRate(rate: number): string {
  return rate.toFixed(RATE_DECIMALS).replace(/\.?0+$/, "");
}

/** bitcoind's sat/kB (as Counterparty reports it) → sat/vB, or null when there is no estimate. */
export function satPerKbToRate(perKb: number): number | null {
  if (!Number.isFinite(perKb) || perKb <= 0) return null;
  return Math.round((perKb / 1000) * 10 ** RATE_DECIMALS) / 10 ** RATE_DECIMALS;
}

/** bitcoind's native BTC/kvB (estimatesmartfee.feerate, mempoolminfee) → sat/vB. */
export function btcPerKvbToRate(btcPerKvb: number): number | null {
  if (!Number.isFinite(btcPerKvb) || btcPerKvb < 0) return null;
  return Math.round((btcPerKvb * 1e8) / 1000 * 10 ** RATE_DECIMALS) / 10 ** RATE_DECIMALS;
}

export type RateVerdict = "ok" | "below-relay-min" | "below-mempool-min";

/** bitcoind rejects strictly below its minimums, so equal passes. */
export function judgeRate(rate: number, floor: { minRelay: number; mempoolMin: number }): RateVerdict {
  if (rate < floor.mempoolMin) return "below-mempool-min";
  if (rate < floor.minRelay) return "below-relay-min";
  return "ok";
}

export type Envelope = "counterparty" | "counterparty/ord";

export interface MintEstimate {
  revealWeight: number;
  revealVbytes: number;
  revealOutputs: number;
  commitVbytes: number;
  commitFee: number;
  revealFee: number;
  revealEffective: number;
  /** True when the 330-sat commit floor, not the rate, set the reveal fee. */
  dustFloored: boolean;
  totalFee: number;
  /** What the wallet must hold: both fees plus any reveal output it funds. */
  totalSats: number;
}

/**
 * Before compose. Frame sizes are measured from Core: a 1,500-byte body
 * composed to 1,959 WU native and 2,144 WU ord; a one-input P2TR commit
 * with commit and change outputs is 155 vB.
 */
export function estimateMint(bytes: number, rate: number, envelope: Envelope): MintEstimate {
  const revealWeight = bytes + (envelope === "counterparty/ord" ? 650 : 460);
  const revealVbytes = vbytesOf(revealWeight);
  const revealOutputs = envelope === "counterparty/ord" ? REGULAR_DUST : 0;
  const commitVbytes = 155;
  const commitFee = feeFor(commitVbytes, rate);
  const revealFee = revealFeeFor(revealWeight, rate, revealOutputs);
  return {
    revealWeight,
    revealVbytes,
    revealOutputs,
    commitVbytes,
    commitFee,
    revealFee,
    revealEffective: effectiveRate(revealFee, revealVbytes),
    dustFloored: feeFor(revealVbytes, rate) + revealOutputs < SEGWIT_DUST,
    totalFee: commitFee + revealFee,
    totalSats: commitFee + revealFee + revealOutputs,
  };
}
