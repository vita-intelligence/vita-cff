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


const POLL_MS = 30_000;


export function ProposalChatPanel({ proposalId }: { proposalId: string }) {
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
          <p className="text-sm">Loading…</p>
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
