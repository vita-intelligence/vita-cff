import type { CommentDto } from "./types";


/**
 * Decide whether an incoming comment should trigger a user-facing
 * notification (toast / chime / OS notification / inbox unread
 * badge increment).
 *
 * The rule, agreed with the team:
 *
 *  * **Customer message** — always notify. A reply from outside
 *    the team is load-bearing for sales / support; missing it costs
 *    real money. Detected via ``author.kind === "client"``.
 *  * **You were @-mentioned** — always notify. Mentions are the
 *    teammate's explicit signal "I need your attention on this".
 *    Detected by walking ``mentions[].id`` against the current
 *    user's id.
 *  * **Everything else** — silent. Cache invalidations still fire
 *    so an open thread repaints in real time, but the bell, the
 *    chime, the toast, and the tab-title prefix all stay quiet.
 *    This is the noise reduction the user asked for: project chats
 *    where the whole team is typing back and forth no longer ping
 *    everyone on every message — only the people whose attention
 *    is actually being requested.
 *
 * Returns ``true`` when the comment is relevant to the caller and
 * any surface watching new comments should escalate it; ``false``
 * when the surface should swallow the event silently.
 */
export function shouldNotifyForComment(
  comment: CommentDto | undefined | null,
  currentUserId: string | null | undefined,
): boolean {
  if (!comment) return false;
  if (comment.author?.kind === "client") return true;
  if (!currentUserId) return false;
  return comment.mentions.some((m) => m.id === currentUserId);
}
