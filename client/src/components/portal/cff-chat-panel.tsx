"use client";

/**
 * Per-CFF chat panel used by ``/portal/cffs/[id]``.
 *
 * Mirrors :component:`ProposalChatPanel` — flat ``read_state`` wire
 * shape, WS join on the ``comments.cff_submission.<id>`` group, and
 * the same outbound typing-ping debounce + inbound TTL — so a
 * customer's CFF thread and proposal thread feel identical.
 *
 * The thread defaults to ``shared`` visibility server-side (see
 * :func:`apps.comments.services.create_comment` +
 * ``CLIENT_VISIBLE_BY_DEFAULT``), so every staff reply lands here
 * automatically without the staff side having to flip a per-comment
 * toggle.
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
  fetchCFFMessages,
  markCFFMessagesRead,
  postCFFMessage,
} from "@/services/portal/api";
import type { PortalMessageDto } from "@/services/portal/types";
import {
  openPortalCommentsSocket,
  type PortalSocketHandle,
} from "@/services/portal/ws-client";
import { usePortalToastStore } from "@/components/portal/portal-toast-store";


//: Long poll — the WS branch carries the realtime path; this is the
//: safety net for corporate proxies / VPN clients that drop the
//: upgrade. Matches the proposal + spec chat panels.
const POLL_MS = 30_000;

//: TTL the receiver applies to a peer's ``typing.start`` when no
//: matching ``typing.stop`` arrives. Same window the proposal chat
//: panel uses so behaviour is consistent across thread kinds.
const TYPING_TTL_MS = 4_000;


export function CFFChatPanel({
  submissionId,
  submissionLabel,
}: {
  submissionId: string;
  /** Display label used as the toast's subject row (e.g. the
   *  project code or a short id slice). Falls back to a short id
   *  slice when omitted so the toast still carries some context;
   *  the deep link uses the id either way. */
  submissionLabel?: string;
}) {
  const [messages, setMessages] = useState<PortalMessageDto[] | null>(null);
  const [lastReadAt, setLastReadAt] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<PortalMessageDto | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typingPeerName, setTypingPeerName] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const refMap = useRef<Map<string, HTMLDivElement>>(new Map());
  const prevCountRef = useRef(0);
  const socketRef = useRef<PortalSocketHandle | null>(null);
  const typingTimerRef = useRef<number | null>(null);
  const sendStopTimerRef = useRef<number | null>(null);
  const typingActiveRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchCFFMessages(submissionId);
      setMessages(data.results);
      setLastReadAt(data.read_state);
    } catch {
      setMessages([]);
      setLastReadAt(null);
    }
  }, [submissionId]);

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

  const pushToast = usePortalToastStore((s) => s.pushToast);

  useEffect(() => {
    const handle = openPortalCommentsSocket("cff_submission", submissionId, {
      onCommentEvent: (kind, payload) => {
        if (
          kind === "created" ||
          kind === "updated" ||
          kind === "deleted"
        ) {
          void load();
        }
        if (kind !== "created") return;
        const p = (payload ?? {}) as {
          body?: string;
          author?: { kind?: string; name?: string };
        };
        // Only staff posts surface as toasts — the customer's own
        // sends + any kiosk guest posts (``"guest"``) shouldn't
        // pop a "new message" card on their own screen.
        if (p.author?.kind !== "member") return;
        const body = (p.body ?? "").trim();
        const preview = body.length > 140 ? `${body.slice(0, 137)}…` : body;
        pushToast({
          kind: "cff_submission",
          entityId: submissionId,
          entityTitle: submissionLabel || submissionId.slice(0, 8),
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
  }, [submissionId, submissionLabel, load, pushToast]);

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
      markCFFMessagesRead(submissionId).catch(() => {});
    }
  }, [submissionId, messages]);

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
    clearOwnTyping();
    try {
      await postCFFMessage(submissionId, body, replyTo?.id ?? null);
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
            About this request
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
          <p className="text-center text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-600">
            Loading messages…
          </p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-neutral-700">
            No messages yet. Send a note to the Vita team about your
            request and they'll reply here.
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
            if (e.target.value.length > 0) {
              announceTyping();
            } else {
              clearOwnTyping();
            }
          }}
          rows={2}
          placeholder={
            replyTo ? "Type your reply…" : "Write a message about your request…"
          }
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
