"use client";

/**
 * In-app toasts rendered when a new message arrives while the
 * user's tab is focused.
 *
 * The OS-level :class:`Notification` only fires when the tab is in
 * the background — for the focused-tab case we ship our own toast
 * here so the user gets a visible cue alongside the soft chime.
 * Click the toast to open the chat directly (skipping a trip
 * through the bell + dropdown); the X button or the auto-dismiss
 * timer otherwise sweeps it away after a few seconds.
 */

import { MessageSquare, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

import {
  TOAST_DISMISS_MS,
  useMessengerStore,
  type MessengerToast,
} from "./messenger-store";


export function MessengerToastStack() {
  const toasts = useMessengerStore((s) => s.toasts);
  const dismissToast = useMessengerStore((s) => s.dismissToast);
  const openThread = useMessengerStore((s) => s.openThread);
  const t = useTranslations("messenger.toast");

  // Auto-dismiss timer per toast. We avoid the simpler
  // ``setTimeout(dismiss, X)`` per toast inside the push action so
  // it survives a fast-refresh / HMR — the timer is owned by the
  // mounted component, not the dispatch.
  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((toast) => {
      const elapsed = Date.now() - toast.receivedAt;
      const remaining = Math.max(0, TOAST_DISMISS_MS - elapsed);
      return window.setTimeout(() => dismissToast(toast.id), remaining);
    });
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [toasts, dismissToast]);

  if (toasts.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="New messages"
      aria-live="polite"
      className="
        pointer-events-none fixed right-4 top-16 z-50 flex
        max-w-[calc(100vw-2rem)] flex-col gap-2
      "
    >
      {toasts.map((toast) => (
        <ToastCard
          key={toast.id}
          toast={toast}
          openLabel={t("open")}
          dismissLabel={t("dismiss")}
          onOpen={() => {
            openThread({
              organizationId: toast.organizationId,
              entityKind: toast.entityKind,
              entityId: toast.entityId,
              title: toast.entityTitle,
            });
            dismissToast(toast.id);
          }}
          onDismiss={() => dismissToast(toast.id)}
        />
      ))}
    </div>
  );
}


interface ToastCardProps {
  readonly toast: MessengerToast;
  readonly openLabel: string;
  readonly dismissLabel: string;
  readonly onOpen: () => void;
  readonly onDismiss: () => void;
}


function ToastCard({
  toast,
  openLabel,
  dismissLabel,
  onOpen,
  onDismiss,
}: ToastCardProps) {
  return (
    <div
      role="alert"
      className="
        pointer-events-auto flex w-[360px] max-w-full items-start gap-3
        overflow-hidden rounded-lg border border-ink-200 bg-white p-3
        shadow-xl ring-1 ring-blue-200
      "
    >
      <span
        className="
          mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center
          rounded-full bg-blue-50 text-blue-700
        "
        aria-hidden="true"
      >
        <MessageSquare className="h-4 w-4" />
      </span>
      <button
        type="button"
        onClick={onOpen}
        title={openLabel}
        aria-label={openLabel}
        className="min-w-0 flex-1 text-left"
      >
        <p className="truncate text-xs font-semibold uppercase tracking-wider text-ink-500">
          {toast.entityTitle || "—"}
        </p>
        <p className="mt-0.5 truncate text-sm font-semibold text-ink-1000">
          {toast.authorName || "—"}
        </p>
        <p className="mt-0.5 line-clamp-2 text-xs text-ink-700">
          {toast.bodyPreview || ""}
        </p>
      </button>
      <button
        type="button"
        onClick={onDismiss}
        title={dismissLabel}
        aria-label={dismissLabel}
        className="
          mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center
          rounded-md text-ink-500 transition-colors
          hover:bg-ink-100 hover:text-ink-800
        "
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
