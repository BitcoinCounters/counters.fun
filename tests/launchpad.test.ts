/**
 * The launchpad predicate reads only the on-chain body. These are fixtures —
 * the MEMEBEAM manifest is counter #166 verbatim, the pointer is LIKETHIS
 * (#169) — because the question is about the shape of the bytes, not the
 * state of the chain.
 */

import { describe, expect, it } from "vitest";
import { launchpadOf, launchpadOfFairminter, matchesXcpFunTemplate } from "../packages/counters/src/launchpad";

const MEMEBEAM =
  '{"asset":"MEMEBEAM","name":"MEMEBEAM","description":"Test mint please ignore","website":"https://xcp.fun/MEMEBEAM","image":"https://xcp.fun/full/MEMEBEAM","images":[{"type":"icon","size":"48x48","data":"https://xcp.fun/full/MEMEBEAM"},{"type":"standard","data":"https://xcp.fun/full/MEMEBEAM"}]}';

describe("launchpadOf", () => {
  it("recognises an inscribed xcp.fun manifest", () => {
    expect(launchpadOf({ body: MEMEBEAM })).toBe("xcp.fun");
  });

  it("recognises a pointer to an xcp.fun manifest", () => {
    expect(launchpadOf({ body: "https://xcp.fun/LIKETHIS.json" })).toBe("xcp.fun");
  });

  it("needs the manifest shape, not just the string", () => {
    expect(launchpadOf({ body: "xcp.fun is a launchpad" })).toBeNull();
    expect(launchpadOf({ body: '{"description":"see xcp.fun"}' })).toBeNull();
    expect(launchpadOf({ body: '{"website":"https://notxcp.fun/x"}' })).toBeNull();
  });

  it("ignores everything else", () => {
    expect(launchpadOf({ body: null })).toBeNull();
    expect(launchpadOf({ body: "" })).toBeNull();
    expect(launchpadOf({ body: "https://ipfs.io/ipfs/Qm..." })).toBeNull();
    expect(launchpadOf({ body: "{not json" })).toBeNull();
    expect(launchpadOf({ body: '{"website":"https://example.com"}' })).toBeNull();
  });
});

/**
 * UPPIES (#164) as Counterparty reports it: a PNG description, template
 * params. `hard_cap` is above 2^53, so the lossless parser hands it over as
 * a string — exactly as the API client does.
 */
const UPPIES = {
  price: 1000000,
  quantity_by_price: 100000000000,
  hard_cap: "10000000000000000",
  soft_cap: 6900000000000000,
  pool_quantity: 3100000000000000,
  premint_quantity: 0,
  max_mint_per_address: 100000000000000,
  divisible: true,
  description: "\u0089PNG\r\n",
};

describe("launchpadOfFairminter", () => {
  it("tags a template launch whose file is the art, not a manifest", () => {
    expect(matchesXcpFunTemplate(UPPIES)).toBe(true);
    expect(launchpadOfFairminter(UPPIES)).toBe("xcp.fun");
  });

  it("tags a pointer launch by its description", () => {
    expect(launchpadOfFairminter({ ...UPPIES, description: "https://xcp.fun/LIKETHIS.json" })).toBe("xcp.fun");
  });

  it("needs every parameter to match", () => {
    expect(launchpadOfFairminter({ ...UPPIES, soft_cap: 6900000000000001 })).toBeNull();
    expect(launchpadOfFairminter({ ...UPPIES, pool_quantity: null })).toBeNull();
    expect(launchpadOfFairminter({ ...UPPIES, divisible: false })).toBeNull();
    expect(launchpadOfFairminter({ ...UPPIES, max_mint_per_address: null })).toBeNull();
  });

  it("accepts raw quantities as strings, the way D1 stores them", () => {
    expect(
      launchpadOfFairminter({
        ...UPPIES,
        price: "1000000",
        hard_cap: "10000000000000000",
        soft_cap: "6900000000000000",
        pool_quantity: "3100000000000000",
      }),
    ).toBe("xcp.fun");
  });
});
