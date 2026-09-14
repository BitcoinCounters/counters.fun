import { NextResponse, type NextRequest } from "next/server";

/**
 * Make the home page cacheable and, more to the point, shareable.
 *
 * Both routes render dynamically — the home page reads `?sort=`, a counter
 * page is resolved per id — and Next marks every dynamic response `private,
 * no-cache, no-store`. That is the right default for a page about one
 * signed-in user and the wrong one here:
 * `private` tells every intermediary the response must not be shared, so a
 * link-preview crawler has no business building a card from it. Chat clients
 * duly showed no preview at all — correct Open Graph tags, refused anyway.
 *
 * Nothing on either page is per-user. The sort lives in the URL and a query
 * string is part of the CDN cache key, so each variant caches on its own. The
 * 30s window matches the `revalidate` on the data fetches underneath.
 *
 * This runs here rather than in `next.config.ts` because a `headers()` entry
 * loses to the cache-control Next sets for a dynamic route — measured, not
 * assumed. Proxy runs on the way out and wins.
 */
export function proxy(request: NextRequest) {
  const response = NextResponse.next();
  response.headers.set(
    "cache-control",
    "public, max-age=0, s-maxage=30, stale-while-revalidate=300",
  );
  return response;
}

// The home page and every counter page. A counter page is the link most worth
// sharing — it is one asset, its art and its market — and it renders
// dynamically for its own reasons, so it carried the same `private, no-store`
// and the same missing preview.
export const config = { matcher: ["/", "/c/:id"] };
