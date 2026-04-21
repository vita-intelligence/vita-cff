/**
 * Shared helpers for the comments UI.
 *
 * Kept outside the components so the hook and the pure renderers
 * can both consume them without cyclical imports.
 */

import type { CommentDto } from "@/services/comments";

/**
 * Group a flat list of comments into ``{ root, replies }`` pairs.
 *
 * The backend orders the list by ``created_at`` ascending, so:
 *   - replies always arrive after their root in the stream;
 *   - within a parent, reply order matches creation order.
 *
 * Replies whose parent was not returned (edge case: the root was
 * filtered out client-side, e.g. when ``resolved`` filter hides it)
 * are dropped — rendering an orphan reply would confuse the reader.
 */
export interface CommentGroup {
  readonly root: CommentDto;
  readonly replies: readonly CommentDto[];
}

export function groupIntoThreads(
  comments: readonly CommentDto[],
): CommentGroup[] {
  const rootIndex = new Map<string, CommentDto[]>();
  const roots: CommentDto[] = [];
  for (const comment of comments) {
    if (comment.parent_id == null) {
      roots.push(comment);
      rootIndex.set(comment.id, []);
    }
  }
  for (const comment of comments) {
    if (comment.parent_id == null) continue;
    const bucket = rootIndex.get(comment.parent_id);
    if (bucket) bucket.push(comment);
  }
  return roots.map((root) => ({
    root,
    replies: rootIndex.get(root.id) ?? [],
  }));
}


/** Pretty-ish relative timestamp. Falls back to an absolute date once
 *  the comment is more than a week old so the UI doesn't claim
 *  "2 weeks ago" (which is less actionable than "Mar 14"). */
export function formatTimestamp(iso: string, locale: string = "en-US"): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  const now = Date.now();
  const diff = now - parsed.getTime();
  const seconds = Math.round(diff / 1000);
  if (seconds < 30) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return parsed.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    year:
      parsed.getFullYear() === new Date().getFullYear()
        ? undefined
        : "numeric",
  });
}


/** First-letter avatar. Used by the rounded initial in the author
 *  header; generating it client-side dodges an image-asset pipeline
 *  we haven't built yet. */
export function authorInitials(name: string, email: string): string {
  const source = (name || email || "?").trim();
  if (!source) return "?";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return parts[0]!.slice(0, 2).toUpperCase();
  }
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
