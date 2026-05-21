/**
 * WebSocket client for the customer portal.
 *
 * Connects to ``/ws/portal/<kind>/<id>/`` (proposal, specification,
 * or cff_submission),
 * authenticated by the ``vita_portal_access`` cookie the browser
 * sends automatically. The server-side consumer joins the same
 * group as the staff comments consumer, so live presence + typing
 * + new-comment broadcasts cross both sides of the conversation.
 *
 * Shape choices vs. the staff
 * :module:`@/services/comments/ws-client`:
 *
 * * Per-component callbacks (no shared presence store). The portal
 *   only needs the simple "Vita team is typing…" + "refetch on
 *   new comment" affordances; the staff presence store's per-user
 *   avatar roster is overkill here.
 * * Single connection per (kind, entityId) — ref-counted so two
 *   components on the same proposal page share one socket. Matches
 *   the staff factory's pattern.
 * * Same reconnect ladder + terminal close codes as the staff
 *   client so flaky hotel-wifi customers still recover gracefully
 *   while a "bad token" close stays closed.
 */


//: Close codes the backend portal consumer emits — see
//: ``apps/comments/consumers.py``.
const CLOSE_UNAUTHENTICATED = 4401;
const CLOSE_BAD_TARGET = 4404;

//: Close codes we treat as permanent (do not retry). Network blips
//: and 1006-style abrupt closes fall into the backoff ladder.
const TERMINAL_CODES = new Set<number>([
  CLOSE_UNAUTHENTICATED,
  CLOSE_BAD_TARGET,
]);


export type PortalEntityKind = "proposal" | "specification" | "cff_submission";


/** Identity payload the backend stamps on every presence / typing
 *  broadcast. ``id`` always starts with ``client:`` for portal-side
 *  peers and is the staff user UUID (no prefix) for staff peers —
 *  the consumer can use that to colour the bubble differently. */
export interface PortalSocketViewer {
  readonly id: string;
  readonly name: string;
  readonly avatar_url?: string;
}


export interface PortalSocketHandlers {
  /** Fired for any ``comment.*`` broadcast — usually wired to a
   *  data-refetch so the chat list re-renders with the new row. */
  readonly onCommentEvent?: (
    kind: "created" | "updated" | "deleted" | "resolved",
    payload: unknown,
  ) => void;
  /** A peer (staff or another portal client on the same entity)
   *  started typing. */
  readonly onPeerTypingStart?: (viewer: PortalSocketViewer) => void;
  /** A peer stopped typing. The handler clears the indicator
   *  for ``viewer.id``. */
  readonly onPeerTypingStop?: (viewerId: string) => void;
}


type SocketMessage =
  | { type: "presence.joined"; viewer: PortalSocketViewer }
  | { type: "presence.left"; viewer: PortalSocketViewer }
  | { type: "typing.start"; viewer: PortalSocketViewer }
  | { type: "typing.stop"; viewer: PortalSocketViewer }
  | { type: "comment.created"; payload: unknown }
  | { type: "comment.updated"; payload: unknown }
  | { type: "comment.deleted"; payload: unknown }
  | { type: "comment.resolved"; payload: unknown }
  | { type: "pong" }
  | { type: string; [key: string]: unknown };


class PortalSocket {
  private readonly path: string;
  private handlers: PortalSocketHandlers;
  private ws: WebSocket | null = null;
  private refcount = 0;
  private retryCount = 0;
  private reconnectTimer: number | null = null;
  private stopped = false;

  constructor(path: string, handlers: PortalSocketHandlers) {
    this.path = path;
    this.handlers = handlers;
  }

  acquire(): void {
    this.refcount += 1;
    if (this.ws === null && !this.stopped) {
      this.open();
    }
  }

  /** Returns ``true`` when this release was the last one and the
   *  underlying socket was shut down — the factory uses that to
   *  drop its map entry so a subsequent acquire builds a fresh
   *  instance instead of resurrecting the dead one. */
  release(): boolean {
    this.refcount = Math.max(0, this.refcount - 1);
    if (this.refcount === 0) {
      this.shutdown();
      return true;
    }
    return false;
  }

  setHandlers(handlers: PortalSocketHandlers): void {
    // Latest closures win. Without this, a component remounting
    // would keep firing into the original handler set captured by
    // the first acquire.
    this.handlers = handlers;
  }

  sendTyping(starting: boolean): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({ type: starting ? "typing.start" : "typing.stop" }),
    );
  }

  private open(): void {
    if (typeof window === "undefined") return;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";

    // Same dev/prod URL plumbing as the staff client. In dev the
    // Next.js HTTP rewrite does not forward WebSocket upgrades, so
    // we connect directly to Daphne on :8000; in production the
    // reverse proxy terminates both on one host.
    const envOrigin =
      process.env.NEXT_PUBLIC_WS_ORIGIN?.trim() || "";
    let url: string;
    if (envOrigin) {
      url = `${envOrigin.replace(/\/$/, "")}${this.path}`;
    } else if (process.env.NODE_ENV !== "production") {
      const host = window.location.hostname;
      url = `${proto}://${host}:8000${this.path}`;
    } else {
      url = `${proto}://${window.location.host}${this.path}`;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      console.warn("[portal-ws] failed to construct WebSocket", err);
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.addEventListener("open", () => {
      this.retryCount = 0;
    });

    socket.addEventListener("message", (e) => {
      let parsed: SocketMessage | null = null;
      try {
        parsed = JSON.parse(e.data) as SocketMessage;
      } catch {
        return;
      }
      if (parsed === null || typeof parsed !== "object") return;
      this.handleMessage(parsed);
    });

    socket.addEventListener("close", (e) => {
      this.ws = null;
      if (this.stopped) return;
      if (TERMINAL_CODES.has(e.code)) {
        console.warn(
          "[portal-ws] WS closed with terminal code",
          e.code,
          e.reason,
        );
        return;
      }
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      // ``error`` always precedes ``close`` — handle in ``close``.
    });
  }

  private handleMessage(message: SocketMessage): void {
    // Debug trace for the customer-side chat panel — surfaces
    // every inbound WS frame so the "bell pings but chat is
    // silent" class of bug can be diagnosed against the browser
    // console. Cheap (single console.debug per frame); strip if
    // it becomes noisy in production.
    if (
      typeof console !== "undefined" &&
      typeof console.debug === "function"
    ) {
      console.debug("[portal-ws]", message.type, message);
    }
    switch (message.type) {
      case "typing.start":
        if (isViewer(message.viewer)) {
          this.handlers.onPeerTypingStart?.(message.viewer);
        }
        return;
      case "typing.stop":
        if (isViewer(message.viewer)) {
          this.handlers.onPeerTypingStop?.(message.viewer.id);
        }
        return;
      case "comment.created":
        this.handlers.onCommentEvent?.("created", message.payload);
        return;
      case "comment.updated":
        this.handlers.onCommentEvent?.("updated", message.payload);
        return;
      case "comment.deleted":
        this.handlers.onCommentEvent?.("deleted", message.payload);
        return;
      case "comment.resolved":
        this.handlers.onCommentEvent?.("resolved", message.payload);
        return;
      // ``presence.*`` is intentionally not surfaced to the FE
      // today — the portal UX is content with the per-message
      // typing indicator, and adding a "who's looking at this"
      // panel for the customer would be a separate design call.
      // The events still arrive (and the consumer broadcasts the
      // customer to staff via the shared group), they just don't
      // drive any portal-side render.
      default:
        return;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || typeof window === "undefined") return;
    // Exponential backoff with jitter — same ladder as the staff
    // client: 0.5s, 1s, 2s, 4s, 8s, capped at 15s + up to 30%
    // jitter. Faster reconnects hammer the server during a real
    // outage; slower ones feel broken to the user.
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
        /* socket already closed */
      }
      this.ws = null;
    }
  }
}


function isViewer(candidate: unknown): candidate is PortalSocketViewer {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    "id" in candidate &&
    "name" in candidate &&
    typeof (candidate as { id: unknown }).id === "string" &&
    typeof (candidate as { name: unknown }).name === "string"
  );
}


// ---------------------------------------------------------------------------
// Ref-counted factory — single connection per (kind, entityId) shared
// across components mounted on the same page.
// ---------------------------------------------------------------------------


const activeSockets = new Map<string, PortalSocket>();


export interface PortalSocketHandle {
  readonly release: () => void;
  readonly setHandlers: (handlers: PortalSocketHandlers) => void;
  readonly sendTyping: (starting: boolean) => void;
}


export function openPortalCommentsSocket(
  kind: PortalEntityKind,
  entityId: string,
  handlers: PortalSocketHandlers,
): PortalSocketHandle {
  const lookup = `${kind}:${entityId}`;
  const path = `/ws/portal/${kind}/${entityId}/`;
  let socket = activeSockets.get(lookup);
  if (!socket) {
    socket = new PortalSocket(path, handlers);
    activeSockets.set(lookup, socket);
  } else {
    socket.setHandlers(handlers);
  }
  socket.acquire();

  const bound = socket;
  return {
    release: () => {
      // Only drop the map entry on the LAST release — otherwise a
      // shared socket between two components (e.g. spec detail
      // page + chat panel) would lose its lookup while the second
      // component is still using it, and the next acquire would
      // open a duplicate connection while the original is still
      // alive in memory.
      const shutdown = bound.release();
      if (shutdown) {
        activeSockets.delete(lookup);
      }
    },
    setHandlers: (next) => bound.setHandlers(next),
    sendTyping: (starting) => bound.sendTyping(starting),
  };
}
