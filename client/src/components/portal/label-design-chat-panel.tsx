"use client";

/**
 * Label-design chat panel — used on
 * ``/portal/label-designs/[id]``. Mirror of
 * :component:`ProposalChatPanel` minus the WebSocket presence
 * + typing-indicator plumbing (kept for a follow-up; the
 * 30-second poll is enough for a first cut). Wire shape +
 * message render is identical so a customer who's used the
 * proposal chat feels at home.
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
  fetchLabelDesignChat,
  markLabelDesignChatRead,
  postLabelDesignChatMessage,
} from "@/services/portal/api";
import type { PortalMessageDto } from "@/services/portal/types";


//: Polling cadence for the label-design chat. Same value as the
//: proposal chat — long enough not to load the server, short
//: enough that a customer doesn't sit on a stale view forever.
const POLL_MS = 30_000;


export function LabelDesignChatPanel({
  labelDesignId,
  designLabel,
}: {
  labelDesignId: string;
  /** Display label used in the empty state to remind the customer
   *  which workflow they're chatting about. Falls back to a
   *  generic label when omitted. */
  designLabel?: string;
}) {
  const [messages, setMessages] = useState<PortalMessageDto[] | null>(null);
  const [lastReadAt, setLastReadAt] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<PortalMessageDto | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const refMap = useRef<Map<string, HTMLDivElement>>(new Map());
  const prevCountRef = useRef(0);

  const load = useCallback(async () => {
    try {
      const data = await fetchLabelDesignChat(labelDesignId);
      setMessages(data.results);
      setLastReadAt(data.read_state);
    } catch {
      setMessages([]);
      setLastReadAt(null);
    }
  }, [labelDesignId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      timer = setInterval(load, POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVis = () => {
      if (document.visibilityState === "visible") {
        load();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  useEffect(() => {
    if (!messages) return;
    if (messages.length > prevCountRef.current) {
      // Scroll to the freshest message on new arrivals.
      const node = scrollRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    }
    prevCountRef.current = messages.length;
  }, [messages]);

  // Mark as read after the customer's been looking at the panel
  // for a beat. Without this the unread badge would never tick
  // down on the bell, which is the canonical UX complaint mode.
  useEffect(() => {
    const id = window.setTimeout(() => {
      void markLabelDesignChatRead(labelDesignId).catch(() => {
        // ignore — read-state failures are non-fatal.
      });
    }, 1200);
    return () => window.clearTimeout(id);
  }, [labelDesignId, messages]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    setSending(true);
    setError(null);
    try {
      const created = await postLabelDesignChatMessage(
        labelDesignId,
        draft.trim(),
        replyTo?.id ?? null,
      );
      setMessages((prev) => (prev ? [...prev, created] : [created]));
      setDraft("");
      setReplyTo(null);
    } catch (e) {
      setError(
        (e as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Couldn't send your message.",
      );
    } finally {
      setSending(false);
    }
  };

  const scrollToMessage = useCallback((id: string) => {
    const node = refMap.current.get(id);
    if (node) {
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      node.classList.add("ring-2", "ring-black");
      setTimeout(() => {
        node.classList.remove("ring-2", "ring-black");
      }, 1200);
    }
  }, []);

  return (
    <Card>
      <header className="flex items-center justify-between border-b-2 border-black px-4 py-3 sm:px-5">
        <div>
          <Eyebrow>Chat with the Vita team</Eyebrow>
          <h2 className="mt-1 text-base font-black uppercase tracking-wide text-black">
            About this label
          </h2>
        </div>
      </header>

      <div
        ref={scrollRef}
        className="flex h-[clamp(340px,55dvh,520px)] flex-col gap-4 overflow-y-auto bg-paper p-4 sm:p-5"
      >
        {messages === null ? (
          <p className="text-center text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-600">
            Loading messages…
          </p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-neutral-700">
            No messages yet. Send a note to the Vita team about{" "}
            {designLabel ? <strong>{designLabel}</strong> : "this label"}{" "}
            — questions, change requests, or just a heads-up.
          </p>
        ) : (
          messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              seen={
                m.author_kind === "staff" &&
                Boolean(lastReadAt && m.created_at <= lastReadAt)
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
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          placeholder={
            replyTo ? "Type your reply…" : "Write a message about this label…"
          }
        />
        <div className="mt-3 flex justify-end">
          <PortalButton type="submit" disabled={sending || !draft.trim()}>
            {sending ? "Sending…" : replyTo ? "Reply" : "Send"}
          </PortalButton>
        </div>
      </form>
    </Card>
  );
}
