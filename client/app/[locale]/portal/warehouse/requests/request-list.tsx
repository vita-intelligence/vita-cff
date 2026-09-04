"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Loader2,
  Package,
  Truck,
  X,
  XCircle,
} from "lucide-react";

import { apiClient } from "@/lib/api";
import { PortalModal } from "@/components/portal/portal-modal";
import {
  PortalInfiniteList,
  type PortalPage,
} from "@/components/portal/portal-infinite-list";

// ---------------------------------------------------------------
// Wire types — mirror
// psp/backend/lib/backend_web/controllers/integration_customer_dispatch_request_list_controller.ex
// ---------------------------------------------------------------

export interface LotSummary {
  readonly uuid: string;
  readonly code: string | null;
  readonly item: {
    readonly name: string | null;
    readonly code: string | null;
  };
  readonly unit_of_measurement: { readonly symbol: string };
}

export interface ShipToSnapshot {
  readonly name: string | null;
  readonly address: string | null;
  readonly country: string | null;
  readonly email: string | null;
  readonly phone: string | null;
}

export interface PickupPhoto {
  readonly uuid: string;
  readonly filename: string;
  readonly mime: string;
  readonly url: string;
}

export interface PickupEvent {
  readonly uuid: string;
  readonly qty: string;
  readonly picked_up_at: string | null;
  readonly driver_name: string | null;
  readonly vehicle_registration: string | null;
  readonly consignment_note_ref: string | null;
  readonly tracking_number: string | null;
  readonly seal_number: string | null;
  readonly temperature_c: string | null;
  readonly notes: string | null;
  readonly packaging_intact: boolean;
  readonly labels_verified: boolean;
  readonly vehicle_clean_suitable: boolean;
  readonly transport_condition_acceptable: boolean;
  readonly dispatch_approved: boolean;
  readonly operator: { readonly name: string | null } | null;
  readonly photos: readonly PickupPhoto[];
}

export interface LinkedShipment {
  readonly uuid: string;
  readonly status: string;
  readonly carrier: string | null;
  readonly tracking_number: string | null;
  readonly planned_ship_at: string | null;
  readonly ready_at: string | null;
  readonly picked_up_at: string | null;
  readonly delivered_at: string | null;
  readonly recipient_signatory: string | null;
  readonly delivery_notes: string | null;
  readonly picked_up_qty: string | null;
  readonly remaining_qty: string | null;
  readonly pickup_events: readonly PickupEvent[];
}

export interface DispatchRequest {
  readonly uuid: string;
  readonly status: "pending" | "completed" | "cancelled" | "return_pending";
  readonly qty: string;
  readonly reference: string | null;
  readonly notes: string | null;
  readonly source: string;
  readonly external_reference: string | null;
  readonly requested_at: string | null;
  readonly dispatched_at: string | null;
  readonly lot: LotSummary | null;
  readonly ship_to: ShipToSnapshot | null;
  readonly shipment: LinkedShipment | null;
}

interface Props {
  readonly initialItems: readonly DispatchRequest[];
  readonly initialNextCursor: string | null;
  readonly statusFilter: "pending" | "completed" | "cancelled" | "all";
  readonly lotFilter?: string | null;
}

/**
 * Client-side dispatch-request history list. SSR seeds the first page +
 * count summary; this component drives search + infinite scroll +
 * expandable per-row detail.
 */
export function RequestList({
  initialItems,
  initialNextCursor,
  statusFilter,
  lotFilter,
}: Props) {
  const fetchPage = useCallback(
    async ({
      q,
      cursor,
    }: {
      q: string;
      cursor: string | null;
    }): Promise<PortalPage<DispatchRequest>> => {
      const url = new URL(
        "/api/portal/warehouse/dispatch-requests/",
        window.location.origin,
      );
      if (q) url.searchParams.set("q", q);
      if (cursor) url.searchParams.set("cursor", cursor);
      if (statusFilter !== "all") url.searchParams.set("status", statusFilter);
      if (lotFilter) url.searchParams.set("lot_uuid", lotFilter);
      const res = await fetch(url.toString(), {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        requests: DispatchRequest[];
        next_cursor: string | null;
      };
      return {
        items: body.requests ?? [],
        next_cursor: body.next_cursor ?? null,
      };
    },
    [statusFilter, lotFilter],
  );

  return (
    <PortalInfiniteList<DispatchRequest>
      initialItems={initialItems}
      initialNextCursor={initialNextCursor}
      fetchPage={fetchPage}
      renderItem={(r) => <RequestRow key={r.uuid} request={r} />}
      emptyState={
        <div className="border-2 border-black bg-white p-4 text-sm text-neutral-700">
          No requests match this search.
        </div>
      }
      searchPlaceholder="Search product / lot code / reference…"
      storageKey={`portal:warehouse:requests:${statusFilter}:q`}
    />
  );
}

// ---------------------------------------------------------------
// Row — collapsed by default; expands to show ship-to + pickup
// evidence (carrier, driver, vehicle, checklist, photos).
// ---------------------------------------------------------------

function RequestRow({ request }: { request: DispatchRequest }) {
  const [expanded, setExpanded] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const lot = request.lot;
  const symbol = lot?.unit_of_measurement.symbol ?? "";
  const shipment = request.shipment;
  const hasEvidence = shipment !== null;
  // Customer POD only makes sense while the shipment is in transit
  // — before the truck departed there's nothing to confirm, and
  // after the customer has already confirmed there's nothing to add.
  const canMarkDelivered =
    shipment !== null &&
    shipment.status === "picked_up" &&
    !shipment.delivered_at;
  return (
    <article className="border-2 border-black bg-white">
      <div className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <StatusBadge status={request.status} shipment={shipment} />
              {request.reference ? (
                <span className="font-mono text-[11px] text-neutral-600">
                  Ref: {request.reference}
                </span>
              ) : null}
            </div>
            <h3 className="mt-2 text-base font-black uppercase leading-tight">
              {lot?.item.name ?? "—"}
            </h3>
            <p className="mt-0.5 text-[11px] text-neutral-600">
              {lot?.item.code ?? "—"}
              {lot?.code ? ` · ${lot.code}` : ""}
            </p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-black tabular-nums">
              {formatDecimal(request.qty, 0)}
              <span className="ml-1 text-sm text-neutral-500">{symbol}</span>
            </p>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 border-t border-neutral-200 pt-3 text-xs sm:grid-cols-3">
          <MetaCell
            label="Requested"
            value={formatDateTime(request.requested_at)}
          />
          <MetaCell
            label="Shipped"
            value={
              shipment?.picked_up_at
                ? formatDateTime(shipment.picked_up_at)
                : request.status === "cancelled"
                  ? "Cancelled"
                  : request.status === "pending"
                    ? "Awaiting pickup"
                    : "In progress"
            }
          />
          <MetaCell
            label="Delivered"
            value={
              shipment?.delivered_at
                ? formatDateTime(shipment.delivered_at)
                : "—"
            }
          />
        </div>

        {request.notes ? (
          <p className="mt-3 border-t border-neutral-200 pt-3 text-xs italic text-neutral-700">
            &ldquo;{request.notes}&rdquo;
          </p>
        ) : null}

        {hasEvidence || request.ship_to ? (
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-neutral-200 pt-3">
            {canMarkDelivered ? (
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                className="inline-flex items-center gap-1.5 border-2 border-emerald-600 bg-emerald-500 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-black transition-all hover:bg-emerald-400"
              >
                <CheckCircle2 className="h-3.5 w-3.5" /> Mark as delivered
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setExpanded((x) => !x)}
              aria-expanded={expanded}
              className="inline-flex items-center gap-1.5 border-2 border-black bg-white px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-black transition-all hover:bg-neutral-100"
            >
              {expanded ? (
                <>
                  <ChevronUp className="h-3.5 w-3.5" /> Hide details
                </>
              ) : (
                <>
                  <ChevronDown className="h-3.5 w-3.5" /> Show details
                </>
              )}
            </button>
          </div>
        ) : null}
      </div>

      {expanded ? (
        <div className="space-y-4 border-t-2 border-dashed border-black bg-neutral-50 p-4">
          {request.ship_to ? <ShipToPanel shipTo={request.ship_to} /> : null}
          {shipment ? <ShipmentPanel shipment={shipment} /> : null}
        </div>
      ) : null}

      {confirmOpen ? (
        <MarkDeliveredDialog
          request={request}
          onClose={() => setConfirmOpen(false)}
        />
      ) : null}
    </article>
  );
}

function MarkDeliveredDialog({
  request,
  onClose,
}: {
  request: DispatchRequest;
  onClose: () => void;
}) {
  const router = useRouter();
  const [signatory, setSignatory] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startPending] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = signatory.trim();
    if (!trimmed) {
      setError("Please enter who signed for the parcel.");
      return;
    }
    setError(null);
    startPending(async () => {
      try {
        await apiClient.post(
          `/api/portal/warehouse/dispatch-requests/${encodeURIComponent(request.uuid)}/confirm-delivery/`,
          {
            recipient_signatory: trimmed,
            delivery_notes: notes.trim() || undefined,
          },
        );
        // Full server refresh — the request row updates status +
        // delivered_at + the pill turns green.
        router.refresh();
        onClose();
      } catch (err: unknown) {
        const detail =
          (err as { response?: { data?: { message?: string; detail?: string } } })
            ?.response?.data?.message ||
          "Couldn't record the delivery. Try again in a moment.";
        setError(detail);
      }
    });
  }

  return (
    <PortalModal
      onClose={onClose}
      ariaLabel="Mark shipment as delivered"
      locked={pending}
    >
      <PortalModal.Header>
        <div className="flex items-start gap-3">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center border-2 border-black bg-emerald-500">
            <CheckCircle2 className="h-5 w-5 text-black" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-neutral-700">
              Confirm delivery
            </p>
            <h2 className="mt-1 truncate text-lg font-black uppercase">
              {request.lot?.item.name ?? "Shipment"}
            </h2>
            <p className="mt-0.5 font-mono text-[11px] text-neutral-500">
              {request.qty} {request.lot?.unit_of_measurement.symbol ?? ""}
            </p>
          </div>
        </div>
      </PortalModal.Header>
      <form onSubmit={submit} id="mark-delivered-form" className="contents">
        <PortalModal.Body>
          <p className="text-sm text-neutral-700">
            This tells us the parcel arrived. Enter who signed for it — that
            name lands on our delivery log. Once confirmed, our team stops
            tracking this request.
          </p>
          <div className="mt-4 space-y-4">
            <div>
              <label className="text-[10px] font-bold uppercase tracking-[0.18em] text-neutral-600">
                Signed by <span className="text-red-700">*</span>
              </label>
              <input
                type="text"
                value={signatory}
                onChange={(e) => setSignatory(e.target.value)}
                maxLength={200}
                required
                disabled={pending}
                placeholder="e.g. Anna Kowalski"
                className="mt-1.5 block w-full border-2 border-black bg-white px-3 py-2 text-sm outline-none"
                autoFocus
              />
            </div>
            <div>
              <label className="text-[10px] font-bold uppercase tracking-[0.18em] text-neutral-600">
                Notes (optional)
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                maxLength={500}
                disabled={pending}
                placeholder="Anything worth recording — damage on arrival, partial receipt, etc."
                className="mt-1.5 block w-full resize-none border-2 border-black bg-white px-3 py-2 text-sm outline-none"
              />
            </div>
            {error ? (
              <div className="flex items-start gap-2 border-2 border-red-700 bg-red-50 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-800" />
                <p className="text-xs text-red-900">{error}</p>
              </div>
            ) : null}
          </div>
        </PortalModal.Body>
        <PortalModal.Footer>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              className="inline-flex items-center justify-center border-2 border-black bg-white px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-black transition-colors hover:bg-neutral-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="mark-delivered-form"
              disabled={pending}
              className="inline-flex items-center justify-center gap-2 border-2 border-black bg-emerald-500 px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-black transition-colors hover:bg-emerald-400 disabled:opacity-50"
            >
              {pending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Confirming…
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4" /> Confirm delivery
                </>
              )}
            </button>
          </div>
        </PortalModal.Footer>
      </form>
    </PortalModal>
  );
}

function StatusBadge({
  status,
  shipment,
}: {
  status: DispatchRequest["status"];
  shipment: LinkedShipment | null;
}) {
  const shared =
    "inline-flex items-center gap-1 border-2 border-black px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.18em]";

  if (status === "cancelled") {
    return (
      <span className={`${shared} bg-red-500 text-white`}>
        <XCircle className="h-3 w-3" />
        Cancelled
      </span>
    );
  }
  if (shipment?.delivered_at) {
    return (
      <span className={`${shared} bg-emerald-500 text-black`}>
        <CheckCircle2 className="h-3 w-3" />
        Delivered
      </span>
    );
  }
  if (status === "completed" && shipment) {
    switch (shipment.status) {
      case "picked_up":
        return (
          <span className={`${shared} bg-blue-500 text-white`}>
            <Truck className="h-3 w-3" />
            In transit
          </span>
        );
      case "partially_picked":
        return (
          <span className={`${shared} bg-blue-500 text-white`}>
            <Truck className="h-3 w-3" />
            Partially picked up
          </span>
        );
      case "ready":
        return (
          <span className={`${shared} bg-amber-400 text-black`}>
            <Truck className="h-3 w-3" />
            Ready for pickup
          </span>
        );
      case "draft":
      default:
        return (
          <span className={`${shared} bg-neutral-200 text-black`}>
            <Truck className="h-3 w-3" />
            Preparing paperwork
          </span>
        );
    }
  }
  if (status === "completed") {
    return (
      <span className={`${shared} bg-emerald-500 text-black`}>
        <CheckCircle2 className="h-3 w-3" />
        Walked to bay
      </span>
    );
  }
  return (
    <span className={`${shared} bg-orange-500 text-black`}>
      <Clock className="h-3 w-3" />
      Pending
    </span>
  );
}

function ShipToPanel({ shipTo }: { shipTo: ShipToSnapshot }) {
  return (
    <section className="border-2 border-black bg-white p-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-neutral-500">
        Ship to
      </p>
      <div className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
        <MetaLine label="Recipient" value={shipTo.name} />
        <MetaLine label="Country" value={shipTo.country} mono />
        <MetaLine label="Email" value={shipTo.email} />
        <MetaLine label="Phone" value={shipTo.phone} />
        <div className="sm:col-span-2">
          <MetaLine label="Address" value={shipTo.address} multiline />
        </div>
      </div>
    </section>
  );
}

function ShipmentPanel({ shipment }: { shipment: LinkedShipment }) {
  const events = shipment.pickup_events ?? [];
  return (
    <section className="border-2 border-black bg-white p-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-neutral-500">
        Shipment
      </p>
      <div className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
        <MetaLine label="Carrier" value={shipment.carrier} />
        <MetaLine label="Tracking" value={shipment.tracking_number} mono />
        <MetaLine
          label="Planned ship"
          value={
            shipment.planned_ship_at
              ? formatDateTime(shipment.planned_ship_at)
              : "—"
          }
        />
        <MetaLine
          label="Ready at"
          value={shipment.ready_at ? formatDateTime(shipment.ready_at) : "—"}
        />
      </div>

      {events.length === 0 ? (
        <p className="mt-3 border-t border-neutral-200 pt-3 text-xs text-neutral-700">
          Truck hasn&rsquo;t collected yet — details will appear here once our
          team logs the pickup.
        </p>
      ) : (
        events.map((event, idx) => (
          <PickupEventPanel
            key={event.uuid}
            event={event}
            index={idx}
            total={events.length}
          />
        ))
      )}

      {shipment.delivered_at ? (
        <div className="mt-3 border-t border-neutral-200 pt-3 text-xs">
          <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-neutral-500">
            Delivered
          </p>
          <p className="mt-1">
            Signed for by{" "}
            <span className="font-semibold">
              {shipment.recipient_signatory ?? "—"}
            </span>{" "}
            on {formatDateTime(shipment.delivered_at)}.
          </p>
          {shipment.delivery_notes ? (
            <p className="mt-1 italic text-neutral-700">
              &ldquo;{shipment.delivery_notes}&rdquo;
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function PickupEventPanel({
  event,
  index,
  total,
}: {
  event: PickupEvent;
  index: number;
  total: number;
}) {
  const isMulti = total > 1;
  return (
    <div className="mt-3 border-t border-dashed border-neutral-300 pt-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-neutral-500">
        {isMulti ? `Truck ${index + 1} of ${total}` : "Pickup"}
      </p>
      <div className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
        <MetaLine label="Left site" value={formatDateTime(event.picked_up_at)} />
        <MetaLine label="Driver" value={event.driver_name} />
        <MetaLine label="Vehicle" value={event.vehicle_registration} mono />
        <MetaLine label="CN ref" value={event.consignment_note_ref} mono />
        <MetaLine label="Tracking" value={event.tracking_number} mono />
        <MetaLine label="Seal" value={event.seal_number} mono />
        <MetaLine
          label="Temperature"
          value={event.temperature_c ? `${event.temperature_c} °C` : null}
        />
        {event.operator?.name ? (
          <MetaLine label="Signed off by" value={event.operator.name} />
        ) : null}
      </div>

      <div className="mt-3 border-t border-neutral-200 pt-2">
        <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-neutral-500">
          Truck-arrival checklist
        </p>
        <div className="mt-1 grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
          <ChecklistLine label="Packaging intact" ok={event.packaging_intact} />
          <ChecklistLine
            label="Correct labels verified"
            ok={event.labels_verified}
          />
          <ChecklistLine
            label="Vehicle clean & suitable"
            ok={event.vehicle_clean_suitable}
          />
          <ChecklistLine
            label="Transport condition acceptable"
            ok={event.transport_condition_acceptable}
          />
          <ChecklistLine label="Dispatch approved" ok={event.dispatch_approved} />
        </div>
      </div>

      {event.photos.length > 0 ? (
        <div className="mt-3 border-t border-neutral-200 pt-2">
          <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.24em] text-neutral-500">
            <Camera className="h-3 w-3" /> Loading photos ({event.photos.length})
          </p>
          <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
            {event.photos.map((photo) => (
              <PhotoTile key={photo.uuid} photo={photo} />
            ))}
          </div>
        </div>
      ) : null}

      {event.notes ? (
        <p className="mt-2 border-t border-neutral-200 pt-2 text-xs italic text-neutral-700">
          &ldquo;{event.notes}&rdquo;
        </p>
      ) : null}
    </div>
  );
}

function PhotoTile({ photo }: { photo: PickupPhoto }) {
  const [loaded, setLoaded] = useState(false);
  const [broken, setBroken] = useState(false);
  const isImage = photo.mime?.startsWith("image/");
  return (
    <a
      href={photo.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative aspect-square overflow-hidden border-2 border-black bg-neutral-100"
      title={photo.filename}
    >
      {isImage && !broken ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photo.url}
            alt={photo.filename}
            className="h-full w-full object-cover transition-opacity group-hover:opacity-80"
            onLoad={() => setLoaded(true)}
            onError={() => setBroken(true)}
          />
          {!loaded ? (
            <div className="absolute inset-0 flex items-center justify-center text-neutral-400">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : null}
        </>
      ) : (
        <div className="flex h-full w-full items-center justify-center text-neutral-400">
          <Package className="h-6 w-6" />
        </div>
      )}
    </a>
  );
}

function ChecklistLine({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      {ok ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
      ) : (
        <X className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
      )}
      <span className={ok ? "" : "text-neutral-400 line-through"}>{label}</span>
    </div>
  );
}

function MetaLine({
  label,
  value,
  mono,
  multiline,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
  multiline?: boolean;
}) {
  const shown = value?.trim();
  return (
    <div>
      <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-neutral-500">
        {label}
      </p>
      <p
        className={`mt-0.5 ${mono ? "font-mono" : ""} ${!shown ? "italic text-neutral-400" : ""} ${multiline ? "whitespace-pre-line" : "truncate"}`}
      >
        {shown || "—"}
      </p>
    </div>
  );
}

function MetaCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-neutral-500">
        {label}
      </p>
      <p className="mt-0.5 font-mono tabular-nums text-xs">{value}</p>
    </div>
  );
}

function formatDecimal(v: string | null, dp: number): string {
  const n = Number(v ?? "0");
  if (!Number.isFinite(n)) return v ?? "—";
  return n.toLocaleString("en-GB", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso.slice(0, 16).replace("T", " ");
  }
}

