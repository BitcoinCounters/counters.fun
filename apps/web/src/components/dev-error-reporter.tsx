"use client";

import { useEffect } from "react";

/**
 * Send this tab's unhandled failures to the local error log.
 *
 * Two listeners and nothing else: `error` for an exception that reached the
 * window, `unhandledrejection` for a promise nobody caught — which is most of
 * what breaks in this app, since every wallet call and every fetch is a
 * promise. React's own warnings are deliberately not captured; they are advice,
 * not failures, and drowning the log in them would make it useless for the
 * thing it is for.
 *
 * Rendered only when the layout is running under `next dev`, and the route it
 * posts to does not exist in a production build either.
 */
export function DevErrorReporter() {
  useEffect(() => {
    // Never let the reporter's own failure become a second error event.
    const send = (payload: Record<string, string | undefined>) => {
      try {
        void fetch("/api/dev-errors", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...payload, url: window.location.pathname + window.location.search }),
          keepalive: true,
        }).catch(() => {});
      } catch {
        // Nothing to do: the log is a convenience.
      }
    };

    const onError = (event: ErrorEvent) => {
      send({
        kind: event.error?.name ?? "Error",
        message: event.message || String(event.error ?? "(no message)"),
        stack: event.error?.stack,
      });
    };

    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      send({
        kind: reason instanceof Error ? `Unhandled ${reason.name}` : "UnhandledRejection",
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
