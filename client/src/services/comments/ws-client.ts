/**
 * WebSocket client for the comments layer.
 *
 * One :class:`CommentsSocket` instance per entity page — it manages
 * the connection, handles reconnect with exponential backoff, and
 * dispatches inbound events into the entity's presence store. A
 * single :func:`openCommentsSocket` factory reuses the same instance
 * when two components mount on the same page (spec-sheet view +
 * comments panel, for example), ref-counting the ``release`` calls
 * so the socket stays up as long as at least one consumer is
 * watching.
 */

import {
  entityStoreKey,
  presenceStoreFor,
  type EntityKey,
  type Viewer,
} from "./presence-store";


//: Close codes the backend consumer emits. Matches the constants in
//: ``apps/comments/consumers.py``.
const CLOSE_UNAUTHENTICATED = 4401;
const CLOSE_FORBIDDEN = 4403;
const CLOSE_BAD_TARGET = 4404;
const CLOSE_ORG_INACTIVE = 4423;

//: Close codes we treat as permanent (do not retry). Everything else
//: — network blips, server restarts, 1006 — falls into the backoff
//: ladder so a partner flakily on hotel wifi still reconnects.
const _TERMINAL_CODES = new Set<number>([
  CLOSE_UNAUTHENTICATED,
  CLOSE_FORBIDDEN,
  CLOSE_BAD_TARGET,
  CLOSE_ORG_INACTIVE,
]);


export interface CommentsSocketHandlers {
  /** Invoked whenever the backend relays a REST-originated
   *  ``comment.*`` broadcast. Commit 5 will pass this through to the
   *  TanStack Query invalidator so the comment list refreshes in
   *  place. Today the handler is unused but the hook shape is final
   *  so commit 5 is a one-line wire-up. */
  readonly onCommentEvent?: (
    kind: "created" | "updated" | "deleted" | "resolved",
    payload: unknown,
  ) => void;
}


type SocketMessage =
  | { type: "presence.joined"; viewer: Viewer }
  | { type: "presence.left"; viewer: Viewer }
  | { type: "typing.start"; viewer: Viewer }
  | { type: "typing.stop"; viewer: Viewer }
  | { type: "comment.created"; payload: unknown }
  | { type: "comment.updated"; payload: unknown }
  | { type: "comment.deleted"; payload: unknown }
  | { type: "comment.resolved"; payload: unknown }
  | { type: "pong" }
  | { type: string; [key: string]: unknown };


class CommentsSocket {
  private readonly key: EntityKey;
  private readonly path: string;
  private handlers: CommentsSocketHandlers;
  private ws: WebSocket | null = null;
  private refcount = 0;
  private retryCount = 0;
  private reconnectTimer: number | null = null;
  private stopped = false;

  constructor(
    key: EntityKey,
    path: string,
    handlers: CommentsSocketHandlers,
  ) {
    this.key = key;
    this.path = path;
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

  setHandlers(handlers: CommentsSocketHandlers): void {
    // The factory overwrites handlers whenever a component remounts
    // with a fresh closure — we always use the latest callbacks, not
    // a stale snapshot from the first mount.
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
    const path = this.path;
    // Next 16's HTTP rewrite does not forward WebSocket upgrades in
    // dev — the handshake never reaches Daphne. We connect directly
    // to the backend port instead. Cookies still ride along because
    // ``SameSite=Lax`` treats ``hostname:3000`` and ``hostname:8000``
    // as the same site (ports are not part of "site" per the spec).
    //
    // In production the reverse proxy terminates both on one host
    // and ``NEXT_PUBLIC_WS_ORIGIN`` stays unset, so we go through
    // the same origin the browser is on.
    const envOrigin =
      process.env.NEXT_PUBLIC_WS_ORIGIN?.trim() || "";
    let url: string;
    if (envOrigin) {
      url = `${envOrigin.replace(/\/$/, "")}${path}`;
    } else if (process.env.NODE_ENV !== "production") {
      // Derive the dev WS URL from whatever host the browser is on
      // so teammates on ``192.168.x.x:3000`` get
      // ``ws://192.168.x.x:8000`` automatically.
      const host = window.location.hostname;
      url = `${proto}://${host}:8000${path}`;
    } else {
      url = `${proto}://${window.location.host}${path}`;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      console.warn("[comments] failed to construct WebSocket", err);
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.addEventListener("open", () => {
      this.retryCount = 0;
      // Reconnect-resilient: on every fresh open, clear the store
      // and let the server's roster broadcast repopulate it.
      presenceStoreFor(this.key).getState().reset();
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
      if (_TERMINAL_CODES.has(e.code)) {
        // Permanent failure — don't retry, the reason code tells the
        // user (via the panel's empty state) to refresh / ask admin.
        console.warn(
          "[comments] WS closed with terminal code",
          e.code,
          e.reason,
        );
        return;
      }
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      // ``error`` always precedes ``close`` — we react in ``close``.
    });
  }

  private handleMessage(message: SocketMessage): void {
    const store = presenceStoreFor(this.key).getState();
    switch (message.type) {
      case "presence.joined":
        if (isViewer(message.viewer)) store.joined(message.viewer);
        return;
      case "presence.left":
        if (isViewer(message.viewer)) store.left(message.viewer);
        return;
      case "typing.start":
        if (isViewer(message.viewer)) store.typingStart(message.viewer);
        return;
      case "typing.stop":
        if (isViewer(message.viewer)) store.typingStop(message.viewer.id);
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
      default:
        return;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || typeof window === "undefined") return;
    // Exponential backoff with jitter: 0.5s, 1s, 2s, 4s, 8s, capped
    // at 15s. Anything longer feels broken; anything faster
    // hammers the server during outages.
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
        // Socket already closed — nothing to do.
      }
      this.ws = null;
    }
    presenceStoreFor(this.key).getState().reset();
  }
}


function isViewer(candidate: unknown): candidate is Viewer {
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
// Ref-counted factory
// ---------------------------------------------------------------------------


const activeSockets = new Map<string, CommentsSocket>();


export interface CommentsSocketHandle {
  readonly release: () => void;
  readonly setHandlers: (handlers: CommentsSocketHandlers) => void;
  readonly sendTyping: (starting: boolean) => void;
}


export function openCommentsSocket(
  key: EntityKey,
  handlers: CommentsSocketHandlers,
): CommentsSocketHandle {
  const path = `/ws/org/${key.orgId}/${key.kind}/${key.entityId}/`;
  return _openSocket(key, path, handlers);
}


/**
 * Public-visitor variant. Routes through ``/ws/public/specification/
 * <token>/`` and piggy-backs on the spec sheet's signed kiosk cookie
 * for auth. Joins the same ``comments.specification.<id>`` group as
 * the authed consumer so org members see kiosk presence + new
 * client comments live (and vice-versa).
 */
export function openKioskCommentsSocket(
  token: string,
  handlers: CommentsSocketHandlers,
): CommentsSocketHandle {
  // Synthesize a presence key scoped under ``public`` so the store
  // does not collide with an authenticated org member also open on
  // the same sheet in another tab. Each browser session runs one of
  // these — the shared-instance concern only matters when two
  // components in the SAME tab use the same key.
  const key: EntityKey = {
    orgId: "public",
    kind: "specification",
    entityId: token,
  };
  const path = `/ws/public/specification/${token}/`;
  return _openSocket(key, path, handlers);
}


function _openSocket(
  key: EntityKey,
  path: string,
  handlers: CommentsSocketHandlers,
): CommentsSocketHandle {
  const lookup = entityStoreKey(key);
  let socket = activeSockets.get(lookup);
  if (!socket) {
    socket = new CommentsSocket(key, path, handlers);
    activeSockets.set(lookup, socket);
  } else {
    socket.setHandlers(handlers);
  }
  socket.acquire();

  const bound = socket;
  return {
    release: () => {
      bound.release();
      // If the socket has no remaining consumers, drop it from the
      // map so the next mount rebuilds fresh. Ref-counted via the
      // socket's own ``refcount``.
      if ((bound as unknown as { refcount: number }).refcount === 0) {
        activeSockets.delete(lookup);
      }
    },
    setHandlers: (h) => bound.setHandlers(h),
    sendTyping: (starting) => bound.sendTyping(starting),
  };
}
