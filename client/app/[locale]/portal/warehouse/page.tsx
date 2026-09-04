import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  AlertCircle,
  Boxes,
  Calendar,
  History,
  Package,
  Warehouse,
} from "lucide-react";

import {
  Card,
  Eyebrow,
  PageHeader,
  PortalShell,
} from "@/components/portal/brutalist";
import { env } from "@/config/env";

import { LotsList, type BaileeLot, type DefaultShipTo } from "./lots-list";


/**
 * /portal/warehouse — customer-facing view of the finished-goods
 * stock we're holding for them in bailee custody + how much storage
 * is accruing.
 *
 * Server-renders the summary tiles + the first page of held lots so
 * the initial paint has data. ``<LotsList>`` takes over on the
 * client for search + infinite scroll — the payload endpoint at
 * ``/api/portal/warehouse/stock/`` accepts ``q`` + ``cursor`` +
 * ``limit`` and returns the paginated slice + a ``next_cursor``.
 * Summary tiles come from PSP's unpaginated rollup so the totals
 * stay honest as the customer scrolls.
 */

interface Summary {
  readonly lot_count: number;
  readonly total_qty_on_hand: string;
  readonly total_qty_pending_dispatch: string | null;
  readonly total_qty_available: string | null;
  readonly total_held_volume_m3: string;
  readonly total_accrued_charge: string;
}

interface Snapshot {
  readonly customer: { readonly uuid: string | null; readonly name: string | null };
  readonly currency: string;
  readonly rate_per_m3_per_day: string | null;
  readonly summary: Summary;
  readonly lots: readonly BaileeLot[];
  readonly next_cursor: string | null;
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
        next_cursor: null,
      };

  const hasStock = data.summary.lot_count > 0;

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
          <div className="mt-6">
            <Eyebrow>Held lots</Eyebrow>
          </div>
          <div className="mt-3">
            <LotsList
              initialItems={data.lots}
              initialNextCursor={data.next_cursor}
              currency={data.currency}
              defaultShipTo={data.default_ship_to}
            />
          </div>

          <div className="mt-8 flex items-start gap-3 border-2 border-black bg-neutral-50 p-4">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-neutral-500" />
            <p className="text-xs text-neutral-700">
              Hit <span className="font-semibold">Request dispatch</span> on any
              lot to queue a send-out on our warehouse floor. Our team confirms
              on mobile, snaps a photo of the pack, and you&rsquo;ll see it flip
              to <span className="font-semibold">completed</span> here.
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


function formatDecimal(v: string | null, dp: number): string {
  const n = Number(v ?? "0");
  if (!Number.isFinite(n)) return v ?? "—";
  return n.toLocaleString("en-GB", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
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
