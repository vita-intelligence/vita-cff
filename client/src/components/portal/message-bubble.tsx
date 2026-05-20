"use client";

/**
 * Shared message bubble — used by both the proposal-level and
 * per-spec chat panels. Factored out so the two surfaces stay
 * visually identical without duplicating layout code.
 */

import type { PortalMessageDto } from "@/services/portal/types";


export function MessageBubble({
  message,
  seen,
  onReply,
  onJumpToParent,
  registerRef,
}: {
  message: PortalMessageDto;
  seen: boolean;
  onReply: () => void;
  onJumpToParent: (parentId: string) => void;
  registerRef: (node: HTMLDivElement | null) => void;
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
      ref={registerRef}
      className={`group flex w-full flex-col scroll-mt-4 ${
        isClient ? "items-end" : "items-start"
      }`}
    >
      <div
        className={`mb-1 flex items-baseline gap-2 text-[11px] ${
          isClient ? "flex-row-reverse" : "flex-row"
        }`}
      >
        <span className="font-bold text-black">{message.author_name}</span>
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
        className={`flex max-w-[85%] items-start gap-2.5 ${
          isClient ? "flex-row-reverse" : "flex-row"
        }`}
      >
        {avatar}
        <div className={`flex min-w-0 flex-col ${align}`}>
          {message.parent ? (
            <button
              type="button"
              onClick={() => onJumpToParent(message.parent!.id)}
              className={`mb-1 max-w-full overflow-hidden border-l-4 border-black bg-white px-3 py-1.5 text-left text-[11px] text-black hover:bg-neutral-100 ${
                isClient ? "self-end" : "self-start"
              }`}
              aria-label="Jump to replied message"
            >
              <div className="font-bold uppercase tracking-widest">
                ↰ {message.parent.author_name}
              </div>
              <div className="truncate text-neutral-700">
                {message.parent.is_deleted
                  ? "(deleted)"
                  : message.parent.body_preview}
              </div>
            </button>
          ) : null}
          <div
            className={`whitespace-pre-wrap break-words px-3.5 py-2 text-sm leading-relaxed shadow-[3px_3px_0_#000] ${bubble}`}
          >
            {message.is_deleted ? (
              <em className="opacity-60">Deleted</em>
            ) : (
              message.body
            )}
          </div>
        </div>
      </div>
      <div
        className={`mt-1 flex items-center gap-3 text-[10px] uppercase tracking-widest text-neutral-500 ${
          isClient ? "flex-row-reverse" : "flex-row"
        }`}
      >
        <button
          type="button"
          onClick={onReply}
          className="opacity-0 transition-opacity hover:underline group-hover:opacity-100 focus:opacity-100"
        >
          ↩ Reply
        </button>
        {seen ? <span className="font-bold">Seen ✓</span> : null}
      </div>
    </div>
  );
}


function initialsOf(name: string): string {
  const trimmed = (name || "").trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
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
        className="h-8 w-8 shrink-0 border-2 border-black object-cover"
      />
    );
  }
  return (
    <span
      className={`flex h-8 w-8 shrink-0 items-center justify-center border-2 border-black text-[10px] font-black uppercase ${
        isClient ? "bg-black text-white" : "bg-white text-black"
      }`}
    >
      {initials}
    </span>
  );
}
