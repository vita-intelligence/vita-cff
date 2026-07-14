"use client";

/**
 * PSP suggested-price hint.
 *
 * Structural twin of :class:`MrpeasyPriceHint`. Renders next to a
 * unit-price input on:
 *   * the director's spec-approval modal,
 *   * the org-wide proposal create modal,
 *   * the /signed page's spec-to-proposal modal,
 *   * the proposal-detail per-line price column.
 *
 * Three terminal states:
 *
 * * **Match** — shows ``PSP: <currency> <selling_price>`` with a
 *   small "Use" button that copies the value into the host
 *   surface's price input via ``onAutofill``.
 * * **No match** — shows ``No PSP match for <code>``. Honest
 *   signal beats a silent hide.
 * * **Off** — render nothing. The org doesn't have PSP live.
 *
 * PSP items are keyed by UUID server-side; the host form only
 * stores the ``code`` (== PSP ``external_sku`` in the picker
 * flow), so we resolve back to an item by hitting the search
 * endpoint with the code. First match wins.
 */

import { Sparkles } from "lucide-react";
import { useMemo } from "react";

import { useOrganization } from "@/services/organizations";
import { usePspItems } from "@/services/psp";


export function PspPriceHint({
  orgId,
  code,
  currency,
  onAutofill,
  className = "",
}: {
  readonly orgId: string;
  /** ``Formulation.code`` (== PSP ``external_sku``). Empty string
   *  disables the query so we don't fire during early modal state. */
  readonly code: string;
  /** ISO 4217 currency code the host surface prefers. Ignored when
   *  the PSP row carries its own ``currency_code`` (PSP is the
   *  source of truth for the price → currency pair). */
  readonly currency?: string;
  readonly onAutofill?: (price: string) => void;
  readonly className?: string;
}) {
  const organization = useOrganization(orgId);
  const live = Boolean(organization?.psp_live);

  const cleanedCode = code.trim();
  const query = usePspItems(orgId, {
    enabled: live && Boolean(cleanedCode),
    search: cleanedCode,
  });

  // Best-match resolution: find a row whose external_sku matches
  // the code exactly first (the case that maps 1:1 with the
  // MRPEasy semantics); fall back to the first row when the
  // server returned any result, so partial-typed codes still
  // surface a reasonable hint.
  const item = useMemo(() => {
    const items = query.data?.items ?? [];
    if (items.length === 0) return null;
    const exact = items.find((i) => i.external_sku === cleanedCode);
    return exact ?? items[0];
  }, [query.data, cleanedCode]);

  if (!live || !cleanedCode) return null;

  if (query.isLoading) {
    return (
      <div
        className={`inline-flex items-center gap-1.5 rounded-md bg-orange-50 px-2 py-1 text-[10px] font-medium text-orange-800 ring-1 ring-inset ring-orange-200 ${className}`}
        role="status"
      >
        <Sparkles className="h-3 w-3 animate-pulse" />
        <span>Checking PSP…</span>
      </div>
    );
  }

  if (query.isError || !item || !item.selling_price) {
    return (
      <div
        className={`inline-flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-[10px] font-medium text-amber-800 ring-1 ring-inset ring-amber-200 ${className}`}
      >
        <Sparkles className="h-3 w-3" />
        <span>No PSP match for {cleanedCode}</span>
      </div>
    );
  }

  const price = item.selling_price;
  // PSP's currency wins when present — the price + currency pair
  // is snapshotted together on the pricelist row. Fall back to
  // whatever the host surface prefers (usually the proposal /
  // spec's own currency) if PSP returned null.
  const displayCurrency = (item.currency_code || currency || "GBP").toUpperCase();
  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-md bg-orange-50 px-2 py-1 text-[10px] font-medium text-orange-900 ring-1 ring-inset ring-orange-200 ${className}`}
    >
      <Sparkles className="h-3 w-3 text-orange-700" />
      <span className="tabular-nums">
        PSP: {displayCurrency} {price}
      </span>
      {onAutofill ? (
        <button
          type="button"
          onClick={() => onAutofill(price)}
          className="rounded bg-orange-600 px-1.5 py-0.5 text-[10px] font-semibold text-white hover:bg-orange-700"
        >
          Use
        </button>
      ) : null}
    </div>
  );
}
