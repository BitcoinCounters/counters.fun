/**
 * The browser's half of the local error log.
 *
 * A client-side exception is the one failure a local run cannot see: it lands
 * in a tab's console and nowhere else. This takes one from the reporter in the
 * root layout and appends it to `.logs/errors.log` with the server's own.
 *
 * It exists only under `next dev` — see lib/dev-errors.ts. In a production
 * build the route answers 404 like any other path that is not there.
 */

import { DEV_ONLY, report } from "@/lib/dev-errors";

const MAX_BODY = 16_000;

export async function POST(request: Request): Promise<Response> {
  if (!DEV_ONLY) return new Response("Not found", { status: 404 });

  const text = (await request.text()).slice(0, MAX_BODY);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "expected JSON" }, { status: 400 });
  }

  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  await report({
    source: "client",
    kind: str(body.kind) ?? "Error",
    message: str(body.message) ?? "(no message)",
    url: str(body.url),
    stack: str(body.stack),
  });
  return new Response(null, { status: 204 });
}
