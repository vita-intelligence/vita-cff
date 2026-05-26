"use client";

/**
 * Project comments bubble — a floating launcher + slide-over chat
 * that follows the user across every project tab (Builder, Overview,
 * Spec sheets, Proposals, Trial batches, QC).
 *
 * Mounted from ``[id]/layout.tsx`` so it persists across tab
 * navigation: the WebSocket subscription stays open, the unread
 * badge survives, and an in-flight message arriving mid-navigation
 * still pings.
 *
 * Architecture:
 *
 * * One WebSocket per project, opened on mount. The bubble's own
 *   ``onCommentEvent`` handler invalidates the comments cache (so an
 *   open :func:`CommentsPanel` inside the bubble repaints) AND, when
 *   the panel is closed, increments the unread badge + plays a chime.
 *
 * * ``CommentsPanel`` opens its own ref-counted socket when the panel
 *   is open. The shared socket's ``setHandlers`` replaces the
 *   bubble's handlers while the panel is mounted, so during that
 *   window the panel's cache invalidator runs (which is the same
 *   behaviour as before). When the panel closes, the bubble re-
 *   claims handlers via ``setHandlers`` so notifications resume.
 *
 * * Sound = Web Audio API tone (no asset ship). Muteable; preference
 *   persisted to localStorage.
 *
 * * The tab title gains a ``(N)`` prefix while there are unread
 *   project messages, so a scientist looking at another window
 *   notices.
 */

import { useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, MessageSquare, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CommentsPanel } from "@/components/comments";
import {
  commentsQueryKeys,
  openCommentsSocket,
  shouldNotifyForComment,
  type CommentDto,
  type CommentsSocketHandle,
} from "@/services/comments";


const MUTE_STORAGE_KEY = "vita.project-comments.muted";


export function ProjectCommentsBubble({
  orgId,
  formulationId,
  currentUserId,
  projectName,
  canRead,
  canWrite,
  canModerate,
}: {
  readonly orgId: string;
  readonly formulationId: string;
  readonly currentUserId: string;
  readonly projectName: string;
  readonly canRead: boolean;
  readonly canWrite: boolean;
  readonly canModerate: boolean;
}) {
  const tComments = useTranslations("comments");
  const queryClient = useQueryClient();

  const [isOpen, setIsOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [muted, setMuted] = useState(false);

  // Refs mirror state so the WebSocket handler (set up once in a
  // useEffect with no state deps) always reads the latest values
  // without re-attaching the socket on every render.
  const isOpenRef = useRef(false);
  const mutedRef = useRef(false);
  isOpenRef.current = isOpen;
  mutedRef.current = muted;

  const socketHandleRef = useRef<CommentsSocketHandle | null>(null);

  // Restore mute preference on mount. Localstorage is read-only at
  // build time so we defer until after hydration.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      setMuted(window.localStorage.getItem(MUTE_STORAGE_KEY) === "1");
    } catch {
      // ignore — quota errors, private browsing, etc.
    }
  }, []);

  // Build the bubble's own WS handlers. The same closure is used to
  // re-claim handlers when the panel closes — see effect below.
  const bubbleHandlersFactory = useCallback(() => {
    return {
      onCommentEvent: (
        kind: "created" | "updated" | "deleted" | "resolved",
        payload: unknown,
      ) => {
        // Keep TanStack cache fresh — mirrors what CommentsPanel
        // would do if it owned the subscription right now.
        queryClient.invalidateQueries({
          queryKey: [
            ...commentsQueryKeys.all,
            orgId,
            "formulation",
            formulationId,
          ],
        });
        // Sound + badge only for new posts. Edits, deletes, and
        // resolutions still invalidate the cache (so an open panel
        // repaints) but don't ping.
        if (kind !== "created") return;
        if (isOpenRef.current) return;
        // Relevance gate. Project chats are 100% internal team
        // surfaces — without this, every teammate's reply chimed
        // every other teammate, which is the exact noise the user
        // asked to stop. Now only @-mentions trigger the badge +
        // chime here. (Formulation threads can't receive customer
        // posts so the customer-author branch is dead code today,
        // but the helper checks it anyway so the rule stays
        // consistent across surfaces.)
        if (
          !shouldNotifyForComment(payload as CommentDto | null, currentUserId)
        ) {
          return;
        }
        setUnread((prev) => Math.min(prev + 1, 999));
        if (!mutedRef.current) {
          playChime();
        }
      },
    };
  }, [orgId, formulationId, queryClient, currentUserId]);

  // Open the WebSocket on mount. Lifetime tracks the layout, not
  // any individual tab page, so a teammate posting a comment while
  // the user switches tabs still triggers the badge.
  useEffect(() => {
    if (!canRead) return;
    const handle = openCommentsSocket(
      { orgId, kind: "formulation", entityId: formulationId },
      bubbleHandlersFactory(),
    );
    socketHandleRef.current = handle;
    return () => {
      handle.release();
      socketHandleRef.current = null;
    };
  }, [canRead, orgId, formulationId, bubbleHandlersFactory]);

  // Re-claim handlers when the panel closes. Why: ``CommentsPanel``
  // opens its own ref-counted socket while mounted, and the shared
  // socket only keeps the last ``setHandlers`` caller. When the
  // panel closes, its handlers are no longer attached but neither
  // are ours — we have to re-set them so the next incoming comment
  // still triggers the badge / chime.
  useEffect(() => {
    if (isOpen) return;
    const handle = socketHandleRef.current;
    if (!handle) return;
    handle.setHandlers(bubbleHandlersFactory());
  }, [isOpen, bubbleHandlersFactory]);

  // Tab-title nudge: prefix unread count when the page is not in
  // focus, so a teammate posting while you're in another window
  // still grabs attention via the tab label.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const titleNow = document.title;
    const cleaned = titleNow.replace(/^\(\d+\)\s*/, "");
    if (unread > 0) {
      document.title = `(${Math.min(unread, 99)}${unread > 99 ? "+" : ""}) ${cleaned}`;
    } else if (titleNow !== cleaned) {
      document.title = cleaned;
    }
  }, [unread]);

  const openPanel = useCallback(() => {
    setIsOpen(true);
    setUnread(0);
  }, []);

  const closePanel = useCallback(() => {
    setIsOpen(false);
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(MUTE_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  // The bubble assumes ``canRead`` — without read access we render
  // nothing so the launcher doesn't tease a thread the user can't
  // see. The layout pre-checks this too, but we mirror it for safety
  // because the layout is a server component and any future client-
  // gated capability switch should fail closed here as well.
  if (!canRead) return null;

  const unreadLabel = useMemo(() => {
    if (unread === 0) return "";
    if (unread > 99) return "99+";
    return String(unread);
  }, [unread]);

  return (
    <div className="fixed bottom-6 right-6 z-40 flex flex-col items-end gap-3 print:hidden">
      {isOpen ? (
        <div
          role="dialog"
          aria-label={tComments("bubble.panel_label")}
          className="flex w-[min(480px,calc(100vw-3rem))] flex-col overflow-hidden rounded-2xl bg-ink-0 shadow-2xl ring-1 ring-ink-200"
          style={{ height: "min(680px, calc(100vh - 8rem))" }}
        >
          <header className="flex items-center justify-between border-b border-ink-200 px-4 py-3">
            <div className="flex min-w-0 flex-col">
              <span className="text-xs font-medium uppercase tracking-wide text-ink-500">
                {tComments("bubble.header_eyebrow")}
              </span>
              <span className="truncate text-sm font-semibold text-ink-1000">
                {projectName}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={toggleMute}
                aria-label={
                  muted
                    ? tComments("bubble.unmute")
                    : tComments("bubble.mute")
                }
                title={
                  muted
                    ? tComments("bubble.unmute")
                    : tComments("bubble.mute")
                }
                className="rounded-md p-1.5 text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-1000"
              >
                {muted ? (
                  <BellOff className="h-4 w-4" />
                ) : (
                  <Bell className="h-4 w-4" />
                )}
              </button>
              <button
                type="button"
                onClick={closePanel}
                aria-label={tComments("bubble.close")}
                className="rounded-md p-1.5 text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-1000"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </header>
          {/* Pass the panel ``layout="fill"`` so it manages its own
              sticky chrome and only the thread list scrolls. The
              wrapper here is just a flex-grow container; the panel's
              header / banner / composer pin themselves against the
              edges and the thread stream fills the remainder. */}
          <div className="flex min-h-0 flex-1 flex-col">
            <CommentsPanel
              orgId={orgId}
              entityKind="formulation"
              entityId={formulationId}
              canRead={canRead}
              canWrite={canWrite}
              canModerate={canModerate}
              currentUserId={currentUserId}
              visibility="internal"
              layout="fill"
            />
          </div>
        </div>
      ) : null}
      <button
        type="button"
        onClick={openPanel}
        aria-label={tComments("bubble.open")}
        title={tComments("bubble.open")}
        className="relative inline-flex h-12 w-12 items-center justify-center rounded-full bg-orange-500 text-ink-0 shadow-lg ring-1 ring-orange-600/50 transition-transform hover:scale-105 hover:bg-orange-600"
      >
        <MessageSquare className="h-5 w-5" />
        {unread > 0 ? (
          <span
            aria-hidden
            className="absolute -right-1 -top-1 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-danger px-1.5 text-[10px] font-semibold text-ink-0 ring-2 ring-ink-0"
          >
            {unreadLabel}
          </span>
        ) : null}
      </button>
    </div>
  );
}


/**
 * Soft two-note chime, generated via Web Audio so we don't ship an
 * audio asset (no licensing concern, no extra HTTP round-trip).
 *
 * Browsers gate ``AudioContext`` playback on a prior user gesture —
 * the first chime after page load can silently fail. We catch and
 * suppress because the alternative (a console error per missed
 * notification) is noise the user can't act on. Once the user has
 * interacted with the page at all the chime works reliably.
 */
function playChime(): void {
  if (typeof window === "undefined") return;
  try {
    const AudioCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtor) return;
    const ctx = new AudioCtor();
    if (ctx.state === "suspended") {
      void ctx.resume();
    }
    const now = ctx.currentTime;
    const playNote = (
      frequency: number,
      offsetSeconds: number,
      durationSeconds: number,
    ) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = frequency;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const startAt = now + offsetSeconds;
      const stopAt = startAt + durationSeconds;
      // Quick fade-in to avoid the click an instant amplitude jump
      // would produce, exponential fade-out for a softer tail.
      gain.gain.setValueAtTime(0, startAt);
      gain.gain.linearRampToValueAtTime(0.14, startAt + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, stopAt);
      osc.start(startAt);
      osc.stop(stopAt + 0.05);
    };
    playNote(880, 0, 0.18); // A5
    playNote(1318.51, 0.11, 0.22); // E6
    // Close the context after the tones finish so the page doesn't
    // accumulate audio nodes when notifications stack up.
    window.setTimeout(() => {
      ctx.close().catch(() => undefined);
    }, 600);
  } catch {
    // Audio unavailable (rare) — no-op.
  }
}
