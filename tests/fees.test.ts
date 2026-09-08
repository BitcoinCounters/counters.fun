/**
 * Fee arithmetic against numbers read off the local node (Counterparty Core
 * 11.2.0, bitcoind 28.2): a 155-vB commit, a 452-WU reveal for a 5-byte
 * file, 1,959 WU native / 2,144 WU ord for a 1,500-byte one.
 */
import { describe, expect, it } from "vitest";
import {
  btcPerKvbToRate,
  effectiveRate,
  estimateMint,
  feeFor,
  formatFeeRate,
  judgeRate,
  parseFeeRate,
  revealFeeFor,
  satPerKbToRate,
  vbytesOf,
} from "../packages/counters/src/fees";

describe("fee math", () => {
  it("rounds vbytes the way the node does", () => {
    expect(vbytesOf(452)).toBe(113);
    expect(vbytesOf(453)).toBe(114);
    expect(vbytesOf(1959)).toBe(490);
    expect(vbytesOf(2144)).toBe(536);
  });

  it("reproduces the node's commit fees for fractional rates", () => {
    expect(feeFor(155, 0.1)).toBe(16);
    expect(feeFor(155, 0.25)).toBe(39);
    expect(feeFor(155, 0.5)).toBe(78);
    expect(feeFor(155, 1)).toBe(155);
    expect(feeFor(155, 2.5)).toBe(388);
  });

  it("applies the 330-sat commit floor to small reveals", () => {
    expect(revealFeeFor(1960, 0.5, 0)).toBe(330);
    expect(revealFeeFor(453, 2.5, 0)).toBe(330);
    expect(revealFeeFor(2145, 0.5, 546)).toBe(269);
    expect(revealFeeFor(400_000, 0.1, 0)).toBe(10_000);
    expect(effectiveRate(330, 490)).toBeCloseTo(0.673, 3);
    expect(effectiveRate(268, 536)).toBe(0.5);
  });

  it("never funds a reveal below what Core funded or below the rate", () => {
    for (const weight of [452, 1959, 2144, 399_999]) {
      for (const rate of [0.1, 0.15, 0.37, 0.5, 0.9, 1, 2.5]) {
        for (const outputs of [0, 546]) {
          const ours = revealFeeFor(weight + 1, rate, outputs);
          const core = Math.max(feeFor(vbytesOf(weight), rate) + outputs, 330) - outputs;
          expect(ours).toBeGreaterThanOrEqual(core);
          const floored = feeFor(vbytesOf(weight + 1), rate) + outputs < 330;
          if (!floored) expect(ours / vbytesOf(weight + 1)).toBeGreaterThanOrEqual(rate - 1e-9);
        }
      }
    }
  });

  it("estimates a mint from the file size", () => {
    const e = estimateMint(1500, 0.5, "counterparty");
    expect(e.commitFee).toBe(78);
    expect(e.revealFee).toBe(330);
    expect(e.dustFloored).toBe(true);
    const big = estimateMint(200_000, 0.5, "counterparty");
    expect(big.dustFloored).toBe(false);
    expect(big.revealEffective).toBeGreaterThanOrEqual(0.5);
  });
});

describe("rate parsing", () => {
  it("accepts decimals and sub-1 values", () => {
    expect(parseFeeRate("0.5")).toEqual({ ok: true, rate: 0.5 });
    expect(parseFeeRate("0.15")).toEqual({ ok: true, rate: 0.15 });
    expect(parseFeeRate(".5")).toEqual({ ok: true, rate: 0.5 });
    expect(parseFeeRate("0.1234")).toEqual({ ok: true, rate: 0.123 });
    expect(parseFeeRate("  2 ")).toEqual({ ok: true, rate: 2 });
  });

  it("refuses what the node would accept but should not", () => {
    expect(parseFeeRate("")).toEqual({ ok: false, reason: "empty" });
    expect(parseFeeRate("0")).toEqual({ ok: false, reason: "zero" });
    expect(parseFeeRate("0.0004")).toEqual({ ok: false, reason: "zero" });
    expect(parseFeeRate("1,5")).toEqual({ ok: false, reason: "nan" });
    expect(parseFeeRate("1.2.3")).toEqual({ ok: false, reason: "nan" });
    expect(parseFeeRate("20000")).toEqual({ ok: false, reason: "too-high" });
  });

  it("formats and converts", () => {
    expect(formatFeeRate(0.629)).toBe("0.629");
    expect(formatFeeRate(1)).toBe("1");
    expect(formatFeeRate(0.1)).toBe("0.1");
    expect(formatFeeRate(0.001)).toBe("0.001");
    expect(satPerKbToRate(629)).toBe(0.629);
    expect(satPerKbToRate(1082)).toBe(1.082);
    expect(satPerKbToRate(0)).toBeNull();
    expect(satPerKbToRate(-1)).toBeNull();
    expect(btcPerKvbToRate(6.29e-6)).toBe(0.629);
    expect(btcPerKvbToRate(0)).toBe(0);
  });

  it("judges against the node's floors, equal passing", () => {
    expect(judgeRate(0.5, { minRelay: 0, mempoolMin: 0 })).toBe("ok");
    expect(judgeRate(0.5, { minRelay: 1, mempoolMin: 1 })).toBe("below-mempool-min");
    expect(judgeRate(0.5, { minRelay: 1, mempoolMin: 0 })).toBe("below-relay-min");
    expect(judgeRate(0.5, { minRelay: 0.1, mempoolMin: 0.8 })).toBe("below-mempool-min");
    expect(judgeRate(0.1, { minRelay: 0.1, mempoolMin: 0.1 })).toBe("ok");
  });
});
