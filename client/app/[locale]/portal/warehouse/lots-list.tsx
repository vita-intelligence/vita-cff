"use client";

import { useCallback } from "react";
import { MapPin, Warehouse } from "lucide-react";

import {
  PortalInfiniteList,
  type PortalPage,
} from "@/components/portal/portal-infinite-list";

import { DispatchRequestButton } from "./dispatch-request-button";

// ---------------------------------------------------------------
// Wire types — mirror
// server/apps/client_portal/api/warehouse_views.py
// ---------------------------------------------------------------

export interface BaileeLot {
  readonly uuid: string;
  readonly code: string | null;
  readonly item: {
    readonly uuid: string | null;
    readonly name: string | null;
    readonly code: string | null;
  };
  readonly qty_on_hand: string;
  readonly qty_pending_dispatch: string | null;
  readonly qty_available: string | null;
  readonly unit_of_measurement: { readonly symbol: string };
  readonly bailee_routed_at: string | null;
  readonly held_volume_m3: string;
  readonly accrued_charge: string;
  readonly location: {
    readonly warehouse: string | null;
    readonly floor: string | null;
    readonly location: string | null;
    readonly cell: string | null;
  } | null;
}

export interface DefaultShipTo {
  readonly name: string | null;
  readonly address: string | null;
  readonly country: string | null;
}

/**
 * Client-side lots list for the portal warehouse page. Renders the
 * SSR first page immediately, then wires ``<PortalInfiniteList>``
 * for search + scroll-to-load-more against
 * ``/api/portal/warehouse/stock/?q=&cursor=`` (proxied to PSP).
 */
export function LotsList({
  initialItems,
  initialNextCursor,
  currency,
  defaultShipTo,
}: {
  initialItems: readonly BaileeLot[];
  initialNextCursor: string | null;
  currency: string;
  defaultShipTo?: DefaultShipTo;
}) {
  const fetchPage = useCallback(
    async ({
      q,
      cursor,
    }: {
      q: string;
      cursor: string | null;
    }): Promise<PortalPage<BaileeLot>> => {
      const url = new URL(
        "/api/portal/warehouse/stock/",
        window.location.origin,
      );
      if (q) url.searchParams.set("q", q);
      if (cursor) url.searchParams.set("cursor", cursor);
      const res = await fetch(url.toString(), {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        lots: BaileeLot[];
        next_cursor: string | null;
      };
      return { items: body.lots ?? [], next_cursor: body.next_cursor ?? null };
    },
    [],
  );

  return (
    <PortalInfiniteList<BaileeLot>
      initialItems={initialItems}
      initialNextCursor={initialNextCursor}
      fetchPage={fetchPage}
      renderItem={(lot) => (
        <LotCard
          key={lot.uuid}
          lot={lot}
          currency={currency}
          defaultShipTo={defaultShipTo}
        />
      )}
      emptyState={
        <div className="flex items-start gap-3 border-2 border-black bg-white p-4">
          <Warehouse className="mt-0.5 h-6 w-6 shrink-0 text-neutral-500" />
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-neutral-500">
              No matches
            </p>
            <p className="mt-1 text-sm">
              No held lots match your search. Try a different product name or
              lot code.
            </p>
          </div>
        </div>
      }
      searchPlaceholder="Search product / lot code / batch…"
      storageKey="portal:warehouse:lots:q"
    />
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
  const availableQty = lot.qty_available ?? lot.qty_on_hand;
  const pendingNum = Number.parseFloat(lot.qty_pending_dispatch ?? "0");
  const hasPending = Number.isFinite(pendingNum) && pendingNum > 0;
  return (
    <article className="border-2 border-black bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-neutral-500">
            {lot.item.code || lot.code || "Lot"}
          </p>
          <h3 className="mt-1 text-lg font-black uppercase leading-tight">
            {lot.item.name || "—"}
          </h3>
          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-neutral-600">
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
              {lot.unit_of_measurement.symbol} pending
            </p>
          ) : null}
          {lot.code ? (
            <p className="mt-0.5 font-mono text-[10px] text-neutral-500">
              {lot.code}
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 border-t border-neutral-200 pt-3 text-xs sm:grid-cols-4">
        <MetaCell
          label="On hand"
          value={`${formatDecimal(lot.qty_on_hand, 0)} ${lot.unit_of_measurement.symbol}`}
        />
        <MetaCell
          label="Volume"
          value={`${formatDecimal(lot.held_volume_m3, 4)} m³`}
        />
        <MetaCell
          label="Accrued"
          value={formatMoney(lot.accrued_charge, currency)}
        />
        <MetaCell
          label="Days held"
          value={String(daysSince(lot.bailee_routed_at))}
        />
      </div>

      <div className="mt-3 flex justify-end border-t border-neutral-200 pt-3">
        <DispatchRequestButton
          lotUuid={lot.uuid}
          lotCode={lot.code ?? ""}
          itemName={lot.item.name ?? "—"}
          qtyOnHand={availableQty}
          unitSymbol={lot.unit_of_measurement.symbol}
          defaultShipTo={defaultShipTo}
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

function daysSince(iso: string | null): number {
  if (!iso) return 0;
  try {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return 0;
    const diff = Date.now() - then;
    return Math.max(0, Math.floor(diff / 86_400_000));
  } catch {
    return 0;
  }
}
