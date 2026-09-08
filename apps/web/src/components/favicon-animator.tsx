"use client";

import { useEffect } from "react";

/**
 * Animate the tab icon.
 *
 * The favicon is an SVG whose gradient slides by SMIL, but browsers
 * rasterise a favicon once, so on its own it sits still in the tab. This
 * repaints the same wordmark from a canvas a few times a second and hands
 * the browser a fresh PNG each time.
 *
 * The page ships several icon links (SVG, 32px PNG, Apple touch) and the
 * browser is free to prefer any of them, so every frame points *all* of
 * them at the new PNG. They are mutated in place, never removed: React owns
 * those metadata elements and removes them itself on navigation, and an
 * element that has already been pulled out of the DOM makes that removal
 * throw ("finishedRoot.parentNode is null"). A route change may render
 * fresh links with the original hrefs; the per-frame query picks those up.
 * Original hrefs go back on unmount.
 *
 * Runs only while the tab is visible, and not at all for people who asked
 * for reduced motion — the static SVG stays in place for them.
 *
 * The letterforms come from public/fun-mask-64.png — the same rasterised
 * shape as the static PNG icons — and only the gradient is drawn here, so
 * the animated frames match the static icon exactly, whatever fonts the
 * viewer's machine has.
 */
const STOPS = ["#f0653f", "#ff9f1c", "#ffd23f", "#3ec78f", "#5b8def"];
const SIZE = 64;
const FPS = 12;
const CYCLE_MS = 8000;

export function FaviconAnimator() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const head = document.head;
    const SELECTOR = 'link[rel~="icon"], link[rel="apple-touch-icon"]';
    if (!head.querySelector(SELECTOR)) return;
    const originals = new Map<HTMLLinkElement, string>();

    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const mask = new Image();
    mask.src = "/fun-mask-64.png";

    const setIcon = (href: string) => {
      for (const link of head.querySelectorAll<HTMLLinkElement>(SELECTOR)) {
        if (!originals.has(link)) originals.set(link, link.getAttribute("href") ?? "");
        link.href = href;
      }
    };

    const start = performance.now();
    const loop = [...STOPS, ...STOPS, STOPS[0]];

    const paint = () => {
      const t = ((performance.now() - start) % CYCLE_MS) / CYCLE_MS;
      ctx.clearRect(0, 0, SIZE, SIZE);

      // Two full colour cycles across three icon widths, shifted by t: the
      // same seamless slide the header does.
      const span = SIZE * 3;
      const shift = -t * ((span * 2) / 3);
      const g = ctx.createLinearGradient(shift, 0, shift + span, 0);
      loop.forEach((c, i) => g.addColorStop(i / (loop.length - 1), c));

      // Letters first, then the gradient kept only where the letters are.
      ctx.drawImage(mask, 0, 0, SIZE, SIZE);
      ctx.globalCompositeOperation = "source-in";
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, SIZE, SIZE);
      ctx.globalCompositeOperation = "source-over";

      setIcon(canvas.toDataURL("image/png"));
    };

    let timer: number | undefined;
    const schedule = () => {
      if (timer !== undefined) return;
      paint();
      timer = window.setInterval(paint, 1000 / FPS);
    };
    const halt = () => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => (document.hidden ? halt() : schedule());

    document.addEventListener("visibilitychange", onVisibility);
    // Nothing to draw until the mask is in; until then the static icon shows.
    // `disposed` guards the load callback: in development React mounts,
    // unmounts and remounts, and a late load must not revive a dead effect.
    let disposed = false;
    const begin = () => {
      if (!disposed && !document.hidden) schedule();
    };
    if (mask.complete && mask.naturalWidth > 0) begin();
    else mask.addEventListener("load", begin, { once: true });

    return () => {
      disposed = true;
      mask.removeEventListener("load", begin);
      document.removeEventListener("visibilitychange", onVisibility);
      halt();
      for (const [link, href] of originals) {
        if (link.isConnected) link.setAttribute("href", href);
      }
    };
  }, []);

  return null;
}
