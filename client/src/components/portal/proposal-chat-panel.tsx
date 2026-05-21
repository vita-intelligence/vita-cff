"use client";

/**
 * Proposal-level chat panel — used on ``/portal/proposals/[id]``.
 *
 * Distinct from :component:`SpecChatPanel` because the wire shape
 * differs slightly (proposal-chat has a flat ``read_state`` string
 * rather than a per-spec map) and we want a separate visual
 * treatment so the customer always knows whether they're
 * messaging "about the deal" or "about a specific spec".
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
  fetchProposalChat,
  markProposalChatRead,
  postProposalChatMessage,
} from "@/services/portal/api";
import type { PortalMessageDto } from "@/services/portal/types";
import {
  openPortalCommentsSocket,
  type PortalSocketHandle,
} from "@/services/portal/ws-client";
import { usePortalToastStore } from "@/components/portal/portal-toast-store";


//: Polling is now the safety net behind the WebSocket — kept long
//: so we don't add load on a healthy connection, but the polling
//: branch still rescues the UI on browsers / proxies that drop the
//: WS upgrade (corporate firewalls, some VPN clients).
const POLL_MS = 30_000;

//: Auto-clear the "Vita team is typing…" indicator if no follow-up
//: ``typing.stop`` lands within this window. Mirrors the staff
//: presence-store's stale-typist TTL — the server never retransmits
//: a stop, so receivers must drop the indicator on their own.
const TYPING_TTL_MS = 4_000;


export function ProposalChatPanel({
  proposalId,
  proposalCode,
}: {
  proposalId: string;
  /** Display label used as the toast's subject row (e.g. "PROP-0042").
   *  Falls back to a short id slice when omitted so the toast still
   *  carries some context — the deep link uses the id either way. */
  proposalCode?: string;
}) {
  const [messages, setMessages] = useState<PortalMessageDto[] | null>(null);
  const [lastReadAt, setLastReadAt] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<PortalMessageDto | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  //: Live typing indicator: name of the peer currently typing (one
  //: at a time is fine for portal UX — the customer doesn't need a
  //: roster), or ``null`` when the indicator should hide. WS-driven
  //: with a self-clearing TTL on the receiver side.
  const [typingPeerName, setTypingPeerName] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const refMap = useRef<Map<string, HTMLDivElement>>(new Map());
  const prevCountRef = useRef(0);
  //: Hold the WS handle across renders so the typing-sender
  //: callback and the cleanup effect see the same connection. The
  //: factory ref-counts on (kind, entityId) so a sibling component
  //: would share the underlying socket rather than open a duplicate.
  const socketRef = useRef<PortalSocketHandle | null>(null);
  //: TTL timer for the typing indicator. The server never re-sends
  //: ``typing.stop`` after a one-off ``typing.start``, so we expire
  //: stale indicators ourselves. Re-armed every time a fresh start
  //: arrives.
  const typingTimerRef = useRef<number | null>(null);
  //: Debounce timer for OUR outbound ``typing.stop``. We send a
  //: ``typing.start`` on the first keystroke, then a ``typing.stop``
  //: after a brief idle period — without this we'd flood the channel
  //: with one start per character.
  const sendStopTimerRef = useRef<number | null>(null);
  //: Tracks whether we've sent a ``typing.start`` that hasn't been
  //: matched with a ``typing.stop`` yet. Without this guard, every
  //: keystroke would re-emit ``typing.start`` (no-op for receivers
  //: but wasted traffic).
  const typingActiveRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchProposalChat(proposalId);
      setMessages(data.results);
      setLastReadAt(data.read_state);
    } catch {
      setMessages([]);
      setLastReadAt(null);
    }
  }, [proposalId]);

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

  // Toast store push — fires from the WS handler below on every
  // incoming ``comment.created`` so the customer gets a top-right
  // brutalist toast in addition to the chat refresh. Toast author
  // always renders as "Vita team" (the portal masks individual
  // staff identities behind one brand voice — matches the in-
  // thread bubble + bell preview).
  const pushToast = usePortalToastStore((s) => s.pushToast);

  // WebSocket: live ``comment.created`` triggers an immediate reload
  // (faster than the 30s poll), and peer ``typing.start`` / ``stop``
  // drive the "Vita team is typing…" indicator. The socket joins
  // the same group the staff comments consumer uses for this
  // proposal, so the staff side simultaneously sees the customer's
  // typing pings and presence on their inline comments panel.
  useEffect(() => {
    const handle = openPortalCommentsSocket("proposal", proposalId, {
      onCommentEvent: (kind, payload) => {
        // ``deleted`` should also refresh — a staff member could
        // retract a SHARED comment and the customer's open view
        // would otherwise still show it.
        if (
          kind === "created" ||
          kind === "updated" ||
          kind === "deleted"
        ) {
          void load();
        }
        // Toast only on ``created`` — updates / deletes shouldn't
        // pop a "new message" card; they're silent corrections.
        if (kind !== "created") return;
        const p = (payload ?? {}) as {
          body?: string;
          author?: { kind?: string; name?: string };
        };
        // Temporary diagnostic: surface every comment.created the
        // proposal chat panel sees so the user can trace the
        // toast-not-appearing case via their browser console.
        // Remove once the toast pipeline is confirmed end-to-end.
        if (typeof console !== "undefined") {
          console.debug(
            "[portal-toast] proposal candidate",
            { authorKind: p.author?.kind, hasBody: Boolean(p.body) },
          );
        }
        // Skip non-staff posts — ``kind === "member"`` is the
        // server-side label for staff users (set whenever
        // ``comment.author_id`` is populated by the comments
        // service). ``"guest"`` covers BOTH kiosk guests AND the
        // customer's own ``client_account``-authored comments
        // (the broadcast serialiser doesn't currently distinguish
        // those), so we strictly require ``"member"`` to avoid
        // popping a toast for the customer's own send.
        if (p.author?.kind !== "member") return;
        const body = (p.body ?? "").trim();
        const preview = body.length > 140 ? `${body.slice(0, 137)}…` : body;
        if (typeof console !== "undefined") {
          console.debug("[portal-toast] proposal push", { preview });
        }
        pushToast({
          kind: "proposal",
          entityId: proposalId,
          entityTitle: proposalCode || proposalId.slice(0, 8),
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
  }, [proposalId, proposalCode, load, pushToast]);

  // Outbound typing pings — fired from the draft input below.
  // Edge-triggered: ``typing.start`` only on the first keystroke
  // after idle, ``typing.stop`` after a short debounce or when
  // the message lands.
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

  useEffect(() => {
    if (messages && messages.length > 0) {
      markProposalChatRead(proposalId).catch(() => {});
    }
  }, [proposalId, messages]);

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
    // Tell the staff side we're no longer typing — the message
    // itself is on the way. Without this the staff inline panel
    // would show "Customer is typing…" for the next 2s of debounce
    // even though we just sent.
    clearOwnTyping();
    try {
      await postProposalChatMessage(proposalId, body, replyTo?.id ?? null);
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
            About this proposal
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
          // Brutalist in-panel loader: stark uppercase tracked
          // label sitting in the panel's paper background so the
          // chat reads as "still loading" without breaking the
          // surrounding design language.
          <p className="text-center text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-600">
            Loading messages…
          </p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-neutral-700">
            No messages yet. Send a note to the Vita team about the proposal
            as a whole. Spec-specific questions go on the spec page.
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

      {/* Live typing indicator — WS-driven, self-clearing after
          {TYPING_TTL_MS}ms of silence. Renders only while a peer is
          actively typing; otherwise the row collapses so the
          conversation height stays steady. */}
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
            // Fire typing.start on the first keystroke and arm the
            // 2s-idle ``typing.stop``. The helper de-dupes so we
            // don't re-emit ``typing.start`` per character.
            if (e.target.value.length > 0) {
              announceTyping();
            } else {
              clearOwnTyping();
            }
          }}
          rows={2}
          placeholder={replyTo ? "Type your reply…" : "Write a message about this proposal…"}
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
