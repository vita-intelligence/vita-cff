"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, ChevronDown, ChevronRight, FileText, Truck } from "lucide-react";
import { DispatchPhotoLightbox } from "@/components/portal/dispatch-photo-lightbox";
import { Eyebrow } from "@/components/portal/brutalist";

/**
 * Customer-facing dispatch card for the custom-formulation portal
 * on NPD. Mirrors the website portal's ProjectDispatchCard 1:1 so a
 * customer looking at the same project on either surface sees the
 * same information + can confirm receipt from either.
 *
 * Structure:
 *   1. Header (status pill + progress bar).
 *   2. Shipment slab (delivery company, tracking, seal, temperature).
 *   3. Per-visit blocks (one per truck): carrier slab, checklist,
 *      loading photos with lightbox, per-event Confirm-receipt CTA.
 *
 * Data lands via ``/api/portal/products/[id]/`` on Django; photo
 * bytes stream through ``/api/portal/products/[id]/dispatch/photos/[uuid]/``
 * and the Confirm-receipt POST hits
 * ``/api/portal/products/[id]/dispatch/pickup-events/[event_uuid]/confirm-delivery/``.
 * Both are already wired for this same Django app.
 */

interface DispatchPickupEventPhoto {
  readonly uuid: string;
  readonly filename: string;
  readonly mime: string;
}

interface DispatchChecklist {
  readonly packaging_intact: boolean | null;
  readonly labels_verified: boolean | null;
  readonly vehicle_clean_suitable: boolean | null;
  readonly transport_condition_acceptable: boolean | null;
  readonly dispatch_approved: boolean | null;
}

export interface DispatchPickupEvent {
  readonly uuid: string;
  readonly qty: string;
  readonly picked_up_at: string;
  readonly driver_name: string | null;
  readonly vehicle_registration: string | null;
  readonly consignment_note_ref: string | null;
  /** Per-truck carrier tracking number. Editable on PSP desktop
   *  post-departure — carriers often send this over email later. */
  readonly tracking_number: string | null;
  /** Per-truck seal + temperature reading. */
  readonly seal_number: string | null;
  readonly temperature_c: string | null;
  readonly notes: string | null;
  readonly checklist: DispatchChecklist;
  readonly delivered_at: string | null;
  readonly recipient_signatory: string | null;
  readonly delivery_notes: string | null;
  readonly photos: ReadonlyArray<DispatchPickupEventPhoto>;
}

export interface Dispatch {
  readonly status: "partially_picked" | "picked_up" | "delivered";
  readonly qty: string | null;
  readonly picked_up_qty: string | null;
  readonly remaining_qty: string | null;
  readonly picked_up_at: string | null;
  readonly delivered_at: string | null;
  readonly carrier: string | null;
  readonly seal_number: string | null;
  readonly temperature_c: string | null;
  readonly tracking_number: string | null;
  readonly pickup_events: ReadonlyArray<DispatchPickupEvent>;
}

const CHECKLIST_LABELS: readonly {
  key: keyof DispatchChecklist;
  label: string;
}[] = [
  { key: "packaging_intact", label: "Packaging intact" },
  { key: "labels_verified", label: "Labels verified" },
  { key: "vehicle_clean_suitable", label: "Vehicle clean & suitable" },
  { key: "transport_condition_acceptable", label: "Transport condition acceptable" },
  { key: "dispatch_approved", label: "Dispatch approved" },
];

export function DispatchSection({
  dispatch,
  productId,
}: {
  dispatch: Dispatch;
  productId: string;
}) {
  const totalQty = Number(dispatch.qty ?? 0);
  const pickedQty = Number(dispatch.picked_up_qty ?? 0);
  const percent =
    totalQty > 0 ? Math.min(100, Math.round((pickedQty / totalQty) * 100)) : 0;
  const isPartial = dispatch.status === "partially_picked";
  const isDelivered = dispatch.status === "delivered";
  const firstOpenIdx = dispatch.pickup_events.findIndex(
    (e) => !e.delivered_at,
  );

  return (
    <section className="mb-10">
      <Eyebrow>Dispatch</Eyebrow>
      <div className="mt-3 border border-black bg-white p-5">
        <div className="mb-4 flex items-center gap-2">
          <Truck className="size-4" aria-hidden />
          <p className="text-sm font-semibold uppercase tracking-widest">
            Shipment
          </p>
          <span
            className={`ml-auto border px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${
              isDelivered
                ? "border-emerald-600 bg-emerald-50 text-emerald-800"
                : isPartial
                  ? "border-amber-600 bg-amber-50 text-amber-800"
                  : "border-black bg-black text-white"
            }`}
          >
            {isDelivered ? "Delivered" : isPartial ? "Partial pickup" : "In transit"}
          </span>
        </div>

        {totalQty > 0 && (
          <div className="mb-4">
            <div className="flex justify-between text-xs">
              <span className="text-black/70">
                {pickedQty.toLocaleString()} of {totalQty.toLocaleString()} units picked up
              </span>
              <span className="font-medium">{percent}%</span>
            </div>
            <div className="mt-1 h-2 w-full overflow-hidden border border-black">
              <div
                className={
                  percent === 100 ? "h-full bg-emerald-500" : "h-full bg-black"
                }
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        )}

        <div className="space-y-3">
          {dispatch.pickup_events.map((event, idx) => (
            <PickupEventBlock
              key={event.uuid}
              event={event}
              eventIndex={idx}
              totalEvents={dispatch.pickup_events.length}
              productId={productId}
              defaultOpen={
                idx === firstOpenIdx || dispatch.pickup_events.length === 1
              }
            />
          ))}
        </div>

        {dispatch.pickup_events.length === 0 && (
          <p className="text-xs text-black/60">No pickups logged yet.</p>
        )}
      </div>
    </section>
  );
}

function PickupEventBlock({
  event,
  eventIndex,
  totalEvents,
  productId,
  defaultOpen,
}: {
  event: DispatchPickupEvent;
  eventIndex: number;
  totalEvents: number;
  productId: string;
  defaultOpen: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [signatory, setSignatory] = useState("");
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const router = useRouter();

  const delivered = Boolean(event.delivered_at);
  const hasPhotos = event.photos && event.photos.length > 0;
  const pickedAt = new Date(event.picked_up_at).toLocaleString();
  const deliveredAt = event.delivered_at
    ? new Date(event.delivered_at).toLocaleString()
    : null;

  const lightboxPhotos = event.photos.map((p) => ({
    uuid: p.uuid,
    filename: p.filename,
    href:
      `/api/portal/products/${encodeURIComponent(productId)}` +
      `/dispatch/photos/${encodeURIComponent(p.uuid)}/`,
  }));

  const visitLabel =
    totalEvents === 1 ? "Pickup" : `Visit ${eventIndex + 1} of ${totalEvents}`;

  const submitConfirm = async () => {
    if (!signatory.trim()) {
      setConfirmError("Please enter who signed for the delivery.");
      return;
    }
    setPending(true);
    setConfirmError(null);
    try {
      const res = await fetch(
        `/api/portal/products/${encodeURIComponent(productId)}/dispatch/pickup-events/${encodeURIComponent(event.uuid)}/confirm-delivery/`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            recipient_signatory: signatory.trim(),
            delivery_notes: notes.trim() || undefined,
          }),
        },
      );
      if (!res.ok) {
        setConfirmError(
          res.status === 502
            ? "Couldn't reach fulfilment. Please try again shortly."
            : "Couldn't record the receipt. Please try again.",
        );
        return;
      }
      setConfirmOpen(false);
      router.refresh();
    } catch {
      setConfirmError("Network error — please try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="border border-black">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 bg-white px-4 py-3 text-left hover:bg-neutral-50"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <p className="text-sm font-semibold">{visitLabel}</p>
            <span className="font-mono text-xs">{event.qty} units</span>
            <span className="text-[11px] text-black/50">· {pickedAt}</span>
          </div>
          <p className="mt-0.5 text-xs text-black/60">
            {event.driver_name || "Driver name unavailable"}
            {event.vehicle_registration ? ` · ${event.vehicle_registration}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {delivered ? (
            <span className="border border-emerald-600 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-emerald-800">
              Received
            </span>
          ) : (
            <span className="border border-black bg-black px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-white">
              In transit
            </span>
          )}
          {expanded ? (
            <ChevronDown className="size-4" aria-hidden />
          ) : (
            <ChevronRight className="size-4" aria-hidden />
          )}
        </div>
      </button>

      {expanded && (
        <div className="space-y-3 border-t border-black bg-neutral-50 p-4">
          <div className="border border-black/60 bg-white p-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-black/60">
              Carrier
            </p>
            <div className="mt-2 grid gap-3 text-sm sm:grid-cols-2">
              <DispatchField label="Driver" value={event.driver_name} />
              <DispatchField
                label="Vehicle registration"
                value={event.vehicle_registration}
                mono
              />
              <DispatchField
                label="Consignment note"
                value={event.consignment_note_ref}
                mono
              />
              <DispatchField
                label="Tracking number"
                value={event.tracking_number}
                mono
              />
              <DispatchField
                label="Seal number"
                value={event.seal_number}
                mono
              />
              <DispatchField
                label="Temperature"
                value={event.temperature_c ? `${event.temperature_c} °C` : null}
                mono
              />
              <DispatchField label="Picked up" value={pickedAt} />
              {deliveredAt && (
                <DispatchField
                  label="Delivered"
                  value={deliveredAt}
                  className="sm:col-span-2"
                />
              )}
              {event.recipient_signatory && (
                <DispatchField
                  label="Signed by"
                  value={event.recipient_signatory}
                  className="sm:col-span-2"
                />
              )}
            </div>
          </div>

          <div className="border border-black/60 bg-white p-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-black/60">
              Truck-arrival checklist
            </p>
            <ul className="mt-2 space-y-1.5">
              {CHECKLIST_LABELS.map(({ key, label }) => {
                const passed = event.checklist[key] === true;
                return (
                  <li key={key} className="flex items-center gap-2 text-sm">
                    <span
                      className={`flex size-5 shrink-0 items-center justify-center border ${
                        passed
                          ? "border-emerald-600 bg-emerald-50 text-emerald-700"
                          : "border-black/40 bg-white text-black/40"
                      }`}
                    >
                      {passed ? (
                        <Check className="size-3" aria-hidden />
                      ) : (
                        <span className="text-xs">—</span>
                      )}
                    </span>
                    <span className={passed ? "text-black/85" : "text-black/50"}>
                      {label}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          {hasPhotos && (
            <div className="border border-black/60 bg-white p-4">
              <div className="flex items-center gap-1.5">
                <FileText className="size-3.5 text-black/60" aria-hidden />
                <p className="text-[10px] font-bold uppercase tracking-widest text-black/60">
                  Loading photos ({event.photos.length})
                </p>
              </div>
              <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {lightboxPhotos.map((photo, index) => (
                  <li key={photo.uuid}>
                    <button
                      type="button"
                      onClick={() => setLightboxIndex(index)}
                      title={photo.filename}
                      aria-label={`Open ${photo.filename} in a larger view`}
                      className="block aspect-square w-full overflow-hidden border border-black/60 bg-white hover:border-black"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={photo.href}
                        alt={photo.filename}
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {event.notes && (
            <p className="text-xs italic text-black/70">
              &ldquo;{event.notes}&rdquo;
            </p>
          )}

          {!delivered && (
            <div className="border border-black bg-white p-4">
              {!confirmOpen ? (
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">Received this pickup?</p>
                    <p className="mt-0.5 text-xs text-black/60">
                      Confirm receipt for {event.qty} units so we can close
                      this visit&apos;s paperwork. Our team can also log it
                      from their side if that&apos;s easier.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setConfirmOpen(true)}
                    className="shrink-0 border border-black bg-black px-4 py-2 text-xs font-semibold uppercase tracking-widest text-white hover:bg-neutral-900"
                  >
                    Confirm receipt
                  </button>
                </div>
              ) : (
                <div className="space-y-2 text-xs">
                  <div>
                    <label className="font-medium text-black/70">
                      Recipient name
                    </label>
                    <input
                      type="text"
                      value={signatory}
                      onChange={(e) => setSignatory(e.target.value)}
                      placeholder="Who signed for it on your side?"
                      className="mt-1 w-full border border-black/60 px-2 py-1.5"
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="font-medium text-black/70">
                      Notes (optional)
                    </label>
                    <textarea
                      rows={2}
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      className="mt-1 w-full border border-black/60 px-2 py-1.5"
                      placeholder="e.g. Boxes intact, driver friendly."
                    />
                  </div>
                  {confirmError && (
                    <p className="text-red-700">{confirmError}</p>
                  )}
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmOpen(false);
                        setConfirmError(null);
                      }}
                      disabled={pending}
                      className="border border-black bg-white px-3 py-1.5 text-black/80"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void submitConfirm()}
                      disabled={pending}
                      className="border border-black bg-black px-3 py-1.5 font-semibold text-white hover:bg-neutral-900 disabled:opacity-60"
                    >
                      {pending ? "Recording…" : "Record delivery"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {lightboxIndex !== null && lightboxPhotos.length > 0 && (
            <DispatchPhotoLightbox
              photos={lightboxPhotos}
              openIndex={lightboxIndex}
              onClose={() => setLightboxIndex(null)}
              onIndexChange={setLightboxIndex}
            />
          )}
        </div>
      )}
    </div>
  );
}

function DispatchField({
  label,
  value,
  mono,
  className,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
  className?: string;
}) {
  const shown = value?.trim();
  return (
    <div className={className}>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-black/60">
        {label}
      </p>
      <p
        className={`mt-0.5 text-sm ${mono ? "font-mono" : ""} ${
          !shown ? "italic text-black/40" : ""
        }`}
      >
        {shown || "—"}
      </p>
    </div>
  );
}
