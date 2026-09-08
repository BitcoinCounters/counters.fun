/**
 * Same-origin proxy to Counterparty Core.
 *
 * Two reasons it exists. The browser cannot reach `api.counterparty.io`
 * directly with any reliability — behind Cloud Armor it returns CORS-less 403s
 * and 429s, which surface in the console as a network error with no
 * explanation. And a compose whose `description` *is* a 200 KB file does not
 * fit in a query string, so it has to be a POST with a form body, which
 * Counterparty accepts but a cross-origin preflight would not survive.
 *
 * The allowlist is deliberately short. This proxy carries reads and composes;
 * it never carries a broadcast. An unsigned transaction passing through
 * infrastructure is a transaction that infrastructure could alter, so signing
 * and broadcasting stay between the wallet and the node.
 */

import { COUNTERPARTY_API_BASE } from "@/lib/constants";

/** Reads the mint and pool flows need, by path shape. */
const READ_ALLOWED: RegExp[] = [
  /^$/, // /v2/ — server info and the current block height
  /^addresses\/[^/]+\/balances$/,
  /^addresses\/[^/]+\/balances\/[^/]+$/,
  /^addresses\/[^/]+\/assets\/owned$/,
  /^addresses\/[^/]+\/pools$/,
  /^addresses\/[^/]+\/compose\/pooldeposit\/estimatexcpfees$/,
  /^addresses\/[^/]+\/compose\/poolwithdraw\/estimatexcpfees$/,
  /^assets\/[^/]+$/,
  /^pools\/[^/]+\/[^/]+$/,
  /^pools\/[^/]+\/[^/]+\/quote$/,
  /^pools\/[^/]+\/[^/]+\/quote\/deposit$/,
  /^pools\/[^/]+\/[^/]+\/quote\/withdraw$/,
];

/** Composes. Each returns an unsigned transaction; none of them move anything. */
const COMPOSE_ALLOWED = new Set(["issuance", "fairminter", "pooldeposit", "poolwithdraw"]);

function allowed(path: string[], method: string): boolean {
  const joined = path.join("/");

  if (method === "GET") return READ_ALLOWED.some((re) => re.test(joined));

  if (method === "POST") {
    // addresses/<addr>/compose/<type>
    return (
      path.length === 4 &&
      path[0] === "addresses" &&
      path[2] === "compose" &&
      COMPOSE_ALLOWED.has(path[3]!)
    );
  }
  return false;
}

async function proxy(request: Request, path: string[]): Promise<Response> {
  if (!allowed(path, request.method)) {
    return Response.json({ error: `not proxied: ${request.method} /${path.join("/")}` }, { status: 403 });
  }

  const incoming = new URL(request.url);
  const target = `${COUNTERPARTY_API_BASE}/${path.join("/")}${incoming.search}`;

  const init: RequestInit = { method: request.method, headers: { accept: "application/json" } };

  if (request.method === "POST") {
    // Counterparty's composes are GET-shaped: parameters go in the query
    // string. A file-sized `description` cannot, so the body is forwarded as a
    // form and Counterparty reads it the same way.
    init.body = await request.text();
    (init.headers as Record<string, string>)["content-type"] =
      request.headers.get("content-type") ?? "application/x-www-form-urlencoded";
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (cause) {
    return Response.json(
      { error: `Counterparty is unreachable: ${(cause as Error).message}` },
      { status: 502 },
    );
  }

  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      // A compose is never cacheable: it selects specific coins, and serving a
      // stale one would hand the wallet inputs that are already spent.
      "cache-control": "no-store",
    },
  });
}

export async function GET(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(request, (await ctx.params).path);
}

export async function POST(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(request, (await ctx.params).path);
}
