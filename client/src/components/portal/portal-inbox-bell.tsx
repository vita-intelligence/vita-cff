"use client";

/**
 * Portal inbox bell — badge + dropdown.
 *
 * Mounted in :component:`PortalShell` so it follows the customer
 * across every portal route. Behaviour mirrors the staff messenger
 * bell:
 *
 * * The badge counts every unread shared comment across every
 *   proposal + spec the customer can see. Polled every 15s
 *   (cheap server-side; the JOIN walks the customer's own
 *   proposals only). Window-focus + tab-visibility refetch on
 *   top of the timer so a customer returning from another tab
 *   sees the freshest number without waiting.
 * * Clicking the bell opens a dropdown listing the threads,
 *   newest activity first. Each row shows the proposal/spec
 *   title, the latest preview, and a per-thread unread chip.
 * * Clicking a row navigates to the proposal or spec page; the
 *   per-page read-pointer write already wired on those pages
 *   bumps the bell on the next poll.
 *
 * Real-time (WebSocket) is intentionally not used here — the
 * portal WS consumer that accepts client-account auth is a
 * separate, larger piece of work. 15s polling lands a new
 * notification well within "feels live" budget for a customer
 * portal and adds zero infra coupling.
 */

import { Bell } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { fetchPortalInbox, fetchPortalUnreadCount, type PortalInboxThread } from "@/services/portal/api";


const POLL_MS = 15_000;


export function PortalInboxBell() {
  const [unread, setUnread] = useState<number>(0);
  const [open, setOpen] = useState(false);
  const [threads, setThreads] = useState<PortalInboxThread[] | null>(null);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Polling: count only (cheap) every 15s. Full thread list only
  // when the dropdown opens — saves the JOIN cost on every tick.
  const refreshCount = useCallback(async () => {
    try {
      const next = await fetchPortalUnreadCount();
      setUnread(next);
    } catch {
      // Best-effort — a 401 / network blip shouldn't tear down the
      // shell. Next poll cycle retries.
    }
  }, []);

  const refreshList = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchPortalInbox();
      setThreads(data.results);
      setUnread(data.total_unread);
    } catch {
      setThreads([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Boot + periodic refresh of the badge.
  useEffect(() => {
    refreshCount();
    let timer: ReturnType<typeof setInterval> | null = setInterval(refreshCount, POLL_MS);
    const onFocus = () => refreshCount();
    const onVis = () => {
      if (document.visibilityState === "visible") refreshCount();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      if (timer) clearInterval(timer);
      timer = null;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refreshCount]);

  // Fetch the list lazily the first time the dropdown opens.
  // Refetch on every open after that so the user sees freshness.
  useEffect(() => {
    if (open) refreshList();
  }, [open, refreshList]);

  // Title-bar prefix while there are unread messages and the tab
  // isn't focused — matches what the staff inbox bell does so a
  // customer scrolling another tab still notices.
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (unread === 0) return;
    if (document.visibilityState === "visible") return;
    const original = document.title;
    document.title = `(${unread}) ${original}`;
    return () => { document.title = original; };
  }, [unread]);

  // Close on outside click / Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={
          unread > 0
            ? `Notifications: ${unread} unread`
            : "Notifications"
        }
        className="relative border-2 border-black bg-white p-2 text-black transition-transform hover:-translate-x-[1px] hover:-translate-y-[1px] hover:shadow-[3px_3px_0_#000]"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 ? (
          <span className="absolute -right-2 -top-2 inline-flex min-w-[20px] items-center justify-center border-2 border-black bg-black px-1 py-0.5 text-[10px] font-black uppercase tracking-widest text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 z-40 mt-2 w-[min(92vw,400px)] border-2 border-black bg-white shadow-[6px_6px_0_#000]">
          <div className="flex items-center justify-between border-b-2 border-black bg-black px-4 py-3 text-white">
            <span className="text-[11px] font-bold uppercase tracking-[0.2em]">
              Notifications
            </span>
            <span className="text-[10px] uppercase tracking-widest text-white/70">
              {unread > 0 ? `${unread} unread` : "All caught up"}
            </span>
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {loading && threads === null ? (
              <div className="p-6 text-sm text-neutral-600">Loading…</div>
            ) : !threads || threads.length === 0 ? (
              <div className="p-6 text-sm text-neutral-700">
                No messages yet. New replies from the Vita team will appear
                here.
              </div>
            ) : (
              <ul>
                {threads.map((t) => (
                  <li key={`${t.entity_kind}:${t.entity_id}`}>
                    <Link
                      href={t.deep_link}
                      onClick={() => setOpen(false)}
                      className={`block border-b border-black/10 px-4 py-3 text-sm transition-colors hover:bg-neutral-100 ${
                        t.unread_count > 0 ? "bg-yellow-50" : ""
                      }`}
                    >
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-neutral-500">
                          {t.entity_kind === "proposal"
                            ? "Proposal"
                            : t.parent_proposal
                              ? `Spec · ${t.parent_proposal.code}`
                              : "Specification"}
                        </span>
                        {t.unread_count > 0 ? (
                          <span className="inline-flex items-center border-2 border-black bg-black px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest text-white">
                            {t.unread_count} new
                          </span>
                        ) : null}
                      </div>
                      <div className="font-black uppercase tracking-tight">
                        {t.entity_title}
                      </div>
                      <div className="mt-1 truncate text-xs text-neutral-700">
                        <span className="font-bold">
                          {t.last_message_author.name}:
                        </span>{" "}
                        {t.last_message_preview}
                      </div>
                      <div className="mt-1 text-[10px] uppercase tracking-widest text-neutral-500">
                        {new Date(t.last_message_at).toLocaleString(undefined, {
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
