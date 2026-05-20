"use client";

/**
 * Per-spec messaging panel for the customer portal.
 *
 * Renders one thread per attached spec on the proposal. Each
 * thread shows the conversation oldest-first and a compose box
 * at the bottom. While we have no WebSocket consumer wired for
 * the portal yet, the panel polls the messages endpoint every
 * 30 seconds so a staff reply lands within "go grab a coffee"
 * latency. The polling timer pauses when the tab is hidden so
 * we don't burn quota while no one's looking.
 *
 * Read receipts: when a thread is visible (tab focused, spec
 * selected) we POST to ``markSpecMessagesRead`` once per render
 * cycle so the staff side sees the "client has read" tick.
 *
 * Brutalist styling matches the rest of the portal — hard
 * borders, offset shadows, uppercase labels.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Card,
  ErrorBanner,
  H2,
  PortalButton,
  PortalTextarea,
} from "@/components/portal/brutalist";
import {
  fetchProposalMessages,
  markSpecMessagesRead,
  postSpecMessage,
} from "@/services/portal/api";
import type {
  PortalMessageDto,
  PortalMessagesDto,
} from "@/services/portal/types";


// Poll every 30s. Short enough that a staff reply feels fresh,
// long enough that ten visitors don't hammer the API. Real-time
// presence + typing will replace this with a WS subscription in
// the next layer.
const POLL_INTERVAL_MS = 30_000;


export function MessagesPanel({
  proposalId,
}: {
  proposalId: string;
}) {
  const [data, setData] = useState<PortalMessagesDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const fresh = await fetchProposalMessages(proposalId);
      setData(fresh);
      setError(null);
    } catch {
      setError("Couldn't load messages. Retrying…");
    } finally {
      setLoading(false);
    }
  }, [proposalId]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll on an interval when the tab is visible. Pausing on hidden
  // tabs matches Slack / Linear behaviour and prevents quota burn
  // on long-open laptop sessions.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    function start() {
      timer = setInterval(load, POLL_INTERVAL_MS);
    }
    function stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }
    function onVisibility() {
      if (document.visibilityState === "visible") {
        load();
        start();
      } else {
        stop();
      }
    }
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  if (loading && !data) {
    return (
      <Card>
        <H2>Messages</H2>
        <p className="text-sm">Loading…</p>
      </Card>
    );
  }

  if (!data || data.spec_ids.length === 0) {
    return (
      <Card>
        <H2>Messages</H2>
        <p className="text-sm">
          Messaging activates once a specification is attached to this
          proposal.
        </p>
      </Card>
    );
  }

  // Group messages by spec so we can render one thread per attached
  // sheet. The backend returns oldest-first; we keep that order so
  // the conversation reads naturally.
  const grouped: Record<string, PortalMessageDto[]> = {};
  for (const id of data.spec_ids) grouped[id] = [];
  for (const m of data.results) {
    const bucket = grouped[m.thread_target_id];
    if (m.thread_target_type === "spec" && bucket) {
      bucket.push(m);
    }
  }

  return (
    <Card>
      <H2>Messages</H2>
      <ErrorBanner>{error}</ErrorBanner>
      <div className="flex flex-col gap-6">
        {data.spec_ids.map((specId, idx) => (
          <SpecThread
            key={specId}
            specId={specId}
            label={`Specification ${idx + 1}`}
            messages={grouped[specId] || []}
            lastReadAt={data.read_state[specId] || null}
            onChanged={load}
            onError={setError}
          />
        ))}
      </div>
    </Card>
  );
}


function SpecThread({
  specId,
  label,
  messages,
  lastReadAt,
  onChanged,
  onError,
}: {
  specId: string;
  label: string;
  messages: PortalMessageDto[];
  lastReadAt: string | null;
  onChanged: () => void | Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(messages.length);

  // Count staff messages that arrived AFTER the user's last-read
  // bump. ``lastReadAt`` is the timestamp we wrote on the backend
  // ``update_or_create`` for the client's CommentReadState; anything
  // newer is "unread" from the client's POV.
  const unread = messages.filter((m) => {
    if (m.author_kind === "client") return false;
    if (!lastReadAt) return true;
    return m.created_at > lastReadAt;
  }).length;

  // Surface "New" in the document title while the tab is hidden so
  // a customer browsing other tabs sees an unread hint. We pulse it
  // until they bring the portal tab back to focus.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const prev = prevCountRef.current;
    if (messages.length > prev && document.visibilityState !== "visible") {
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
  }, [messages.length]);

  // Bump the read receipt whenever new messages render. Idempotent
  // on the backend (``update_or_create``) so this is safe to fire
  // on every refresh.
  useEffect(() => {
    if (messages.length > 0) {
      markSpecMessagesRead(specId).catch(() => {
        /* swallow — read state is best-effort */
      });
    }
  }, [specId, messages.length]);

  // Pin the scroll to the bottom when new messages arrive — same UX
  // as a chat app.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    onError(null);
    try {
      await postSpecMessage(specId, body);
      setDraft("");
      await onChanged();
    } catch {
      onError("Couldn't send. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="border-2 border-black">
      <div className="flex items-center justify-between border-b-2 border-black bg-black px-4 py-2 text-xs font-bold uppercase tracking-widest text-white">
        <span>{label}</span>
        {unread > 0 ? (
          <span className="border-2 border-white bg-white px-2 py-0.5 text-[10px] font-black uppercase tracking-widest text-black">
            {unread} new
          </span>
        ) : null}
      </div>
      <div
        ref={scrollRef}
        className="flex h-96 flex-col gap-3 overflow-y-auto bg-white p-4"
      >
        {messages.length === 0 ? (
          <p className="text-sm">No messages yet. Start the conversation.</p>
        ) : (
          messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              seen={isSeenByStaff(m, lastReadAt)}
            />
          ))
        )}
      </div>
      <form onSubmit={send} className="border-t-2 border-black p-3">
        <PortalTextarea
          name={`compose-${specId}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          placeholder="Write a message…"
        />
        <div className="mt-3 flex justify-end">
          <PortalButton type="submit" disabled={sending || !draft.trim()}>
            {sending ? "Sending…" : "Send"}
          </PortalButton>
        </div>
      </form>
    </div>
  );
}


function isSeenByStaff(
  message: PortalMessageDto,
  lastReadAt: string | null,
): boolean {
  // We can't see staff's read state from the portal yet — that
  // would require a second per-thread read field for the
  // ``viewer_user`` side. For now we only render "Seen" hints on
  // staff messages, indicating the client has acknowledged them.
  // (lastReadAt is the *client's* last-read; staff messages older
  // than that are "seen by you".)
  if (!lastReadAt) return false;
  if (message.author_kind === "client") return false;
  return message.created_at <= lastReadAt;
}


function initialsOf(name: string): string {
  const trimmed = (name || "").trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}


function MessageBubble({
  message,
  seen,
}: {
  message: PortalMessageDto;
  seen: boolean;
}) {
  const isClient = message.author_kind === "client";
  const align = isClient ? "items-end" : "items-start";
  const bubble = isClient
    ? "bg-black text-white"
    : "bg-white text-black border-2 border-black";
  const initials = initialsOf(message.author_name);
  const avatar = (
    <Avatar
      src={message.author_avatar}
      initials={initials}
      isClient={isClient}
    />
  );
  return (
    <div
      className={`flex w-full items-end gap-3 ${
        isClient ? "flex-row-reverse" : "flex-row"
      }`}
    >
      {avatar}
      <div
        className={`flex min-w-0 max-w-[75%] flex-col ${align}`}
      >
        <div
          className={`mb-1 flex items-baseline gap-2 text-[11px] ${
            isClient ? "flex-row-reverse" : "flex-row"
          }`}
        >
          <span className="font-bold text-black">
            {message.author_name}
          </span>
          <span className="text-neutral-500">
            {new Date(message.created_at).toLocaleString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
              day: "2-digit",
              month: "short",
            })}
          </span>
        </div>
        <div
          className={`whitespace-pre-wrap break-words px-4 py-2.5 text-sm leading-relaxed shadow-[3px_3px_0_#000] ${bubble}`}
        >
          {message.is_deleted ? (
            <em className="opacity-60">Deleted</em>
          ) : (
            message.body
          )}
        </div>
        {seen ? (
          <span className="mt-1 text-[10px] font-bold uppercase tracking-widest text-neutral-500">
            Seen ✓
          </span>
        ) : null}
      </div>
    </div>
  );
}


function Avatar({
  src,
  initials,
  isClient,
}: {
  src: string;
  initials: string;
  isClient: boolean;
}) {
  if (src) {
    return (
      <img
        src={src}
        alt={initials}
        className="h-9 w-9 shrink-0 border-2 border-black object-cover"
      />
    );
  }
  return (
    <span
      className={`flex h-9 w-9 shrink-0 items-center justify-center border-2 border-black text-[11px] font-black uppercase ${
        isClient ? "bg-black text-white" : "bg-white text-black"
      }`}
    >
      {initials}
    </span>
  );
}
