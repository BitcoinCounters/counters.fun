/**
 * Hand a signed reveal to the box and walk away.
 *
 * The alternative is a browser tab that has to stay open for hours: a
 * Slipstream reveal cannot be submitted until its commit is MINED, because MARA
 * prices a reveal from the chain and from its own submissions and never from
 * the public mempool. POSTing it here moves that wait onto the server, so the
 * person can close the page the moment they have signed.
 *
 * The reveal is validated against this node rather than trusted: it must spend
 * the commit it names, and that commit must already be on chain. A reveal is
 * also harmless to hold — it spends exactly one output its own signer
 * committed to, so this server can stall it but can never redirect it.
 */

import { EnqueueError, enqueue, listJobs, readJob } from "@/lib/server/reveal-jobs";

export const dynamic = "force-dynamic";

/** A multi-megabyte reveal is the normal case here, not the exception. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const commitTxid = params.get("commit");
  if (commitTxid) {
    const job = await readJob(commitTxid);
    if (!job) return Response.json({ error: "no such job" }, { status: 404 });
    return Response.json(job, { headers: { "cache-control": "no-store" } });
  }
  const source = params.get("source");
  return Response.json(
    { jobs: await listJobs(source ?? undefined) },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) {
    return Response.json({ error: "reveal too large" }, { status: 413 });
  }

  let body: { commitTxid?: string; revealHex?: string; source?: string; asset?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  if (!body.commitTxid || !body.revealHex || !body.source) {
    return Response.json(
      { error: "commitTxid, revealHex and source are required" },
      { status: 400 },
    );
  }

  try {
    const job = await enqueue({
      commitTxid: body.commitTxid,
      revealHex: body.revealHex,
      source: body.source,
      asset: body.asset ?? null,
    });
    return Response.json(job, { headers: { "cache-control": "no-store" } });
  } catch (cause) {
    if (cause instanceof EnqueueError) {
      return Response.json({ error: cause.message }, { status: 400 });
    }
    return Response.json({ error: (cause as Error).message }, { status: 502 });
  }
}
