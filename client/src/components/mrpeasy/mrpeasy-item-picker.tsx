"use client";

import { Boxes, Loader2, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { useMrpeasyItems, type MrpeasyItemDto } from "@/services/mrpeasy";
import { useOrganization } from "@/services/organizations";

/**
 * MRPEasy item picker — button-triggered search.
 *
 * The operator types a query (code or product name) and clicks
 * "Search" (or hits Enter). The backend pulls up to 500 items from
 * MRPEasy and the component filters that list client-side against
 * the typed string. One round-trip per search burst rather than
 * one per keystroke.
 *
 * Why explicit Search instead of debounced typeahead:
 *   * MRPEasy's ``/items`` endpoint has a 100-row per-request cap;
 *     fetching the full catalogue takes multiple round-trips, so
 *     firing on every keystroke would be wasteful.
 *   * Manual click matches the operator's mental model — "I'm
 *     looking up THIS thing now" — which is what they asked for.
 *
 * Render gate: when the org doesn't have MRPEasy live, the
 * component renders nothing — the host form falls through to the
 * existing manual-entry path.
 */

// Cap on rows shown in the dropdown. The fetched list itself can be
// up to 500 items; filtering down further keeps the dropdown
// scannable without forcing the operator to scroll.
const MAX_RESULTS = 25;

export function MrpeasyItemPicker({
  orgId,
  onPick,
}: {
  readonly orgId: string;
  readonly onPick: (item: MrpeasyItemDto) => void;
}) {
  const tFormulations = useTranslations("formulations");
  const organization = useOrganization(orgId);
  const live = Boolean(organization?.mrpeasy_live);

  const [search, setSearch] = useState("");
  // ``committedQuery`` is what we filter against — only changes
  // when the operator hits Search / Enter, not on every keystroke.
  // This gives the operator a stable result set they can scan
  // without it shifting underneath them while typing.
  const [committedQuery, setCommittedQuery] = useState("");
  // Gates the underlying TanStack query — we don't want to fire a
  // (potentially 5-page-paginated) MRPEasy fetch just because the
  // modal opened. Only fire after the operator says "go".
  const [hasSearched, setHasSearched] = useState(false);

  // Filtering happens server-side now (MRPEasy ``code`` exact +
  // ``title`` partial). The hook re-runs whenever ``search``
  // changes, but we only flip it from the empty string after the
  // operator clicks Search — so re-rendering the host form while
  // typing doesn't trigger a fetch.
  const itemsQuery = useMrpeasyItems(orgId, {
    enabled: live && hasSearched,
    search: committedQuery,
  });

  const matches = useMemo(() => {
    const items = itemsQuery.data?.items ?? [];
    return items.slice(0, MAX_RESULTS);
  }, [itemsQuery.data]);

  const trimmedSearch = search.trim();
  const canSearch = trimmedSearch.length > 0 && !itemsQuery.isFetching;

  const handleSearch = () => {
    if (!canSearch) return;
    setCommittedQuery(trimmedSearch);
    setHasSearched(true);
  };

  const handlePick = (item: MrpeasyItemDto) => {
    onPick(item);
    setSearch("");
    setCommittedQuery("");
    setHasSearched(false);
  };

  if (!live) return null;

  const showResults = hasSearched && committedQuery.length > 0;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-xs font-medium text-ink-700">
        <Boxes className="h-3.5 w-3.5 text-blue-700" />
        {tFormulations("mrpeasy_picker.label")}
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
                // Suppress the default form-submit so hitting Enter
                // inside the picker triggers the lookup instead of
                // posting the host new-project form prematurely.
                e.preventDefault();
                handleSearch();
              }
            }}
            placeholder={tFormulations("mrpeasy_picker.placeholder")}
            className="w-full rounded-lg bg-ink-0 pl-9 pr-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          />
        </div>
        <button
          type="button"
          onClick={handleSearch}
          disabled={!canSearch}
          className="flex items-center gap-1.5 rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-ink-300"
        >
          {itemsQuery.isFetching ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Search className="h-4 w-4" />
          )}
          {tFormulations("mrpeasy_picker.search_button")}
        </button>
      </div>

      {showResults ? (
        <div className="mt-1 max-h-72 overflow-y-auto rounded-lg bg-ink-0 shadow-sm ring-1 ring-inset ring-ink-200">
          {itemsQuery.isFetching ? (
            <div className="px-3 py-3 text-xs text-ink-500">
              {tFormulations("mrpeasy_picker.loading")}
            </div>
          ) : matches.length === 0 ? (
            <div className="px-3 py-3 text-xs text-ink-500">
              {tFormulations("mrpeasy_picker.empty_results")}
            </div>
          ) : (
            matches.map((item) => (
              <button
                key={item.code}
                type="button"
                onClick={() => handlePick(item)}
                className="flex w-full flex-col items-start gap-0.5 border-b border-ink-100 px-3 py-2 text-left last:border-b-0 hover:bg-blue-50"
              >
                <span className="text-sm font-medium text-ink-1000">
                  {item.code}
                  <span className="ml-2 text-ink-500">{item.title}</span>
                </span>
                {item.selling_price ? (
                  <span className="text-[11px] text-ink-500">
                    {tFormulations("mrpeasy_picker.price", {
                      price: item.selling_price,
                    })}
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
      ) : null}

      <span className="text-[11px] text-ink-500">
        {tFormulations("mrpeasy_picker.hint")}
      </span>
    </div>
  );
}
