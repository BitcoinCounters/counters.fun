/**
 * The assets an address owns, without their files.
 *
 * Counterparty inlines each asset's description on every row, and for an
 * inscribed asset that description *is* the file: one address in this
 * project's own history answered `assets/owned` with 2.8 MB of PNG for a list
 * the page renders as fifteen names. So the paging happens here and the
 * descriptions are measured and dropped, leaving a few hundred bytes for the
 * browser to hold.
 *
 * It is a list for choosing from, not a source of truth: the mint form still
 * reads the asset it is about to reinscribe through `assets/{name}` and
 * composes against that.
 */

import { COUNTERPARTY_API_BASE } from "@/lib/constants";
import { classifyMimeType } from "@/lib/inscribe/content";
import type { OwnedAsset } from "@/lib/cp";

interface UpstreamAsset {
  asset?: string;
  asset_longname?: string | null;
  divisible?: boolean;
  locked?: boolean;
  supply?: number | string;
  description?: string | null;
  description_locked?: boolean;
  mime_type?: string | null;
  last_issuance_block_index?: number | null;
}

/**
 * How many bytes the description occupies on chain.
 *
 * Counterparty hands back textual content as the text and binary content as
 * hex, so the character count means one thing or half of it depending on the
 * MIME type — the same split the mint path encodes with.
 */
function descriptionBytes(description: string | null | undefined, mimeType: string | null | undefined): number {
  if (!description) return 0;
  if (classifyMimeType(mimeType ?? "text/plain") === "text") return new TextEncoder().encode(description).length;
  return Math.floor(description.length / 2);
}

/** Pages upstream until it runs out, so the browser never has to. */
const PAGE = 500;
const MAX_PAGES = 20;

export async function GET(request: Request): Promise<Response> {
  const address = new URL(request.url).searchParams.get("address");
  if (!address || !/^[a-zA-Z0-9]{20,90}$/.test(address)) {
    return Response.json({ error: "an address is required" }, { status: 400 });
  }

  const owned: OwnedAsset[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: String(PAGE), verbose: "false" });
    if (cursor) query.set("cursor", cursor);
    const target = `${COUNTERPARTY_API_BASE}/addresses/${encodeURIComponent(address)}/assets/owned?${query}`;

    let upstream: Response;
    try {
      upstream = await fetch(target, { headers: { accept: "application/json" }, cache: "no-store" });
    } catch (cause) {
      return Response.json({ error: `Counterparty is unreachable: ${(cause as Error).message}` }, { status: 502 });
    }
    if (!upstream.ok) {
      return Response.json({ error: `Counterparty said ${upstream.status}` }, { status: upstream.status });
    }

    const body = (await upstream.json()) as { result?: UpstreamAsset[]; next_cursor?: string | null };
    for (const row of body.result ?? []) {
      if (!row.asset) continue;
      owned.push({
        asset: row.asset,
        asset_longname: row.asset_longname ?? null,
        divisible: row.divisible === true,
        locked: row.locked === true,
        supply: String(row.supply ?? 0),
        description_locked: row.description_locked === true,
        mime_type: row.mime_type ?? null,
        description_bytes: descriptionBytes(row.description, row.mime_type),
        last_issuance_block_index: row.last_issuance_block_index ?? null,
      });
    }
    cursor = body.next_cursor ?? null;
    if (!cursor) break;
  }

  // Newest first: the asset someone wants to reinscribe is usually the one
  // they were just working on.
  owned.sort((a, b) => (b.last_issuance_block_index ?? 0) - (a.last_issuance_block_index ?? 0));

  return Response.json({ result: owned }, { headers: { "cache-control": "no-store" } });
}
