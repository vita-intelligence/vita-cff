import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  AlertCircle,
  Boxes,
  Calendar,
  History,
  MapPin,
  Package,
  Warehouse,
} from "lucide-react";

import { DispatchRequestButton } from "./dispatch-request-button";

import {
  Card,
  Eyebrow,
  PageHeader,
  PortalShell,
} from "@/components/portal/brutalist";
import { env } from "@/config/env";


/**
 * /portal/warehouse — customer-facing view of the finished-goods
 * stock we're holding for them in bailee custody + how much storage
 * is accruing.
 *
 * Phase 1 of the 3PL portal integration. Read-only. Data proxied
 * from PSP's ``/api/integration/customer-bailee-inventory/:uuid``
 * via vita-cff's ``PortalWarehouseStockView``. The wire shape is
 * echoed from PSP unchanged so the FE renders whatever the operator
 * sees on the staff-side ``/three-pl`` dashboard.
 *
 * Empty-state posture — the endpoint always returns the envelope
 * (never errors), so we render the "no stock held" surface when
 * ``lots`` is empty rather than an error banner.
 */

interface LotLocation {
  readonly warehouse: string | null;
  readonly floor: string | null;
  readonly location: string | null;
  readonly cell: string | null;
}

interface ItemSummary {
  readonly uuid: string | null;
  readonly name: string | null;
  readonly code: string | null;
}

interface BaileeLot {
  readonly uuid: string;
  readonly code: string | null;
  readonly item: ItemSummary;
  readonly qty_on_hand: string;
  /** Sum of `pending` dispatch requests already queued against this
   *  lot — what the customer's already asked for but hasn't been
   *  picked yet. `qty_available` is `qty_on_hand - qty_pending`. */
  readonly qty_pending_dispatch: string | null;
  /** What the customer can freshly request. Clamped ≥ 0. */
  readonly qty_available: string | null;
  readonly unit_of_measurement: { readonly symbol: string };
  readonly bailee_routed_at: string | null;
  readonly held_volume_m3: string;
  readonly accrued_charge: string;
  readonly location: LotLocation | null;
}

interface Summary {
  readonly lot_count: number;
  readonly total_qty_on_hand: string;
  readonly total_qty_pending_dispatch: string | null;
  readonly total_qty_available: string | null;
  readonly total_held_volume_m3: string;
  readonly total_accrued_charge: string;
}

interface DefaultShipTo {
  readonly name: string | null;
  readonly address: string | null;
  readonly country: string | null;
}

interface Snapshot {
  readonly customer: { readonly uuid: string | null; readonly name: string | null };
  readonly currency: string;
  readonly rate_per_m3_per_day: string | null;
  readonly summary: Summary;
  readonly lots: readonly BaileeLot[];
  readonly default_ship_to?: DefaultShipTo;
}


export default async function PortalWarehousePage() {
  const jar = await cookies();
  const portalCookie = jar.get("vita_portal_access");
  if (!portalCookie) {
    redirect("/portal/login");
  }

  const headers = { Cookie: `vita_portal_access=${portalCookie.value}` };
  const base = env.NEXT_PUBLIC_API_URL;

  const res = await fetch(`${base}/api/portal/warehouse/stock/`, {
    cache: "no-store",
    headers,
  }).catch(() => null);

  if (!res || res.status === 401 || res.status === 403) {
    redirect("/portal/login");
  }

  const data: Snapshot = res.ok
    ? await res.json()
    : {
        customer: { uuid: null, name: null },
        currency: "GBP",
        rate_per_m3_per_day: null,
        summary: {
          lot_count: 0,
          total_qty_on_hand: "0",
          total_qty_pending_dispatch: "0",
          total_qty_available: "0",
          total_held_volume_m3: "0",
          total_accrued_charge: "0",
        },
        lots: [],
      };

  const hasStock = data.lots.length > 0;

  return (
    <PortalShell active="warehouse">
      <PageHeader
        eyebrow="Warehouse"
        title="Your stock with us"
        subtitle={
          hasStock
            ? `${data.summary.lot_count} ${data.summary.lot_count === 1 ? "lot" : "lots"} on our shelves — storage costs are accruing at ${formatMoney(data.rate_per_m3_per_day ?? "0", data.currency)}/m³/day.`
            : "We're not holding any finished-goods stock for you right now."
        }
      />

      <div className="mt-4 flex justify-end">
        <Link
          href="/portal/warehouse/requests"
          className="inline-flex items-center gap-1.5 border-2 border-black bg-white px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-black transition-all hover:bg-neutral-100"
        >
          <History className="h-3.5 w-3.5" />
          My dispatch requests
        </Link>
      </div>

      {hasStock ? (
        <SummaryStrip data={data} />
      ) : (
        <Card className="mt-6">
          <div className="flex items-start gap-3">
            <Warehouse className="mt-0.5 h-6 w-6 shrink-0 text-neutral-500" />
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-neutral-500">
                Nothing held right now
              </p>
              <p className="mt-1 text-sm">
                Once we ship a batch into bailee-custody storage on your behalf,
                you&rsquo;ll see it here — quantities on hand, the shelf it&rsquo;s
                sitting on, and the storage-cost meter ticking against it.
              </p>
              {data.rate_per_m3_per_day ? (
                <p className="mt-2 text-xs text-neutral-600">
                  Our storage rate is{" "}
                  <span className="font-semibold">
                    {formatMoney(data.rate_per_m3_per_day, data.currency)}/m³/day
                  </span>
                  .
                </p>
              ) : null}
            </div>
          </div>
        </Card>
      )}

      {hasStock ? (
        <>
          <Eyebrow>Held lots</Eyebrow>
          <div className="mt-3 flex flex-col gap-3">
            {data.lots.map((lot) => (
              <LotCard
                key={lot.uuid}
                lot={lot}
                currency={data.currency}
                defaultShipTo={data.default_ship_to}
              />
            ))}
          </div>

          <div className="mt-8 flex items-start gap-3 border-2 border-black bg-neutral-50 p-4">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-neutral-500" />
            <p className="text-xs text-neutral-700">
              Hit <span className="font-semibold">Request dispatch</span> on any
              lot to queue a send-out on our warehouse floor. Our team confirms
              on mobile, snaps a photo of the pack, and you&rsquo;ll see it flip
              to <span className="font-semibold">completed</span> here. A
              Shopify / custom-storefront webhook is coming next so your online
              orders can trigger this automatically.
            </p>
          </div>
        </>
      ) : null}
    </PortalShell>
  );
}


function SummaryStrip({ data }: { data: Snapshot }) {
  const pendingNum = Number.parseFloat(
    data.summary.total_qty_pending_dispatch ?? "0",
  );
  const hasPending = Number.isFinite(pendingNum) && pendingNum > 0;
  return (
    <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
      <SummaryTile
        icon={<Boxes className="h-5 w-5" />}
        label="Lots on shelves"
        value={String(data.summary.lot_count)}
        subtitle={
          hasPending
            ? `${formatDecimal(data.summary.total_qty_pending_dispatch ?? "0", 0)} units pending`
            : undefined
        }
      />
      <SummaryTile
        icon={<Package className="h-5 w-5" />}
        label="Held volume"
        value={`${formatDecimal(data.summary.total_held_volume_m3, 3)} m³`}
      />
      <SummaryTile
        icon={<Calendar className="h-5 w-5" />}
        label="Storage cost accrued"
        value={formatMoney(data.summary.total_accrued_charge, data.currency)}
      />
    </div>
  );
}


function SummaryTile({
  icon,
  label,
  value,
  subtitle,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  subtitle?: string;
}) {
  return (
    <div className="border-2 border-black bg-white p-4">
      <div className="flex items-center gap-2 text-neutral-500">
        {icon}
        <p className="text-[10px] font-bold uppercase tracking-[0.25em]">{label}</p>
      </div>
      <p className="mt-2 text-2xl font-black tabular-nums">{value}</p>
      {subtitle ? (
        <p className="mt-1 text-[10px] font-semibold text-orange-700">{subtitle}</p>
      ) : null}
    </div>
  );
}


function LotCard({
  lot,
  currency,
  defaultShipTo,
}: {
  lot: BaileeLot;
  currency: string;
  defaultShipTo?: DefaultShipTo;
}) {
  const location = lot.location;
  const locationLine = location
    ? [location.warehouse, location.floor, location.location, location.cell]
        .filter(Boolean)
        .join(" · ")
    : "Location pending";
  // Fall back to on-hand when the PSP payload predates the pending /
  // available fields (defensive — the wire types allow null on both
  // for backward compat).
  const availableQty = lot.qty_available ?? lot.qty_on_hand;
  const pendingNum = Number.parseFloat(lot.qty_pending_dispatch ?? "0");
  const hasPending = Number.isFinite(pendingNum) && pendingNum > 0;
  return (
    <article className="border-2 border-black bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-neutral-500">
            {lot.item.code || lot.code || "Lot"}
          </p>
          <h3 className="mt-1 text-base font-black uppercase leading-tight sm:text-lg">
            {lot.item.name || "—"}
          </h3>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-neutral-600">
            <MapPin className="h-3 w-3" />
            {locationLine}
          </p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-black tabular-nums">
            {formatDecimal(availableQty, 0)}
            <span className="ml-1 text-sm text-neutral-500">
              {lot.unit_of_measurement.symbol}
            </span>
          </p>
          <p className="mt-0.5 text-[10px] uppercase tracking-widest text-neutral-500">
            Available to request
          </p>
          {hasPending ? (
            <p className="mt-1 text-[10px] font-semibold text-orange-700">
              {formatDecimal(lot.qty_pending_dispatch ?? "0", 0)}{" "}
              {lot.unit_of_measurement.symbol} pending dispatch
            </p>
          ) : null}
          {lot.code ? (
            <p className="mt-0.5 font-mono text-[10px] text-neutral-500">{lot.code}</p>
          ) : null}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 border-t border-neutral-200 pt-3 text-xs sm:grid-cols-4">
        <MetaCell
          label="On hand"
          value={`${formatDecimal(lot.qty_on_hand, 0)} ${lot.unit_of_measurement.symbol}`}
        />
        <MetaCell label="Volume" value={`${formatDecimal(lot.held_volume_m3, 4)} m³`} />
        <MetaCell
          label="Accrued storage"
          value={formatMoney(lot.accrued_charge, currency)}
        />
        <MetaCell label="Days held" value={String(daysSince(lot.bailee_routed_at))} />
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-neutral-200 pt-3">
        <Link
          href={`/portal/warehouse/requests?lot=${encodeURIComponent(lot.uuid)}`}
          className="inline-flex items-center gap-1.5 border-2 border-black bg-white px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-black transition-all hover:bg-neutral-100"
        >
          <History className="h-3.5 w-3.5" />
          View requests
        </Link>
        <DispatchRequestButton
          lotUuid={lot.uuid}
          lotCode={lot.code || lot.item.code || "Lot"}
          itemName={lot.item.name || "—"}
          qtyOnHand={availableQty}
          defaultShipTo={defaultShipTo}
          unitSymbol={lot.unit_of_measurement.symbol}
        />
      </div>
    </article>
  );
}


function MetaCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-neutral-500">
        {label}
      </p>
      <p className="mt-0.5 font-mono tabular-nums">{value}</p>
    </div>
  );
}


function formatMoney(amount: string, currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${currency || ""}`.trim();
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: (currency || "GBP").toUpperCase(),
      minimumFractionDigits: 2,
    }).format(n);
  } catch {
    return `£${n.toFixed(2)}`;
  }
}


function formatDecimal(v: string | null, dp: number): string {
  const n = Number(v ?? "0");
  if (!Number.isFinite(n)) return v ?? "—";
  return n.toLocaleString("en-GB", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
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


function daysSince(iso: string | null): number {
  if (!iso) return 0;
  try {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return 0;
    const diffMs = Date.now() - then;
    return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
  } catch {
    return 0;
  }
}
