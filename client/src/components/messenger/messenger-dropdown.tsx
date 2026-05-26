"use client";

/**
 * Dropdown rendered when the user clicks the messenger bell.
 *
 * Lists every chat the user can see, ordered by most-recent
 * activity, with an unread badge on each row. Clicking a row pushes
 * a window onto the floating-chat stack and marks the thread read
 * (the dropdown closes; the chat opens in place).
 */

import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { ArrowRight, Loader2 } from "lucide-react";

import { Link } from "@/i18n/navigation";
import {
  useInboxList,
  useMarkThreadRead,
  type InboxEntityKind,
  type InboxThreadDto,
} from "@/services/inbox";

import { useMessengerStore } from "./messenger-store";


function kindLabelFor(
  kind: InboxEntityKind,
  t: ReturnType<typeof useTranslations<"messenger.dropdown">>,
): string {
  // Exhaustive switch so a future kind addition becomes a TS
  // error instead of silently rendering as "Spec sheet" (the
  // pre-fix fallback that mis-labelled proposal + CFF threads
  // in the messenger drop-down).
  switch (kind) {
    case "formulation":
      return t("kind_formulation");
    case "specification":
      return t("kind_specification");
    case "proposal":
      return t("kind_proposal");
    case "cff_submission":
      return t("kind_cff_submission");
  }
}


export interface MessengerDropdownProps {
  readonly onClose: () => void;
}


export function MessengerDropdown({ onClose }: MessengerDropdownProps) {
  const t = useTranslations("messenger.dropdown");
  const tCommon = useTranslations("common");
  const inbox = useInboxList();
  const markRead = useMarkThreadRead();
  const openThread = useMessengerStore((s) => s.openThread);

  const threads = useMemo<readonly InboxThreadDto[]>(
    () => inbox.data?.threads ?? [],
    [inbox.data],
  );

  const handleOpen = (thread: InboxThreadDto) => {
    openThread({
      organizationId: thread.organization.id,
      entityKind: thread.entity_kind,
      entityId: thread.entity_id,
      title: thread.entity_title || thread.entity_code,
    });
    if (thread.unread_count > 0) {
      // Pass the lane so opening the internal-bubble entry from
      // the bell doesn't accidentally clear the unread count on
      // the sibling customer-conversation row for the same entity.
      markRead.mutate({
        entityKind: thread.entity_kind,
        entityId: thread.entity_id,
        visibility: thread.visibility,
      });
    }
    onClose();
  };

  return (
    <div
      role="menu"
      aria-label={t("title")}
      className="
        absolute right-0 top-full z-50 mt-2 w-[360px] max-w-[calc(100vw-1.5rem)]
        overflow-hidden rounded-lg border border-ink-200 bg-white shadow-xl
      "
    >
      <header className="flex items-center justify-between border-b border-ink-200 px-3 py-2">
        <p className="text-sm font-semibold text-ink-1000">{t("title")}</p>
      </header>
      <div className="max-h-[60vh] overflow-y-auto">
        {inbox.isLoading ? (
          <div className="flex items-center justify-center gap-2 p-6 text-sm text-ink-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>{t("loading")}</span>
          </div>
        ) : threads.length === 0 ? (
          <p className="px-6 py-6 text-center text-sm text-ink-500">{t("empty")}</p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {threads.map((thread) => (
              <li
                key={`${thread.entity_kind}:${thread.entity_id}:${thread.visibility}`}
              >
                <button
                  type="button"
                  onClick={() => handleOpen(thread)}
                  className="
                    flex w-full items-start gap-3 px-3 py-3 text-left
                    transition-colors hover:bg-ink-50
                    focus:outline-none focus:bg-ink-50
                  "
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-ink-500">
                        {kindLabelFor(thread.entity_kind, t)}
                      </span>
                      {thread.entity_code ? (
                        <span className="truncate text-[11px] font-mono text-ink-600">
                          {thread.entity_code}
                        </span>
                      ) : null}
                      {thread.visibility === "internal" ? (
                        <span className="shrink-0 rounded bg-ink-1000 px-1 text-[9px] font-semibold uppercase tracking-wide text-ink-0">
                          Internal
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 truncate text-sm font-semibold text-ink-1000">
                      {thread.entity_title || tCommon("unknown") || "—"}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-ink-700">
                      <span className="font-medium">
                        {thread.last_message_author.name || "—"}:
                      </span>{" "}
                      <span>{thread.last_message_preview}</span>
                    </p>
                  </div>
                  {thread.unread_count > 0 ? (
                    <span
                      className="
                        ml-2 mt-0.5 inline-flex h-5 min-w-[20px] items-center
                        justify-center rounded-full bg-blue-600 px-1.5
                        text-[10px] font-bold leading-none text-white
                      "
                      aria-label={t("unread_plural", {
                        count: thread.unread_count,
                      })}
                    >
                      {thread.unread_count > 9 ? "9+" : thread.unread_count}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {/* Always-rendered footer that routes to the full mailbox.
          Stays visible even when the list is empty / loading so the
          path to /inbox is one click away regardless of dropdown
          state. ``onClose`` fires alongside the navigation so the
          dropdown doesn't hover over the destination page on slow
          route transitions. */}
      <Link
        href="/inbox"
        onClick={onClose}
        className="
          flex items-center justify-center gap-1.5 border-t border-ink-200
          bg-ink-0 px-3 py-2 text-xs font-medium text-ink-700
          transition-colors hover:bg-ink-50 hover:text-ink-1000
        "
      >
        See all messages
        <ArrowRight className="h-3 w-3" aria-hidden />
      </Link>
    </div>
  );
}
