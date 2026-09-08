"use client";

import { Fragment, useState } from "react";
import { copy } from "@content/copy";
import { fillParagraphs, type Segment } from "@content/fill";

/**
 * The home page's intro text, collapsed to its first paragraph by default.
 * The rest expands in place — the lede is prose, and prose should not push
 * the pools below the fold.
 */
export function HomeLede() {
  const [open, setOpen] = useState(false);
  const paragraphs = fillParagraphs(copy.home.lede);
  const shown = open ? paragraphs : paragraphs.slice(0, 1);
  const expandable = paragraphs.length > 1;

  return (
    <div className="max-w-[58ch] space-y-4 text-[15px] leading-relaxed text-dim">
      {shown.map((segments, p) => (
        <p key={p}>
          {segments.map((segment, i) => (
            <LedeSegment key={i} segment={segment} />
          ))}
          {expandable && !open && p === 0 && (
            <>
              {" "}
              <ToggleButton label="more" onClick={() => setOpen(true)} />
            </>
          )}
        </p>
      ))}
      {expandable && open && <ToggleButton label="less" onClick={() => setOpen(false)} />}
    </div>
  );
}

function LedeSegment({ segment }: { segment: Segment }) {
  const inner = segment.bold ? (
    <strong className="font-semibold text-ink">{segment.text}</strong>
  ) : (
    segment.text
  );
  return segment.href ? (
    <a
      href={segment.href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline decoration-copper/50 underline-offset-4 transition-colors hover:decoration-copper"
    >
      {inner}
    </a>
  ) : (
    <Fragment>{inner}</Fragment>
  );
}

function ToggleButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="font-mono text-[11px] uppercase tracking-[0.1em] text-copper transition-colors hover:text-copper2"
    >
      {label} {label === "more" ? "▾" : "▴"}
    </button>
  );
}
