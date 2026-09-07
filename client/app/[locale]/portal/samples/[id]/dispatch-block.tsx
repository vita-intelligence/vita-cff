"use client";

/**
 * Dispatch block for the NPD portal's sample detail page. Feature-
 * parity with the web-site portal's ``DispatchCard`` (loading photos
 * with lightbox, truck-arrival checklist, per-visit + whole-shipment
 * "Confirm receipt" flows) so a customer sees the same information
 * regardless of which portal skin they land on.
 *
 * All mutations hit the same Django proxy routes the web-site portal
 * uses (``/api/portal/samples/<id>/dispatch/...``) — Next rewrites
 * them straight to Django, so nothing new server-side is needed.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  PackageCheck,
  Truck,
  X,
} from "lucide-react";

import { Eyebrow } from "@/components/portal/brutalist";

// ---------------------------------------------------------------------------
// Wire types (mirror server response — kept local so the block stays
// self-contained and re-usable if the page ever splits further).
// ---------------------------------------------------------------------------

export interface DispatchPickupEventPhoto {
  readonly uuid: string;
  readonly filename: string;
  readonly mime: string;
}

export interface DispatchChecklist {
  readonly packaging_intact: boolean | null;
  readonly labels_verified: boolean | null;
  readonly vehicle_clean_suitable: boolean | null;
  readonly transport_condition_acceptable: boolean | null;
  readonly dispatch_approved: boolean | null;
}

export interface DispatchPhoto {
  readonly uuid: string;
  readonly filename: string;
  readonly mime: string;
}

export interface DispatchPickupEvent {
  readonly uuid: string;
  readonly qty: string;
  readonly picked_up_at: string;
  readonly driver_name: string | null;
  readonly vehicle_registration: string | null;
  readonly consignment_note_ref: string | null;
  readonly tracking_number: string | null;
  readonly seal_number: string | null;
  readonly temperature_c: string | null;
  readonly delivered_at: string | null;
  readonly recipient_signatory: string | null;
  readonly delivery_notes: string | null;
  readonly photos: readonly DispatchPickupEventPhoto[];
}

export interface DispatchSnapshot {
  readonly status: "partially_picked" | "picked_up" | "delivered";
  readonly qty: string | null;
  readonly picked_up_qty: string | null;
  readonly remaining_qty: string | null;
  readonly ready_at: string | null;
  readonly picked_up_at: string | null;
  readonly delivered_at: string | null;
  readonly carrier: string | null;
  readonly vehicle_registration: string | null;
  readonly driver_name: string | null;
  readonly consignment_note_ref: string | null;
  readonly seal_number: string | null;
  readonly temperature_c: string | null;
  readonly checklist: DispatchChecklist | null;
  readonly photos: readonly DispatchPhoto[];
  readonly pickup_events: readonly DispatchPickupEvent[];
}

// PSP's ``TRUCK_ARRIVAL_CHECKLIST`` — same order so operator + customer
// see identical sequences.
const CHECKLIST_LABELS: { key: keyof DispatchChecklist; label: string }[] = [
  { key: "packaging_intact", label: "Packaging intact" },
  { key: "labels_verified", label: "Correct labels verified" },
  { key: "vehicle_clean_suitable", label: "Vehicle clean & suitable" },
  { key: "transport_condition_acceptable", label: "Transport condition acceptable" },
  { key: "dispatch_approved", label: "Dispatch approved" },
];

// ---------------------------------------------------------------------------
// Root block
// ---------------------------------------------------------------------------

export function DispatchBlock({
  dispatch: initialDispatch,
  sampleId,
}: {
  dispatch: DispatchSnapshot;
  sampleId: string;
}) {
  const [dispatch, setDispatch] = useState<DispatchSnapshot>(initialDispatch);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);

  const statusCopy =
    dispatch.status === "delivered"
      ? "Delivered"
      : dispatch.status === "picked_up"
        ? "In transit"
        : "Partial pickup";

  const lightboxPhotos = dispatch.photos.map((photo) => ({
    uuid: photo.uuid,
    filename: photo.filename,
    href: photoHref(sampleId, photo.uuid),
  }));

  // Refetch so future FE additions (e.g. status headline sync) work
  // without an extra prop drilling contract. For now we just flip
  // local state after a successful confirm — the top-level page is a
  // server component and reloads on next navigation anyway.
  const handleWholeConfirmed = useCallback(
    (updated: { delivered_at: string | null }) => {
      setDispatch((prev) => ({
        ...prev,
        status: "delivered",
        delivered_at: updated.delivered_at ?? prev.delivered_at,
      }));
      setConfirmModalOpen(false);
    },
    [],
  );

  const handleEventConfirmed = useCallback(
    (uuid: string, deliveredAt: string, signatory: string) => {
      setDispatch((prev) => {
        const events = prev.pickup_events.map((row) =>
          row.uuid === uuid
            ? { ...row, delivered_at: deliveredAt, recipient_signatory: signatory }
            : row,
        );
        const allDelivered = events.every((e) => Boolean(e.delivered_at));
        return {
          ...prev,
          pickup_events: events,
          status: allDelivered ? "delivered" : prev.status,
          delivered_at:
            allDelivered && !prev.delivered_at ? deliveredAt : prev.delivered_at,
        };
      });
    },
    [],
  );

  return (
    <section className="mt-8 mb-8">
      <Eyebrow>Dispatch</Eyebrow>
      <div className="mt-3 border-2 border-black bg-white">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-black bg-black px-4 py-3 text-white">
          <div className="flex items-center gap-2">
            <Truck className="h-4 w-4" />
            <p className="text-[10px] font-bold uppercase tracking-[0.25em]">
              {statusCopy}
            </p>
          </div>
          {dispatch.qty ? (
            <p className="text-xs">
              <span className="opacity-70">Total qty · </span>
              <span className="font-bold tabular-nums">{dispatch.qty}</span>
              {dispatch.picked_up_qty ? (
                <>
                  <span className="ml-3 opacity-70">Picked up · </span>
                  <span className="font-bold tabular-nums">{dispatch.picked_up_qty}</span>
                </>
              ) : null}
            </p>
          ) : null}
        </header>

        <div className="space-y-4 p-4">
          {/* Multi-visit progress bar — shows on partially_picked or
              multi-event shipments. Legacy single-visit ones skip
              this so the display stays clean. */}
          {(dispatch.status === "partially_picked" ||
            (dispatch.pickup_events && dispatch.pickup_events.length > 1)) &&
          dispatch.qty &&
          dispatch.picked_up_qty ? (
            <ProgressBar total={dispatch.qty} pickedUp={dispatch.picked_up_qty} />
          ) : null}

          {/* Whole-shipment confirm-receipt CTA — only for legacy
              single-event shipments in ``picked_up`` state. Per-visit
              modals live on the individual pickup rows. */}
          {dispatch.status === "picked_up" &&
          (dispatch.pickup_events?.length ?? 0) <= 1 ? (
            <div className="flex flex-wrap items-center gap-3 border-2 border-black bg-orange-100 p-3">
              <PackageCheck className="h-5 w-5 shrink-0" />
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-bold uppercase tracking-tight">Did it arrive?</p>
                <p className="mt-0.5 text-xs text-neutral-700">
                  Confirm receipt to close the paperwork on this sample.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setConfirmModalOpen(true)}
                className="shrink-0 border-2 border-black bg-black px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-white hover:bg-neutral-800"
              >
                Confirm receipt
              </button>
            </div>
          ) : null}

          {/* Carrier / driver / waybill slab — top-level shipment
              detail. Per-visit rows repeat the ones that differ. */}
          <div className="border-2 border-black bg-neutral-50 p-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-neutral-500">
              Carrier
            </p>
            <div className="mt-2 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
              <DispatchField label="Delivery company" value={dispatch.carrier} />
              <DispatchField
                label="Vehicle registration"
                value={dispatch.vehicle_registration}
                mono
              />
              <DispatchField label="Driver" value={dispatch.driver_name} />
              <DispatchField
                label="Consignment note"
                value={dispatch.consignment_note_ref}
                mono
              />
              {dispatch.seal_number ? (
                <DispatchField label="Seal number" value={dispatch.seal_number} mono />
              ) : null}
              {dispatch.temperature_c ? (
                <DispatchField
                  label="Temperature"
                  value={`${dispatch.temperature_c} °C`}
                />
              ) : null}
              {dispatch.picked_up_at ? (
                <DispatchField label="Left warehouse" value={formatDate(dispatch.picked_up_at)} />
              ) : null}
              {dispatch.delivered_at ? (
                <DispatchField
                  label="Delivered"
                  value={formatDate(dispatch.delivered_at)}
                  className="sm:col-span-2"
                />
              ) : null}
            </div>
          </div>

          {/* Truck-arrival checklist — five green ticks / grey dashes
              so the customer knows exactly what QA signed off. */}
          {dispatch.checklist ? (
            <div className="border-2 border-black bg-white p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-neutral-500">
                Truck-arrival checklist
              </p>
              <ul className="mt-2 space-y-1.5">
                {CHECKLIST_LABELS.map(({ key, label }) => {
                  const value = dispatch.checklist?.[key];
                  const passed = value === true;
                  return (
                    <li key={key} className="flex items-center gap-2 text-sm">
                      <span
                        className={`flex h-5 w-5 shrink-0 items-center justify-center border-2 border-black ${
                          passed ? "bg-emerald-400" : "bg-neutral-100 text-neutral-400"
                        }`}
                      >
                        {passed ? (
                          <Check className="h-3 w-3" />
                        ) : (
                          <span className="text-[10px]">—</span>
                        )}
                      </span>
                      <span
                        className={passed ? "text-black" : "text-neutral-500"}
                      >
                        {label}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {/* Loading photos — thumbnail grid + full-screen lightbox
              (built inline; no shared library dependency). */}
          {dispatch.photos.length > 0 ? (
            <div className="border-2 border-black bg-white p-3">
              <div className="flex items-center gap-2">
                <Camera className="h-3.5 w-3.5 text-neutral-500" />
                <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-neutral-500">
                  Loading photos ({dispatch.photos.length})
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
                      className="block aspect-square w-full overflow-hidden border-2 border-black bg-white hover:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element --
                         operator-uploaded evidence served via our
                         ownership-scoped proxy at unknown resolutions. */}
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
          ) : null}

          {/* Per-visit pickup timeline — always renders when there's
              at least one event, so the "who came, when, what did
              they take" story shows even for single-visit shipments. */}
          {dispatch.pickup_events.length === 0 ? (
            <p className="text-sm text-neutral-600">
              No pickup events yet. We&rsquo;ll update this the moment the carrier collects
              your kit.
            </p>
          ) : (
            <ol className="space-y-4">
              {dispatch.pickup_events.map((event) => (
                <PickupEventRow
                  key={event.uuid}
                  event={event}
                  sampleId={sampleId}
                  onEventConfirmed={handleEventConfirmed}
                />
              ))}
            </ol>
          )}
        </div>
      </div>

      {confirmModalOpen ? (
        <ConfirmDeliveryModal
          sampleId={sampleId}
          onClose={() => setConfirmModalOpen(false)}
          onConfirmed={handleWholeConfirmed}
        />
      ) : null}

      {lightboxIndex !== null && lightboxPhotos.length > 0 ? (
        <PhotoLightbox
          photos={lightboxPhotos}
          openIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onIndexChange={setLightboxIndex}
        />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Per-visit row with photo strip + per-visit "Confirm receipt" modal
// ---------------------------------------------------------------------------

function PickupEventRow({
  event,
  sampleId,
  onEventConfirmed,
}: {
  event: DispatchPickupEvent;
  sampleId: string;
  onEventConfirmed: (uuid: string, deliveredAt: string, signatory: string) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const delivered = Boolean(event.delivered_at);

  return (
    <li className="border-l-2 border-black pl-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-bold uppercase tracking-tight">
          Pickup · qty {event.qty}
        </p>
        <p className="text-[10px] uppercase tracking-widest text-neutral-500">
          {formatDateTime(event.picked_up_at)}
        </p>
      </div>

      <div className="mt-2 grid gap-x-6 gap-y-1 text-xs text-neutral-700 sm:grid-cols-2">
        {event.driver_name ? (
          <span>
            <span className="font-semibold">Driver:</span> {event.driver_name}
          </span>
        ) : null}
        {event.vehicle_registration ? (
          <span>
            <span className="font-semibold">Vehicle:</span> {event.vehicle_registration}
          </span>
        ) : null}
        {event.tracking_number ? (
          <span>
            <span className="font-semibold">Tracking:</span> {event.tracking_number}
          </span>
        ) : null}
        {event.consignment_note_ref ? (
          <span>
            <span className="font-semibold">Consignment:</span> {event.consignment_note_ref}
          </span>
        ) : null}
        {event.seal_number ? (
          <span>
            <span className="font-semibold">Seal:</span> {event.seal_number}
          </span>
        ) : null}
        {event.temperature_c ? (
          <span>
            <span className="font-semibold">Temperature:</span> {event.temperature_c}°C
          </span>
        ) : null}
      </div>

      {/* Per-visit "Confirm receipt" / "Received" chip */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {delivered ? (
          <span className="inline-flex items-center gap-1 border-2 border-emerald-500 bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-emerald-800">
            <Check className="h-3 w-3" />
            Received {formatDateTime(event.delivered_at!)}
            {event.recipient_signatory ? ` · ${event.recipient_signatory}` : ""}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            className="border-2 border-black bg-black px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-white hover:bg-neutral-800"
          >
            Confirm receipt
          </button>
        )}
      </div>

      {/* Per-visit photo strip. Clicking opens a new tab (small strip
          — the full-image lightbox is reserved for the top-level
          "Loading photos" grid). */}
      {event.photos && event.photos.length > 0 ? (
        <div className="mt-2">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500">
            Photos from loading
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {event.photos.map((photo) => {
              const href = photoHref(sampleId, photo.uuid);
              return (
                <a
                  key={photo.uuid}
                  href={href}
                  target="_blank"
                  rel="noopener"
                  className="block h-14 w-14 overflow-hidden border-2 border-black"
                  title={photo.filename}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={href}
                    alt={photo.filename}
                    className="h-full w-full object-cover"
                  />
                </a>
              );
            })}
          </div>
        </div>
      ) : null}

      {confirmOpen && !delivered ? (
        <PerVisitConfirmModal
          event={event}
          sampleId={sampleId}
          onClose={() => setConfirmOpen(false)}
          onConfirmed={(deliveredAt, signatory) => {
            onEventConfirmed(event.uuid, deliveredAt, signatory);
            setConfirmOpen(false);
          }}
        />
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

function ConfirmDeliveryModal({
  sampleId,
  onClose,
  onConfirmed,
}: {
  sampleId: string;
  onClose: () => void;
  onConfirmed: (updated: { delivered_at: string | null }) => void;
}) {
  const [signatory, setSignatory] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose, submitting]);

  const canSubmit = signatory.trim().length > 0 && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/portal/samples/${encodeURIComponent(sampleId)}/dispatch/confirm-delivery`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            recipient_signatory: signatory.trim(),
            delivery_notes: notes.trim(),
          }),
        },
      );
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as {
          detail?: string;
        } | null;
        setError(
          res.status === 409
            ? "This sample has already been marked delivered."
            : payload?.detail || "Couldn't confirm right now. Try again in a moment.",
        );
        setSubmitting(false);
        return;
      }
      const body = (await res.json().catch(() => null)) as {
        dispatch?: { delivered_at?: string | null };
      } | null;
      onConfirmed({ delivered_at: body?.dispatch?.delivered_at ?? null });
    } catch {
      setError("Network blip — try again in a moment.");
      setSubmitting(false);
    }
  };

  return (
    <ModalShell
      onClose={onClose}
      locked={submitting}
      title="Confirm you've received it"
      eyebrow="Delivery"
    >
      <p className="text-sm text-neutral-700">
        Once you confirm, we&rsquo;ll close the paperwork on this sample.
      </p>

      <label className="mt-4 block">
        <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-neutral-500">
          Your name
        </span>
        <input
          type="text"
          value={signatory}
          onChange={(e) => setSignatory(e.target.value)}
          maxLength={200}
          autoFocus
          className="mt-1 w-full border-2 border-black bg-white px-3 py-2 text-sm outline-none focus:bg-orange-50"
        />
      </label>

      <label className="mt-3 block">
        <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-neutral-500">
          Notes (optional)
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="e.g. box was slightly dented but contents intact"
          className="mt-1 w-full border-2 border-black bg-white px-3 py-2 text-sm outline-none focus:bg-orange-50"
        />
      </label>

      {error ? (
        <div className="mt-3 border-2 border-red-500 bg-red-50 p-2 text-xs text-red-800">
          {error}
        </div>
      ) : null}

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="border-2 border-black bg-white px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-black hover:bg-neutral-100 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="border-2 border-black bg-black px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-white hover:bg-neutral-800 disabled:opacity-50"
        >
          {submitting ? "Confirming…" : "Confirm receipt"}
        </button>
      </div>
    </ModalShell>
  );
}

function PerVisitConfirmModal({
  event,
  sampleId,
  onClose,
  onConfirmed,
}: {
  event: DispatchPickupEvent;
  sampleId: string;
  onClose: () => void;
  onConfirmed: (deliveredAt: string, signatory: string) => void;
}) {
  const [signatory, setSignatory] = useState("");
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose, pending]);

  async function submit() {
    if (!signatory.trim()) {
      setError("Please enter a signatory name.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/portal/samples/${encodeURIComponent(sampleId)}/dispatch/pickup-events/${encodeURIComponent(event.uuid)}/confirm-delivery`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            recipient_signatory: signatory.trim(),
            delivery_notes: notes.trim() || undefined,
          }),
        },
      );
      if (!res.ok) {
        setError("Couldn't record the receipt. Please try again.");
        setPending(false);
        return;
      }
      const data = (await res.json()) as {
        event?: { delivered_at?: string; recipient_signatory?: string };
      };
      const deliveredAt = data.event?.delivered_at ?? new Date().toISOString();
      const sig = data.event?.recipient_signatory ?? signatory.trim();
      onConfirmed(deliveredAt, sig);
    } catch {
      setError("Network error — please try again.");
      setPending(false);
    }
  }

  return (
    <ModalShell
      onClose={onClose}
      locked={pending}
      title={`Confirm receipt of ${event.qty} units`}
      eyebrow={`Picked up ${formatDate(event.picked_up_at)}`}
    >
      <p className="text-sm text-neutral-700">
        Enter the name of whoever signed for this delivery on your side.
      </p>

      <label className="mt-4 block">
        <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-neutral-500">
          Recipient name
        </span>
        <input
          type="text"
          value={signatory}
          onChange={(e) => setSignatory(e.target.value)}
          maxLength={200}
          autoFocus
          className="mt-1 w-full border-2 border-black bg-white px-3 py-2 text-sm outline-none focus:bg-orange-50"
        />
      </label>

      <label className="mt-3 block">
        <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-neutral-500">
          Notes (optional)
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          maxLength={2000}
          className="mt-1 w-full border-2 border-black bg-white px-3 py-2 text-sm outline-none focus:bg-orange-50"
        />
      </label>

      {error ? (
        <div className="mt-3 border-2 border-red-500 bg-red-50 p-2 text-xs text-red-800">
          {error}
        </div>
      ) : null}

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={pending}
          className="border-2 border-black bg-white px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-black hover:bg-neutral-100 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={pending}
          className="border-2 border-black bg-black px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-white hover:bg-neutral-800 disabled:opacity-50"
        >
          {pending ? "Confirming…" : "Confirm receipt"}
        </button>
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Photo lightbox — inline, no shared library. Keeps the block self-
// contained; adds keyboard nav + backdrop close for consistency with
// the web-site portal's experience.
// ---------------------------------------------------------------------------

function PhotoLightbox({
  photos,
  openIndex,
  onClose,
  onIndexChange,
}: {
  photos: readonly { uuid: string; filename: string; href: string }[];
  openIndex: number;
  onClose: () => void;
  onIndexChange: (i: number) => void;
}) {
  const total = photos.length;
  const current = photos[openIndex];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && openIndex > 0) onIndexChange(openIndex - 1);
      if (e.key === "ArrowRight" && openIndex < total - 1)
        onIndexChange(openIndex + 1);
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [openIndex, total, onClose, onIndexChange]);

  if (!current) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={current.filename}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="Close"
        className="absolute top-4 right-4 border-2 border-white bg-black p-2 text-white hover:bg-neutral-800"
      >
        <X className="h-5 w-5" />
      </button>

      {openIndex > 0 ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onIndexChange(openIndex - 1);
          }}
          aria-label="Previous photo"
          className="absolute left-4 border-2 border-white bg-black p-2 text-white hover:bg-neutral-800"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
      ) : null}

      {openIndex < total - 1 ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onIndexChange(openIndex + 1);
          }}
          aria-label="Next photo"
          className="absolute right-4 border-2 border-white bg-black p-2 text-white hover:bg-neutral-800"
        >
          <ChevronRight className="h-6 w-6" />
        </button>
      ) : null}

      {/* eslint-disable-next-line @next/next/no-img-element --
         operator-uploaded evidence served via ownership-scoped proxy. */}
      <img
        src={current.href}
        alt={current.filename}
        className="max-h-[85vh] max-w-[90vw] object-contain"
        onClick={(e) => e.stopPropagation()}
      />

      <p className="absolute bottom-4 left-1/2 -translate-x-1/2 border-2 border-white bg-black px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-white">
        {openIndex + 1} of {total} · {current.filename}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal + display helpers
// ---------------------------------------------------------------------------

function ModalShell({
  children,
  onClose,
  locked,
  title,
  eyebrow,
}: {
  children: React.ReactNode;
  onClose: () => void;
  locked: boolean;
  title: string;
  eyebrow?: string;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={() => {
        if (!locked) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="w-full max-w-md border-4 border-black bg-white p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            {eyebrow ? (
              <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-neutral-500">
                {eyebrow}
              </p>
            ) : null}
            <h3 className="mt-1 text-base font-black uppercase leading-tight">{title}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={locked}
            aria-label="Close"
            className="border-2 border-black bg-white p-1 hover:bg-neutral-100 disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
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
      <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500">
        {label}
      </p>
      <p
        className={`mt-0.5 text-sm ${mono ? "font-mono" : ""} ${
          !shown ? "italic text-neutral-400" : "text-black"
        }`}
      >
        {shown || "—"}
      </p>
    </div>
  );
}

function ProgressBar({ total, pickedUp }: { total: string; pickedUp: string }) {
  const t = Number(total) || 1;
  const p = Number(pickedUp) || 0;
  const pct = Math.min(100, Math.round((p / t) * 100));
  return (
    <div className="border-2 border-black bg-neutral-50 p-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-neutral-500">
        Pickup progress
      </p>
      <div className="mt-2 flex justify-between text-xs">
        <span className="text-neutral-600">
          {pickedUp} of {total} units picked up
        </span>
        <span className="font-bold tabular-nums">{pct}%</span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden border-2 border-black bg-white">
        <div
          className="h-full bg-orange-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function photoHref(sampleId: string, photoUuid: string): string {
  return `/api/portal/samples/${encodeURIComponent(sampleId)}/dispatch/photos/${encodeURIComponent(photoUuid)}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
