import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The web app's own `@/` alias, so adapter tests can import the modules the
  // app imports rather than a parallel copy of them.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
      "@counters/core": fileURLToPath(new URL("./packages/counters/src", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    /**
     * Several suites assert against the live chain — the counters index, a real
     * pool quote, a real Esplora relay — because that is where their value is:
     * a fixture cannot tell you the on-chain rule still separates 71 files from
     * 98 pointers, or that the LP-supply shortcut has drifted again.
     *
     * The cost is that a transient network blip fails the build for a reason
     * that has nothing to do with the code. Retrying absorbs that without
     * weakening the assertions; a genuine regression fails all three times.
     */
    retry: 2,
    testTimeout: 30_000,
  },
});
