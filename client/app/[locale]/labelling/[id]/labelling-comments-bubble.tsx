"use client";

/**
 * Labelling comments bubble — floating launcher + slide-over chat
 * for the **internal** staff conversation about a label design.
 *
 * Mirror of :file:`proposals/[id]/proposal-comments-bubble.tsx` with
 * two scope changes:
 *
 * * ``entityKind="label_design"`` so the thread sits on the label
 *   design record, alongside the inline customer-facing chat panel
 *   that lives further up the workspace.
 * * ``visibility="internal"`` + ``visibilityFilter="internal"`` so
 *   every comment posted here is staff-only AND the bubble only
 *   shows the internal slice. The customer portal already filters
 *   its read path to ``Visibility.SHARED``, so an internal post
 *   could not leak even if the filter here failed.
 *
 * Mute preference uses its own localStorage key so muting the
 * proposal bubble doesn't mute this one.
 */

import { useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, MessageSquare, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CommentsPanel } from "@/components/comments";
import {
  commentsQueryKeys,
  openCommentsSocket,
  shouldNotifyForComment,
  type CommentDto,
  type CommentsSocketHandle,
} from "@/services/comments";


const MUTE_STORAGE_KEY = "vita.labelling-comments.muted";


export function LabellingCommentsBubble({
  orgId,
  labelDesignId,
  currentUserId,
  designLabel,
  canRead,
  canWrite,
  canModerate,
}: {
  readonly orgId: string;
  readonly labelDesignId: string;
  readonly currentUserId: string;
  /** Human-readable title shown in the bubble header — usually
   *  the formulation code so the staff member can tell at a
   *  glance which label they're chatting about. */
  readonly designLabel: string;
  readonly canRead: boolean;
  readonly canWrite: boolean;
  readonly canModerate: boolean;
}) {
  const queryClient = useQueryClient();

  const [isOpen, setIsOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [muted, setMuted] = useState(false);

  // Refs mirror state so the WebSocket handler closure (set up
  // once with no state deps) always reads the latest values
  // without re-attaching the socket on every render.
  const isOpenRef = useRef(false);
  const mutedRef = useRef(false);
  isOpenRef.current = isOpen;
  mutedRef.current = muted;

  const socketHandleRef = useRef<CommentsSocketHandle | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      setMuted(window.localStorage.getItem(MUTE_STORAGE_KEY) === "1");
    } catch {
      // ignore — quota errors, private browsing, etc.
    }
  }, []);

  const bubbleHandlersFactory = useCallback(() => {
    return {
      onCommentEvent: (
        kind: "created" | "updated" | "deleted" | "resolved",
        payload: unknown,
      ) => {
        queryClient.invalidateQueries({
          queryKey: [
            ...commentsQueryKeys.all,
            orgId,
            "label_design",
            labelDesignId,
          ],
        });
        if (kind !== "created") return;
        if (isOpenRef.current) return;
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
  }, [orgId, labelDesignId, queryClient, currentUserId]);

  useEffect(() => {
    if (!canRead) return;
    const handle = openCommentsSocket(
      { orgId, kind: "label_design", entityId: labelDesignId },
      bubbleHandlersFactory(),
    );
    socketHandleRef.current = handle;
    return () => {
      handle.release();
      socketHandleRef.current = null;
    };
  }, [canRead, orgId, labelDesignId, bubbleHandlersFactory]);

  useEffect(() => {
    if (isOpen) return;
    const handle = socketHandleRef.current;
    if (!handle) return;
    handle.setHandlers(bubbleHandlersFactory());
  }, [isOpen, bubbleHandlersFactory]);

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

  const unreadLabel = useMemo(() => {
    if (unread === 0) return "";
    if (unread > 99) return "99+";
    return String(unread);
  }, [unread]);

  if (!canRead) return null;

  return (
    <div className="fixed bottom-6 right-6 z-40 flex flex-col items-end gap-3 print:hidden">
      {isOpen ? (
        <div
          role="dialog"
          aria-label="Internal chat about this label design"
          className="flex w-[min(480px,calc(100vw-3rem))] flex-col overflow-hidden rounded-2xl bg-ink-0 shadow-2xl ring-1 ring-ink-200"
          style={{ height: "min(680px, calc(100vh - 8rem))" }}
        >
          <header className="flex items-center justify-between border-b border-ink-200 px-4 py-3">
            <div className="flex min-w-0 flex-col">
              <span className="text-xs font-medium uppercase tracking-wide text-ink-500">
                Internal chat
              </span>
              <span className="truncate text-sm font-semibold text-ink-1000">
                {designLabel}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={toggleMute}
                aria-label={muted ? "Unmute notifications" : "Mute notifications"}
                title={muted ? "Unmute notifications" : "Mute notifications"}
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
                aria-label="Close internal chat"
                className="rounded-md p-1.5 text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-1000"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </header>
          <div className="flex min-h-0 flex-1 flex-col">
            <CommentsPanel
              orgId={orgId}
              entityKind="label_design"
              entityId={labelDesignId}
              canRead={canRead}
              canWrite={canWrite}
              canModerate={canModerate}
              currentUserId={currentUserId}
              visibility="internal"
              visibilityFilter="internal"
              layout="fill"
            />
          </div>
        </div>
      ) : null}
      <button
        type="button"
        onClick={openPanel}
        aria-label="Open internal chat about this label design"
        title="Internal chat"
        className="relative inline-flex h-12 w-12 items-center justify-center rounded-full bg-ink-1000 text-ink-0 shadow-lg ring-1 ring-ink-700 transition-transform hover:scale-105 hover:bg-ink-800"
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


/** Soft two-note chime, identical to the proposal / project
 *  bubbles so a staff member trained on those recognises it
 *  without thinking. */
function playChime(): void {
  if (typeof window === "undefined") return;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return;
  try {
    const ctx = new Ctor();
    const now = ctx.currentTime;
    const playTone = (freq: number, start: number, duration: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + start);
      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(0.05, now + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + duration);
    };
    playTone(880, 0, 0.18);
    playTone(1320, 0.12, 0.22);
    setTimeout(() => {
      try {
        void ctx.close();
      } catch {
        // ignore
      }
    }, 600);
  } catch {
    // ignore — autoplay block, hardware quirk, etc.
  }
}
