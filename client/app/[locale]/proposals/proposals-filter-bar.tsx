"use client";

/**
 * Filter bar above the org-wide proposals list.
 *
 * Same two-tier state model as the projects bar:
 *
 * * **Applied** — URL-driven, what the backend actually filters by.
 *   Survives refresh and is shareable as a deep link.
 * * **Pending** — local React state. Every chip / date / search edit
 *   mutates pending only; no backend request fires until the user
 *   hits **Apply** (or Enter on any input). Apply batches every
 *   in-flight change into one navigation + one query.
 *
 * Keeping the projects + proposals bars in lock-step means a sales
 * rep moving between them sees the same controls in the same
 * places, and shared components (member picker, chip strip, apply
 * controls) carry the visual language.
 */

import {
  Calendar,
  ListFilter,
  RotateCcw,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";

import { MemberPicker } from "@/components/filters/member-picker";
import {
  PROPOSAL_STATUSES,
  type ProposalStatus,
} from "@/services/proposals";


const PARAM_KEYS = {
  search: "q",
  status: "status",
  salesPerson: "sales",
  validFrom: "valid_from",
  validTo: "valid_to",
} as const;

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;


export interface ProposalsFiltersState {
  readonly search: string;
  readonly statuses: readonly ProposalStatus[];
  readonly salesPersonId: string;
  readonly validUntilFrom: string;
  readonly validUntilTo: string;
}


function readFromParams(
  params: URLSearchParams | null,
): ProposalsFiltersState {
  const search = params?.get(PARAM_KEYS.search) ?? "";
  const allowed = new Set<ProposalStatus>(PROPOSAL_STATUSES);
  const statuses = (params?.getAll(PARAM_KEYS.status) ?? []).filter(
    (value): value is ProposalStatus => allowed.has(value as ProposalStatus),
  );
  const salesPersonId = params?.get(PARAM_KEYS.salesPerson) ?? "";
  const fromRaw = params?.get(PARAM_KEYS.validFrom) ?? "";
  const toRaw = params?.get(PARAM_KEYS.validTo) ?? "";
  const validUntilFrom = ISO_DATE_REGEX.test(fromRaw) ? fromRaw : "";
  const validUntilTo = ISO_DATE_REGEX.test(toRaw) ? toRaw : "";
  return { search, statuses, salesPersonId, validUntilFrom, validUntilTo };
}


function statesEqual(a: ProposalsFiltersState, b: ProposalsFiltersState): boolean {
  if (a.search !== b.search) return false;
  if (a.salesPersonId !== b.salesPersonId) return false;
  if (a.validUntilFrom !== b.validUntilFrom) return false;
  if (a.validUntilTo !== b.validUntilTo) return false;
  if (a.statuses.length !== b.statuses.length) return false;
  for (const s of a.statuses) if (!b.statuses.includes(s)) return false;
  return true;
}


function activeCountFor(state: ProposalsFiltersState): number {
  return (
    (state.search ? 1 : 0) +
    (state.statuses.length > 0 ? 1 : 0) +
    (state.salesPersonId ? 1 : 0) +
    (state.validUntilFrom || state.validUntilTo ? 1 : 0)
  );
}


export function useProposalsFiltersState() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const applied = useMemo(
    () => readFromParams(params as unknown as URLSearchParams | null),
    [params],
  );
  const [pending, setPending] = useState<ProposalsFiltersState>(applied);

  const lastSyncedAppliedRef = useRef<ProposalsFiltersState>(applied);
  useEffect(() => {
    if (statesEqual(lastSyncedAppliedRef.current, applied)) return;
    lastSyncedAppliedRef.current = applied;
    setPending(applied);
  }, [applied]);

  const writeApplied = useCallback(
    (next: ProposalsFiltersState) => {
      const params = new URLSearchParams();
      if (next.search) params.set(PARAM_KEYS.search, next.search);
      for (const s of next.statuses) params.append(PARAM_KEYS.status, s);
      if (next.salesPersonId)
        params.set(PARAM_KEYS.salesPerson, next.salesPersonId);
      if (next.validUntilFrom && ISO_DATE_REGEX.test(next.validUntilFrom)) {
        params.set(PARAM_KEYS.validFrom, next.validUntilFrom);
      }
      if (next.validUntilTo && ISO_DATE_REGEX.test(next.validUntilTo)) {
        params.set(PARAM_KEYS.validTo, next.validUntilTo);
      }
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    },
    [pathname, router],
  );

  const setSearch = useCallback(
    (value: string) =>
      setPending((p) => ({ ...p, search: value.trimStart() })),
    [],
  );
  const toggleStatus = useCallback(
    (value: ProposalStatus) =>
      setPending((p) => {
        const has = p.statuses.includes(value);
        return {
          ...p,
          statuses: has
            ? p.statuses.filter((v) => v !== value)
            : [...p.statuses, value],
        };
      }),
    [],
  );
  const setStatuses = useCallback(
    (values: readonly ProposalStatus[]) =>
      setPending((p) => ({ ...p, statuses: values })),
    [],
  );
  const setSalesPersonId = useCallback(
    (value: string) => setPending((p) => ({ ...p, salesPersonId: value })),
    [],
  );
  const setValidUntilFrom = useCallback(
    (value: string) => setPending((p) => ({ ...p, validUntilFrom: value })),
    [],
  );
  const setValidUntilTo = useCallback(
    (value: string) => setPending((p) => ({ ...p, validUntilTo: value })),
    [],
  );

  const apply = useCallback(() => {
    const normalised: ProposalsFiltersState = {
      ...pending,
      search: pending.search.trim(),
    };
    writeApplied(normalised);
    setPending(normalised);
  }, [pending, writeApplied]);

  const reset = useCallback(() => setPending(applied), [applied]);

  const clearAll = useCallback(() => {
    const empty: ProposalsFiltersState = {
      search: "",
      statuses: [],
      salesPersonId: "",
      validUntilFrom: "",
      validUntilTo: "",
    };
    setPending(empty);
    writeApplied(empty);
  }, [writeApplied]);

  const dirty = !statesEqual(pending, applied);
  const appliedActiveCount = activeCountFor(applied);
  const appliedAnyActive = appliedActiveCount > 0;

  return {
    applied,
    pending,
    dirty,
    appliedActiveCount,
    appliedAnyActive,
    setSearch,
    toggleStatus,
    setStatuses,
    setSalesPersonId,
    setValidUntilFrom,
    setValidUntilTo,
    apply,
    reset,
    clearAll,
  };
}


export type ProposalsFiltersHandle = ReturnType<typeof useProposalsFiltersState>;


export function ProposalsFilterBar({
  orgId,
  filters,
}: {
  orgId: string;
  filters: ProposalsFiltersHandle;
}) {
  const t = useTranslations("proposals");
  // Reuse the project filter copy where it makes sense (sales
  // person, status legend, clear-all, apply/reset) so the two bars
  // speak with one voice.
  const tFormulations = useTranslations("formulations");

  const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Enter" && filters.dirty) {
      e.preventDefault();
      filters.apply();
    }
  };

  const pending = filters.pending;
  const statusActive = pending.statuses.length;
  const dateActive = pending.validUntilFrom || pending.validUntilTo ? 1 : 0;

  return (
    <div
      className="rounded-2xl bg-ink-0 shadow-sm ring-1 ring-ink-200"
      onKeyDown={handleKeyDown}
    >
      <div className="flex flex-col gap-3 p-3 sm:p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-2">
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400"
              aria-hidden
            />
            <input
              type="search"
              value={pending.search}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                filters.setSearch(e.target.value)
              }
              placeholder={t("filters.search_placeholder")}
              aria-label={t("filters.search_placeholder")}
              className="h-10 w-full rounded-xl bg-ink-50 pl-9 pr-9 text-sm text-ink-1000 ring-1 ring-inset ring-transparent placeholder:text-ink-400 focus:bg-ink-0 focus:outline-none focus:ring-orange-400"
            />
            {pending.search ? (
              <button
                type="button"
                onClick={() => filters.setSearch("")}
                aria-label={t("filters.search_clear")}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-1000"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>

          <MemberPicker
            orgId={orgId}
            value={pending.salesPersonId}
            onChange={filters.setSalesPersonId}
            label={tFormulations("filters.sales_person_label")}
            allLabel={tFormulations("filters.sales_person_all")}
            unassignedLabel={tFormulations("filters.sales_person_unassigned")}
            searchPlaceholder={tFormulations(
              "filters.sales_person_search_placeholder",
            )}
            emptyHint={tFormulations("filters.sales_person_no_matches")}
            group="sales"
          />

          {/* Right-rail action cluster — always rendered so the bar's
           *  geometry stays stable. Apply uses a disabled style when
           *  there's nothing to commit; Reset / Clear use
           *  ``invisible`` to keep their slot widths when they don't
           *  apply. See the projects bar for the same pattern. */}
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              onClick={filters.apply}
              disabled={!filters.dirty}
              className={`inline-flex h-10 items-center gap-1.5 rounded-xl px-3 text-sm font-medium shadow-sm transition-colors ${
                filters.dirty
                  ? "bg-orange-500 text-ink-0 hover:bg-orange-600"
                  : "bg-ink-50 text-ink-400 ring-1 ring-inset ring-ink-200"
              }`}
            >
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
              {tFormulations("filters.apply")}
            </button>
            <button
              type="button"
              onClick={filters.reset}
              aria-label={tFormulations("filters.reset")}
              title={tFormulations("filters.reset")}
              aria-hidden={!filters.dirty}
              tabIndex={filters.dirty ? 0 : -1}
              className={`inline-flex h-10 items-center justify-center rounded-xl px-2 text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-1000 ${
                filters.dirty ? "" : "invisible"
              }`}
            >
              <RotateCcw className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={filters.clearAll}
              title={tFormulations("filters.clear_all_tooltip")}
              aria-hidden={!filters.appliedAnyActive}
              tabIndex={filters.appliedAnyActive ? 0 : -1}
              className={`inline-flex h-10 items-center gap-1.5 rounded-xl px-3 text-xs font-medium text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-1000 ${
                filters.appliedAnyActive ? "" : "invisible"
              }`}
            >
              <X className="h-3.5 w-3.5" />
              {tFormulations("filters.clear_all", {
                count: Math.max(filters.appliedActiveCount, 1),
              })}
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center lg:gap-x-6 lg:gap-y-2">
          {/* Status chip strip — legend stays the same size whether
           *  or not the dimension has active selections; only colour
           *  + a hidden-but-spaced count/✕ change. */}
          <fieldset className="flex flex-wrap items-center gap-1.5">
            <StableLegend
              icon={<ListFilter className="h-3 w-3" aria-hidden />}
              label={tFormulations("filters.status_legend")}
              activeCount={statusActive}
              onClear={() => filters.setStatuses([])}
              clearLabel={tFormulations("filters.clear_dimension")}
            />
            {PROPOSAL_STATUSES.map((s) => {
              const active = pending.statuses.includes(s);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => filters.toggleStatus(s)}
                  aria-pressed={active}
                  className={`inline-flex h-7 items-center rounded-full px-2.5 text-[11px] font-medium transition-colors ${
                    active
                      ? "bg-orange-500 text-ink-0 shadow-sm ring-1 ring-inset ring-orange-500"
                      : "bg-ink-50 text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-100 hover:ring-ink-300"
                  }`}
                >
                  {t(`status.${s}` as "status.draft")}
                </button>
              );
            })}
          </fieldset>

          {/* Valid-until date range */}
          <fieldset className="flex flex-wrap items-center gap-1.5">
            <StableLegend
              icon={<Calendar className="h-3 w-3" aria-hidden />}
              label={t("filters.valid_until_legend")}
              activeCount={dateActive}
              onClear={() => {
                filters.setValidUntilFrom("");
                filters.setValidUntilTo("");
              }}
              clearLabel={tFormulations("filters.clear_dimension")}
              hideCountBadge
            />
            <input
              type="date"
              value={pending.validUntilFrom}
              onChange={(e) => filters.setValidUntilFrom(e.target.value)}
              aria-label={t("filters.valid_until_from")}
              className="h-7 rounded-lg bg-ink-50 px-2 text-xs text-ink-1000 ring-1 ring-inset ring-transparent focus:bg-ink-0 focus:outline-none focus:ring-orange-400"
            />
            <span className="text-[11px] text-ink-400">
              {t("filters.valid_until_separator")}
            </span>
            <input
              type="date"
              value={pending.validUntilTo}
              onChange={(e) => filters.setValidUntilTo(e.target.value)}
              aria-label={t("filters.valid_until_to")}
              className="h-7 rounded-lg bg-ink-50 px-2 text-xs text-ink-1000 ring-1 ring-inset ring-transparent focus:bg-ink-0 focus:outline-none focus:ring-orange-400"
            />
          </fieldset>
        </div>
      </div>
    </div>
  );
}


/**
 * Section legend that doesn't shift the row's geometry when the
 * dimension flips between "no selection" and "N selected". Always
 * renders the icon, label, count badge, and clear ✕ — the count and
 * ✕ are ``invisible`` when inactive so they keep their slot widths
 * but don't render. Clicking the pill clears the dimension when
 * active.
 */
function StableLegend({
  icon,
  label,
  activeCount,
  onClear,
  clearLabel,
  hideCountBadge = false,
}: {
  icon: React.ReactNode;
  label: string;
  activeCount: number;
  onClear: () => void;
  clearLabel: string;
  hideCountBadge?: boolean;
}) {
  const isFiltering = activeCount > 0;
  return (
    <span
      role={isFiltering ? "button" : undefined}
      tabIndex={isFiltering ? 0 : -1}
      onClick={() => {
        if (isFiltering) onClear();
      }}
      onKeyDown={(e) => {
        if (!isFiltering) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClear();
        }
      }}
      aria-label={isFiltering ? clearLabel : undefined}
      className={`mr-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ring-1 ring-inset transition-colors ${
        isFiltering
          ? "cursor-pointer bg-orange-50 text-orange-700 ring-orange-200 hover:bg-orange-100"
          : "cursor-default bg-transparent text-ink-500 ring-transparent"
      }`}
    >
      {icon}
      {label}
      {hideCountBadge ? null : (
        <span
          className={`rounded-full bg-orange-500 px-1.5 text-[10px] leading-4 text-ink-0 ${
            isFiltering ? "" : "invisible"
          }`}
          aria-hidden={!isFiltering}
        >
          {activeCount || 1}
        </span>
      )}
      <X
        className={`h-3 w-3 ${isFiltering ? "" : "invisible"}`}
        aria-hidden
      />
    </span>
  );
}
