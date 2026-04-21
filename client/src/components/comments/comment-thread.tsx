"use client";

/**
 * One root comment + its replies + the inline reply composer.
 *
 * Rendered as a chat stream — the root bubble comes first, then
 * each reply as a separate bubble that carries a small
 * ``↳ @Name: excerpt`` quote header pointing back at the root.
 * Visually feels like Telegram / WhatsApp threads rather than the
 * old indented-reply card look.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";

import type { CommentDto } from "@/services/comments";

import { CommentCard } from "./comment-card";
import { CommentComposer } from "./comment-composer";


interface Props {
  readonly root: CommentDto;
  readonly replies: readonly CommentDto[];
  readonly orgId: string;
  readonly currentUserId: string | null;
  readonly currentUserEmail?: string | null;
  readonly canWrite: boolean;
  readonly canModerate: boolean;
  readonly onReply: (
    parentId: string,
    body: string,
  ) => void | Promise<void>;
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
  onReply,
  onEdit,
  onDelete,
  onToggleResolve,
  onToggleFlag,
}: Props) {
  const tComments = useTranslations("comments");
  const [isReplying, setIsReplying] = useState(false);

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
          canWrite && !root.is_resolved
            ? () => setIsReplying(true)
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
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
      {isReplying ? (
        <div className="px-3 pb-2 pt-1">
          <CommentComposer
            orgId={orgId}
            placeholder={tComments("composer.reply_placeholder")}
            submitLabel={tComments("actions.send")}
            cancelLabel={tComments("actions.cancel")}
            onSubmit={async (body) => {
              await onReply(root.id, body);
              setIsReplying(false);
            }}
            onCancel={() => setIsReplying(false)}
            autoFocus
          />
        </div>
      ) : null}
    </article>
  );
}
