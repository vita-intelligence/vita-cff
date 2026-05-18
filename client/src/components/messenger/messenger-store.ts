/**
 * Ephemeral UI state for the messenger surface.
 *
 * Holds only what's not already in TanStack Query: which floating
 * chat panels the user has open + the locally tracked browser
 * notification permission. The inbox thread list and unread counts
 * stay in TanStack Query so the cache invalidation flow already in
 * place keeps working.
 */

import { create } from "zustand";

import type { InboxEntityKind } from "@/services/inbox";


export interface OpenChatWindow {
  readonly organizationId: string;
  readonly entityKind: InboxEntityKind;
  readonly entityId: string;
  /** Display title we cache when opening so the panel header
   *  renders something useful even before the org/entity hook
   *  resolves. Falls back to the entity_code if the thread had no
   *  human-readable name. */
  readonly title: string;
}

export type BrowserNotificationStatus = "default" | "granted" | "denied" | "unsupported";


/**
 * One in-app toast that surfaces in the bottom-right of the screen
 * when a new message arrives while the user is on a different page.
 * Auto-dismisses after :data:`TOAST_DISMISS_MS`; the user can also
 * click it (to open the chat) or dismiss it manually.
 */
export interface MessengerToast {
  readonly id: string;
  readonly organizationId: string;
  readonly entityKind: InboxEntityKind;
  readonly entityId: string;
  readonly entityTitle: string;
  readonly authorName: string;
  readonly bodyPreview: string;
  /** Epoch ms — used to age the toast out without a timer per toast. */
  readonly receivedAt: number;
}


export const TOAST_DISMISS_MS = 6000;
const MAX_TOASTS = 3;


interface MessengerStore {
  readonly openWindows: readonly OpenChatWindow[];
  readonly toasts: readonly MessengerToast[];
  readonly notificationStatus: BrowserNotificationStatus;
  readonly notificationPromptDismissed: boolean;

  readonly openThread: (window: OpenChatWindow) => void;
  readonly closeThread: (entityKind: InboxEntityKind, entityId: string) => void;
  readonly closeAll: () => void;
  readonly pushToast: (toast: Omit<MessengerToast, "id" | "receivedAt">) => void;
  readonly dismissToast: (id: string) => void;
  readonly clearToasts: () => void;
  readonly setNotificationStatus: (status: BrowserNotificationStatus) => void;
  readonly dismissNotificationPrompt: () => void;
}


//: Cap on how many windows we keep mounted at once. The dock scrolls
//: horizontally when more than fit on screen — that's mostly a layout
//: concern — but we also drop the oldest when a user piles up a huge
//: number to keep memory + WS connections bounded.
const MAX_OPEN_WINDOWS = 8;


function makeKey(kind: InboxEntityKind, id: string): string {
  return `${kind}:${id}`;
}


export const useMessengerStore = create<MessengerStore>((set) => ({
  openWindows: [],
  toasts: [],
  notificationStatus: "default",
  notificationPromptDismissed: false,

  openThread: (next) =>
    set((state) => {
      const nextKey = makeKey(next.entityKind, next.entityId);
      const filtered = state.openWindows.filter(
        (w) => makeKey(w.entityKind, w.entityId) !== nextKey,
      );
      const combined = [...filtered, next];
      // Keep the most recent N — drop oldest from the front if over.
      const trimmed =
        combined.length > MAX_OPEN_WINDOWS
          ? combined.slice(combined.length - MAX_OPEN_WINDOWS)
          : combined;
      return { openWindows: trimmed };
    }),

  closeThread: (kind, id) =>
    set((state) => ({
      openWindows: state.openWindows.filter(
        (w) => makeKey(w.entityKind, w.entityId) !== makeKey(kind, id),
      ),
    })),

  closeAll: () => set({ openWindows: [] }),

  pushToast: (incoming) =>
    set((state) => {
      // Coalesce by thread — if the user already has an active toast
      // for this chat, replace it instead of stacking duplicates.
      const threadKey = makeKey(incoming.entityKind, incoming.entityId);
      const filtered = state.toasts.filter(
        (t) => makeKey(t.entityKind, t.entityId) !== threadKey,
      );
      const next: MessengerToast = {
        ...incoming,
        id: `${threadKey}:${Date.now()}`,
        receivedAt: Date.now(),
      };
      const combined = [...filtered, next];
      const trimmed =
        combined.length > MAX_TOASTS
          ? combined.slice(combined.length - MAX_TOASTS)
          : combined;
      return { toasts: trimmed };
    }),

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  clearToasts: () => set({ toasts: [] }),

  setNotificationStatus: (status) => set({ notificationStatus: status }),
  dismissNotificationPrompt: () => set({ notificationPromptDismissed: true }),
}));


//: Storage key for the persisted "user dismissed the OS-notif prompt"
//: flag. We keep this in localStorage so a dismissed prompt does not
//: reappear on every page reload.
export const NOTIFICATION_DISMISSED_KEY = "vita-npd:messenger:notif-dismissed";
