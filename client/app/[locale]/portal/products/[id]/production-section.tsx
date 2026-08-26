"use client";

/**
 * Production section on /portal/products/[id] — mirrors the customer's
 * PSP wizard 1:1 so they can see exactly which of the 8 shop-floor
 * stages each of their batches is on. Full parity with the web-site
 * portal's ProductionRoadmap; styled brutalist to match the rest of
 * the NPD portal (border-2 border-black + uppercase tracking) instead
 * of the softcard aesthetic.
 *
 * Data lands on the page as `production_status.manufacturing_orders` —
 * a slim customer-safe subset the PSP → NPD callback pushes on every
 * MO state change. Empty list = the project is still in an earlier
 * phase (no MOs yet) OR the PSP push predates the roadmap fields
 * (backward compat, this section renders nothing in that case).
 */

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  X as XIcon,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Wire types — mirror server/apps/client_portal/api/product_detail_views.py
// ---------------------------------------------------------------------------

export interface ProductionMoPurchaseOrder {
  readonly uuid: string;
  readonly code: string | null;
  readonly vendor_name: string | null;
  readonly status: string | null;
  readonly expected_delivery_date: string | null;
  readonly line_count: number | null;
  readonly payment_status?: string | null;
  readonly paid_at?: string | null;
}

export interface ProductionMoSession {
  readonly uuid: string;
  readonly workstation_name: string | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly status: string | null;
  readonly duration_seconds: number | null;
}

export interface ProductionMoRoadmap {
  readonly uuid: string;
  readonly parent_mo_uuid?: string | null;
  readonly code: string | null;
  readonly item_name: string | null;
  readonly quantity: string | null;
  readonly quantity_produced: string | null;
  readonly uom_symbol?: string | null;
  readonly stage: string;
  readonly stage_index: number | null;
  readonly stage_total: number | null;
  readonly status: string | null;
  readonly target_lot_code: string | null;
  readonly approved_at: string | null;
  readonly released_to_warehouse_at: string | null;
  readonly pickup_started_at: string | null;
  readonly pickup_completed_at: string | null;
  readonly actual_start: string | null;
  readonly actual_finish: string | null;
  readonly closeout_completed_at: string | null;
  readonly due_date: string | null;
  readonly bookings_total: number | null;
  readonly bookings_picked_count: number | null;
  readonly bookings_received_count: number | null;
  readonly output_lots_pending_qc_count: number | null;
  readonly sessions?: readonly ProductionMoSession[];
  readonly purchase_orders?: readonly ProductionMoPurchaseOrder[];
}

// ---------------------------------------------------------------------------
// Stage catalog + helpers
// ---------------------------------------------------------------------------

const PRODUCTION_STAGES: readonly {
  key: string;
  label: string;
  hint: string;
}[] = [
  { key: "mo_request", label: "Manufacturing order", hint: "Our planner is drafting the recipe + approvals." },
  { key: "pickup", label: "Warehouse pickup", hint: "Ingredients being pulled from our warehouse." },
  { key: "transfer", label: "Transfer to line", hint: "Trolley moving from the warehouse to the production line." },
  { key: "preflight", label: "Preflight checks", hint: "Operator verifying every ingredient at the line." },
  { key: "production", label: "Production run", hint: "Your batch is being manufactured." },
  { key: "quality", label: "Quality control", hint: "QA signing off every output pack." },
  { key: "closeout", label: "Closeout", hint: "Consumption + paperwork wrapped up." },
  { key: "return_pickup", label: "Return to warehouse", hint: "Any leftover ingredients trolley back to storage." },
];

function stageCompletionAt(mo: ProductionMoRoadmap, stageKey: string): string | null {
  switch (stageKey) {
    case "mo_request": return mo.approved_at;
    case "pickup": return mo.pickup_started_at;
    case "transfer": return mo.pickup_completed_at;
    case "preflight": return mo.actual_start;
    case "production": return mo.actual_finish;
    case "closeout": return mo.closeout_completed_at;
    default: return null;
  }
}

function currentStageSubstatus(mo: ProductionMoRoadmap): string {
  if (mo.stage === "mo_request") {
    const poCount = mo.purchase_orders?.length ?? 0;
    if (poCount > 0) {
      return `Awaiting ingredients from ${poCount} supplier${poCount === 1 ? "" : "s"}.`;
    }
  }
  if (mo.stage === "pickup" && (mo.bookings_total ?? 0) > 0) {
    return `${mo.bookings_picked_count ?? 0} of ${mo.bookings_total ?? 0} ingredients picked so far.`;
  }
  if (mo.stage === "preflight" && (mo.bookings_total ?? 0) > 0) {
    return `${mo.bookings_received_count ?? 0} of ${mo.bookings_total ?? 0} confirmed at the line.`;
  }
  if (mo.stage === "production") return "Batch is on the line.";
  if (mo.stage === "quality") {
    const pending = mo.output_lots_pending_qc_count ?? 0;
    return pending > 0
      ? `${pending} output pack${pending === 1 ? "" : "s"} awaiting QA sign-off.`
      : "Awaiting QA sign-off.";
  }
  if (mo.stage === "closeout") return "Wrapping up the paperwork.";
  return "";
}

type PoTone = "amber" | "blue" | "emerald" | "rose" | "muted";

/** Same delivery-status translation the web-site portal uses. */
function poDeliveryStatusLabel(status: string | null): {
  label: string;
  tone: PoTone;
} {
  switch (status) {
    case "draft":
      return { label: "Draft", tone: "muted" };
    case "pending_approver":
      return { label: "Awaiting approver", tone: "amber" };
    case "pending_director":
      return { label: "Awaiting authoriser", tone: "amber" };
    case "approved":
      return { label: "Approved, sending to supplier", tone: "amber" };
    case "ordered":
      return { label: "Ordered — awaiting delivery", tone: "blue" };
    case "partially_received":
      return { label: "Partial delivery received", tone: "blue" };
    case "received":
      return { label: "Delivered", tone: "emerald" };
    default: {
      const raw = (status ?? "").replace(/_/g, " ").trim();
      return {
        label: raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "In progress",
        tone: "muted",
      };
    }
  }
}

function poPaymentStatusLabel(
  paymentStatus: string | null | undefined,
  paidAt: string | null | undefined,
): { label: string; tone: PoTone } {
  switch (paymentStatus) {
    case "paid": {
      const on = formatDeliveryDate(paidAt ?? null);
      return { label: on ? `Paid ${on}` : "Paid", tone: "emerald" };
    }
    case "partially_paid":
      return { label: "Partially paid", tone: "blue" };
    case "invoiced_unpaid":
      return { label: "Invoice received — awaiting payment", tone: "amber" };
    case "disputed":
      return { label: "Payment disputed", tone: "rose" };
    case "not_invoiced":
    default:
      return { label: "Not invoiced yet", tone: "muted" };
  }
}

function formatDeliveryDate(iso: string | null): string {
  if (!iso) return "";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return "";
  const currentYear = new Date().getFullYear();
  const opts: Intl.DateTimeFormatOptions =
    dt.getFullYear() === currentYear
      ? { day: "2-digit", month: "short" }
      : { day: "2-digit", month: "short", year: "numeric" };
  return dt.toLocaleDateString("en-GB", opts);
}

/** Brutalist tone → hard colour block. */
function poBlockClass(tone: PoTone): string {
  switch (tone) {
    case "emerald":
      return "bg-emerald-500";
    case "blue":
      return "bg-blue-500";
    case "amber":
      return "bg-orange-500";
    case "rose":
      return "bg-red-500";
    default:
      return "bg-neutral-400";
  }
}

function poTextClass(tone: PoTone): string {
  switch (tone) {
    case "emerald":
      return "text-emerald-700";
    case "blue":
      return "text-blue-700";
    case "amber":
      return "text-orange-700";
    case "rose":
      return "text-red-700";
    default:
      return "text-neutral-600";
  }
}

/** Leaves-first execution order — blending → encapsulation → bottling
 *  → finishing. Depth via parent_mo_uuid walk. */
function computeExecutionOrder(mos: readonly ProductionMoRoadmap[]): ProductionMoRoadmap[] {
  const byUuid = new Map(mos.map((mo) => [mo.uuid, mo]));
  const depth = (mo: ProductionMoRoadmap, visited = new Set<string>()): number => {
    if (!mo.parent_mo_uuid) return 0;
    if (visited.has(mo.uuid)) return 0;
    visited.add(mo.uuid);
    const parent = byUuid.get(mo.parent_mo_uuid);
    return parent ? 1 + depth(parent, visited) : 0;
  };
  return [...mos].sort((a, b) => {
    const d = depth(b) - depth(a);
    if (d !== 0) return d;
    return (a.code || "").localeCompare(b.code || "");
  });
}

function moInFlight(mo: ProductionMoRoadmap): boolean {
  return mo.stage !== "done" && mo.stage !== "cancelled";
}

function findActiveMoUuid(ordered: readonly ProductionMoRoadmap[]): string | null {
  const inFlight = ordered.find(moInFlight);
  if (inFlight) return inFlight.uuid;
  return ordered[ordered.length - 1]?.uuid ?? null;
}

function shortMoLabel(mo: ProductionMoRoadmap): string {
  const name = mo.item_name || "Batch";
  const head = name.split(" · ")[0]?.trim();
  return head || name;
}

function formatMoQuantity(qty: string | null | undefined, uom: string | null | undefined): string | null {
  if (!qty) return null;
  const num = Number.parseFloat(qty);
  if (!Number.isFinite(num)) return qty;
  const formatted = new Intl.NumberFormat("en-GB", {
    maximumFractionDigits: 5,
    minimumFractionDigits: 0,
  }).format(num);
  return uom ? `${formatted} ${uom}` : formatted;
}

function formatSessionDuration(seconds: number): string {
  if (seconds < 0) return "0s";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatSessionTime(iso: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  const timeStr = dt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const isToday = new Date().toDateString() === dt.toDateString();
  return isToday ? timeStr : `${dt.toLocaleDateString("en-GB")} ${timeStr}`;
}

function useTickingNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}

// ---------------------------------------------------------------------------
// Brutalist sub-components
// ---------------------------------------------------------------------------

function ProgressDots({ mo }: { mo: ProductionMoRoadmap }) {
  const total = mo.stage_total ?? 8;
  const current = mo.stage_index ?? 0;
  const isDone = mo.stage === "done";
  const isCancelled = mo.stage === "cancelled";
  return (
    <div className="flex gap-0.5" aria-hidden>
      {Array.from({ length: total }, (_, i) => {
        const stepNumber = i + 1;
        const isComplete = isDone || stepNumber < current;
        const isCurrent = !isDone && !isCancelled && stepNumber === current;
        return (
          <span
            key={i}
            className={
              "block h-1.5 w-1.5 " +
              (isComplete
                ? "bg-black"
                : isCurrent
                  ? "bg-orange-500 ring-2 ring-orange-500/30"
                  : isCancelled
                    ? "bg-neutral-400"
                    : "border border-black bg-white")
            }
          />
        );
      })}
    </div>
  );
}

function ProductionChain({
  ordered,
  activeUuid,
  onSelect,
}: {
  ordered: readonly ProductionMoRoadmap[];
  activeUuid: string | null;
  onSelect: (uuid: string) => void;
}) {
  if (ordered.length <= 1) return null;
  return (
    <div className="border-2 border-black bg-white p-3">
      <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em]">
        Production journey · {ordered.length} batches
      </p>
      <div className="-mx-1 flex snap-x snap-mandatory items-stretch gap-1.5 overflow-x-auto px-1 pb-1 sm:mx-0 sm:snap-none sm:overflow-visible sm:px-0 sm:pb-0">
        {ordered.map((mo, idx) => {
          const isActive = mo.uuid === activeUuid;
          return (
            <button
              key={mo.uuid}
              type="button"
              onClick={() => onSelect(mo.uuid)}
              className={
                "flex min-w-[7.5rem] shrink-0 snap-start flex-col items-start gap-1 border-2 px-2 py-1.5 text-left transition-all sm:min-w-0 sm:flex-1 sm:basis-24 " +
                (isActive
                  ? "border-black bg-orange-500 text-black shadow-[3px_3px_0_0_black]"
                  : "border-neutral-300 bg-white hover:border-black")
              }
            >
              <span className="font-mono text-[10px] uppercase tracking-widest text-neutral-500">
                {idx + 1}/{ordered.length}
              </span>
              <span
                className="line-clamp-1 text-[11px] font-bold uppercase tracking-tight"
                title={mo.item_name || undefined}
              >
                {shortMoLabel(mo)}
              </span>
              <ProgressDots mo={mo} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CollapsedMoRow({ mo, onExpand }: { mo: ProductionMoRoadmap; onExpand: () => void }) {
  const stageLabel = PRODUCTION_STAGES.find((s) => s.key === mo.stage)?.label ?? mo.stage;
  const total = mo.stage_total ?? 8;
  const current = mo.stage_index ?? 0;
  const isDone = mo.stage === "done";
  const isCancelled = mo.stage === "cancelled";
  return (
    <button
      type="button"
      onClick={onExpand}
      className="flex w-full items-center gap-3 border-2 border-black bg-white p-3 text-left transition-all hover:shadow-[3px_3px_0_0_black]"
    >
      <ChevronRight className="h-4 w-4 shrink-0 text-neutral-500" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-bold uppercase tracking-tight">
          {shortMoLabel(mo)}
          {mo.item_name && mo.item_name !== shortMoLabel(mo) ? (
            <span className="ml-1.5 text-xs font-normal normal-case tracking-normal text-neutral-500">
              · {mo.item_name}
            </span>
          ) : null}
        </p>
        <div className="mt-1 flex items-center gap-2 text-xs">
          <ProgressDots mo={mo} />
          <span className="text-neutral-600">
            {isCancelled
              ? "Cancelled"
              : isDone
                ? "All 8 stages complete"
                : `Stage ${current}/${total} · ${stageLabel}`}
          </span>
        </div>
      </div>
    </button>
  );
}

/** Brutalist "Ingredients on order" block. Each PO gets a two-line
 *  status (Delivery on top, Payment below) so the customer sees
 *  both independent workstreams honestly. */
function PurchaseOrdersBlock({
  pos,
}: {
  pos: readonly ProductionMoPurchaseOrder[];
}) {
  if (pos.length === 0) return null;

  return (
    <div className="mt-3 space-y-2">
      <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-neutral-500">
        Ingredients on order ({pos.length})
      </p>
      <ul className="divide-y-2 divide-black border-2 border-black bg-white">
        {pos.map((po) => {
          const delivery = poDeliveryStatusLabel(po.status);
          const payment = poPaymentStatusLabel(po.payment_status, po.paid_at);
          const eta = formatDeliveryDate(po.expected_delivery_date);
          const showEta =
            eta &&
            (po.status === "ordered" || po.status === "partially_received");

          return (
            <li key={po.uuid} className="p-2.5">
              <p className="truncate text-xs font-bold uppercase tracking-tight text-black">
                {po.vendor_name || "Supplier"}
                {po.code ? (
                  <span className="ml-1.5 font-mono text-[10px] font-normal normal-case tracking-normal text-neutral-500">
                    {po.code}
                  </span>
                ) : null}
              </p>
              <dl className="mt-1.5 space-y-1 text-[11px]">
                <div className="flex items-baseline gap-2">
                  <span
                    className={"mt-0.5 h-1.5 w-1.5 shrink-0 " + poBlockClass(delivery.tone)}
                    aria-hidden
                  />
                  <dt className="w-16 shrink-0 font-bold uppercase tracking-widest text-neutral-500">
                    Delivery
                  </dt>
                  <dd className={"min-w-0 flex-1 " + poTextClass(delivery.tone)}>
                    {delivery.label}
                    {showEta ? (
                      <span className="font-normal text-neutral-600">
                        {" · arriving "}
                        {eta}
                      </span>
                    ) : null}
                  </dd>
                </div>
                <div className="flex items-baseline gap-2">
                  <span
                    className={"mt-0.5 h-1.5 w-1.5 shrink-0 " + poBlockClass(payment.tone)}
                    aria-hidden
                  />
                  <dt className="w-16 shrink-0 font-bold uppercase tracking-widest text-neutral-500">
                    Payment
                  </dt>
                  <dd className={"min-w-0 flex-1 " + poTextClass(payment.tone)}>
                    {payment.label}
                  </dd>
                </div>
              </dl>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SessionTimeline({ sessions }: { sessions: readonly ProductionMoSession[] }) {
  const activeSessions = useMemo(
    () => sessions.filter((s) => !s.finished_at),
    [sessions],
  );
  const pastSessions = useMemo(
    () => sessions.filter((s) => !!s.finished_at),
    [sessions],
  );
  const [pastExpanded, setPastExpanded] = useState(false);
  const now = useTickingNow(activeSessions.length > 0);

  if (sessions.length === 0) return null;

  return (
    <div className="mt-4 space-y-2">
      <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-neutral-500">
        Shop-floor sessions
      </p>
      {activeSessions.map((s) => {
        const startMs = s.started_at ? new Date(s.started_at).getTime() : null;
        const liveSeconds =
          startMs && Number.isFinite(startMs)
            ? Math.max(0, Math.floor((now - startMs) / 1000))
            : (s.duration_seconds ?? 0);
        return (
          <div
            key={s.uuid}
            className="flex items-start gap-2.5 border-2 border-orange-500 bg-orange-500/10 p-2.5"
          >
            <span className="mt-1.5 h-2 w-2 shrink-0 animate-pulse bg-orange-500" aria-hidden />
            <div className="min-w-0 flex-1 text-xs">
              <p className="font-bold uppercase tracking-tight text-orange-700">
                Running now · {s.workstation_name || "Workstation"}
              </p>
              <p className="mt-0.5 text-neutral-600">
                Started {s.started_at ? formatSessionTime(s.started_at) : "—"} ·
                Running for{" "}
                <span className="font-bold text-black">
                  {formatSessionDuration(liveSeconds)}
                </span>
              </p>
            </div>
          </div>
        );
      })}
      {pastSessions.length > 0 ? (
        <div>
          <button
            type="button"
            onClick={() => setPastExpanded((v) => !v)}
            className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-widest text-neutral-500 transition-colors hover:text-black"
          >
            {pastExpanded ? (
              <ChevronDown className="h-3 w-3" aria-hidden />
            ) : (
              <ChevronRight className="h-3 w-3" aria-hidden />
            )}
            {pastSessions.length} past session{pastSessions.length === 1 ? "" : "s"}
          </button>
          {pastExpanded ? (
            <ul className="mt-2 space-y-1.5 border-t-2 border-black pt-2">
              {pastSessions.map((s) => (
                <li
                  key={s.uuid}
                  className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-neutral-700"
                >
                  <span>
                    <span className="font-bold text-black">
                      {s.workstation_name || "Workstation"}
                    </span>
                    {" · "}
                    Ran {formatSessionDuration(s.duration_seconds ?? 0)}
                  </span>
                  {s.finished_at ? (
                    <span className="text-[10px] uppercase tracking-widest text-neutral-500">
                      finished {formatSessionTime(s.finished_at)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ExpandedMoCard({
  mo,
  onCollapse,
  isOnlyMo,
}: {
  mo: ProductionMoRoadmap;
  onCollapse: () => void;
  isOnlyMo: boolean;
}) {
  const currentIndex = mo.stage_index ?? 0;
  const isCancelled = mo.stage === "cancelled";
  const isDone = mo.stage === "done";

  return (
    <div className="border-2 border-black bg-white p-4 shadow-[4px_4px_0_0_black]">
      <div className="flex items-start gap-2">
        {!isOnlyMo ? (
          <button
            type="button"
            onClick={onCollapse}
            className="mt-0.5 shrink-0 text-neutral-500 transition-colors hover:text-black"
            aria-label="Collapse batch"
          >
            <ChevronDown className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold uppercase tracking-tight">
                {shortMoLabel(mo)}
              </p>
              <p className="mt-0.5 font-mono text-xs text-neutral-600">
                {mo.code || "—"}
                {formatMoQuantity(mo.quantity, mo.uom_symbol) ? (
                  <>
                    {" · "}
                    <span className="font-sans">
                      Qty: {formatMoQuantity(mo.quantity, mo.uom_symbol)}
                    </span>
                  </>
                ) : null}
                {formatMoQuantity(mo.quantity_produced, mo.uom_symbol) ? (
                  <>
                    {" · "}
                    <span className="font-sans text-emerald-700">
                      Produced:{" "}
                      {formatMoQuantity(mo.quantity_produced, mo.uom_symbol)}
                    </span>
                  </>
                ) : null}
                {mo.item_name && mo.item_name !== shortMoLabel(mo) ? (
                  <span className="font-sans text-neutral-500">
                    {" · "}
                    {mo.item_name}
                  </span>
                ) : null}
              </p>
            </div>
            {/* Root MO's target lot code is what the design team pre-
                printed on the pack label. Only meaningful on the root. */}
            {!mo.parent_mo_uuid && mo.target_lot_code ? (
              <div className="border-2 border-black bg-orange-500 px-2 py-1 text-[11px] font-bold uppercase tracking-widest">
                <span className="text-neutral-800">Lot code:</span>{" "}
                <span className="font-mono">{mo.target_lot_code}</span>
              </div>
            ) : null}
          </div>

          {/* POs blocking this MO — surfaces WHY stage 1 is holding.
              Rendered above the 8-stage list so the customer's eye
              lands on it before scanning the pipeline. */}
          {!isCancelled ? (
            <PurchaseOrdersBlock pos={mo.purchase_orders ?? []} />
          ) : null}

          {isCancelled ? (
            <p className="mt-3 border-2 border-black bg-red-100 p-2.5 text-xs">
              This batch was cancelled. Reach out via chat if you have any
              questions.
            </p>
          ) : (
            <ol className="mt-3 space-y-2">
              {PRODUCTION_STAGES.map((stage, idx) => {
                const stepNumber = idx + 1;
                const isComplete = isDone || stepNumber < currentIndex;
                const isCurrent = !isDone && stepNumber === currentIndex;
                const completedAt = isComplete ? stageCompletionAt(mo, stage.key) : null;
                return (
                  <li
                    key={stage.key}
                    className={
                      "flex items-start gap-2.5 text-sm " +
                      (!isComplete && !isCurrent ? "opacity-50" : "")
                    }
                  >
                    <span
                      className={
                        "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border-2 text-[11px] font-bold " +
                        (isComplete
                          ? "border-black bg-black text-white"
                          : isCurrent
                            ? "border-black bg-orange-500 text-black ring-4 ring-orange-500/20"
                            : "border-neutral-400 bg-white text-neutral-400")
                      }
                      aria-hidden
                    >
                      {isComplete ? <Check className="h-3 w-3" /> : stepNumber}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p
                        className={
                          "font-bold uppercase tracking-tight " +
                          (isCurrent ? "text-orange-700" : "text-black")
                        }
                      >
                        {stage.label}
                      </p>
                      <p className="mt-0.5 text-xs normal-case tracking-normal text-neutral-600">
                        {isCurrent
                          ? currentStageSubstatus(mo) || stage.hint
                          : stage.hint}
                      </p>
                      {completedAt ? (
                        <p className="mt-0.5 text-[10px] uppercase tracking-widest text-neutral-500">
                          Moved on {new Date(completedAt).toLocaleDateString("en-GB")}
                        </p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          <SessionTimeline sessions={mo.sessions ?? []} />

          {isDone ? (
            <p className="mt-3 border-2 border-black bg-emerald-100 p-2.5 text-xs font-bold uppercase tracking-tight">
              All stages complete. Batch ready for release.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function ProductionSection({ mos }: { mos: readonly ProductionMoRoadmap[] }) {
  const ordered = useMemo(() => computeExecutionOrder(mos), [mos]);
  const activeMos = useMemo(
    () => ordered.filter((mo) => mo.stage !== "cancelled"),
    [ordered],
  );
  const cancelledMos = useMemo(
    () => ordered.filter((mo) => mo.stage === "cancelled"),
    [ordered],
  );
  const allCancelled = activeMos.length === 0 && cancelledMos.length > 0;
  const visibleMos = allCancelled ? cancelledMos : activeMos;
  const hiddenCancelledCount = allCancelled ? 0 : cancelledMos.length;

  const activeUuid = useMemo(() => findActiveMoUuid(visibleMos), [visibleMos]);

  const [userChoice, setUserChoice] = useState<{ value: string | null } | null>(null);
  const [cancelledExpanded, setCancelledExpanded] = useState(false);
  const expandedUuid = userChoice ? userChoice.value : activeUuid;

  if (visibleMos.length === 0) return null;

  const isOnlyMo = visibleMos.length === 1;

  const renderCard = (mo: ProductionMoRoadmap) => {
    const isExpanded = mo.uuid === expandedUuid;
    if (isExpanded) {
      return (
        <ExpandedMoCard
          key={mo.uuid}
          mo={mo}
          onCollapse={() => setUserChoice({ value: null })}
          isOnlyMo={isOnlyMo}
        />
      );
    }
    return (
      <CollapsedMoRow
        key={mo.uuid}
        mo={mo}
        onExpand={() => setUserChoice({ value: mo.uuid })}
      />
    );
  };

  return (
    <div className="space-y-3">
      <ProductionChain
        ordered={visibleMos}
        activeUuid={expandedUuid}
        onSelect={(uuid) => setUserChoice({ value: uuid })}
      />
      <div className="space-y-2">{visibleMos.map(renderCard)}</div>

      {hiddenCancelledCount > 0 ? (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setCancelledExpanded((v) => !v)}
            className="mt-1 flex items-center gap-1 text-[11px] font-bold uppercase tracking-widest text-neutral-500 transition-colors hover:text-black"
          >
            {cancelledExpanded ? (
              <ChevronDown className="h-3 w-3" aria-hidden />
            ) : (
              <ChevronRight className="h-3 w-3" aria-hidden />
            )}
            <XIcon className="h-3 w-3" aria-hidden />
            {hiddenCancelledCount} cancelled batch
            {hiddenCancelledCount === 1 ? "" : "es"}
          </button>
          {cancelledExpanded ? cancelledMos.map(renderCard) : null}
        </div>
      ) : null}
    </div>
  );
}
