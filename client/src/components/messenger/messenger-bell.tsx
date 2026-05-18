"use client";

/**
 * Top-nav bell — the entry point to the messenger.
 *
 * Owns three things:
 *
 *   1. The badge count (driven by TanStack Query ``useInboxUnreadCount``).
 *   2. The popover open/close state.
 *   3. The browser-notification permission prompt — fired once on
 *      first sign-in via the messenger provider; we re-surface it
 *      from the bell's dropdown if the user dismisses without
 *      deciding so the path to enable is always one click away.
 */

import { Bell } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { useInboxUnreadCount } from "@/services/inbox";

import { MessengerDropdown } from "./messenger-dropdown";


export function MessengerBell() {
  const t = useTranslations("messenger.bell");
  const unreadQuery = useInboxUnreadCount();
  const unread = unreadQuery.data?.unread_count ?? 0;
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Click-outside + Esc handling, same pattern as the user menu.
  useEffect(() => {
    if (!isOpen) return;
    const onClick = (event: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [isOpen]);

  const ariaLabel =
    unread > 0
      ? t("label_with_unread", { count: unread })
      : t("label");

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((v) => !v)}
        className="
          relative inline-flex h-9 w-9 items-center justify-center
          rounded-full text-ink-700 transition-colors
          hover:bg-ink-100 hover:text-ink-900
          focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500
        "
      >
        <Bell className="h-5 w-5" />
        {unread > 0 ? (
          <span
            className="
              absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-[16px]
              items-center justify-center rounded-full bg-red-600 px-1
              text-[10px] font-bold leading-none text-white
              ring-2 ring-white
            "
            aria-hidden="true"
          >
            {unread > 9 ? t("badge_overflow") : unread}
          </span>
        ) : null}
      </button>
      {isOpen ? <MessengerDropdown onClose={() => setIsOpen(false)} /> : null}
    </div>
  );
}
