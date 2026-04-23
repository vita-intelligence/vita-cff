"use client";

/**
 * Top-level comment surface mounted on formulation + spec-sheet pages.
 *
 * Owns the TanStack Query hook(s), threading composition, and
 * orchestration of every mutation. Individual cards / threads stay
 * presentational so the WS-driven rewrite in commit 5 only has to
 * touch the hook layer.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, MessageSquare, Pin } from "lucide-react";
import { useTranslations } from "next-intl";

import { buttonClass } from "@/components/ui/button-styles";
import {
  commentsQueryKeys,
  openCommentsSocket,
  useCreateComment,
  useDeleteComment,
  useEditComment,
  useInfiniteComments,
  useSetCommentFlagged,
  useSetCommentResolved,
  type CommentEntityKind,
  type CommentsSocketHandle,
  type PaginatedCommentsDto,
} from "@/services/comments";

import { CommentComposer } from "./comment-composer";
import { CommentThread } from "./comment-thread";
import { InfiniteLoader } from "./infinite-loader";
import { PresenceAvatars } from "./presence-avatars";
import { TypingIndicator } from "./typing-indicator";
import { groupIntoThreads } from "./utils";

interface Props {
  readonly orgId: string;
  readonly entityKind: CommentEntityKind;
  readonly entityId: string;
  readonly canRead: boolean;
  readonly canWrite: boolean;
  readonly canModerate: boolean;
  readonly currentUserId: string | null;
  readonly initialFirstPage?: PaginatedCommentsDto | null;
  /** Who is expected to see this thread. ``"internal"`` means
   *  team-only (formulation workspaces, QC), ``"client"`` means the
   *  comments surface through the kiosk once the sheet is shared
   *  with the customer. The panel renders a prominent banner so
   *  scientists never accidentally post a rant onto a client's
   *  kiosk view. Default: inferred from ``entityKind``. */
  readonly visibility?: "internal" | "client";
}


export function CommentsPanel({
  orgId,
  entityKind,
  entityId,
  canRead,
  canWrite,
  canModerate,
  currentUserId,
  initialFirstPage = null,
  visibility,
}: Props) {
  const tComments = useTranslations("comments");
  // Client kiosks render comments from spec sheets only; everything
  // else (formulations, future QC surfaces) is internal-only. If the
  // caller passes ``visibility`` explicitly that wins — useful for
  // forcing internal on a sheet still in draft.
  const effectiveVisibility: "internal" | "client" =
    visibility ??
    (entityKind === "specification" ? "client" : "internal");
  const [includeResolved, setIncludeResolved] = useState(true);

  const query = useInfiniteComments({
    orgId,
    kind: entityKind,
    entityId,
    includeResolved,
    enabled: canRead,
    initialFirstPage,
  });

  const createMutation = useCreateComment(orgId, entityKind, entityId);
  const editMutation = useEditComment(orgId, entityKind, entityId);
  const deleteMutation = useDeleteComment(orgId, entityKind, entityId);
  const resolveMutation = useSetCommentResolved(
    orgId,
    entityKind,
    entityId,
  );
  const flagMutation = useSetCommentFlagged(orgId, entityKind, entityId);

  // One WS connection per panel instance. ``openCommentsSocket``
  // is ref-counted behind the scenes so two panels on the same
  // entity share a single socket. Opening inside ``useEffect`` so
  // the socket never attaches during SSR and the ref-count only
  // increments after hydration.
  const socketRef = useRef<CommentsSocketHandle | null>(null);
  const entityKey = useMemo(
    () => ({ orgId, kind: entityKind, entityId }),
    [orgId, entityKind, entityId],
  );
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!canRead) return;
    const handle = openCommentsSocket(entityKey, {
      // Every ``comment.*`` broadcast from the REST write path
      // invalidates the TanStack Query cache for this thread — the
      // list refetches once, stays consistent with whatever the
      // server persisted, and the whole surface repaints without
      // optimistic-merge gymnastics in the client.
      onCommentEvent: () => {
        queryClient.invalidateQueries({
          queryKey: [
            ...commentsQueryKeys.all,
            orgId,
            entityKind,
            entityId,
          ],
        });
      },
    });
    socketRef.current = handle;
    return () => {
      handle.release();
      socketRef.current = null;
    };
  }, [entityKey, canRead, queryClient, orgId, entityKind, entityId]);

  const comments = useMemo(() => {
    const pages = query.data?.pages ?? [];
    return pages.flatMap((p) => p.results);
  }, [query.data]);

  const threads = useMemo(() => groupIntoThreads(comments), [comments]);
  // Split pinned from regular so the panel can render pinned threads
  // in a sticky block that stays glued to the top while the rest of
  // the stream scrolls underneath.
  const pinnedThreads = useMemo(
    () =>
      threads.filter(
        (t) => t.root.needs_resolution && !t.root.is_resolved,
      ),
    [threads],
  );
  const regularThreads = useMemo(() => {
    const rest = threads.filter(
      (t) => !(t.root.needs_resolution && !t.root.is_resolved),
    );
    return includeResolved
      ? rest
      : rest.filter((t) => !t.root.is_resolved);
  }, [threads, includeResolved]);

  if (!canRead) {
    return (
      <section className="rounded-2xl bg-ink-0 p-6 text-sm text-ink-600 shadow-sm ring-1 ring-ink-200">
        <header className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-ink-500">
          <MessageSquare className="h-3.5 w-3.5" />
          {tComments("title")}
        </header>
        <p className="mt-3">{tComments("no_access")}</p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl bg-ink-0 shadow-sm ring-1 ring-ink-200">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-ink-500">
          <MessageSquare className="h-3.5 w-3.5" />
          {tComments("title")}
        </div>
        <div className="flex items-center gap-3">
          <PresenceAvatars
            entityKey={entityKey}
            excludeViewerId={currentUserId}
          />
          <label className="inline-flex items-center gap-1.5 text-xs text-ink-600">
            <input
              type="checkbox"
              checked={includeResolved}
              onChange={(e) => setIncludeResolved(e.target.checked)}
              className="h-3.5 w-3.5 accent-orange-500"
            />
            {tComments("filter.show_resolved")}
          </label>
        </div>
      </header>

      {/* Visibility banner — scientists need to know at a glance
          whether the thread is team-only or shared with the client.
          Two states, different colours, different icons so the
          signal survives a quick sideways glance. */}
      {effectiveVisibility === "client" ? (
        <div className="flex items-start gap-2 border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs text-warning">
          <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <div className="flex flex-col">
            <span className="font-semibold">
              {tComments("visibility.client.title")}
            </span>
            <span className="text-warning/90">
              {tComments("visibility.client.body")}
            </span>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2 border-b border-ink-100 bg-ink-50 px-4 py-2 text-xs text-ink-600">
          <EyeOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <div className="flex flex-col">
            <span className="font-semibold text-ink-700">
              {tComments("visibility.internal.title")}
            </span>
            <span>{tComments("visibility.internal.body")}</span>
          </div>
        </div>
      )}

      {/* Thread stream. A scroll container with ``overflow-y: auto``
          is required for ``position: sticky`` to anchor the pinned
          block against *this* scrollport rather than the page — we
          cap at 70vh so a long thread fits the viewport without
          pushing the rest of the page below the fold. */}
      <div
        className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto px-0 py-3"
      >
        {/* Pinned strip — only renders when at least one thread is
            flagged. Sticks to the top of the scroll container so
            "what needs a decision" is always in view. */}
        {pinnedThreads.length > 0 ? (
          <div className="sticky top-0 z-10 flex flex-col gap-2 border-b border-warning/30 bg-warning/5 px-4 py-2 backdrop-blur">
            <p className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-warning">
              <Pin className="h-2.5 w-2.5" />
              {tComments("states.pinned")} · {pinnedThreads.length}
            </p>
            {pinnedThreads.map((thread) => (
              <CommentThread
                key={`pin-${thread.root.id}`}
                root={thread.root}
                replies={thread.replies}
                orgId={orgId}
                currentUserId={currentUserId}
                canWrite={canWrite}
                canModerate={canModerate}
                onReply={async (parentId, body) => {
                  await createMutation.mutateAsync({
                    payload: { body, parent_id: parentId },
                  });
                }}
                onEdit={async (commentId, body) => {
                  await editMutation.mutateAsync({
                    commentId,
                    payload: { body },
                  });
                }}
                onDelete={async (commentId) => {
                  await deleteMutation.mutateAsync({ commentId });
                }}
                onToggleResolve={async (commentId, resolved) => {
                  await resolveMutation.mutateAsync({
                    commentId,
                    resolved,
                  });
                }}
                onToggleFlag={async (commentId, flagged) => {
                  await flagMutation.mutateAsync({ commentId, flagged });
                }}
              />
            ))}
          </div>
        ) : null}

        <div className="flex flex-col gap-3 px-4">
          {query.isLoading && regularThreads.length === 0 ? (
            <p className="text-xs text-ink-500">
              {tComments("states.loading")}
            </p>
          ) : regularThreads.length === 0 && pinnedThreads.length === 0 ? (
            <p className="text-xs text-ink-500">
              {tComments("states.empty")}
            </p>
          ) : (
            regularThreads.map((thread) => (
              <CommentThread
                key={thread.root.id}
                root={thread.root}
                replies={thread.replies}
                orgId={orgId}
                currentUserId={currentUserId}
                canWrite={canWrite}
                canModerate={canModerate}
                onReply={async (parentId, body) => {
                  await createMutation.mutateAsync({
                    payload: { body, parent_id: parentId },
                  });
                }}
                onEdit={async (commentId, body) => {
                  await editMutation.mutateAsync({
                    commentId,
                    payload: { body },
                  });
                }}
                onDelete={async (commentId) => {
                  await deleteMutation.mutateAsync({ commentId });
                }}
                onToggleResolve={async (commentId, resolved) => {
                  await resolveMutation.mutateAsync({
                    commentId,
                    resolved,
                  });
                }}
                onToggleFlag={async (commentId, flagged) => {
                  await flagMutation.mutateAsync({ commentId, flagged });
                }}
              />
            ))
          )}

          {query.hasNextPage ? (
            <InfiniteLoader
              onVisible={() => {
                if (!query.isFetchingNextPage) {
                  void query.fetchNextPage();
                }
              }}
              label={
                query.isFetchingNextPage
                  ? tComments("states.loading")
                  : tComments("actions.load_more")
              }
            />
          ) : null}
        </div>
      </div>

      <TypingIndicator
        entityKey={entityKey}
        excludeViewerId={currentUserId}
      />

      {canWrite ? (
        <div className="border-t border-ink-100 px-4 py-3">
          <CommentComposer
            orgId={orgId}
            placeholder={tComments("composer.placeholder")}
            submitLabel={tComments("actions.send")}
            isSubmitting={createMutation.isPending}
            onSubmit={async (body) => {
              await createMutation.mutateAsync({ payload: { body } });
            }}
            onTypingChange={(starting) => {
              socketRef.current?.sendTyping(starting);
            }}
          />
        </div>
      ) : null}
    </section>
  );
}
