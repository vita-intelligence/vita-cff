"use client";

/**
 * One root comment + its replies.
 *
 * Rendered as a chat stream — the root bubble comes first, then
 * each reply as a separate bubble that carries a small
 * ``↳ @Name: excerpt`` quote header pointing back at the root.
 * Visually feels like Telegram / WhatsApp threads rather than the
 * old indented-reply card look.
 *
 * Replies no longer get their own inline composer here. Clicking
 * "Reply" announces the intent to the parent panel via
 * :prop:`onStartReply`, which targets its single bottom composer
 * at this thread until the user submits or cancels.
 */

import type { CommentDto } from "@/services/comments";

import { CommentCard } from "./comment-card";


interface Props {
  readonly root: CommentDto;
  readonly replies: readonly CommentDto[];
  readonly orgId: string;
  readonly currentUserId: string | null;
  readonly currentUserEmail?: string | null;
  readonly canWrite: boolean;
  readonly canModerate: boolean;
  /** Click handler for the per-card "Reply" action. Receives the
   *  root comment id plus the metadata the panel needs to render
   *  its "Replying to {author}: {excerpt}" chip above the shared
   *  composer. Pass ``undefined`` to disable the reply action
   *  entirely (e.g. resolved threads). */
  readonly onStartReply?: (
    rootId: string,
    authorLabel: string,
    excerpt: string,
  ) => void;
  /** Click handler for the quote header on each reply card —
   *  scrolls the parent (root) into view so a reader can jump
   *  back to whatever the reply was responding to. The panel
   *  wires this to its existing ``scrollToThread`` helper so the
   *  highlight/flash behaviour matches a pinned-preview click. */
  readonly onJumpToParent?: (rootId: string) => void;
  readonly onEdit: (commentId: string, body: string) => void | Promise<void>;
  readonly onDelete: (commentId: string) => void | Promise<void>;
  readonly onToggleResolve: (
    commentId: string,
    resolved: boolean,
  ) => void | Promise<void>;
  readonly onToggleFlag?: (
    commentId: string,
    flagged: boolean,
  ) => void | Promise<void>;
}


//: Soft cap on the quote excerpt so a giant root comment doesn't
//: stretch the reply header. Anything longer truncates with a
//: single-char ellipsis — the reader can scroll up to see the full
//: body.
const QUOTE_EXCERPT_CHARS = 80;


function excerptFor(body: string): string {
  const trimmed = (body || "").replace(/\s+/g, " ").trim();
  if (trimmed.length <= QUOTE_EXCERPT_CHARS) return trimmed;
  return trimmed.slice(0, QUOTE_EXCERPT_CHARS).trimEnd() + "…";
}


export function CommentThread({
  root,
  replies,
  orgId,
  currentUserId,
  currentUserEmail,
  canWrite,
  canModerate,
  onStartReply,
  onJumpToParent,
  onEdit,
  onDelete,
  onToggleResolve,
  onToggleFlag,
}: Props) {
  // The reply quote header points back to the root. Author is the
  // root's display name; excerpt is a short slice of the root body
  // (but only when the root is not itself deleted).
  const rootAuthorLabel =
    root.author.name || root.author.email || "—";
  const quoteExcerpt = root.is_deleted ? null : excerptFor(root.body);

  return (
    <article
      className={`flex flex-col gap-0.5 rounded-2xl py-2 ${
        root.needs_resolution && !root.is_resolved
          ? "bg-warning/5 ring-1 ring-inset ring-warning/30"
          : ""
      } ${root.is_resolved ? "bg-ink-50/60" : ""}`}
    >
      <CommentCard
        comment={root}
        orgId={orgId}
        currentUserId={currentUserId}
        currentUserEmail={currentUserEmail}
        canModerate={canModerate}
        canWrite={canWrite}
        onEdit={onEdit}
        onDelete={onDelete}
        onToggleResolve={onToggleResolve}
        onToggleFlag={onToggleFlag}
        onReply={
          canWrite && !root.is_resolved && onStartReply
            ? () =>
                onStartReply(root.id, rootAuthorLabel, quoteExcerpt ?? "")
            : undefined
        }
      />
      {replies.map((reply) => (
        <CommentCard
          key={reply.id}
          comment={reply}
          orgId={orgId}
          currentUserId={currentUserId}
          currentUserEmail={currentUserEmail}
          canModerate={canModerate}
          canWrite={canWrite}
          isReply
          replyToAuthor={rootAuthorLabel}
          replyToExcerpt={quoteExcerpt}
          onJumpToParent={
            onJumpToParent
              ? () => onJumpToParent(root.id)
              : undefined
          }
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
    </article>
  );
}
