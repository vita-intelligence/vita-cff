/**
 * WebSocket client for the messenger inbox firehose.
 *
 * One singleton per browser tab — a signed-in user has exactly one
 * inbox stream. The shape mirrors :file:`comments/ws-client.ts`
 * (ref-counted acquire/release, exponential backoff, terminal close
 * codes) but with a narrower handler surface since the inbox is
 * server-push only — clients never send anything beyond ``ping``.
 */

import type { InboxWsMessageDto } from "./types";


// Matches the close codes in ``apps/comments/consumers.py``.
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


export interface InboxSocketHandlers {
  /** Invoked for every ``inbox.message`` envelope the server pushes. */
  readonly onInboxMessage?: (message: InboxWsMessageDto) => void;
  /** Invoked when the socket opens — caller usually refetches the
   *  inbox + unread count to reconcile against anything missed while
   *  disconnected. */
  readonly onConnect?: () => void;
}


type IncomingMessage =
  | { type: "inbox.message"; payload: InboxWsMessageDto }
  | { type: "pong" }
  | { type: string; [key: string]: unknown };


class InboxSocket {
  private handlers: InboxSocketHandlers;
  private ws: WebSocket | null = null;
  private refcount = 0;
  private retryCount = 0;
  private reconnectTimer: number | null = null;
  private stopped = false;

  constructor(handlers: InboxSocketHandlers) {
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

  setHandlers(handlers: InboxSocketHandlers): void {
    this.handlers = handlers;
  }

  private open(): void {
    if (typeof window === "undefined") return;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const path = "/ws/inbox/";
    // Dev does not proxy WS through Next; connect directly to the
    // backend port. Prod terminates HTTP + WS on the same host.
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
      console.warn("[inbox] failed to construct WebSocket", err);
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
      if (parsed.type === "inbox.message" && isInboxMessagePayload(parsed.payload)) {
        this.handlers.onInboxMessage?.(parsed.payload);
      }
    });

    socket.addEventListener("close", (e) => {
      this.ws = null;
      if (this.stopped) return;
      if (TERMINAL_CODES.has(e.code)) {
        console.warn(
          "[inbox] WS closed with terminal code",
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


function isInboxMessagePayload(payload: unknown): payload is InboxWsMessageDto {
  if (typeof payload !== "object" || payload === null) return false;
  const value = payload as Record<string, unknown>;
  return (
    typeof value.entity_kind === "string" &&
    typeof value.entity_id === "string" &&
    typeof value.organization_id === "string" &&
    typeof value.comment === "object" &&
    value.comment !== null
  );
}


// ---------------------------------------------------------------------------
// Singleton — one socket per tab
// ---------------------------------------------------------------------------


let activeSocket: InboxSocket | null = null;


export interface InboxSocketHandle {
  readonly release: () => void;
  readonly setHandlers: (handlers: InboxSocketHandlers) => void;
}


export function openInboxSocket(
  handlers: InboxSocketHandlers,
): InboxSocketHandle {
  if (activeSocket === null) {
    activeSocket = new InboxSocket(handlers);
  } else {
    activeSocket.setHandlers(handlers);
  }
  const bound = activeSocket;
  bound.acquire();
  return {
    release: () => {
      bound.release();
      if ((bound as unknown as { refcount: number }).refcount === 0) {
        activeSocket = null;
      }
    },
    setHandlers: (h) => bound.setHandlers(h),
  };
}
