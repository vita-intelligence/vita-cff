"use client";

/**
 * Single-spec chat panel used by ``/portal/specs/[id]``.
 *
 * Wraps the same per-spec polling / reply UI as the messages
 * panel on the proposal page but filtered to ONE spec id, since
 * the new spec-detail route owns its own thread surface. The
 * proposal page no longer renders per-spec chat (specs link out
 * to their own pages); proposal-level chat lives in
 * :component:`ProposalChatPanel`.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  Card,
  ErrorBanner,
  Eyebrow,
  PortalButton,
  PortalTextarea,
} from "@/components/portal/brutalist";
import { MessageBubble } from "@/components/portal/message-bubble";
import {
  markSpecMessagesRead,
  postSpecMessage,
} from "@/services/portal/api";
import { apiClient } from "@/lib/api";
import type { PortalMessageDto } from "@/services/portal/types";
import {
  openPortalCommentsSocket,
  type PortalSocketHandle,
} from "@/services/portal/ws-client";
import { usePortalToastStore } from "@/components/portal/portal-toast-store";


//: Polling is the safety net behind the WebSocket — corporate
//: proxies and some VPN clients drop the WS upgrade, so we keep a
//: long-interval poll as a fallback. On a healthy connection the
//: WS branch beats the poll every time.
const POLL_MS = 30_000;

//: Self-clearing TTL for the peer typing indicator. Mirrors the
//: proposal chat panel + the staff presence store's stale-typist
//: drop window.
const TYPING_TTL_MS = 4_000;


export function SpecChatPanel({
  sheetId,
  sheetCode,
}: {
  sheetId: string;
  /** Display label used as the toast's subject row (e.g. "SPEC-0042").
   *  Falls back to a short id slice when omitted so the toast still
   *  carries some context — the deep link uses the id either way. */
  sheetCode?: string;
}) {
  const [messages, setMessages] = useState<PortalMessageDto[] | null>(null);
  const [lastReadAt, setLastReadAt] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<PortalMessageDto | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  //: Peer typing indicator — name of whoever is actively typing,
  //: or ``null`` to hide the row. WS-driven via the portal comments
  //: socket; the staff inline panel emits ``typing.start`` /
  //: ``typing.stop`` into the shared group.
  const [typingPeerName, setTypingPeerName] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const refMap = useRef<Map<string, HTMLDivElement>>(new Map());
  const prevCountRef = useRef(0);
  //: WS handle + typing-side timers, same shape as the proposal
  //: chat panel. The factory ref-counts on (kind, entityId), so a
  //: sibling component mounted on the same spec page would share
  //: this socket rather than open a duplicate.
  const socketRef = useRef<PortalSocketHandle | null>(null);
  const typingTimerRef = useRef<number | null>(null);
  const sendStopTimerRef = useRef<number | null>(null);
  const typingActiveRef = useRef(false);

  const load = useCallback(async () => {
    try {
      // The per-spec messaging endpoint lives on the proposal —
      // it doesn't have a direct sheet endpoint. The proposal id
      // is irrelevant for this thread because the messages are
      // joined on ``specification_sheet_id`` server-side; we just
      // need any owning proposal id to satisfy the route. The
      // simplest path is the spec-list endpoint which gives us
      // the proposal, but to keep the panel self-contained we
      // call the staff-shared comments endpoint that already
      // exists ... actually, we'll use the dedicated portal
      // route: GET /api/portal/specs/<id>/messages/ — which we
      // need to add. For this commit we fetch via the
      // proposal-aware shape: the spec detail endpoint already
      // returns the parent proposal, so the caller could pass
      // it. For zero-coupling we hit the proposal's messages
      // endpoint and filter by sheet id on the client.
      // Cleanest: just expose a per-spec messages endpoint.
      const { data } = await apiClient.get<{
        results: PortalMessageDto[];
        read_state: Record<string, string>;
      }>(`/api/portal/specs/${sheetId}/messages/`);
      setMessages(data.results);
      setLastReadAt(data.read_state[sheetId] || null);
    } catch {
      setMessages([]);
      setLastReadAt(null);
    }
  }, [sheetId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => { timer = setInterval(load, POLL_MS); };
    const stop = () => { if (timer) clearInterval(timer); timer = null; };
    const onVis = () => {
      if (document.visibilityState === "visible") { load(); start(); }
      else stop();
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVis);
    return () => { stop(); document.removeEventListener("visibilitychange", onVis); };
  }, [load]);

  // Toast store push — fires from the WS handler on every incoming
  // ``comment.created`` so the customer sees a top-right brutalist
  // card alongside the chat refresh. Author masked as "Vita team"
  // to match the in-thread bubble + bell preview voice.
  const pushToast = usePortalToastStore((s) => s.pushToast);

  // WS layer — joins ``comments.specification.<sheetId>`` (same
  // group the staff inline comments panel uses). Live comment.*
  // broadcasts trigger an immediate reload, and peer typing events
  // drive the "Vita team is typing…" indicator.
  useEffect(() => {
    const handle = openPortalCommentsSocket("specification", sheetId, {
      onCommentEvent: (kind, payload) => {
        if (
          kind === "created" ||
          kind === "updated" ||
          kind === "deleted"
        ) {
          void load();
        }
        // Toast only on ``created`` — updates / deletes are silent
        // corrections and don't warrant a "new message" pop.
        if (kind !== "created") return;
        const p = (payload ?? {}) as {
          body?: string;
          author?: { kind?: string; name?: string };
        };
        // Temporary diagnostic — mirrors the proposal chat panel
        // so a browser-console trace captures both threads while
        // we verify the toast pipeline end-to-end.
        if (typeof console !== "undefined") {
          console.debug(
            "[portal-toast] spec candidate",
            { authorKind: p.author?.kind, hasBody: Boolean(p.body) },
          );
        }
        // Skip non-staff posts — the customer's own message and
        // kiosk guest replies shouldn't surface as "new staff
        // message" notifications.
        if (p.author?.kind !== "member") return;
        const body = (p.body ?? "").trim();
        const preview = body.length > 140 ? `${body.slice(0, 137)}…` : body;
        if (typeof console !== "undefined") {
          console.debug("[portal-toast] spec push", { preview });
        }
        pushToast({
          kind: "specification",
          entityId: sheetId,
          entityTitle: sheetCode || sheetId.slice(0, 8),
          authorName: "Vita team",
          bodyPreview: preview,
        });
      },
      onPeerTypingStart: (viewer) => {
        setTypingPeerName(viewer.name || "Vita team");
        if (typingTimerRef.current !== null) {
          window.clearTimeout(typingTimerRef.current);
        }
        typingTimerRef.current = window.setTimeout(() => {
          setTypingPeerName(null);
          typingTimerRef.current = null;
        }, TYPING_TTL_MS);
      },
      onPeerTypingStop: () => {
        if (typingTimerRef.current !== null) {
          window.clearTimeout(typingTimerRef.current);
          typingTimerRef.current = null;
        }
        setTypingPeerName(null);
      },
    });
    socketRef.current = handle;
    return () => {
      handle.release();
      socketRef.current = null;
      if (typingTimerRef.current !== null) {
        window.clearTimeout(typingTimerRef.current);
        typingTimerRef.current = null;
      }
      if (sendStopTimerRef.current !== null) {
        window.clearTimeout(sendStopTimerRef.current);
        sendStopTimerRef.current = null;
      }
    };
  }, [sheetId, sheetCode, load, pushToast]);

  // Outbound typing helpers — edge-triggered ``typing.start`` on
  // the first keystroke after idle, debounced ``typing.stop`` after
  // 2s of silence or when the send completes.
  const announceTyping = useCallback(() => {
    const socket = socketRef.current;
    if (!socket) return;
    if (!typingActiveRef.current) {
      socket.sendTyping(true);
      typingActiveRef.current = true;
    }
    if (sendStopTimerRef.current !== null) {
      window.clearTimeout(sendStopTimerRef.current);
    }
    sendStopTimerRef.current = window.setTimeout(() => {
      socket.sendTyping(false);
      typingActiveRef.current = false;
      sendStopTimerRef.current = null;
    }, 2_000);
  }, []);

  const clearOwnTyping = useCallback(() => {
    if (sendStopTimerRef.current !== null) {
      window.clearTimeout(sendStopTimerRef.current);
      sendStopTimerRef.current = null;
    }
    if (typingActiveRef.current) {
      socketRef.current?.sendTyping(false);
      typingActiveRef.current = false;
    }
  }, []);

  // Title-bar pulse on new staff message while tab is hidden.
  useEffect(() => {
    if (typeof document === "undefined" || !messages) return;
    if (messages.length > prevCountRef.current
        && document.visibilityState !== "visible") {
      const original = document.title;
      document.title = `● New message — ${original}`;
      const restore = () => {
        if (document.visibilityState === "visible") {
          document.title = original;
          document.removeEventListener("visibilitychange", restore);
        }
      };
      document.addEventListener("visibilitychange", restore);
    }
    prevCountRef.current = messages.length;
  }, [messages]);

  // Bump read state when messages come in.
  useEffect(() => {
    if (messages && messages.length > 0) {
      markSpecMessagesRead(sheetId).catch(() => {});
    }
  }, [sheetId, messages]);

  // Pin scroll to bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages?.length]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    setError(null);
    // Cancel any pending ``typing.stop`` and send one immediately —
    // staff side should not see "Customer is typing…" after the
    // message is actually on the wire.
    clearOwnTyping();
    try {
      await postSpecMessage(sheetId, body, replyTo?.id ?? null);
      setDraft("");
      setReplyTo(null);
      await load();
    } catch {
      setError("Couldn't send. Try again.");
    } finally {
      setSending(false);
    }
  }

  const unread = (messages || []).filter((m) => {
    if (m.author_kind === "client") return false;
    if (!lastReadAt) return true;
    return m.created_at > lastReadAt;
  }).length;
  const firstUnreadId = (messages || []).find((m) => {
    if (m.author_kind === "client") return false;
    if (!lastReadAt) return true;
    return m.created_at > lastReadAt;
  })?.id;

  function scrollToMessage(id: string) {
    const el = refMap.current.get(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-4", "ring-black");
    window.setTimeout(() => el.classList.remove("ring-4", "ring-black"), 1200);
  }

  return (
    <Card className="!p-0">
      <header className="flex items-center justify-between border-b-2 border-black bg-black px-6 py-4 text-white">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/60">
            Conversation
          </span>
          <span className="text-base font-black uppercase tracking-tight">
            About this specification
          </span>
        </div>
        {unread > 0 && firstUnreadId ? (
          <button
            type="button"
            onClick={() => scrollToMessage(firstUnreadId)}
            className="border-2 border-white bg-white px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-black hover:translate-x-[-1px] hover:translate-y-[-1px]"
          >
            {unread} new ↓
          </button>
        ) : null}
      </header>

      <div
        ref={scrollRef}
        className="flex h-[420px] flex-col gap-4 overflow-y-auto bg-paper p-5"
      >
        {messages === null ? (
          <p className="text-sm">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-neutral-700">
            No messages yet. Send a note to the Vita team and they'll reply
            here.
          </p>
        ) : (
          messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              seen={
                m.author_kind === "staff"
                && Boolean(lastReadAt && m.created_at <= lastReadAt)
              }
              onReply={() => setReplyTo(m)}
              onJumpToParent={scrollToMessage}
              registerRef={(node: HTMLDivElement | null) => {
                if (node) refMap.current.set(m.id, node);
                else refMap.current.delete(m.id);
              }}
            />
          ))
        )}
      </div>

      {/* Live typing indicator — same shape + behaviour as the
          proposal chat panel. Renders only while a peer is actively
          typing; collapses otherwise so the chat height stays
          steady. */}
      {typingPeerName ? (
        <div className="border-t-2 border-black bg-paper px-5 py-2 text-[11px] uppercase tracking-[0.2em] text-neutral-700">
          {typingPeerName} is typing…
        </div>
      ) : null}

      <ErrorBanner>{error}</ErrorBanner>

      <form onSubmit={send} className="border-t-2 border-black p-4">
        {replyTo ? (
          <div className="mb-3 flex items-start gap-3 border-2 border-black bg-paper px-3 py-2 text-xs">
            <div className="min-w-0 flex-1">
              <div className="mb-0.5">
                <Eyebrow>Replying to {replyTo.author_name}</Eyebrow>
              </div>
              <div className="truncate text-neutral-700">
                {replyTo.is_deleted ? "(deleted)" : replyTo.body}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setReplyTo(null)}
              className="font-black uppercase tracking-widest hover:underline"
              aria-label="Cancel reply"
            >
              ✕
            </button>
          </div>
        ) : null}
        <PortalTextarea
          name="compose"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            // Edge-trigger typing pings — start on first keystroke,
            // debounce a stop after 2s of silence. The helper
            // dedups against ``typingActiveRef`` so we don't
            // re-emit ``typing.start`` per character.
            if (e.target.value.length > 0) {
              announceTyping();
            } else {
              clearOwnTyping();
            }
          }}
          rows={2}
          placeholder={replyTo ? "Type your reply…" : "Write a message…"}
        />
        <div className="mt-3 flex justify-end">
          <PortalButton type="submit" disabled={sending || !draft.trim()}>
            {sending ? "Sending…" : (replyTo ? "Reply" : "Send")}
          </PortalButton>
        </div>
      </form>
    </Card>
  );
}
