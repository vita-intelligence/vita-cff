"use client";

/**
 * Side-effects mount for the global messenger surface.
 *
 * Owns four cross-cutting concerns that belong outside any single
 * page:
 *
 *   1. The inbox WebSocket — one socket per signed-in user, kept
 *      alive for the lifetime of the session. On every push it
 *      invalidates the relevant TanStack Query caches so the bell
 *      badge + dropdown update without a refetch round-trip.
 *
 *   2. Browser tab-title badge — the page title gets a ``(3) Vita
 *      NPD`` prefix when there are unread messages so the user
 *      notices new traffic from a different tab. Cleared the
 *      moment the unread count hits zero.
 *
 *   3. Audio chime + OS notification on incoming messages — chime
 *      only plays in the focused tab (multi-tab echo avoidance),
 *      OS notification only fires when the tab is hidden and the
 *      user has granted permission.
 *
 *   4. First-sign-in browser-notification permission prompt — fires
 *      the standard ``Notification.requestPermission()`` once and
 *      persists the outcome locally so the prompt does not re-ask.
 *
 * Renders the :component:`FloatingChatStack` so the open windows
 * follow the user across route navigation.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef } from "react";

import {
  inboxQueryKeys,
  openInboxSocket,
  type InboxListResponseDto,
  type InboxSocketHandle,
  type InboxWsMessageDto,
} from "@/services/inbox";
import { useCurrentUser } from "@/services/accounts";
import { shouldNotifyForComment } from "@/services/comments";

import { FloatingChatStack } from "./floating-chat-stack";
import { MessengerToastStack } from "./messenger-toast-stack";
import {
  NOTIFICATION_DISMISSED_KEY,
  useMessengerStore,
  type BrowserNotificationStatus,
} from "./messenger-store";


export function MessengerProvider({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  const userQuery = useCurrentUser();
  const isAuthenticated = Boolean(userQuery.data?.id);
  const currentUserId = userQuery.data?.id ?? null;

  return (
    <>
      {isAuthenticated ? (
        <MessengerEffects currentUserId={currentUserId} />
      ) : null}
      {children}
      {isAuthenticated ? (
        <>
          <MessengerToastStack />
          <FloatingChatStack />
        </>
      ) : null}
    </>
  );
}


/**
 * Isolated effects component so the WS + permission flows only
 * mount once we know the user is signed in. Guard avoids
 * connecting to ``/ws/inbox/`` while the login page is on screen.
 */
function MessengerEffects({
  currentUserId,
}: {
  readonly currentUserId: string | null;
}) {
  const queryClient = useQueryClient();
  const t = useTranslations("messenger.notifications");
  const setStatus = useMessengerStore((s) => s.setNotificationStatus);
  const dismissPrompt = useMessengerStore((s) => s.dismissNotificationPrompt);
  const socketRef = useRef<InboxSocketHandle | null>(null);

  // -------------------------------------------------------------------
  // 1. Inbox WebSocket
  // -------------------------------------------------------------------
  const pushToast = useMessengerStore((s) => s.pushToast);
  useEffect(() => {
    const handleMessage = (envelope: InboxWsMessageDto) => {
      // Read the inbox cache BEFORE invalidating so we can pull the
      // entity title (the WS envelope only carries the comment +
      // entity id, not the project name). The invalidate kicks off
      // a refetch immediately after — by next render the dropdown
      // is fresh.
      const cached = queryClient.getQueryData<InboxListResponseDto>(
        inboxQueryKeys.list(),
      );
      const matchingThread = cached?.threads.find(
        (thread) =>
          thread.entity_kind === envelope.entity_kind &&
          thread.entity_id === envelope.entity_id,
      );

      queryClient.invalidateQueries({ queryKey: inboxQueryKeys.list() });
      queryClient.invalidateQueries({
        queryKey: inboxQueryKeys.unreadCount(),
      });
      onIncomingMessage({
        envelope,
        currentUserId,
        t,
        pushToast,
        entityTitle:
          matchingThread?.entity_title ||
          matchingThread?.entity_code ||
          "",
      });
    };

    const handle = openInboxSocket({
      onInboxMessage: handleMessage,
      onConnect: () => {
        // Reconcile on every (re)connect — we may have missed events
        // while disconnected.
        queryClient.invalidateQueries({ queryKey: inboxQueryKeys.list() });
        queryClient.invalidateQueries({
          queryKey: inboxQueryKeys.unreadCount(),
        });
      },
    });
    socketRef.current = handle;
    return () => {
      handle.release();
      socketRef.current = null;
    };
  }, [queryClient, currentUserId, t, pushToast]);

  // -------------------------------------------------------------------
  // 1b. Prime AudioContext on the first user gesture.
  //
  // Chrome / Safari refuse to play audio until the user has
  // interacted with the page. We attach a one-shot listener on
  // mount; the first click/keypress unlocks the chime so the next
  // incoming message is audible.
  // -------------------------------------------------------------------
  useEffect(() => {
    if (typeof window === "undefined") return;
    const unlock = () => {
      try {
        primeAudioContext();
      } catch {
        /* swallow — audio is a nice-to-have, not load-bearing */
      }
      window.removeEventListener("click", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("touchstart", unlock);
    };
    window.addEventListener("click", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    window.addEventListener("touchstart", unlock, { once: true });
    return () => {
      window.removeEventListener("click", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("touchstart", unlock);
    };
  }, []);

  // -------------------------------------------------------------------
  // 2. Tab-title badge
  // -------------------------------------------------------------------
  useTabTitleBadge();

  // -------------------------------------------------------------------
  // 3. OS notification permission prompt (first sign-in)
  // -------------------------------------------------------------------
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("Notification" in window)) {
      setStatus("unsupported");
      return;
    }
    const current = Notification.permission as BrowserNotificationStatus;
    setStatus(current);

    if (current !== "default") return;
    if (window.localStorage.getItem(NOTIFICATION_DISMISSED_KEY) === "1") {
      return;
    }

    // Fire once. Browsers won't reprompt anyway after the user has
    // dismissed, but we set the localStorage flag too so a flaky
    // dismissal stays sticky across reloads.
    Notification.requestPermission()
      .then((result) => {
        setStatus(result as BrowserNotificationStatus);
        if (result !== "granted") {
          window.localStorage.setItem(NOTIFICATION_DISMISSED_KEY, "1");
          dismissPrompt();
        }
      })
      .catch(() => {
        // Older browsers expose the promise but reject on edge
        // cases; treat as denied to avoid retry loops.
        setStatus("denied");
        window.localStorage.setItem(NOTIFICATION_DISMISSED_KEY, "1");
        dismissPrompt();
      });
  }, [setStatus, dismissPrompt]);

  return null;
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


interface IncomingArgs {
  readonly envelope: InboxWsMessageDto;
  readonly currentUserId: string | null;
  readonly t: ReturnType<typeof useTranslations>;
  /** Best-effort entity title resolved from the inbox cache. Empty
   *  string when we haven't seen this thread before (first ever
   *  message on a brand-new project) — the toast falls back to the
   *  short id prefix in that case. */
  readonly entityTitle: string;
  readonly pushToast: (toast: {
    readonly organizationId: string;
    readonly entityKind: InboxWsMessageDto["entity_kind"];
    readonly entityId: string;
    readonly entityTitle: string;
    readonly authorName: string;
    readonly bodyPreview: string;
  }) => void;
}

/**
 * Surface a new incoming message to the user in the most-appropriate
 * channel for the current tab state:
 *
 *   * Focused tab → in-app toast + audio chime (you're here, gentle).
 *   * Hidden tab + OS permission granted → OS notification (so you
 *     notice from another tab / OS spaces).
 *   * Hidden tab + OS permission denied → silent; the bell badge +
 *     document title prefix are the only signals.
 *
 * The author-of-the-message guard is server-side first (fan-out
 * skips the author) but we re-check here so a stale duplicate
 * delivery can't echo a message back to its own sender.
 */
function onIncomingMessage({
  envelope,
  currentUserId,
  t,
  entityTitle,
  pushToast,
}: IncomingArgs) {
  if (typeof document === "undefined") return;
  const authorId = envelope.comment?.author?.id ?? null;
  if (authorId && currentUserId && authorId === currentUserId) return;

  // Relevance gate. Without this, every internal team message
  // chimed everyone in the org — noisy enough that staff started
  // muting the bell, which then made them miss the customer
  // replies that actually need a fast response. With the gate,
  // chime / toast / OS notification only fire when the message
  // is a customer reply or it @-mentions the current user. The
  // bell badge + inbox unread counts still update (via the
  // cache invalidation in ``handleInboxMessage`` upstream of
  // this function), they just stop being noisy.
  if (!shouldNotifyForComment(envelope.comment, currentUserId)) return;

  const authorName = envelope.comment?.author?.name || "";
  const bodyPreview = envelope.comment?.body?.trim().slice(0, 140) || "";
  const displayTitle = entityTitle || envelope.entity_id.slice(0, 8);

  const isVisible = document.visibilityState === "visible";
  if (isVisible) {
    pushToast({
      organizationId: envelope.organization_id,
      entityKind: envelope.entity_kind,
      entityId: envelope.entity_id,
      entityTitle: displayTitle,
      authorName,
      bodyPreview,
    });
    playChime();
    return;
  }

  if (
    "Notification" in window &&
    Notification.permission === "granted"
  ) {
    try {
      const title = t("incoming_title", {
        name: authorName,
        project: displayTitle,
      });
      const body = bodyPreview || t("incoming_body_fallback");
      new Notification(title, { body, silent: false });
    } catch {
      // Some browsers throw if invoked too quickly after grant; the
      // failure is non-critical so swallow it.
    }
  }
}


/**
 * Web Audio API beep. Two short sine pulses, total ~120ms — pleasant
 * enough that the user notices without it being a sound effect from
 * a video game. We synthesise inline so we don't ship an audio
 * binary in the bundle.
 *
 * AudioContext creation is lazy (and cached) because Chrome blocks
 * construction outside a user gesture for newer pages — the
 * provider primes the context on the first click/keypress of the
 * session via :func:`primeAudioContext`, so by the time the first
 * inbox event arrives the context is already running.
 */
let audioContext: AudioContext | null = null;


function ensureAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (audioContext === null) {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return null;
    audioContext = new Ctx();
  }
  // A brand-new context (or one created before the page received a
  // user gesture) starts in ``suspended`` state and silently swallows
  // ``start()`` calls. Resuming is async but we fire-and-forget — by
  // the time the next chime fires the context is running.
  if (audioContext.state === "suspended") {
    void audioContext.resume().catch(() => {
      /* swallow — silent audio is acceptable, broken UI is not */
    });
  }
  return audioContext;
}


/**
 * Warm the audio context on first user interaction. Without this,
 * the first chime of the session is silently swallowed by Chrome's
 * autoplay gate. The provider attaches a one-shot click/keydown/
 * touchstart listener on mount and calls this when it fires.
 */
function primeAudioContext(): void {
  ensureAudioContext();
}


function playChime(): void {
  const ctx = ensureAudioContext();
  if (ctx === null) return;
  try {
    const now = ctx.currentTime;
    const playBeep = (start: number, freq: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.2);
    };
    playBeep(now, 880);
    playBeep(now + 0.08, 1175);
  } catch {
    // Audio failure is non-critical — keep the messenger functional.
  }
}


/**
 * Hook that mirrors the current unread count into the document
 * title — ``(3) Vita NPD — Projects`` — so a user on another tab
 * still notices the badge. Clears the prefix the moment unread
 * returns to zero, and restores the original title on unmount.
 */
function useTabTitleBadge(): void {
  const queryClient = useQueryClient();

  // Snapshot the original title once so a hot-reload doesn't compound
  // the prefix on every render.
  const originalTitleRef = useRef<string | null>(null);
  const lastPrefixRef = useRef<string>("");

  const syncTitle = useCallback(() => {
    if (typeof document === "undefined") return;
    if (originalTitleRef.current === null) {
      originalTitleRef.current = document.title;
    }
    const cached = queryClient.getQueryData<{ unread_count: number }>(
      inboxQueryKeys.unreadCount(),
    );
    const unread = cached?.unread_count ?? 0;
    const prefix = unread > 0 ? `(${unread > 99 ? "99+" : unread}) ` : "";
    if (prefix === lastPrefixRef.current) return;
    // Strip any prior prefix before applying the new one.
    const base = document.title.replace(/^\(\d+\+?\)\s+/, "");
    document.title = prefix ? `${prefix}${base}` : base;
    lastPrefixRef.current = prefix;
  }, [queryClient]);

  useEffect(() => {
    // Re-run on every query cache change rather than subscribing to
    // a specific key — the unread count is the only ``inbox.*`` query
    // that drives the badge and we already invalidate it on every WS
    // event.
    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      syncTitle();
    });
    syncTitle();
    return () => {
      unsubscribe();
      // Best-effort restore on unmount.
      if (originalTitleRef.current !== null && typeof document !== "undefined") {
        document.title = originalTitleRef.current;
      }
    };
  }, [queryClient, syncTitle]);
}
