import type { NextConfig } from "next";

const API = process.env.NEXT_PUBLIC_COUNTERS_API_BASE ?? "http://localhost:8787";

const config: NextConfig = {
  // Dev only: mirror the browser console (errors, warnings, hydration
  // issues — the things the "N issues" overlay counts) into the dev server's
  // output, so they land in the service journal and can be watched from a
  // terminal instead of only in DevTools.
  logging: { browserToTerminal: true },

  // Next's dev server blocks cross-origin requests for its own chunks, and it
  // counts `127.0.0.1` as a different origin from `localhost`. Opening the site
  // by IP therefore serves the HTML and then blocks every script — the page
  // renders server-side and never hydrates, which looks exactly like a browser
  // that has JavaScript disabled. Production is unaffected; this is dev only.
  //
  // ngrok hosts are listed so a tunnel to the dev server hydrates too; the
  // subdomain is random per session, hence the wildcards.
  allowedDevOrigins: ["127.0.0.1", "localhost", "*.ngrok-free.dev", "*.ngrok-free.app", "*.ngrok.app"],

  // On-chain bytes must be same-origin. The counters server sends
  // X-Frame-Options: DENY, so an HTML or JavaScript counter cannot be framed
  // cross-origin at all — and MEMENOME, the only counter with a pool today, is
  // 69 KB of on-chain JavaScript. Rewriting through the API worker puts the
  // bytes on this origin with a sandbox CSP instead.
  async rewrites() {
    return [
      { source: "/content/:n", destination: `${API}/content/:n` },
      { source: "/preview/:n", destination: `${API}/preview/:n` },
      { source: "/stamp/:n", destination: `${API}/stamp/:n` },
    ];
  },

  /**
   * The home page reads `?sort=`, which makes it dynamically rendered, and
   * Next marks a dynamic response `private, no-cache, no-store`. That is the
   * right default for a page about one signed-in user and the wrong one here:
   * `private` says the response must not be shared, so a link-preview crawler
   * has no business building a card from it, and chat clients duly showed no
   * preview at all.
   *
   * Nothing on this page is per-user — the sort is in the URL, and a query
   * string is part of the CDN cache key, so each variant caches on its own.
   * The 30s window matches the `revalidate` on the data fetches underneath.
   */
  async headers() {
    return [
      {
        source: "/",
        headers: [
          {
            key: "cache-control",
            value: "public, max-age=0, s-maxage=30, stale-while-revalidate=300",
          },
        ],
      },
    ];
  },
};

export default config;
