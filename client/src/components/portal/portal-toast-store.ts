/**
 * Ephemeral UI state for the customer-portal toast stack.
 *
 * Mirrors the shape of :mod:`@/components/messenger/messenger-store`
 * but trimmed to the affordances the portal needs:
 *
 * * One toast per (kind, entityId) thread at a time — a flurry of
 *   incoming messages on the same proposal coalesces into a single
 *   updating card rather than stacking N visually-identical rows.
 * * Auto-dismiss after :data:`PORTAL_TOAST_DISMISS_MS` (a touch
 *   shorter than the staff side — the customer's session is
 *   usually shorter and the noise floor lower).
 * * Cap at :data:`MAX_PORTAL_TOASTS` so a runaway producer cannot
 *   flood the screen.
 *
 * No notification-permission or floating-window state here — the
 * portal does not (yet) request OS notifications and has no
 * floating mini-chat dock; the toast plus the bell drop-down cover
 * the surface.
 */

import { create } from "zustand";


/** Thread the toast points at. Used both as the visual subject of
 *  the toast row and as the click-through target. Matches the
 *  ``PortalEntityKind`` union the WS client accepts — keep them in
 *  sync. */
export type PortalToastKind =
  | "proposal"
  | "specification"
  | "cff_submission";


export interface PortalToast {
  readonly id: string;
  readonly kind: PortalToastKind;
  readonly entityId: string;
  /** Human-readable thread title — e.g. "PROP-0042" for proposals,
   *  the spec's ``code`` for specifications. Falls back to a short
   *  id slice when the entity title hasn't been resolved yet. */
  readonly entityTitle: string;
  /** Always "Vita team" today — the portal masks individual staff
   *  identities behind a single brand voice (matches the in-thread
   *  bubble + bell preview behaviour). */
  readonly authorName: string;
  /** Single-line preview of the message body, hard-truncated. */
  readonly bodyPreview: string;
  /** Epoch ms — used by the dismiss timer to age the toast out
   *  without a per-toast useEffect timer race. */
  readonly receivedAt: number;
}


export const PORTAL_TOAST_DISMISS_MS = 5_500;
const MAX_PORTAL_TOASTS = 3;


interface PortalToastStore {
  readonly toasts: readonly PortalToast[];
  /** Push a new toast, coalescing by thread. If the customer already
   *  has an active toast for this thread, replace it instead of
   *  stacking — the user only needs one "new activity here" cue. */
  readonly pushToast: (
    toast: Omit<PortalToast, "id" | "receivedAt">,
  ) => void;
  readonly dismissToast: (id: string) => void;
  readonly clearToasts: () => void;
}


function makeKey(kind: PortalToastKind, id: string): string {
  return `${kind}:${id}`;
}


export const usePortalToastStore = create<PortalToastStore>((set) => ({
  toasts: [],

  pushToast: (incoming) =>
    set((state) => {
      const key = makeKey(incoming.kind, incoming.entityId);
      const filtered = state.toasts.filter(
        (t) => makeKey(t.kind, t.entityId) !== key,
      );
      const next: PortalToast = {
        ...incoming,
        id: `${key}:${Date.now()}`,
        receivedAt: Date.now(),
      };
      const combined = [...filtered, next];
      const trimmed =
        combined.length > MAX_PORTAL_TOASTS
          ? combined.slice(combined.length - MAX_PORTAL_TOASTS)
          : combined;
      return { toasts: trimmed };
    }),

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  clearToasts: () => set({ toasts: [] }),
}));
