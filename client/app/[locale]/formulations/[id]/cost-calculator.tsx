"use client";

/**
 * Real-time cost calculator for the formulation builder.
 *
 * Two pieces:
 *
 * * ``CostCalculatorPill`` — sticky bottom-center chip on the builder
 *   tab that shows the current total cost / pack. Always visible
 *   while the builder is active; click to open the breakdown card.
 * * ``CostCalculatorCard`` — draggable, non-blocking floating card
 *   with the per-line breakdown, source badges (PO history / purchase
 *   term / none), and warnings for items missing pricing.
 *
 * The card is deliberately *not* backed by a modal — like the
 * project comments bubble, it stays out of the way of the builder
 * form so scientists can keep editing while glancing at the number.
 *
 * ---
 *
 * Architecture — client-side compute
 *
 * The calculator receives the builder's *live* line set as a prop
 * (unsaved edits included) and computes everything in memory:
 *
 * 1. Extract unique ``item_psp_source_uuid`` values from the lines.
 * 2. ``useItemPrices`` fetches PSP prices keyed by that sorted uuid
 *    list. Cache hit when the same set of items is quoted again.
 * 3. For every line, join price by uuid → per-line cost using the
 *    UoM conversion below.
 *
 * Delete / claim edit / reorder never fires a network call — the
 * pill updates on the next paint. Adding a new ingredient warms
 * the cache with just that uuid.
 *
 * ---
 *
 * Per-line cost math:
 *
 * * For rows with ``uom_symbol ∈ {g, kg, mg}`` the unit cost is per
 *   mass, so ``cost = mg_per_pack ÷ conversion(uom)``.
 * * For rows with ``uom_symbol ∈ {unit, each, pcs, pack}`` (mostly
 *   packaging), we treat one item per finished pack:
 *   ``cost = unit_cost``.
 * * Everything else falls back to a warning row and doesn't affect
 *   the total.
 *
 * ``label_claim_mg × servings_per_pack`` gives ``mg_per_pack``.
 * When servings_per_pack is unknown we fall back to ``× 1`` so the
 * number is at least the per-serving cost.
 */

import { Loader2, TrendingUp, X } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  useItemPrices,
  type ItemPriceDto,
} from "@/services/formulations";


const MASS_CONVERSION_TO_MG: Record<string, number> = {
  mg: 1,
  g: 1000,
  kg: 1_000_000,
};
const UNIT_UOMS = new Set(["unit", "each", "pcs", "pack", "piece", "ea"]);


//: Minimal line shape the calculator consumes. Matches a subset of
//: the builder's ``BuilderLine`` so anything the builder holds in
//: state can be passed through without extra plumbing.
export interface CostCalculatorLine {
  readonly key: string;
  readonly item_id: string;
  readonly item_name: string;
  readonly item_internal_code?: string | null;
  readonly item_psp_source_uuid: string | null;
  readonly label_claim_mg: string;
  readonly source_kind: "active" | "band_pick" | "manual";
  readonly band_key: string | null;
}


type SourceTag =
  //: Real money paid on a prior PO.
  | "po_history"
  //: Vendor-negotiated primary term (no PO yet).
  | "purchase_term"
  //: Semi-finished with no direct cost, priced by walking its own
  //: BOM on the PSP side. Every child was priced cleanly.
  | "bom_rollup"
  //: Same as ``bom_rollup`` but at least one child couldn't be
  //: priced — the sum is a partial best-guess, not the true cost.
  | "bom_rollup_partial"
  //: Line is a semi-finished item produced by another stage of this
  //: same project. Its cost is already inside the stage that emits
  //: it, so counting it again on the finished-product BOM would
  //: double it. Rendered as £0 with a "included in stage cost" note.
  | "own_project_stage"
  //: PSP-side row deleted / archived since the line was picked.
  | "psp_missing"
  //: Line item has no PSP mirror at all.
  | "no_psp_link"
  //: PSP has the item but no live purchase data of any kind.
  | "none";


interface DerivedRow {
  readonly key: string;
  readonly name: string;
  readonly code: string | null;
  readonly source: SourceTag;
  readonly unitCost: number | null;
  readonly currency: string | null;
  readonly uomSymbol: string | null;
  readonly vendorName: string | null;
  readonly linePerPackMg: number | null;
  readonly linePerPackCost: number | null;
  readonly note: string | null;
}


function derive(
  lines: readonly CostCalculatorLine[],
  pricesByUuid: Map<string, ItemPriceDto>,
  fetchedUuids: ReadonlySet<string>,
  ownProjectPspUuids: ReadonlySet<string>,
  servingsPerPack: number,
): {
  readonly derivedRows: readonly DerivedRow[];
  readonly total: number;
  readonly currency: string | null;
  readonly missing: number;
} {
  let total = 0;
  let currency: string | null = null;
  let missing = 0;

  const derivedRows: DerivedRow[] = lines.map((line) => {
    const claim = line.label_claim_mg
      ? Number(line.label_claim_mg)
      : null;
    const mgPerPack =
      claim !== null && Number.isFinite(claim)
        ? claim * (servingsPerPack || 1)
        : null;

    const psp = line.item_psp_source_uuid;
    const price = psp !== null ? pricesByUuid.get(psp) : undefined;
    const wasFetched = psp !== null ? fetchedUuids.has(psp) : false;
    const isOwnProjectStage =
      psp !== null && ownProjectPspUuids.has(psp);

    let source: SourceTag;
    let unitCostNumeric: number | null = null;
    let currencyForRow: string | null = null;
    let uom: string | null = null;
    let vendorName: string | null = null;
    let linePerPackCost: number | null = null;
    let note: string | null = null;

    if (isOwnProjectStage) {
      //: Semi-finished output of one of *this* project's stages —
      //: its cost is already inside that stage's BOM, so counting
      //: this line on the finished-product total would double-book.
      //: Render at £0 with a dedicated badge.
      source = "own_project_stage";
      note = "Included in stage cost";
      linePerPackCost = 0;
    } else if (psp === null) {
      source = "no_psp_link";
      note = "Not linked to PSP";
      missing += 1;
    } else if (price === undefined) {
      // Uuid was in the fetch batch but PSP returned nothing → the
      // item was archived / deleted on the PSP side. If it wasn't in
      // the batch yet, we're still loading its price.
      if (wasFetched) {
        source = "psp_missing";
        note = "Deleted on PSP";
        missing += 1;
      } else {
        source = "none";
        note = "Loading…";
      }
    } else {
      unitCostNumeric = price.unit_cost !== null ? Number(price.unit_cost) : null;
      currencyForRow = price.currency_code;
      uom = (price.uom_symbol || "").toLowerCase();
      vendorName = price.vendor_name;
      source = price.source;

      if (unitCostNumeric === null || source === "none") {
        source = "none";
        note = "No PSP purchase data";
        missing += 1;
      } else if (UNIT_UOMS.has(uom)) {
        linePerPackCost = unitCostNumeric;
      } else if (MASS_CONVERSION_TO_MG[uom]) {
        const conversion = MASS_CONVERSION_TO_MG[uom]!;
        if (mgPerPack !== null) {
          linePerPackCost = (mgPerPack / conversion) * unitCostNumeric;
        } else {
          note = "Missing per-serving mg";
          missing += 1;
        }
      } else {
        note = `Unsupported UoM: ${uom || "—"}`;
        missing += 1;
      }
    }

    if (linePerPackCost !== null) {
      total += linePerPackCost;
      if (currency === null && currencyForRow) currency = currencyForRow;
    }

    return {
      key: line.key,
      name: line.item_name || "?",
      code: line.item_internal_code ?? null,
      source,
      unitCost: unitCostNumeric,
      currency: currencyForRow,
      uomSymbol: price?.uom_symbol ?? null,
      vendorName,
      linePerPackMg: mgPerPack,
      linePerPackCost,
      note,
    };
  });

  const sortedRows = [...derivedRows].sort(
    (a, b) => (b.linePerPackCost ?? 0) - (a.linePerPackCost ?? 0),
  );
  return { derivedRows: sortedRows, total, currency, missing };
}


function formatMoney(value: number, currency: string | null): string {
  const ccy = currency || "GBP";
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: ccy,
      maximumFractionDigits: 4,
    }).format(value);
  } catch {
    return `${ccy} ${value.toFixed(4)}`;
  }
}


export function CostCalculator({
  orgId,
  formulationId,
  lines,
  servingsPerPack,
  ownProjectPspUuids,
  enabled = true,
}: {
  readonly orgId: string;
  readonly formulationId: string;
  //: Live builder lines — passed directly from FormulationBuilder so
  //: unsaved edits show up in the pill within the next paint.
  readonly lines: readonly CostCalculatorLine[];
  readonly servingsPerPack: number;
  //: PSP uuids that this project itself produces as semi-finished
  //: outputs (finished-product uuid + every stage's
  //: ``psp_semi_finished_uuid``). Lines pointing at any of these
  //: are treated as ``own_project_stage`` — their cost is already
  //: captured inside the stage's own BOM.
  readonly ownProjectPspUuids?: ReadonlySet<string>;
  readonly enabled?: boolean;
}) {
  const tCost = useTranslations("cost_calculator");

  //: Empty-set fallback so the derive() signature can accept a
  //: guaranteed-non-null Set without needing per-call default logic.
  const ownProjectSet = useMemo(
    () => ownProjectPspUuids ?? new Set<string>(),
    [ownProjectPspUuids],
  );

  //: Unique PSP uuids present on the live line set. Sorted so the
  //: query cache key stays stable regardless of line order. Skip
  //: any uuid this project itself produces — we know its cost is
  //: already captured in a stage BOM, so paying to price it again
  //: would just add wire noise + trigger a "no purchase data" chip
  //: on the PSP side for a semi-finished that has no direct term.
  const pspUuids = useMemo(() => {
    const set = new Set<string>();
    for (const line of lines) {
      const uuid = line.item_psp_source_uuid;
      if (uuid && !ownProjectSet.has(uuid)) set.add(uuid);
    }
    return [...set].sort();
  }, [lines, ownProjectSet]);

  const { data, isLoading, isFetching, error, refetch } = useItemPrices(
    orgId,
    formulationId,
    pspUuids,
    { enabled },
  );

  //: Uuid → price lookup + a "was fetched" set so a row that came
  //: back missing renders "psp_missing" while a row still loading
  //: renders "loading". Wrapped in useMemo so the derived rows only
  //: recompute when either input actually changes.
  const pricesByUuid = useMemo(() => {
    const map = new Map<string, ItemPriceDto>();
    for (const item of data?.items ?? []) {
      map.set(item.uuid, item);
    }
    return map;
  }, [data?.items]);

  const fetchedUuids = useMemo(() => {
    //: Every uuid we've *sent* the server in this fetch was
    //: considered by the query — anything missing from the
    //: response is truly gone on the PSP side.
    return new Set(pspUuids);
  }, [pspUuids]);

  const derived = useMemo(
    () =>
      derive(lines, pricesByUuid, fetchedUuids, ownProjectSet, servingsPerPack),
    [lines, pricesByUuid, fetchedUuids, ownProjectSet, servingsPerPack],
  );

  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null,
  );
  const dragOffsetRef = useRef<{ x: number; y: number } | null>(null);

  const storageKey = `vita.cost-calculator.pos.${formulationId}`;

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (
        typeof parsed?.x === "number" &&
        typeof parsed?.y === "number"
      ) {
        setPosition({ x: parsed.x, y: parsed.y });
      }
    } catch {
      // Malformed localStorage → user drags to reset.
    }
  }, [storageKey]);

  const totalLabel = useMemo(() => {
    if (data?.psp_configured === false) return tCost("pill.psp_not_ready");
    if (error) return tCost("pill.error");
    if (isLoading && derived.total === 0) return tCost("pill.loading");
    return formatMoney(derived.total, derived.currency);
  }, [
    isLoading,
    data?.psp_configured,
    error,
    derived.total,
    derived.currency,
    tCost,
  ]);

  const handleDragStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const eventTarget = event.target as HTMLElement | null;
      if (
        eventTarget !== null &&
        (eventTarget.closest("button") ||
          eventTarget.closest("[data-nodrag]"))
      ) {
        return;
      }
      const target = event.currentTarget.getBoundingClientRect();
      dragOffsetRef.current = {
        x: event.clientX - target.left,
        y: event.clientY - target.top,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );

  const handleDragMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (dragOffsetRef.current === null) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId) === false) {
        return;
      }
      const nextX = event.clientX - dragOffsetRef.current.x;
      const nextY = event.clientY - dragOffsetRef.current.y;
      const maxX = window.innerWidth - 60;
      const maxY = window.innerHeight - 60;
      setPosition({
        x: Math.max(0, Math.min(nextX, maxX)),
        y: Math.max(0, Math.min(nextY, maxY)),
      });
    },
    [],
  );

  const handleDragEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (dragOffsetRef.current === null) return;
      dragOffsetRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      if (position !== null && typeof window !== "undefined") {
        try {
          window.localStorage.setItem(
            storageKey,
            JSON.stringify(position),
          );
        } catch {
          // Storage quota / disabled — non-fatal.
        }
      }
    },
    [position, storageKey],
  );

  if (!enabled) return null;

  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center print:hidden">
        <button
          type="button"
          onClick={() => setIsOpen((prev) => !prev)}
          className="pointer-events-auto inline-flex items-center gap-2 rounded-full bg-ink-1000 px-4 py-2 text-sm font-semibold text-ink-0 shadow-lg ring-1 ring-ink-1000 transition-transform hover:-translate-y-0.5"
        >
          <TrendingUp className="h-4 w-4" />
          <span>{tCost("pill.label")}</span>
          <span
            className={`inline-flex items-center gap-1 rounded-full bg-ink-800 px-2 py-0.5 text-xs font-medium ${
              derived.missing > 0 ? "text-amber-300" : "text-emerald-300"
            }`}
          >
            {isFetching ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : null}
            {totalLabel}
          </span>
          {derived.missing > 0 ? (
            <span
              className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-200"
              title={tCost("pill.missing_hint", {
                count: derived.missing,
              })}
            >
              {derived.missing}
            </span>
          ) : null}
        </button>
      </div>

      {isOpen ? (
        <div
          className="pointer-events-auto fixed z-40 w-[min(560px,92vw)] rounded-2xl bg-ink-0 shadow-xl ring-1 ring-ink-200 print:hidden"
          style={
            position !== null
              ? { top: position.y, left: position.x }
              : {
                  bottom: 88,
                  left: "50%",
                  transform: "translateX(-50%)",
                }
          }
        >
          <div
            onPointerDown={handleDragStart}
            onPointerMove={handleDragMove}
            onPointerUp={handleDragEnd}
            className="flex cursor-move select-none items-center justify-between gap-2 border-b border-ink-200 px-4 py-3"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-semibold text-ink-1000">
                {tCost("card.title")}
              </span>
              <span className="text-xs text-ink-500">
                {tCost("card.per_pack")}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="rounded-full p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-900"
              aria-label={tCost("card.close")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
            {data?.psp_configured === false ? (
              <p className="text-sm text-ink-500">
                {tCost("card.psp_not_ready")}
              </p>
            ) : error ? (
              <div className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
                {tCost("card.error")}{" "}
                <button
                  type="button"
                  onClick={() => refetch()}
                  className="ml-2 underline"
                >
                  {tCost("card.retry")}
                </button>
              </div>
            ) : derived.derivedRows.length === 0 ? (
              <p className="py-6 text-center text-sm text-ink-500">
                {tCost("card.empty")}
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide text-ink-500">
                    <th className="py-1 pr-2">{tCost("card.col_item")}</th>
                    <th className="py-1 pr-2">{tCost("card.col_source")}</th>
                    <th className="py-1 pr-2 text-right">
                      {tCost("card.col_unit_price")}
                    </th>
                    <th className="py-1 pl-2 text-right">
                      {tCost("card.col_line_cost")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {derived.derivedRows.map((row) => (
                    <tr key={row.key}>
                      <td className="py-1.5 pr-2 align-top">
                        <div className="flex flex-col">
                          <span className="font-medium text-ink-1000">
                            {row.name}
                          </span>
                          {row.code ? (
                            <span className="text-xs text-ink-500">
                              {row.code}
                            </span>
                          ) : null}
                          {row.note ? (
                            <span className="text-xs text-amber-700">
                              {row.note}
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="py-1.5 pr-2 align-top">
                        <SourceBadge source={row.source} />
                        {row.vendorName ? (
                          <div className="text-[10px] text-ink-500">
                            {row.vendorName}
                          </div>
                        ) : null}
                      </td>
                      <td className="py-1.5 pr-2 align-top text-right tabular-nums text-ink-700">
                        {row.unitCost !== null
                          ? `${formatMoney(row.unitCost, row.currency)}${
                              row.uomSymbol ? ` / ${row.uomSymbol}` : ""
                            }`
                          : "—"}
                      </td>
                      <td className="py-1.5 pl-2 align-top text-right tabular-nums font-semibold text-ink-1000">
                        {row.linePerPackCost !== null
                          ? formatMoney(row.linePerPackCost, row.currency)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-ink-200">
                    <td colSpan={3} className="py-2 text-right text-xs uppercase tracking-wide text-ink-600">
                      {tCost("card.total")}
                    </td>
                    <td className="py-2 pl-2 text-right tabular-nums text-base font-semibold text-ink-1000">
                      {formatMoney(derived.total, derived.currency)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}


function SourceBadge({ source }: { source: SourceTag }) {
  const tCost = useTranslations("cost_calculator");
  const styles: Record<SourceTag, string> = {
    po_history: "bg-emerald-50 text-emerald-800 ring-emerald-200",
    purchase_term: "bg-sky-50 text-sky-800 ring-sky-200",
    bom_rollup: "bg-violet-50 text-violet-800 ring-violet-200",
    bom_rollup_partial: "bg-amber-50 text-amber-800 ring-amber-200",
    own_project_stage: "bg-indigo-50 text-indigo-800 ring-indigo-200",
    none: "bg-amber-50 text-amber-800 ring-amber-200",
    psp_missing: "bg-amber-50 text-amber-800 ring-amber-200",
    no_psp_link: "bg-ink-100 text-ink-700 ring-ink-200",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset ${styles[source]}`}
    >
      {tCost(`source.${source}` as "source.po_history")}
    </span>
  );
}
