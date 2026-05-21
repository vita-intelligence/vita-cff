"use client";

/**
 * Top-right toast stack for the customer portal.
 *
 * Brutalist counterpart to the staff :component:`MessengerToastStack`:
 * pops a stark, hard-shadowed card on every incoming staff comment
 * the per-thread WS surfaces, then auto-dismisses after
 * :data:`PORTAL_TOAST_DISMISS_MS`. Click the card to jump to the
 * thread it points at.
 *
 * Mount once at shell level (:component:`PortalShell`) — the
 * absolute positioning ensures the stack escapes whatever layout
 * the current portal page uses and the deep-link ``<a>`` works
 * regardless of the page's local route.
 *
 * Style notes:
 *
 * * 2px black border + ``6px_6px_0_#000`` shadow — matches the
 *   ``Card`` primitive in :mod:`brutalist`.
 * * No rounded corners, uppercase tracked label, dense body text.
 * * Author always renders as "Vita team" — the portal masks
 *   individual staff identities behind one brand voice; the bubble
 *   in the thread does the same.
 */

import { MessageSquare, X } from "lucide-react";
import { useEffect } from "react";

import {
  PORTAL_TOAST_DISMISS_MS,
  usePortalToastStore,
  type PortalToast,
} from "./portal-toast-store";


export function PortalToastStack() {
  const toasts = usePortalToastStore((s) => s.toasts);
  const dismissToast = usePortalToastStore((s) => s.dismissToast);

  // One ageing pass per render — calculates remaining lifetime for
  // each toast and schedules a dismissal. Owned by the mounted
  // component (not the dispatch) so an HMR / fast-refresh that
  // swaps the producer doesn't leak a setTimeout into the void.
  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((toast) => {
      const elapsed = Date.now() - toast.receivedAt;
      const remaining = Math.max(0, PORTAL_TOAST_DISMISS_MS - elapsed);
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
        pointer-events-none fixed right-4 top-20 z-50 flex
        max-w-[calc(100vw-2rem)] flex-col gap-3
      "
    >
      {toasts.map((toast) => (
        <ToastCard
          key={toast.id}
          toast={toast}
          onDismiss={() => dismissToast(toast.id)}
        />
      ))}
    </div>
  );
}


function deepLinkFor(toast: PortalToast): string {
  return toast.kind === "proposal"
    ? `/portal/proposals/${toast.entityId}`
    : `/portal/specs/${toast.entityId}`;
}


function ToastCard({
  toast,
  onDismiss,
}: {
  toast: PortalToast;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      className="
        pointer-events-auto flex w-[360px] max-w-full items-start gap-3
        border-2 border-black bg-paper p-3
        shadow-[6px_6px_0_#000]
        transition-transform
      "
    >
      <span
        className="
          mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center
          border-2 border-black bg-black text-white
        "
        aria-hidden="true"
      >
        <MessageSquare className="h-4 w-4" />
      </span>
      <a
        href={deepLinkFor(toast)}
        onClick={onDismiss}
        title="Open conversation"
        aria-label={`Open conversation about ${toast.entityTitle}`}
        className="min-w-0 flex-1 text-left"
      >
        <p className="truncate text-[10px] font-bold uppercase tracking-[0.2em] text-neutral-700">
          {toast.kind === "proposal" ? "Proposal" : "Specification"}
          {toast.entityTitle ? ` · ${toast.entityTitle}` : ""}
        </p>
        <p className="mt-0.5 truncate text-sm font-black uppercase tracking-tight text-black">
          {toast.authorName || "Vita team"}
        </p>
        <p className="mt-1 line-clamp-2 text-xs text-neutral-800">
          {toast.bodyPreview || ""}
        </p>
      </a>
      <button
        type="button"
        onClick={onDismiss}
        title="Dismiss"
        aria-label="Dismiss notification"
        className="
          mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center
          border-2 border-black bg-white text-black transition-transform
          hover:-translate-x-[1px] hover:-translate-y-[1px]
          hover:shadow-[3px_3px_0_#000]
        "
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
