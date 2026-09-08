/** Same-origin pass-through to the worker's /search; the worker itself is not public. */
import { COUNTERS_API_BASE } from "@/lib/constants";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  try {
    const res = await fetch(`${COUNTERS_API_BASE}/search?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(5000) });
    return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch (cause) {
    return Response.json({ result: [], error: (cause as Error).message }, { status: 502 });
  }
}
