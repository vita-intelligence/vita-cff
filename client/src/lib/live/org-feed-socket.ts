/**
 * WebSocket client for the org-scoped live feed.
 *
 * One socket per (browser tab, organisation). Every high-value
 * staff-facing list — CFF, projects, proposals, samples, trial
 * batches, label designs, specifications, payments — shares this
 * transport. Adding a new entity kind is (a) a broadcast call site
 * on the backend + (b) one mapping row in
 * :file:`use-org-feed.ts` — no new socket, no new URL.
 *
 * Shape mirrors :file:`services/inbox/ws-client.ts`:
 *  * ref-counted acquire / release so mounting the hook on two
 *    components on one page does not open two sockets;
 *  * exponential backoff + jitter on non-terminal closes;
 *  * terminal close codes short-circuit reconnect so a
 *    ``forbidden`` / ``bad target`` / ``inactive`` does not spin
 *    forever.
 */


// Terminal close codes — same set as the comments + inbox consumers
// (see :mod:`apps.comments.consumers`).
const CLOSE_UNAUTHENTICATED = 4401;
const CLOSE_FORBIDDEN = 4403;
const CLOSE_BAD_TARGET = 4404;
const CLOSE_ORG_INACTIVE = 4423;

const TERMINAL_CODES = new Set<number>([
  CLOSE_UNAUTHENTICATED,
  CLOSE_FORBIDDEN,
  CLOSE_BAD_TARGET,
  CLOSE_ORG_INACTIVE,
]);


/** Entities the backend broadcasts today. Keep in sync with
 *  ``EntityKind`` in :mod:`apps.organizations.live` and the routing
 *  table in :file:`use-org-feed.ts`. */
export type OrgFeedEntity =
  | "payment"
  | "cff_submission"
  | "formulation"
  | "proposal"
  | "trial_batch"
  | "label_design"
  | "specification";


export interface EntityChangedPayload {
  readonly entity: OrgFeedEntity | (string & {});
  readonly entity_id: string;
  readonly action: string;
  // Optional entity-specific extras — e.g. Payment carries
  // ``status`` + ``kind`` for cheap column routing. Unknown extras
  // are ignored by the FE.
  readonly [key: string]: unknown;
}


export interface OrgFeedHandlers {
  readonly onEntityChanged?: (payload: EntityChangedPayload) => void;
  /** Fires on socket open — hooks use this to force a reconcile
   *  invalidation on reconnect so any events pushed during a
   *  disconnected interval are picked up. */
  readonly onConnect?: () => void;
}


type IncomingMessage =
  | { type: "entity.changed"; payload: EntityChangedPayload }
  | { type: "pong" }
  | { type: string; [key: string]: unknown };


class OrgFeedSocket {
  private readonly orgId: string;
  private handlers: OrgFeedHandlers;
  private ws: WebSocket | null = null;
  private refcount = 0;
  private retryCount = 0;
  private reconnectTimer: number | null = null;
  private stopped = false;

  constructor(orgId: string, handlers: OrgFeedHandlers) {
    this.orgId = orgId;
    this.handlers = handlers;
  }

  acquire(): void {
    this.refcount += 1;
    if (this.ws === null && !this.stopped) {
      this.open();
    }
  }

  release(): void {
    this.refcount = Math.max(0, this.refcount - 1);
    if (this.refcount === 0) {
      this.shutdown();
    }
  }

  setHandlers(handlers: OrgFeedHandlers): void {
    this.handlers = handlers;
  }

  get refcountForCleanup(): number {
    return this.refcount;
  }

  private open(): void {
    if (typeof window === "undefined") return;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const path = `/ws/org/${this.orgId}/feed/`;
    const envOrigin =
      process.env.NEXT_PUBLIC_WS_ORIGIN?.trim() || "";
    let url: string;
    if (envOrigin) {
      url = `${envOrigin.replace(/\/$/, "")}${path}`;
    } else if (process.env.NODE_ENV !== "production") {
      const host = window.location.hostname;
      url = `${proto}://${host}:8000${path}`;
    } else {
      url = `${proto}://${window.location.host}${path}`;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      console.warn("[org-feed] failed to construct WebSocket", err);
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.addEventListener("open", () => {
      this.retryCount = 0;
      this.handlers.onConnect?.();
    });

    socket.addEventListener("message", (e) => {
      let parsed: IncomingMessage | null = null;
      try {
        parsed = JSON.parse(e.data) as IncomingMessage;
      } catch {
        return;
      }
      if (parsed === null || typeof parsed !== "object") return;
      if (
        parsed.type === "entity.changed" &&
        isEntityChangedPayload(parsed.payload)
      ) {
        this.handlers.onEntityChanged?.(parsed.payload);
      }
    });

    socket.addEventListener("close", (e) => {
      this.ws = null;
      if (this.stopped) return;
      if (TERMINAL_CODES.has(e.code)) {
        console.warn(
          "[org-feed] WS closed with terminal code",
          e.code,
          e.reason,
        );
        return;
      }
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      // ``error`` always precedes ``close`` — recover in ``close``.
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || typeof window === "undefined") return;
    const base = Math.min(15_000, 500 * 2 ** this.retryCount);
    const jitter = Math.random() * (base * 0.3);
    const delay = base + jitter;
    this.retryCount += 1;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.open();
    }, delay);
  }

  private shutdown(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null && typeof window !== "undefined") {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, "client shutdown");
      } catch {
        // Socket already closed.
      }
      this.ws = null;
    }
  }
}


function isEntityChangedPayload(
  payload: unknown,
): payload is EntityChangedPayload {
  if (typeof payload !== "object" || payload === null) return false;
  const v = payload as Record<string, unknown>;
  return (
    typeof v.entity === "string" &&
    typeof v.entity_id === "string" &&
    typeof v.action === "string"
  );
}


// ---------------------------------------------------------------------------
// Registry — one socket per orgId, ref-counted across hook mounts
// ---------------------------------------------------------------------------


const activeSockets = new Map<string, OrgFeedSocket>();


export interface OrgFeedHandle {
  readonly release: () => void;
  readonly setHandlers: (handlers: OrgFeedHandlers) => void;
}


export function openOrgFeedSocket(
  orgId: string,
  handlers: OrgFeedHandlers,
): OrgFeedHandle {
  let bound = activeSockets.get(orgId);
  if (bound === undefined) {
    bound = new OrgFeedSocket(orgId, handlers);
    activeSockets.set(orgId, bound);
  } else {
    bound.setHandlers(handlers);
  }
  const socket = bound;
  socket.acquire();
  return {
    release: () => {
      socket.release();
      if (socket.refcountForCleanup === 0) {
        activeSockets.delete(orgId);
      }
    },
    setHandlers: (h) => socket.setHandlers(h),
  };
}
