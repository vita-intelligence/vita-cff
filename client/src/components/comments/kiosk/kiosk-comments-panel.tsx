"use client";

/**
 * Public-visitor comment panel mounted on ``/p/<token>``.
 *
 * Visual + interaction parity with the authed
 * :class:`CommentsPanel` so a client opening their spec sheet sees
 * the same chat layout the team uses on the project workspace:
 *
 *   - Linear chronological stream (newest at the bottom).
 *   - Compact pinned-preview rows at the top with click-to-scroll.
 *   - Sticky header / typing indicator / composer with only the
 *     message list scrolling between them.
 *   - Auto-scroll to the latest on first load and on new arrivals,
 *     with a floating "↓ N new messages" pill when the visitor is
 *     scrolled up reading history.
 *   - Avatars on both sides (mine vs theirs) for visual symmetry.
 *
 * Behavioural differences from the authed panel preserved:
 *   - No mentions, no moderation, no resolve toggle — the visitor
 *     can only post top-level comments.
 *   - Identity is captured once per browser session via the
 *     :class:`KioskIdentityModal`.
 *   - Comments live in local component state (no TanStack Query)
 *     — refreshed via the public WebSocket or an on-focus refetch.
 */

import { MessageSquare, ArrowDown, Pin } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { buttonClass } from "@/components/ui/button-styles";
import {
  openKioskCommentsSocket,
  type CommentDto,
  type CommentsSocketHandle,
  type PaginatedCommentsDto,
} from "@/services/comments";
import {
  createKioskComment,
  fetchKioskCommentsPage,
  signOutKioskVisitor,
  type KioskIdentityEcho,
} from "@/services/comments/kiosk-api";

import { CommentCard } from "../comment-card";
import { InfiniteLoader } from "../infinite-loader";
import { PinnedThreadPreview } from "../pinned-thread-preview";
import { PresenceAvatars } from "../presence-avatars";
import { TypingIndicator } from "../typing-indicator";
import { groupIntoThreads } from "../utils";

import { KioskIdentityModal } from "./kiosk-identity-modal";


interface Props {
  readonly token: string;
}


//: localStorage marker keyed per token so a visitor stays
//: "signed in" across refreshes / tab closes.
const identifiedKey = (token: string) => `vita_kiosk_${token}_identified`;


// Soft cap on the body excerpt shown in a reply card's quote
// header. Same as the authed panel — keeps the kiosk's reply-back-
// to-original navigation visually consistent.
const QUOTE_EXCERPT_CHARS = 90;


function excerptForQuote(body: string): string {
  const trimmed = (body || "").replace(/\s+/g, " ").trim();
  if (trimmed.length <= QUOTE_EXCERPT_CHARS) return trimmed;
  return trimmed.slice(0, QUOTE_EXCERPT_CHARS).trimEnd() + "…";
}


export function KioskCommentsPanel({ token }: Props) {
  const tComments = useTranslations("comments");
  const tKiosk = useTranslations("comments.kiosk");

  const [identity, setIdentity] = useState<KioskIdentityEcho | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [comments, setComments] = useState<readonly CommentDto[]>([]);
  const [nextUrl, setNextUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Lookup map for reply quote headers — finds the parent comment
  // by id so a reply card can render "↳ Replying to X" pointing
  // back at the original. Mirrors the authed panel.
  const commentById = useMemo(() => {
    const map = new Map<string, CommentDto>();
    for (const comment of comments) {
      map.set(comment.id, comment);
    }
    return map;
  }, [comments]);

  // Pinned strip — only flagged-but-unresolved root comments. Drawn
  // from the grouped view because "needs resolution" is a root-level
  // state. Replies never appear in the strip.
  const pinnedRoots = useMemo(() => {
    const grouped = groupIntoThreads(comments);
    return grouped
      .filter((t) => t.root.needs_resolution && !t.root.is_resolved)
      .map((t) => ({ root: t.root, replyCount: t.replies.length }));
  }, [comments]);

  // Linear stream — every comment in chronological order. Replies
  // whose parent is resolved drop out for symmetry with the parent.
  const linearComments = useMemo(() => {
    return comments.filter((comment) => {
      if (comment.parent_id == null) return !comment.is_resolved;
      const parent = commentById.get(comment.parent_id);
      return parent != null && !parent.is_resolved;
    });
  }, [comments, commentById]);

  // Presence store key — mirrors the one ``openKioskCommentsSocket``
  // uses so the avatars / typing indicator read the right roster.
  const entityKey = useMemo(
    () => ({
      orgId: "public" as const,
      kind: "specification" as const,
      entityId: token,
    }),
    [token],
  );

  const refresh = useCallback(async () => {
    try {
      const page = await fetchKioskCommentsPage(token);
      setComments(page.results);
      setNextUrl(page.next);
      setLoading(false);
    } catch {
      setLoading(false);
    }
  }, [token]);

  const loadMore = useCallback(async () => {
    if (!nextUrl) return;
    try {
      const page: PaginatedCommentsDto = await fetchKioskCommentsPage(
        token,
        { cursorUrl: nextUrl },
      );
      setComments((prev) => [...prev, ...page.results]);
      setNextUrl(page.next);
    } catch {
      /* leave the button visible so the user can retry */
    }
  }, [nextUrl, token]);

  // -------------------------------------------------------------------
  // Identity bootstrap + WebSocket sync
  // -------------------------------------------------------------------
  useEffect(() => {
    if (typeof window === "undefined") return;
    const marker = window.localStorage.getItem(identifiedKey(token));
    if (marker) {
      try {
        const parsed = JSON.parse(marker) as KioskIdentityEcho;
        setIdentity(parsed);
      } catch {
        setIdentity({ name: "", email: "", company: "" });
      }
    }
    void refresh();
  }, [refresh, token]);

  const socketRef = useRef<CommentsSocketHandle | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!identity) return;
    const handle = openKioskCommentsSocket(token, {
      onCommentEvent: () => {
        void refresh();
      },
    });
    socketRef.current = handle;
    return () => {
      handle.release();
      socketRef.current = null;
    };
  }, [identity, refresh, token]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // -------------------------------------------------------------------
  // Per-thread refs + scroll-to-thread helper (pinned-preview click +
  // reply quote-header click). Reuses the exact pattern from the
  // authed panel.
  // -------------------------------------------------------------------
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
  // Auto-scroll + "new message" pill
  // -------------------------------------------------------------------
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const lastCommentCountRef = useRef<number>(0);
  const lastLatestIdRef = useRef<string | null>(null);
  const didInitialScrollRef = useRef<boolean>(false);
  const isAtBottomRef = useRef<boolean>(true);
  const [newMessageCount, setNewMessageCount] = useState(0);

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

  const handleScroll = useCallback(() => {
    const node = scrollContainerRef.current;
    if (!node) return;
    const distance =
      node.scrollHeight - node.scrollTop - node.clientHeight;
    const wasAtBottom = isAtBottomRef.current;
    const nowAtBottom = distance < 80;
    isAtBottomRef.current = nowAtBottom;
    if (!wasAtBottom && nowAtBottom && newMessageCount > 0) {
      setNewMessageCount(0);
    }
  }, [newMessageCount]);

  useEffect(() => {
    if (didInitialScrollRef.current) return;
    if (comments.length === 0) return;
    didInitialScrollRef.current = true;
    lastCommentCountRef.current = comments.length;
    lastLatestIdRef.current = comments[comments.length - 1]?.id ?? null;
    requestAnimationFrame(() => scrollToBottom("auto"));
  }, [comments, scrollToBottom]);

  useEffect(() => {
    if (!didInitialScrollRef.current) return;
    const prevCount = lastCommentCountRef.current;
    const nextCount = comments.length;
    if (nextCount <= prevCount) {
      lastCommentCountRef.current = nextCount;
      lastLatestIdRef.current = comments[nextCount - 1]?.id ?? null;
      return;
    }
    const prevLatestId = lastLatestIdRef.current;
    const nextLatestId = comments[nextCount - 1]?.id ?? null;
    lastCommentCountRef.current = nextCount;
    lastLatestIdRef.current = nextLatestId;
    if (prevLatestId === nextLatestId) return;
    const added = nextCount - prevCount;
    if (isAtBottomRef.current) {
      requestAnimationFrame(() => scrollToBottom("smooth"));
    } else {
      setNewMessageCount((prev) => prev + added);
    }
  }, [comments, scrollToBottom]);

  const handleIdentified = (echo: KioskIdentityEcho) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        identifiedKey(token),
        JSON.stringify(echo),
      );
    }
    setIdentity(echo);
    setModalOpen(false);
  };

  const handleSignOut = async () => {
    try {
      await signOutKioskVisitor(token);
    } catch {
      /* cookie clear is best-effort */
    }
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(identifiedKey(token));
    }
    setIdentity(null);
  };

  const handlePost = async (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setPosting(true);
    setError(null);
    try {
      const created = await createKioskComment(token, { body: body.trim() });
      setComments((prev) => [...prev, created]);
      setBody("");
      socketRef.current?.sendTyping(false);
      // Land the visitor on their own freshly-posted message.
      requestAnimationFrame(() => scrollToBottom("smooth"));
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      if (status === 403) {
        setError(tKiosk("error_session_expired"));
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(identifiedKey(token));
        }
        setIdentity(null);
      } else {
        setError(tKiosk("error_generic"));
      }
    } finally {
      setPosting(false);
    }
  };

  return (
    <section className="flex max-h-[80vh] min-h-[28rem] flex-col overflow-hidden rounded-2xl bg-ink-0 shadow-sm ring-1 ring-ink-200">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-ink-500">
          <MessageSquare className="h-3.5 w-3.5" />
          {tComments("title")}
        </div>
        <div className="flex items-center gap-3">
          {/* Presence strip — org members + other clients watching
              the same sheet. The visitor's own avatar shows too so
              they have a stable "you're here" cue. */}
          <PresenceAvatars entityKey={entityKey} />
          {identity ? (
            <div className="flex items-center gap-2 text-xs text-ink-600">
              <span>
                {tKiosk("signed_in_as", {
                  name: identity.name || identity.email,
                })}
              </span>
              <button
                type="button"
                className="rounded-md px-2 py-0.5 text-ink-500 hover:bg-ink-50 hover:text-ink-1000"
                onClick={() => void handleSignOut()}
              >
                {tKiosk("sign_out")}
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {/* Scroll viewport — wrapped in a relative container so the
          floating "↓ N new messages" pill can anchor to the bottom-
          right of the scrollport rather than the page. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto py-3"
        >
          {pinnedRoots.length > 0 ? (
            <div className="sticky top-0 z-10 flex flex-col gap-1.5 border-b border-warning/30 bg-warning/5 px-4 py-2 backdrop-blur">
              <p className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-warning">
                <Pin className="h-2.5 w-2.5" />
                {tComments("states.pinned")} · {pinnedRoots.length}
              </p>
              <ul className="flex flex-col gap-1">
                {pinnedRoots.map((entry) => (
                  <li key={`pin-${entry.root.id}`}>
                    <PinnedThreadPreview
                      root={entry.root}
                      replyCount={entry.replyCount}
                      onSelect={() => scrollToThread(entry.root.id)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex flex-col gap-2 px-4">
            {loading && linearComments.length === 0 ? (
              <p className="text-xs text-ink-500">
                {tComments("states.loading")}
              </p>
            ) : linearComments.length === 0 && pinnedRoots.length === 0 ? (
              <p className="text-xs text-ink-500">
                {tComments("states.empty")}
              </p>
            ) : (
              linearComments.map((comment) => {
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
                const isHighlighted =
                  isRoot && highlightedRootId === comment.id;
                return (
                  <div
                    key={comment.id}
                    ref={isRoot ? setThreadRef(comment.id) : undefined}
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
                      orgId=""
                      currentUserId={null}
                      currentUserEmail={identity?.email ?? null}
                      canModerate={false}
                      canWrite={false}
                      isReply={!isRoot}
                      replyToAuthor={replyToAuthor}
                      replyToExcerpt={replyToExcerpt}
                      onJumpToParent={
                        parent
                          ? () => scrollToThread(parent.id)
                          : undefined
                      }
                      onEdit={async () => undefined}
                      onDelete={async () => undefined}
                    />
                  </div>
                );
              })
            )}
            {nextUrl ? (
              <InfiniteLoader
                onVisible={() => void loadMore()}
                label={tComments("actions.load_more")}
              />
            ) : null}
          </div>
        </div>

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

      <div className="shrink-0">
        <TypingIndicator entityKey={entityKey} />
      </div>

      <div className="shrink-0 border-t border-ink-100 px-4 py-3">
        {identity ? (
          <form onSubmit={handlePost} className="flex flex-col gap-2">
            <textarea
              value={body}
              onChange={(e) => {
                const next = e.target.value;
                setBody(next);
                socketRef.current?.sendTyping(next.trim().length > 0);
              }}
              onBlur={() => socketRef.current?.sendTyping(false)}
              placeholder={tComments("composer.placeholder")}
              rows={3}
              className="w-full resize-y rounded-xl bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none placeholder:text-ink-500 focus:ring-2 focus:ring-orange-400"
            />
            {error ? (
              <p
                role="alert"
                className="rounded-lg bg-danger/10 px-3 py-2 text-xs font-medium text-danger ring-1 ring-inset ring-danger/20"
              >
                {error}
              </p>
            ) : null}
            <div className="flex justify-end">
              <button
                type="submit"
                className={buttonClass("primary", "sm")}
                disabled={posting || !body.trim()}
              >
                {tComments("actions.send")}
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            className={buttonClass("primary", "sm")}
            onClick={() => setModalOpen(true)}
          >
            {tKiosk("open_modal")}
          </button>
        )}
      </div>

      {modalOpen ? (
        <KioskIdentityModal
          token={token}
          onIdentified={handleIdentified}
          onDismiss={() => setModalOpen(false)}
        />
      ) : null}
    </section>
  );
}
