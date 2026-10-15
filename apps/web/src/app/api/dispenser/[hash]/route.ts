/**
 * Same-origin pass-through to the worker's /dispensers/:hash, for the buy
 * that opens on a card: the card knows the listing, and the buy needs the
 * live lot and rate, which only the worker (and Core behind it) can say.
 * The worker itself is not public, as with /search.
 */
import { COUNTERS_API_BASE } from "@/lib/constants";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  if (!/^[0-9a-fA-F]{64}$/.test(hash)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  try {
    const res = await fetch(`${COUNTERS_API_BASE}/dispensers/${hash.toLowerCase()}`, { signal: AbortSignal.timeout(8000) });
    return new Response(await res.text(), {
      status: res.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (cause) {
    return Response.json({ error: (cause as Error).message }, { status: 502 });
  }
}
