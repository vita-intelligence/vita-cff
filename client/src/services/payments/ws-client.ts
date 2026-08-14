/**
 * WebSocket client for the finance payments live feed.
 *
 * One socket per (browser tab, organisation). Mirrors the inbox
 * client in :file:`services/inbox/ws-client.ts`:
 *
 *  * ref-counted acquire / release so mounting the same feed hook in
 *    two components on the page does not open two sockets;
 *  * exponential backoff with jitter on non-terminal closes;
 *  * terminal close codes short-circuit reconnect so a
 *    ``forbidden`` / ``bad target`` does not spin forever.
 *
 * The feed is server-push only. Clients send ``ping`` opportunistically
 * so proxies that swallow idle TCP get an application-layer heartbeat;
 * everything else the server sends is a ``payment.changed`` envelope,
 * which the FE hook translates into a TanStack Query invalidation.
 */


// Matches the close codes in ``apps/payments/consumers.py`` (same set
// the comments + inbox consumers use — one shared FE guard).
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


export interface PaymentChangedPayload {
  readonly payment_id: string;
  readonly action:
    | "created"
    | "updated"
    | "approved"
    | "voided"
    | "assigned"
    | "invoice_attached";
  readonly status: "pending" | "approved" | "voided";
  readonly kind: "final" | "deposit";
}


export interface PaymentsSocketHandlers {
  /** Fired for every ``payment.changed`` envelope pushed by the
   *  server. Typically wired to a TanStack Query invalidation of the
   *  three list caches for the org. */
  readonly onPaymentChanged?: (payload: PaymentChangedPayload) => void;
  /** Fired on socket open — the hook uses this to force a reconcile
   *  invalidate on reconnect so any events fired during a
   *  disconnected interval are picked up. */
  readonly onConnect?: () => void;
}


type IncomingMessage =
  | { type: "payment.changed"; payload: PaymentChangedPayload }
  | { type: "pong" }
  | { type: string; [key: string]: unknown };


class PaymentsSocket {
  private readonly orgId: string;
  private handlers: PaymentsSocketHandlers;
  private ws: WebSocket | null = null;
  private refcount = 0;
  private retryCount = 0;
  private reconnectTimer: number | null = null;
  private stopped = false;

  constructor(orgId: string, handlers: PaymentsSocketHandlers) {
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

  setHandlers(handlers: PaymentsSocketHandlers): void {
    this.handlers = handlers;
  }

  get refcountForCleanup(): number {
    return this.refcount;
  }

  private open(): void {
    if (typeof window === "undefined") return;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const path = `/ws/org/${this.orgId}/payments/`;
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
      console.warn("[payments] failed to construct WebSocket", err);
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
        parsed.type === "payment.changed" &&
        isPaymentChangedPayload(parsed.payload)
      ) {
        this.handlers.onPaymentChanged?.(parsed.payload);
      }
    });

    socket.addEventListener("close", (e) => {
      this.ws = null;
      if (this.stopped) return;
      if (TERMINAL_CODES.has(e.code)) {
        console.warn(
          "[payments] WS closed with terminal code",
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


function isPaymentChangedPayload(
  payload: unknown,
): payload is PaymentChangedPayload {
  if (typeof payload !== "object" || payload === null) return false;
  const v = payload as Record<string, unknown>;
  return (
    typeof v.payment_id === "string" &&
    typeof v.action === "string" &&
    typeof v.status === "string" &&
    typeof v.kind === "string"
  );
}


// ---------------------------------------------------------------------------
// Registry — one socket per orgId, ref-counted across hook mounts
// ---------------------------------------------------------------------------


const activeSockets = new Map<string, PaymentsSocket>();


export interface PaymentsSocketHandle {
  readonly release: () => void;
  readonly setHandlers: (handlers: PaymentsSocketHandlers) => void;
}


export function openPaymentsSocket(
  orgId: string,
  handlers: PaymentsSocketHandlers,
): PaymentsSocketHandle {
  let bound = activeSockets.get(orgId);
  if (bound === undefined) {
    bound = new PaymentsSocket(orgId, handlers);
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
