"use client";

/**
 * One comment rendered as a WhatsApp/Telegram-style chat bubble.
 *
 * Self-messages right-aligned in orange, everyone else left-aligned
 * in neutral ink. Author name + avatar live outside the bubble on
 * the "other" side; timestamp and "edited" marker sit inside the
 * bubble's inner footer. Reply context is a small
 * ``↳ @Name: excerpt`` line above the bubble, Telegram-style.
 *
 * Actions (reply / edit / delete / flag / resolve) live in a
 * floating row that reveals on hover, so the chat stream stays
 * visually clean in the default state.
 */

import { useState } from "react";
import {
  Check,
  CheckCircle2,
  CornerUpLeft,
  Flag,
  Pencil,
  Pin,
  Reply,
  Trash2,
  Undo2,
} from "lucide-react";
import { useTranslations } from "next-intl";

import type { CommentDto } from "@/services/comments";

import { CommentComposer } from "./comment-composer";
import { renderCommentBody } from "./render-body";
import { UserAvatar } from "@/components/ui/user-avatar";

import { formatTimestamp } from "./utils";

interface Props {
  readonly comment: CommentDto;
  readonly orgId: string;
  readonly currentUserId: string | null;
  /** Used for kiosk visitors — guest comments have no ``author.id``,
   *  so we fall back to matching on email to decide whether the
   *  bubble is "mine" (right-aligned, orange) or "theirs". */
  readonly currentUserEmail?: string | null;
  readonly canModerate: boolean;
  readonly canWrite: boolean;
  /** Whether the viewer can pin / resolve / flag threads *they
   *  didn't author*. Split from :prop:`canModerate` because
   *  resolve / flag are non-destructive housekeeping actions every
   *  staff team member should be able to perform on a client
   *  thread, while :prop:`canModerate` (which still gates
   *  destructive delete-of-others) stays restricted to moderators
   *  and owners. Authors keep full rights on their own threads
   *  regardless. */
  readonly canPinAnyThread: boolean;
  /** ``true`` when this card represents a reply — flips off the
   *  root-only action set (flag / resolve / reopen) since we never
   *  resolve individual replies. */
  readonly isReply?: boolean;
  /** Optional reply-context header shown above the bubble. */
  readonly replyToAuthor?: string | null;
  readonly replyToExcerpt?: string | null;
  /** When set, the reply-context header becomes a clickable button
   *  that takes the user to the parent comment. Used so a reply in
   *  the chat stream can navigate back to whatever it's quoting —
   *  no different from tapping a reply preview in WhatsApp /
   *  Telegram. */
  readonly onJumpToParent?: () => void;
  readonly onEdit: (commentId: string, body: string) => void | Promise<void>;
  readonly onDelete: (commentId: string) => void | Promise<void>;
  readonly onToggleResolve?: (
    commentId: string,
    resolved: boolean,
  ) => void | Promise<void>;
  readonly onToggleFlag?: (
    commentId: string,
    flagged: boolean,
  ) => void | Promise<void>;
  readonly onReply?: () => void;
}


export function CommentCard({
  comment,
  orgId,
  currentUserId,
  currentUserEmail,
  canModerate,
  canWrite,
  canPinAnyThread,
  isReply = false,
  replyToAuthor,
  replyToExcerpt,
  onJumpToParent,
  onEdit,
  onDelete,
  onToggleResolve,
  onToggleFlag,
  onReply,
}: Props) {
  const tComments = useTranslations("comments");
  const tCommon = useTranslations("common");
  const [isEditing, setIsEditing] = useState(false);

  const isSelf =
    (currentUserId != null && comment.author.id === currentUserId) ||
    (currentUserEmail != null &&
      comment.author.email != null &&
      comment.author.email.toLowerCase() ===
        currentUserEmail.toLowerCase());
  const isAuthor = isSelf;
  const canEdit = !comment.is_deleted && canWrite && isAuthor;
  const canDelete = !comment.is_deleted && (canModerate || isAuthor);
  const canFlagHere =
    !isReply &&
    !comment.is_deleted &&
    !comment.is_resolved &&
    onToggleFlag != null &&
    (canPinAnyThread || isAuthor);
  const canResolveHere =
    !isReply &&
    !comment.is_deleted &&
    comment.needs_resolution &&
    onToggleResolve != null &&
    (canPinAnyThread || isAuthor);
  const canReopen =
    !isReply &&
    !comment.is_deleted &&
    comment.is_resolved &&
    onToggleResolve != null &&
    (canPinAnyThread || isAuthor);

  // Deleted tombstone — thin, no bubble, aligned with the author.
  if (comment.is_deleted) {
    return (
      <div
        className={`flex px-3 py-1 ${
          isSelf ? "justify-end" : "justify-start"
        }`}
      >
        <span className="rounded-2xl bg-ink-50 px-3 py-1.5 text-xs italic text-ink-500">
          {tComments("states.deleted")}
        </span>
      </div>
    );
  }

  const displayName =
    comment.author.name || comment.author.email || "—";

  return (
    <div
      className={`group flex gap-2 px-3 py-1.5 ${
        isSelf ? "justify-end" : "justify-start"
      } ${comment.is_resolved ? "opacity-70" : ""}`}
    >
      {/* Avatar on the "other" side. Shows the author's uploaded
          photo when available, else falls back to the coloured
          initials pill. The self-side avatar mirrors below so the
          chat surface doesn't feel anonymous when half the bubbles
          are yours. */}
      {!isSelf ? (
        <div className="mt-5">
          <UserAvatar
            name={comment.author.name}
            email={comment.author.email}
            imageUrl={comment.author.avatar_url || null}
            size={28}
          />
        </div>
      ) : null}

      <div
        className={`flex min-w-0 max-w-[78%] flex-col gap-1 ${
          isSelf ? "items-end" : "items-start"
        }`}
      >
        {/* Reply-context quote header (Telegram-style).
            Clickable when ``onJumpToParent`` is provided — taps
            scroll the original message into view and flash it for
            visual confirmation, same machinery as the pinned-thread
            preview. The non-clickable variant stays available so
            kiosk / read-only surfaces don't render a button they
            can't act on. */}
        {replyToAuthor ? (
          onJumpToParent ? (
            <button
              type="button"
              onClick={onJumpToParent}
              title={tComments("reply.jump_hint")}
              className={`group flex max-w-full items-start gap-1 rounded-md px-1 py-0.5 text-[11px] text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-1000 ${
                isSelf ? "flex-row-reverse text-right" : ""
              }`}
            >
              <CornerUpLeft className="mt-[2px] h-3 w-3 shrink-0 text-orange-600" />
              <span className="truncate">
                <strong className="text-ink-700 group-hover:text-ink-1000">
                  {replyToAuthor}
                </strong>
                {replyToExcerpt ? (
                  <>
                    <span className="mx-1">·</span>
                    <span className="italic">“{replyToExcerpt}”</span>
                  </>
                ) : null}
              </span>
            </button>
          ) : (
            <div
              className={`flex max-w-full items-start gap-1 px-1 text-[11px] text-ink-500 ${
                isSelf ? "flex-row-reverse text-right" : ""
              }`}
            >
              <CornerUpLeft className="mt-[2px] h-3 w-3 shrink-0" />
              <span className="truncate">
                <strong className="text-ink-700">{replyToAuthor}</strong>
                {replyToExcerpt ? (
                  <>
                    <span className="mx-1">·</span>
                    <span className="italic">“{replyToExcerpt}”</span>
                  </>
                ) : null}
              </span>
            </div>
          )
        ) : null}

        {/* Bubble */}
        <div
          className={`relative rounded-2xl px-3 py-2 text-sm shadow-sm ${
            isSelf
              ? "rounded-br-sm bg-orange-500 text-ink-0"
              : "rounded-bl-sm bg-ink-100 text-ink-1000"
          }`}
        >
          {/* Author line — only for "other" bubbles. Self bubbles
              never repeat your own name. */}
          {!isSelf ? (
            <div className="mb-0.5 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold text-ink-700">
              <span>{displayName}</span>
              {/* Customer-side authors arrive with one of two kinds:
                   ``"client"`` (portal-authenticated ClientAccount,
                   the modern path) or ``"guest"`` (legacy kiosk).
                   Both should get the org chip + the "client" pill
                   so a teammate scanning the thread can tell at a
                   glance which bubbles are from outside the company. */}
              {(comment.author.kind === "client" ||
                comment.author.kind === "guest") &&
              comment.author.org_label ? (
                <span className="rounded-full bg-ink-0 px-1.5 py-[1px] text-[9px] font-medium text-ink-600 ring-1 ring-ink-200">
                  {comment.author.org_label}
                </span>
              ) : null}
              {comment.author.kind === "client" ||
              comment.author.kind === "guest" ? (
                <span className="rounded-full bg-orange-50 px-1.5 py-[1px] text-[9px] font-medium uppercase tracking-wide text-orange-700">
                  client
                </span>
              ) : null}
            </div>
          ) : null}

          {isEditing ? (
            <div className="min-w-[240px]">
              <CommentComposer
                orgId={orgId}
                initialValue={comment.body}
                placeholder={tComments("composer.placeholder")}
                submitLabel={tCommon("actions.save")}
                cancelLabel={tCommon("actions.cancel")}
                onSubmit={async (body) => {
                  await onEdit(comment.id, body);
                  setIsEditing(false);
                }}
                onCancel={() => setIsEditing(false)}
                autoFocus
              />
            </div>
          ) : (
            <p className="whitespace-pre-wrap break-words">
              {renderCommentBody(comment.body, comment.mentions)}
            </p>
          )}

          {/* Inner footer — timestamp + edited marker. Kept subtle
              so the main content stays visually dominant. */}
          <div
            className={`mt-1 flex items-center justify-end gap-1 text-[10px] ${
              isSelf ? "text-ink-0/70" : "text-ink-500"
            }`}
          >
            <span>{formatTimestamp(comment.created_at)}</span>
            {comment.is_edited ? (
              <span
                title={
                  comment.edited_at
                    ? formatTimestamp(comment.edited_at)
                    : undefined
                }
              >
                · {tComments("states.edited")}
              </span>
            ) : null}
          </div>
        </div>

        {/* Badges row below the bubble — pinned / resolved. */}
        {!isReply &&
        (comment.needs_resolution || comment.is_resolved) ? (
          <div
            className={`flex gap-1.5 text-[10px] ${
              isSelf ? "justify-end" : ""
            }`}
          >
            {comment.needs_resolution && !comment.is_resolved ? (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-1.5 py-0.5 font-medium uppercase tracking-wide text-warning"
                title={tComments("states.pinned_hint")}
              >
                <Pin className="h-2.5 w-2.5" />
                {tComments("states.pinned")}
              </span>
            ) : null}
            {comment.is_resolved ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-1.5 py-0.5 font-medium uppercase tracking-wide text-success">
                <CheckCircle2 className="h-2.5 w-2.5" />
                {tComments("states.resolved")}
              </span>
            ) : null}
          </div>
        ) : null}

        {/* Hover actions — floating row below the bubble, visible on
            group-hover so the default stream stays clean. Stays
            visible while any of its buttons is focused so keyboard
            users can still reach them. */}
        {!isEditing &&
        (onReply ||
          canEdit ||
          canDelete ||
          canFlagHere ||
          canResolveHere ||
          canReopen) ? (
          <div
            className={`flex gap-0.5 rounded-xl bg-ink-0 p-0.5 text-[11px] opacity-60 shadow-sm ring-1 ring-ink-200 transition-opacity hover:opacity-100 group-hover:opacity-100 focus-within:opacity-100 ${
              isSelf ? "self-end" : "self-start"
            }`}
          >
            {onReply && !isReply ? (
              <ActionButton
                icon={<Reply className="h-3 w-3" />}
                label={tComments("actions.reply")}
                onClick={onReply}
              />
            ) : null}
            {canFlagHere ? (
              <ActionButton
                icon={
                  <Flag
                    className={`h-3 w-3 ${
                      comment.needs_resolution ? "fill-current" : ""
                    }`}
                  />
                }
                label={
                  comment.needs_resolution
                    ? tComments("actions.unflag")
                    : tComments("actions.flag")
                }
                title={
                  comment.needs_resolution
                    ? tComments("actions.unflag_hint")
                    : tComments("actions.flag_hint")
                }
                onClick={() =>
                  onToggleFlag?.(comment.id, !comment.needs_resolution)
                }
              />
            ) : null}
            {canResolveHere ? (
              <ActionButton
                icon={<Check className="h-3 w-3" />}
                label={tComments("actions.resolve")}
                tone="success"
                onClick={() => onToggleResolve?.(comment.id, true)}
              />
            ) : null}
            {canReopen ? (
              <ActionButton
                icon={<Undo2 className="h-3 w-3" />}
                label={tComments("actions.reopen")}
                onClick={() => onToggleResolve?.(comment.id, false)}
              />
            ) : null}
            {canEdit ? (
              <ActionButton
                icon={<Pencil className="h-3 w-3" />}
                label={tComments("actions.edit")}
                onClick={() => setIsEditing(true)}
              />
            ) : null}
            {canDelete ? (
              <ActionButton
                icon={<Trash2 className="h-3 w-3" />}
                label={tComments("actions.delete")}
                tone="danger"
                onClick={() => {
                  if (window.confirm(tComments("confirm.delete"))) {
                    void onDelete(comment.id);
                  }
                }}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Mirror avatar on the self-side. Same 28px chip as the
          opposite layout so the conversation stays visually
          symmetric — both authors are equally identifiable at a
          glance. */}
      {isSelf ? (
        <div className="mt-5">
          <UserAvatar
            name={comment.author.name}
            email={comment.author.email}
            imageUrl={comment.author.avatar_url || null}
            size={28}
          />
        </div>
      ) : null}
    </div>
  );
}


function ActionButton({
  icon,
  label,
  title,
  tone,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  title?: string;
  tone?: "danger" | "success";
  onClick: () => void;
}) {
  const toneClasses =
    tone === "danger"
      ? "text-danger hover:bg-danger/5"
      : tone === "success"
        ? "text-success hover:bg-success/5"
        : "text-ink-600 hover:bg-ink-50";
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 ${toneClasses}`}
      title={title ?? label}
      onClick={onClick}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
