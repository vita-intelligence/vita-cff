"use client";

/**
 * Top-level comment surface mounted on formulation + spec-sheet pages.
 *
 * Owns the TanStack Query hook(s), threading composition, and
 * orchestration of every mutation. Individual cards / threads stay
 * presentational so the WS-driven rewrite in commit 5 only has to
 * touch the hook layer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, CornerUpLeft, Eye, EyeOff, MessageSquare, Pin, X } from "lucide-react";
import { useTranslations } from "next-intl";

import type { CommentDto } from "@/services/comments";

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
import { CommentCard } from "./comment-card";
import { InfiniteLoader } from "./infinite-loader";
import { PinnedThreadPreview } from "./pinned-thread-preview";
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
  /** Whether the viewer can resolve / flag / reopen a thread they
   *  did NOT author. Defaults to ``canWrite`` so any staff team
   *  member who can post can also pin a client message — the
   *  housekeeping action they routinely need. Set to ``false``
   *  explicitly on customer-facing surfaces (kiosk) where clients
   *  must not flip the state of staff conversations. */
  readonly canPinAnyThread?: boolean;
  readonly currentUserId: string | null;
  readonly initialFirstPage?: PaginatedCommentsDto | null;
  /** Who is expected to see this thread. ``"internal"`` means
   *  team-only (formulation workspaces, QC), ``"client"`` means the
   *  comments surface through the kiosk once the sheet is shared
   *  with the customer. The panel renders a prominent banner so
   *  scientists never accidentally post a rant onto a client's
   *  kiosk view. Default: inferred from ``entityKind``. */
  readonly visibility?: "internal" | "client";
  /** ``"natural"`` (default) renders the panel at its content's
   *  intrinsic height, scrolling the inner thread list only when it
   *  exceeds 70vh — used for the inline spec-sheet placement.
   *  ``"fill"`` makes the panel fill its parent container's height
   *  with sticky header / banner / composer and a flex-grow thread
   *  scroller in between — used by the floating project comments
   *  bubble so chrome stays put while the conversation scrolls. */
  readonly layout?: "natural" | "fill";
  /** Optional visibility scope for both the read and the write path.
   *  Omitting it preserves the historical contract: the GET returns
   *  every comment the caller can see, and the POST visibility is
   *  auto-derived by the backend. Pass ``"internal"`` to mount a
   *  staff-only thread on a customer-facing entity (the new
   *  proposal-page internal bubble does this) or ``"shared"`` to
   *  scope an existing customer-conversation panel so an internal
   *  comment never bleeds back into it. */
  readonly visibilityFilter?: "internal" | "shared";
}


export function CommentsPanel({
  orgId,
  entityKind,
  entityId,
  canRead,
  canWrite,
  canModerate,
  canPinAnyThread,
  currentUserId,
  initialFirstPage = null,
  visibility,
  layout = "natural",
  visibilityFilter,
}: Props) {
  const tComments = useTranslations("comments");
  // Default the "can pin / resolve any thread" gate to ``canWrite``.
  // Every staff team member who can post a comment should also be
  // able to resolve a client thread — a non-destructive housekeeping
  // action, not a moderator privilege. Customer-facing surfaces
  // (kiosk) pass this explicitly as ``false`` so clients can't flip
  // staff conversations.
  const effectivePinAny = canPinAnyThread ?? canWrite;
  // Spec sheets, proposals, and CFF submissions are all customer-
  // facing surfaces — the portal mounts a matching shared-comment
  // thread on each, so the staff side has to default to
  // ``visibility="client"`` for replies to actually reach the
  // customer. Without this CFFs in particular were a silent one-way
  // leak: the customer's portal posts arrive shared (and we see
  // them because staff sees every visibility), but our replies
  // were stamped internal and the customer never saw them.
  //
  // Formulation threads stay internal-only unless the caller passes
  // ``visibility`` explicitly — those are team workspaces with no
  // customer-facing twin. Callers can still force ``internal`` on a
  // customer-facing surface in flight (e.g. an unsent spec draft).
  const effectiveVisibility: "internal" | "client" =
    visibility ??
    (entityKind === "specification" ||
    entityKind === "proposal" ||
    entityKind === "cff_submission"
      ? "client"
      : "internal");
  const isFill = layout === "fill";
  const [includeResolved, setIncludeResolved] = useState(true);

  const query = useInfiniteComments({
    orgId,
    kind: entityKind,
    entityId,
    includeResolved,
    enabled: canRead,
    initialFirstPage,
    visibilityFilter,
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
  // the stream scrolls underneath. Pinned still operates on the
  // grouped view because "flagged for resolution" is a root-level
  // state — only roots can be pinned.
  const pinnedThreads = useMemo(
    () =>
      threads.filter(
        (t) => t.root.needs_resolution && !t.root.is_resolved,
      ),
    [threads],
  );
  // Quick lookup table so a reply card can find its parent without
  // re-scanning the comment list — used to populate the "↳ Replying
  // to X" quote header on each reply and to gate the
  // ``includeResolved`` filter on replies whose parent is resolved.
  const commentById = useMemo(() => {
    const map = new Map<string, CommentDto>();
    for (const comment of comments) {
      map.set(comment.id, comment);
    }
    return map;
  }, [comments]);
  // Linear chat stream: every comment in chronological order,
  // regardless of whether it's a root or a reply. Replies render with
  // their existing quote header pointing back at the parent (click
  // jumps to the original). Mirrors Telegram / WhatsApp / Slack-with-
  // threads-collapsed so a freshly-posted reply always lands at the
  // bottom — never tucked into the middle next to an ancient root.
  const linearComments = useMemo(() => {
    if (includeResolved) return comments;
    return comments.filter((comment) => {
      if (comment.parent_id == null) {
        return !comment.is_resolved;
      }
      const parent = commentById.get(comment.parent_id);
      // If the parent is missing (filter dropped it) the reply has
      // nowhere to attach — drop it too so we don't render an
      // orphan with a broken quote header.
      return parent != null && !parent.is_resolved;
    });
  }, [comments, commentById, includeResolved]);

  // Per-thread refs so a pinned-preview click can scroll the full
  // thread into view. Keyed by root comment id — built on every
  // render but stable across renders thanks to the empty-Map fresh
  // identity check below.
  const threadRefsRef = useRef<Map<string, HTMLElement>>(new Map());
  const setThreadRef = useCallback(
    (rootId: string) => (node: HTMLElement | null) => {
      if (node) {
        threadRefsRef.current.set(rootId, node);
      } else {
        threadRefsRef.current.delete(rootId);
      }
    },
    [],
  );
  const [highlightedRootId, setHighlightedRootId] = useState<string | null>(
    null,
  );
  const highlightTimer = useRef<number | null>(null);
  const scrollToThread = useCallback((rootId: string) => {
    const node = threadRefsRef.current.get(rootId);
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedRootId(rootId);
    if (highlightTimer.current !== null) {
      window.clearTimeout(highlightTimer.current);
    }
    highlightTimer.current = window.setTimeout(() => {
      setHighlightedRootId(null);
      highlightTimer.current = null;
    }, 1600);
  }, []);
  useEffect(() => {
    return () => {
      if (highlightTimer.current !== null) {
        window.clearTimeout(highlightTimer.current);
      }
    };
  }, []);

  // -------------------------------------------------------------------
  // Chat-style auto-scroll + "new message" pill
  // -------------------------------------------------------------------
  //
  // The thread stream is rendered oldest -> newest top-down, so
  // bottom of the scroll container = the most recent comment. We
  // mirror the WhatsApp/Telegram/Slack convention:
  //
  //  * Initial mount: jump to the bottom once comments have loaded
  //    so the panel always opens on today's conversation.
  //  * New message arrives while the user is reading the latest:
  //    smooth-scroll to the new bottom automatically.
  //  * New message arrives while the user is scrolled up reading
  //    history: keep their position and surface a floating "N new"
  //    pill at the bottom-right. Clicking the pill scrolls to the
  //    bottom and clears the badge.
  //
  // ``isAtBottomRef`` tracks position via a scroll listener so the
  // arrival decision doesn't have to query layout numbers on every
  // render. ``newMessageCount`` is a render-state so the pill
  // can react.
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const lastCommentCountRef = useRef<number>(0);
  const lastLatestIdRef = useRef<string | null>(null);
  const didInitialScrollRef = useRef<boolean>(false);
  const isAtBottomRef = useRef<boolean>(true);
  const [newMessageCount, setNewMessageCount] = useState(0);

  // -------------------------------------------------------------------
  // Reply target — handled by the bottom composer
  // -------------------------------------------------------------------
  //
  // Clicking "Reply" on a thread no longer opens a per-thread inline
  // composer. Instead the panel tracks which root the next outgoing
  // message should attach to, surfaces a "Replying to X" chip above
  // the bottom composer, and threads ``parent_id`` through on send.
  // Bumping ``composerFocusToken`` drags input focus down to the
  // composer so the user can start typing immediately.
  const [replyingTo, setReplyingTo] = useState<{
    readonly rootId: string;
    readonly authorLabel: string;
    readonly excerpt: string;
  } | null>(null);
  const [composerFocusToken, setComposerFocusToken] = useState(0);
  const handleStartReply = useCallback(
    (rootId: string, authorLabel: string, excerpt: string) => {
      setReplyingTo({ rootId, authorLabel, excerpt });
      setComposerFocusToken((prev) => prev + 1);
    },
    [],
  );
  const handleCancelReply = useCallback(() => {
    setReplyingTo(null);
    setComposerFocusToken((prev) => prev + 1);
  }, []);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const node = scrollContainerRef.current;
      if (!node) return;
      node.scrollTo({ top: node.scrollHeight, behavior });
      isAtBottomRef.current = true;
      setNewMessageCount(0);
    },
    [],
  );

  // Mark "at bottom" using a generous 80px slack so the pill
  // doesn't show when the user is reading the latest message but
  // not pixel-perfect at the bottom edge.
  const handleScroll = useCallback(() => {
    const node = scrollContainerRef.current;
    if (!node) return;
    const distance =
      node.scrollHeight - node.scrollTop - node.clientHeight;
    const wasAtBottom = isAtBottomRef.current;
    const nowAtBottom = distance < 80;
    isAtBottomRef.current = nowAtBottom;
    // Scrolling back to the bottom dismisses any pending "new"
    // pill: the user has caught up either by clicking the pill or
    // by scrolling manually.
    if (!wasAtBottom && nowAtBottom && newMessageCount > 0) {
      setNewMessageCount(0);
    }
  }, [newMessageCount]);

  // First-paint scroll: once the very first batch of comments has
  // loaded, jump to the bottom without animation so the panel
  // opens fully scrolled.
  useEffect(() => {
    if (didInitialScrollRef.current) return;
    if (comments.length === 0) return;
    didInitialScrollRef.current = true;
    lastCommentCountRef.current = comments.length;
    lastLatestIdRef.current = comments[comments.length - 1]?.id ?? null;
    // ``requestAnimationFrame`` defers the scroll until after layout
    // — without it ``scrollHeight`` may still be 0 on the first
    // render and the jump misses.
    requestAnimationFrame(() => scrollToBottom("auto"));
  }, [comments, scrollToBottom]);

  // Subsequent arrivals: compare against the last-seen count + tail
  // id. We compare ids too so the effect doesn't fire for cache
  // refreshes that leave the list unchanged (TanStack Query can
  // re-emit identical data on a refocus).
  useEffect(() => {
    if (!didInitialScrollRef.current) return;
    const prevCount = lastCommentCountRef.current;
    const nextCount = comments.length;
    if (nextCount <= prevCount) {
      // Comments shrank (delete) — sync the ref and bail. No new
      // message to announce.
      lastCommentCountRef.current = nextCount;
      lastLatestIdRef.current = comments[nextCount - 1]?.id ?? null;
      return;
    }
    const prevLatestId = lastLatestIdRef.current;
    const newest = comments[nextCount - 1];
    const nextLatestId = newest?.id ?? null;
    lastCommentCountRef.current = nextCount;
    lastLatestIdRef.current = nextLatestId;
    if (prevLatestId === nextLatestId) return;
    const added = nextCount - prevCount;
    // Linear chat: every new comment — root or reply — renders at
    // the bottom in chronological order, so the scroll target is
    // always the end of the list.
    if (isAtBottomRef.current) {
      requestAnimationFrame(() => scrollToBottom("smooth"));
    } else {
      setNewMessageCount((prev) => prev + added);
    }
  }, [comments, scrollToBottom]);

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
    <section
      className={
        isFill
          ? "flex h-full min-h-0 flex-col bg-ink-0"
          : "rounded-2xl bg-ink-0 shadow-sm ring-1 ring-ink-200"
      }
    >
      <header
        className={
          isFill
            ? "flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-ink-100 px-4 py-2.5"
            : "flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 px-4 py-3"
        }
      >
        {/* In fill mode the bubble's outer header already names the
            surface ("Project comments · {project name}"), so we
            collapse the inner title down to just the presence chips
            on the left and the filter toggle on the right. Saves
            ~28px of vertical real estate that the thread list gets
            instead. */}
        {isFill ? (
          <PresenceAvatars
            entityKey={entityKey}
            excludeViewerId={currentUserId}
          />
        ) : (
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-ink-500">
            <MessageSquare className="h-3.5 w-3.5" />
            {tComments("title")}
          </div>
        )}
        <div className="flex items-center gap-3">
          {isFill ? null : (
            <PresenceAvatars
              entityKey={entityKey}
              excludeViewerId={currentUserId}
            />
          )}
          <label className="inline-flex items-center gap-1.5 text-xs text-ink-600">
            <input
              type="checkbox"
              checked={includeResolved}
              onChange={(e) => setIncludeResolved(e.target.checked)}
              className="h-3.5 w-3.5 accent-orange-500"
            />
            {tComments("filter.show_resolved")}
          </label>
          {/*
            Manual "Notify client" button removed — every public
            comment now auto-fires an email to the customer the
            same way teammates get pinged for replies / mentions.
            See ``apps/comments/notifications.py:_dispatch_customer``.
          */}
        </div>
      </header>

      {/* Visibility banner — scientists need to know at a glance
          whether the thread is team-only or shared with the client.
          Two states, different colours, different icons so the
          signal survives a quick sideways glance. */}
      {effectiveVisibility === "client" ? (
        <div
          className={
            isFill
              ? "flex shrink-0 items-start gap-2 border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs text-warning"
              : "flex items-start gap-2 border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs text-warning"
          }
        >
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
        <div
          className={
            isFill
              ? "flex shrink-0 items-start gap-2 border-b border-ink-100 bg-ink-50 px-4 py-2 text-xs text-ink-600"
              : "flex items-start gap-2 border-b border-ink-100 bg-ink-50 px-4 py-2 text-xs text-ink-600"
          }
        >
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
          block against *this* scrollport rather than the page. In
          natural layout we cap at 70vh so a long thread fits the
          viewport without pushing the rest of the page below the
          fold; in fill layout we let flex-grow take whatever space
          the parent allows so the bubble's header + composer can
          stay stuck against the edges of the card.
          The wrapping ``relative`` container hosts the floating
          "↓ N new" pill so it stays glued to the bottom-right of
          the scroll viewport rather than the page. */}
      <div
        className={
          isFill
            ? "relative flex min-h-0 flex-1 flex-col"
            : "relative flex flex-col"
        }
      >
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className={
          isFill
            ? "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-0 py-3"
            : "flex max-h-[70vh] flex-col gap-3 overflow-y-auto px-0 py-3"
        }
      >
        {/* Pinned strip — compact previews of flagged threads.
            Sticks to the top of the scroll container so "what needs
            a decision" is always in view. Each row truncates to a
            single line and click-scrolls to the full thread in the
            chronological stream below; rendering the entire flagged
            comment here used to dominate the bubble whenever the
            root body was long. */}
        {pinnedThreads.length > 0 ? (
          <div className="sticky top-0 z-10 flex flex-col gap-1.5 border-b border-warning/30 bg-warning/5 px-4 py-2 backdrop-blur">
            <p className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-warning">
              <Pin className="h-2.5 w-2.5" />
              {tComments("states.pinned")} · {pinnedThreads.length}
            </p>
            <ul className="flex flex-col gap-1">
              {pinnedThreads.map((thread) => (
                <li key={`pin-${thread.root.id}`}>
                  <PinnedThreadPreview
                    root={thread.root}
                    replyCount={thread.replies.length}
                    onSelect={() => scrollToThread(thread.root.id)}
                  />
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-col gap-2 px-4">
          {query.isLoading && linearComments.length === 0 ? (
            <p className="text-xs text-ink-500">
              {tComments("states.loading")}
            </p>
          ) : linearComments.length === 0 && pinnedThreads.length === 0 ? (
            <p className="text-xs text-ink-500">
              {tComments("states.empty")}
            </p>
          ) : (
            linearComments.map((comment) => {
              // Each comment renders as its own card in chronological
              // order — newest at the bottom. Replies show a clickable
              // quote header pointing at the parent root; clicking it
              // scrolls to the original and flashes the highlight ring
              // (same machinery as the pinned-preview click).
              const isRoot = comment.parent_id == null;
              const parent =
                !isRoot && comment.parent_id
                  ? commentById.get(comment.parent_id) ?? null
                  : null;
              const replyToAuthor = parent
                ? parent.author.name || parent.author.email || "—"
                : null;
              const replyToExcerpt =
                parent && !parent.is_deleted
                  ? excerptForQuote(parent.body)
                  : null;
              // ``parent_id`` for new replies is always the ROOT id
              // (the data model is one-level threading). When the
              // user clicks "Reply" on a reply, we still attach the
              // new comment to the same root but surface the clicked
              // person's name in the composer chip so it doesn't
              // misleadingly say "Replying to {root.author}" when
              // they actually clicked someone further down.
              const replyAttachRootId = isRoot
                ? comment.id
                : comment.parent_id ?? comment.id;
              const replyChipAuthor =
                comment.author.name || comment.author.email || "—";
              const replyChipExcerpt = comment.is_deleted
                ? ""
                : excerptForQuote(comment.body);
              const isHighlighted =
                isRoot && highlightedRootId === comment.id;
              return (
                <div
                  key={comment.id}
                  ref={isRoot ? setThreadRef(comment.id) : undefined}
                  // ``scroll-mt-2`` gives the scrolled-to root a
                  // little breathing room under the sticky pinned
                  // strip / banner. The transient highlight ring
                  // surrounds the root's bubble row and is cleared
                  // by the timeout in ``scrollToThread``.
                  className={`scroll-mt-2 rounded-2xl transition-shadow ${
                    isHighlighted ? "ring-2 ring-orange-400/70" : ""
                  } ${
                    isRoot &&
                    comment.needs_resolution &&
                    !comment.is_resolved
                      ? "bg-warning/5 ring-1 ring-inset ring-warning/30"
                      : ""
                  } ${
                    isRoot && comment.is_resolved ? "bg-ink-50/60" : ""
                  }`}
                >
                  <CommentCard
                    comment={comment}
                    orgId={orgId}
                    currentUserId={currentUserId}
                    canModerate={canModerate}
                    canWrite={canWrite}
                    canPinAnyThread={effectivePinAny}
                    isReply={!isRoot}
                    replyToAuthor={replyToAuthor}
                    replyToExcerpt={replyToExcerpt}
                    onJumpToParent={
                      parent
                        ? () => scrollToThread(parent.id)
                        : undefined
                    }
                    onEdit={async (commentId, body) => {
                      await editMutation.mutateAsync({
                        commentId,
                        payload: { body },
                      });
                    }}
                    onDelete={async (commentId) => {
                      await deleteMutation.mutateAsync({ commentId });
                    }}
                    onToggleResolve={
                      isRoot
                        ? async (commentId, resolved) => {
                            await resolveMutation.mutateAsync({
                              commentId,
                              resolved,
                            });
                          }
                        : undefined
                    }
                    onToggleFlag={
                      isRoot
                        ? async (commentId, flagged) => {
                            await flagMutation.mutateAsync({
                              commentId,
                              flagged,
                            });
                          }
                        : undefined
                    }
                    onReply={
                      canWrite &&
                      !comment.is_deleted &&
                      (parent ? !parent.is_resolved : !comment.is_resolved)
                        ? () =>
                            handleStartReply(
                              replyAttachRootId,
                              replyChipAuthor,
                              replyChipExcerpt,
                            )
                        : undefined
                    }
                  />
                </div>
              );
            })
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

      {/* "New message" pill — only renders when the user has
          scrolled up AND a new message arrived while they were
          reading history. Clicking jumps them back to the bottom
          and clears the badge. Positioned absolute inside the
          ``relative`` wrapper above so it tracks the scroll
          viewport rather than the page. */}
      {newMessageCount > 0 ? (
        <button
          type="button"
          onClick={() => scrollToBottom("smooth")}
          aria-label={tComments("scroll.new_messages_aria", {
            count: newMessageCount,
          })}
          className="absolute bottom-3 right-3 z-20 inline-flex items-center gap-1.5 rounded-full bg-orange-500 px-3 py-1.5 text-xs font-medium text-ink-0 shadow-lg ring-1 ring-orange-600/40 transition-transform hover:scale-105 hover:bg-orange-600"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          {tComments("scroll.new_messages", {
            count: newMessageCount,
          })}
        </button>
      ) : null}
      </div>

      <div className={isFill ? "shrink-0" : ""}>
        <TypingIndicator
          entityKey={entityKey}
          excludeViewerId={currentUserId}
        />
      </div>

      {canWrite ? (
        <div
          className={
            isFill
              ? "shrink-0 border-t border-ink-100 px-4 py-3"
              : "border-t border-ink-100 px-4 py-3"
          }
        >
          {/* Reply context chip — only renders when the user has
              clicked "Reply" on a thread. The next send threads
              ``parent_id`` so the new comment hangs off that root.
              Clicking the X (or pressing Escape in a future
              iteration) clears the target and the composer goes
              back to posting a fresh top-level message. */}
          {replyingTo ? (
            <div className="mb-2 flex items-start gap-2 rounded-lg bg-ink-100/70 px-2.5 py-1.5 text-xs ring-1 ring-inset ring-ink-200">
              <CornerUpLeft
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-600"
                aria-hidden
              />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
                  {tComments("reply.replying_to", {
                    author: replyingTo.authorLabel,
                  })}
                </span>
                {replyingTo.excerpt ? (
                  <span className="truncate text-ink-700">
                    {replyingTo.excerpt}
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                onClick={handleCancelReply}
                aria-label={tComments("reply.cancel")}
                title={tComments("reply.cancel")}
                className="shrink-0 rounded-md p-1 text-ink-500 transition-colors hover:bg-ink-200 hover:text-ink-1000"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}
          <CommentComposer
            orgId={orgId}
            placeholder={
              replyingTo
                ? tComments("composer.reply_placeholder")
                : tComments("composer.placeholder")
            }
            submitLabel={tComments("actions.send")}
            isSubmitting={createMutation.isPending}
            focusToken={composerFocusToken}
            onSubmit={async (body) => {
              const parentId = replyingTo?.rootId ?? null;
              // Map the panel's ``client | internal`` visibility to
              // the backend's ``shared | internal`` enum. Sending
              // it explicitly only when the caller has scoped this
              // panel via ``visibilityFilter`` (or passed
              // ``visibility``) — otherwise the backend's
              // entity-kind default keeps running, which preserves
              // the contract every existing mount relies on.
              const visibilityOut: "internal" | "shared" | undefined =
                visibilityFilter
                  ? visibilityFilter
                  : effectiveVisibility === "client"
                    ? "shared"
                    : "internal";
              const sendVisibility = visibilityFilter || visibility
                ? visibilityOut
                : undefined;
              await createMutation.mutateAsync({
                payload: parentId
                  ? { body, parent_id: parentId, visibility: sendVisibility }
                  : { body, visibility: sendVisibility },
              });
              // Clear the reply target after a successful send so
              // the next message is a fresh top-level post unless
              // the user clicks "Reply" on a different thread.
              if (parentId) {
                setReplyingTo(null);
              }
              // Linear chat: the user's new message — root or reply —
              // always lands at the bottom in chronological order,
              // so jump there for instant visual confirmation.
              requestAnimationFrame(() => scrollToBottom("smooth"));
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


// Soft cap on the body excerpt shown in a reply card's quote header
// + the composer's "Replying to {author}" chip. 90 chars matches the
// pinned-preview cap so a single mental model — "one-line summary
// with a click to expand" — covers every place a comment gets
// previewed in the panel.
const QUOTE_EXCERPT_CHARS = 90;


function excerptForQuote(body: string): string {
  const trimmed = (body || "").replace(/\s+/g, " ").trim();
  if (trimmed.length <= QUOTE_EXCERPT_CHARS) return trimmed;
  return trimmed.slice(0, QUOTE_EXCERPT_CHARS).trimEnd() + "…";
}
