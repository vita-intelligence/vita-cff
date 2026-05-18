"use client";

/**
 * One floating chat window docked at the bottom of the viewport.
 *
 * Mounts the existing :file:`comments-panel.tsx` inside a fixed-size
 * shell so the user can chat without leaving the page they're on.
 * Closing the panel removes it from the messenger store; the parent
 * stack handles the horizontal layout + overflow scroll.
 */

import { Maximize2, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { CommentsPanel } from "@/components/comments/comments-panel";
import { Link } from "@/i18n/navigation";
import { hasFlatCapability } from "@/lib/auth/capabilities";
import { useCurrentUser } from "@/services/accounts";
import type { InboxEntityKind } from "@/services/inbox";
import { useOrganization } from "@/services/organizations";

import { useMessengerStore, type OpenChatWindow } from "./messenger-store";


export interface FloatingChatPanelProps {
  readonly window: OpenChatWindow;
}


export function FloatingChatPanel({ window }: FloatingChatPanelProps) {
  const t = useTranslations("messenger.panel");
  const tKinds = useTranslations("messenger.panel");
  const closeThread = useMessengerStore((s) => s.closeThread);
  const userQuery = useCurrentUser();
  const organization = useOrganization(window.organizationId);

  // Capability resolution. We default optimistic (canRead/Write true,
  // canModerate false) because the inbox only ever surfaces chats the
  // user already has comments_view on, and the backend enforces the
  // write side. If the org row loads, we tighten the flags from the
  // membership permissions.
  const canRead = organization
    ? hasFlatCapability(organization, "formulations", "comments_view")
    : true;
  const canWrite = organization
    ? hasFlatCapability(organization, "formulations", "comments_write")
    : true;
  const canModerate = organization
    ? hasFlatCapability(organization, "formulations", "comments_moderate")
    : false;

  const kindLabel =
    window.entityKind === "formulation"
      ? tKinds("kind_formulation")
      : tKinds("kind_specification");

  const fullPageHref = buildFullPageHref(window.entityKind, window.entityId);

  return (
    <section
      className="
        flex h-[560px] w-[340px] flex-col overflow-hidden
        rounded-t-xl border border-ink-200 bg-white shadow-2xl
        max-h-[80vh]
      "
      aria-label={window.title || t("title_fallback")}
    >
      <header className="flex items-center justify-between gap-2 border-b border-ink-200 bg-ink-50 px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-[10px] font-semibold uppercase tracking-wider text-ink-500">
            {kindLabel}
          </p>
          <p className="truncate text-sm font-semibold text-ink-1000">
            {window.title || t("title_fallback")}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Link
            href={fullPageHref}
            className="rounded-md p-1.5 text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-800"
            title={t("open_full_page")}
            aria-label={t("open_full_page")}
          >
            <Maximize2 className="h-4 w-4" />
          </Link>
          <button
            type="button"
            onClick={() => closeThread(window.entityKind, window.entityId)}
            className="rounded-md p-1.5 text-ink-500 transition-colors hover:bg-ink-100 hover:text-red-700"
            title={t("close")}
            aria-label={t("close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>
      {/*
        ``min-h-0`` is the critical bit: without it the flex child
        cannot shrink below its content's intrinsic height, which
        defeats CommentsPanel's ``layout="fill"`` mode. With it,
        CommentsPanel pins its own header (presence avatars) and
        composer + scrolls only the message list — same UX as the
        in-page floating bubble on the project workspace.
      */}
      <div className="flex min-h-0 flex-1 flex-col">
        <CommentsPanel
          orgId={window.organizationId}
          entityKind={window.entityKind}
          entityId={window.entityId}
          canRead={canRead}
          canWrite={canWrite}
          canModerate={canModerate}
          currentUserId={userQuery.data?.id ?? null}
          layout="fill"
        />
      </div>
    </section>
  );
}


function buildFullPageHref(kind: InboxEntityKind, id: string): string {
  if (kind === "formulation") {
    return `/formulations/${id}`;
  }
  return `/specifications/${id}`;
}
