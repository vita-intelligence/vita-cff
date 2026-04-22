/**
 * Ephemeral presence + typing store for a single comment entity.
 *
 * Scoped per-entity so a user who has two tabs open — one on a
 * formulation, one on a spec sheet — sees independent rosters. The
 * store is consumed via ``useEntityPresence({orgId, kind, entityId})``
 * which instantiates (or returns) the scoped instance on demand.
 *
 * Nothing in here is persisted; the WebSocket layer is the source of
 * truth. On reconnect the store is wiped and refilled from the
 * peer-driven roster broadcasts the consumer sends out.
 */

import { create, type StoreApi, type UseBoundStore } from "zustand";


export interface Viewer {
  readonly id: string;
  readonly name: string;
  /** Opaque avatar URL — base64 today, blob-storage URL tomorrow.
   *  Optional so old-shape events from a pre-avatar server still
   *  typecheck and fall back to initials. */
  readonly avatar_url?: string;
}


interface TypistEntry {
  readonly viewer: Viewer;
  /** Millisecond epoch at which this typing signal expires. Matched
   *  against ``Date.now()`` when the store tick fires so stale
   *  typists clear on their own if a ``typing.stop`` is dropped on
   *  the network floor. */
  readonly expiresAt: number;
}


export interface PresenceState {
  readonly viewers: Record<string, Viewer>;
  readonly typists: readonly Viewer[];
  /** Call on every ``presence.joined`` broadcast. */
  joined: (viewer: Viewer) => void;
  /** Call on every ``presence.left`` broadcast. */
  left: (viewer: Viewer) => void;
  /** Replace the whole roster — used on reconnect to reset state. */
  reset: () => void;
  /** Call on every ``typing.start`` broadcast. */
  typingStart: (viewer: Viewer) => void;
  /** Call on every ``typing.stop`` broadcast. */
  typingStop: (viewerId: string) => void;
}


/** Milliseconds a typing signal remains active without a follow-up
 *  heartbeat. The server never emits stop when a peer drops, so a
 *  client-side TTL guard is the only thing that clears a stuck
 *  "X is typing…" line when the network flakes out. */
const TYPING_TTL_MS = 5_000;


function createPresenceStore(): UseBoundStore<StoreApi<PresenceState>> {
  // Internal typist bookkeeping isn't part of the public state shape
  // — consumers render ``typists`` directly, we keep expiry
  // elsewhere. Closure over a ``Map`` keeps the TTL pruner cheap.
  const expiries = new Map<string, number>();
  let pruneHandle: number | null = null;

  return create<PresenceState>((set, get) => {
    function scheduleNextPrune() {
      if (typeof window === "undefined") return;
      if (pruneHandle !== null) {
        window.clearTimeout(pruneHandle);
        pruneHandle = null;
      }
      if (expiries.size === 0) return;
      const now = Date.now();
      const soonest = Math.min(...Array.from(expiries.values()));
      const delay = Math.max(50, soonest - now);
      pruneHandle = window.setTimeout(() => {
        pruneHandle = null;
        prune();
      }, delay);
    }

    function prune() {
      const now = Date.now();
      let changed = false;
      for (const [id, expires] of Array.from(expiries.entries())) {
        if (expires <= now) {
          expiries.delete(id);
          changed = true;
        }
      }
      if (changed) {
        const typists = get().typists.filter((v) =>
          expiries.has(v.id),
        );
        set({ typists });
      }
      scheduleNextPrune();
    }

    return {
      viewers: {},
      typists: [],

      joined(viewer) {
        if (!viewer.id) return;
        set((state) => {
          if (state.viewers[viewer.id]) {
            // Update name in case the server's snapshot changed.
            const existing = state.viewers[viewer.id]!;
            if (existing.name === viewer.name) return state;
          }
          return {
            viewers: { ...state.viewers, [viewer.id]: viewer },
          };
        });
      },

      left(viewer) {
        if (!viewer.id) return;
        set((state) => {
          if (!state.viewers[viewer.id]) return state;
          const next = { ...state.viewers };
          delete next[viewer.id];
          return { viewers: next };
        });
        // Typist list drops with them too — stale typing signals
        // for a departed viewer would be a UX papercut.
        expiries.delete(viewer.id);
        set((state) => ({
          typists: state.typists.filter((v) => v.id !== viewer.id),
        }));
      },

      reset() {
        expiries.clear();
        if (pruneHandle !== null && typeof window !== "undefined") {
          window.clearTimeout(pruneHandle);
          pruneHandle = null;
        }
        set({ viewers: {}, typists: [] });
      },

      typingStart(viewer) {
        if (!viewer.id) return;
        expiries.set(viewer.id, Date.now() + TYPING_TTL_MS);
        set((state) => {
          if (state.typists.some((v) => v.id === viewer.id)) {
            return state;
          }
          return { typists: [...state.typists, viewer] };
        });
        scheduleNextPrune();
      },

      typingStop(viewerId) {
        if (!viewerId) return;
        expiries.delete(viewerId);
        set((state) => ({
          typists: state.typists.filter((v) => v.id !== viewerId),
        }));
      },
    };
  });
}


//: Map keyed by ``<orgId>:<kind>:<entityId>`` so every component
//: mounting ``useEntityPresence`` for the same entity shares the same
//: store instance — prevents two panels on the same page from
//: holding divergent rosters.
const entityStores = new Map<
  string,
  UseBoundStore<StoreApi<PresenceState>>
>();


export interface EntityKey {
  readonly orgId: string;
  readonly kind: "formulation" | "specification";
  readonly entityId: string;
}


export function entityStoreKey(key: EntityKey): string {
  return `${key.orgId}:${key.kind}:${key.entityId}`;
}


export function presenceStoreFor(
  key: EntityKey,
): UseBoundStore<StoreApi<PresenceState>> {
  const lookup = entityStoreKey(key);
  const existing = entityStores.get(lookup);
  if (existing) return existing;
  const created = createPresenceStore();
  entityStores.set(lookup, created);
  return created;
}
