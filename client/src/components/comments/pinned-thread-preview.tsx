"use client";

/**
 * Compact preview row for the sticky pinned strip at the top of a
 * comments panel.
 *
 * Renders the root author + a single-line truncated body + an
 * optional reply counter. Clicking the row delegates to the parent
 * panel's ``scrollToThread`` machinery so the full message (and its
 * replies) come into view in the chronological stream below — much
 * better than re-rendering the entire flagged comment here, where a
 * long root used to dominate the chat.
 *
 * Shared between the authed project bubble and the public kiosk so
 * the two surfaces always read the same way.
 */

import { Pin } from "lucide-react";

import type { CommentDto } from "@/services/comments";


/** Soft cap on the truncated preview body. Mirrors the reply quote
 *  excerpt cap on ``CommentsPanel`` so a flagged thread reads
 *  identically wherever it's previewed. */
const PINNED_PREVIEW_CHARS = 90;


function previewExcerpt(body: string): string {
  const trimmed = (body || "").replace(/\s+/g, " ").trim();
  if (trimmed.length <= PINNED_PREVIEW_CHARS) return trimmed;
  return trimmed.slice(0, PINNED_PREVIEW_CHARS).trimEnd() + "…";
}


export function PinnedThreadPreview({
  root,
  replyCount,
  onSelect,
}: {
  readonly root: CommentDto;
  readonly replyCount: number;
  readonly onSelect: () => void;
}) {
  const authorLabel = root.author.name || root.author.email || "—";
  const body = root.is_deleted ? "" : previewExcerpt(root.body);
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group flex w-full items-center gap-2 rounded-lg bg-ink-0 px-2.5 py-1.5 text-left text-xs text-ink-700 ring-1 ring-inset ring-warning/30 transition-colors hover:bg-warning/10"
    >
      <Pin className="h-3 w-3 shrink-0 text-warning" aria-hidden />
      <span className="shrink-0 font-semibold text-ink-1000">
        {authorLabel}
      </span>
      <span className="min-w-0 flex-1 truncate text-ink-700">
        {body || "—"}
      </span>
      {replyCount > 0 ? (
        <span
          className="shrink-0 rounded-full bg-warning/20 px-1.5 py-0.5 text-[10px] font-medium text-warning"
          aria-label={`${replyCount} replies`}
        >
          {replyCount}
        </span>
      ) : null}
    </button>
  );
}
