"use client";

/**
 * PSP item picker — button-triggered search.
 *
 * Same UX shape as :class:`MrpeasyItemPicker`: the operator types a
 * query and clicks Search, and the backend returns matching items
 * from PSP. Click a row → the host form auto-fills its code + name
 * inputs from the picked item.
 *
 * Self-gates on ``organization.psp_live`` — renders nothing when
 * the integration isn't active, so the host form falls through to
 * the manual-entry path (or the MRPEasy picker if that's live
 * instead). The two integrations are mutually exclusive
 * server-side, so at most one picker ever renders.
 *
 * PSP items are looked up on the wire by UUID, but the host form
 * stores ``Formulation.code`` as the identifier. We use
 * ``external_sku`` (falling back to the UUID) so subsequent
 * price-hint lookups on the same code find the item again — the
 * same key semantics MRPEasy uses.
 */

import { Boxes, Loader2, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { usePspItems, type PspItemDto } from "@/services/psp";
import { useOrganization } from "@/services/organizations";


/** Wire shape the host form consumes. Mirrors ``MrpeasyItemDto``'s
 *  ``code`` + ``title`` contract so a shared form component can be
 *  fed by either picker without branching on source. */
export interface PspItemPickResult {
  readonly code: string;
  readonly title: string;
  /** Kept for consumers that want the strict PSP identity (e.g. a
   *  deep-link back to the item). Not used by the new-formulation
   *  form which only stores ``code`` + ``name``. */
  readonly uuid: string;
}


// Cap on rows shown in the dropdown. PSP returns everything active
// so a large catalogue would flood the panel; the picker filters
// server-side by ``search``, and we further cap here.
const MAX_RESULTS = 25;


export function PspItemPicker({
  orgId,
  onPick,
  itemTypes,
}: {
  readonly orgId: string;
  readonly onPick: (item: PspItemPickResult) => void;
  /** Optional PSP-side ``item_types`` filter. Defaults to
   *  ``finished_product`` for the new-project surface — the
   *  formulation IS a finished product, so we scope the picker to
   *  that type by default. Callers on other surfaces (e.g. the
   *  builder's raw-materials picker) will pass their own filter. */
  readonly itemTypes?: readonly string[];
}) {
  const organization = useOrganization(orgId);
  const live = Boolean(organization?.psp_live);

  const [search, setSearch] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");
  const [hasSearched, setHasSearched] = useState(false);

  const itemsQuery = usePspItems(orgId, {
    enabled: live && hasSearched,
    search: committedQuery,
    itemTypes: itemTypes ?? ["finished_product"],
  });

  const matches = useMemo(() => {
    const items = itemsQuery.data?.items ?? [];
    return items.slice(0, MAX_RESULTS);
  }, [itemsQuery.data]);

  const trimmedSearch = search.trim();
  const canSearch =
    trimmedSearch.length > 0 && !itemsQuery.isFetching;

  const handleSearch = () => {
    if (!canSearch) return;
    setCommittedQuery(trimmedSearch);
    setHasSearched(true);
  };

  const handlePick = (item: PspItemDto) => {
    // The host form stores ``code`` — reuse PSP's ``external_sku``
    // when the row carries one, else fall back to the UUID so a
    // later price-hint lookup on the same code still has something
    // deterministic to match against. Falling back to a raw UUID
    // reads oddly in the code column but preserves lookup
    // continuity for orgs that haven't populated ``external_sku``
    // on every row yet.
    const code = item.external_sku || item.uuid;
    onPick({ code, title: item.name, uuid: item.uuid });
    setSearch("");
    setCommittedQuery("");
    setHasSearched(false);
  };

  if (!live) return null;

  const showResults = hasSearched && committedQuery.length > 0;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-xs font-medium text-ink-700">
        <Boxes className="h-3.5 w-3.5 text-orange-700" />
        Pick from PSP catalogue
      </span>
      <div className="flex items-stretch gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                // Same trick as MRPEasy: suppress the default
                // form submit so Enter triggers the lookup, not
                // a premature host-form POST.
                e.preventDefault();
                handleSearch();
              }
            }}
            placeholder="Search PSP items by name, SKU, or barcode…"
            className="w-full rounded-lg bg-ink-0 pl-9 pr-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          />
        </div>
        <button
          type="button"
          onClick={handleSearch}
          disabled={!canSearch}
          className="flex items-center gap-1.5 rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:bg-ink-300"
        >
          {itemsQuery.isFetching ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Search className="h-4 w-4" />
          )}
          Search
        </button>
      </div>

      {showResults ? (
        <div className="mt-1 max-h-72 overflow-y-auto rounded-lg bg-ink-0 shadow-sm ring-1 ring-inset ring-ink-200">
          {itemsQuery.isFetching ? (
            <div className="px-3 py-3 text-xs text-ink-500">
              Searching PSP…
            </div>
          ) : matches.length === 0 ? (
            <div className="px-3 py-3 text-xs text-ink-500">
              No PSP items matched.
            </div>
          ) : (
            matches.map((item) => (
              <button
                key={item.uuid}
                type="button"
                onClick={() => handlePick(item)}
                className="flex w-full flex-col items-start gap-0.5 border-b border-ink-100 px-3 py-2 text-left last:border-b-0 hover:bg-orange-50"
              >
                <span className="text-sm font-medium text-ink-1000">
                  {item.external_sku || item.uuid.slice(0, 8)}
                  <span className="ml-2 text-ink-500">{item.name}</span>
                </span>
                {item.selling_price ? (
                  <span className="text-[11px] text-ink-500">
                    {item.currency_code ?? ""} {item.selling_price}
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
      ) : null}

      <span className="text-[11px] text-ink-500">
        Picks a Ready-to-Go recipe from PSP and auto-fills the code
        + name below.
      </span>
    </div>
  );
}
