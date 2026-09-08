import type { NextConfig } from "next";

const API = process.env.NEXT_PUBLIC_COUNTERS_API_BASE ?? "http://localhost:8787";

const config: NextConfig = {
  // Next's dev server blocks cross-origin requests for its own chunks, and it
  // counts `127.0.0.1` as a different origin from `localhost`. Opening the site
  // by IP therefore serves the HTML and then blocks every script — the page
  // renders server-side and never hydrates, which looks exactly like a browser
  // that has JavaScript disabled. Production is unaffected; this is dev only.
  allowedDevOrigins: ["127.0.0.1", "localhost"],

  // On-chain bytes must be same-origin. The counters server sends
  // X-Frame-Options: DENY, so an HTML or JavaScript counter cannot be framed
  // cross-origin at all — and MEMENOME, the only counter with a pool today, is
  // 69 KB of on-chain JavaScript. Rewriting through the API worker puts the
  // bytes on this origin with a sandbox CSP instead.
  async rewrites() {
    return [
      { source: "/content/:n", destination: `${API}/content/:n` },
      { source: "/preview/:n", destination: `${API}/preview/:n` },
    ];
  },
};

export default config;
