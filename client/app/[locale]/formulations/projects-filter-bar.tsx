"use client";

/**
 * Filter bar above the projects table.
 *
 * Two-tier state model:
 *
 * * **Applied** — what the backend is actually filtered by. Lives in
 *   the URL so deep links and refresh round-trip. The parent table
 *   reads this for its TanStack Query call.
 * * **Pending** — what the user is currently editing in the bar.
 *   Held in local React state. Every chip / dropdown / search /
 *   date change mutates pending instantly so the UI feels live, but
 *   no backend request fires until the user hits **Apply** (or
 *   presses Enter in any input). The Reset button reverts pending
 *   back to the currently-applied state.
 *
 * Visual contract:
 *
 * * Chips show the *pending* selection. Anything in pending that
 *   differs from applied is technically a "draft" but the bar makes
 *   no distinction — the only signal that there's work to commit is
 *   the Apply button lighting up.
 * * URL updates exactly once per Apply, batching all the chips +
 *   text + date changes into a single navigation + single query.
 */

import { ListFilter, RotateCcw, Search, Sparkles, X } from "lucide-react";
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
  PROJECT_STATUSES,
  PROJECT_TYPES,
  type ProjectStatus,
  type ProjectType,
} from "@/services/formulations";


const PARAM_KEYS = {
  search: "q",
  status: "status",
  salesPerson: "sales",
  projectType: "type",
} as const;


export interface ProjectsFiltersState {
  readonly search: string;
  readonly statuses: readonly ProjectStatus[];
  readonly salesPersonId: string;
  readonly projectType: ProjectType | "";
}


function readFromParams(
  params: URLSearchParams | null,
): ProjectsFiltersState {
  const search = params?.get(PARAM_KEYS.search) ?? "";
  const allowed = new Set<ProjectStatus>(PROJECT_STATUSES);
  const statuses = (params?.getAll(PARAM_KEYS.status) ?? []).filter(
    (value): value is ProjectStatus => allowed.has(value as ProjectStatus),
  );
  const salesPersonId = params?.get(PARAM_KEYS.salesPerson) ?? "";
  const projectTypeRaw = params?.get(PARAM_KEYS.projectType) ?? "";
  const projectType: ProjectType | "" =
    projectTypeRaw && PROJECT_TYPES.includes(projectTypeRaw as ProjectType)
      ? (projectTypeRaw as ProjectType)
      : "";
  return { search, statuses, salesPersonId, projectType };
}


function statesEqual(a: ProjectsFiltersState, b: ProjectsFiltersState): boolean {
  if (a.search !== b.search) return false;
  if (a.salesPersonId !== b.salesPersonId) return false;
  if (a.projectType !== b.projectType) return false;
  if (a.statuses.length !== b.statuses.length) return false;
  // Order-insensitive — chip toggle order shouldn't fake a dirty
  // state. Statuses arrays are short, so the O(n²) check is fine.
  for (const s of a.statuses) if (!b.statuses.includes(s)) return false;
  return true;
}


function activeCountFor(state: ProjectsFiltersState): number {
  return (
    (state.search ? 1 : 0) +
    (state.statuses.length > 0 ? 1 : 0) +
    (state.salesPersonId ? 1 : 0) +
    (state.projectType ? 1 : 0)
  );
}


export function useProjectsFiltersState() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  // ``applied`` derives from the URL — authoritative for the
  // backend query. ``pending`` is local state seeded from applied;
  // chip / search edits mutate pending only, and ``apply`` flushes
  // pending back into the URL (and therefore into applied).
  const applied = useMemo(
    () => readFromParams(params as unknown as URLSearchParams | null),
    [params],
  );
  const [pending, setPending] = useState<ProjectsFiltersState>(applied);

  // When the URL changes externally (back/forward nav, an Apply
  // from elsewhere), re-seed pending. We do this through a ref so
  // typing during a Suspense boundary won't get clobbered by the
  // initial mount's effect.
  const lastSyncedAppliedRef = useRef<ProjectsFiltersState>(applied);
  useEffect(() => {
    if (statesEqual(lastSyncedAppliedRef.current, applied)) return;
    lastSyncedAppliedRef.current = applied;
    setPending(applied);
  }, [applied]);

  const writeApplied = useCallback(
    (next: ProjectsFiltersState) => {
      const params = new URLSearchParams();
      if (next.search) params.set(PARAM_KEYS.search, next.search);
      for (const s of next.statuses) params.append(PARAM_KEYS.status, s);
      if (next.salesPersonId)
        params.set(PARAM_KEYS.salesPerson, next.salesPersonId);
      if (next.projectType)
        params.set(PARAM_KEYS.projectType, next.projectType);
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
    (value: ProjectStatus) =>
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
    (values: readonly ProjectStatus[]) =>
      setPending((p) => ({ ...p, statuses: values })),
    [],
  );
  const setSalesPersonId = useCallback(
    (value: string) => setPending((p) => ({ ...p, salesPersonId: value })),
    [],
  );
  const setProjectType = useCallback(
    (value: ProjectType | "") =>
      setPending((p) => ({ ...p, projectType: value })),
    [],
  );

  const apply = useCallback(() => {
    const normalised: ProjectsFiltersState = {
      ...pending,
      search: pending.search.trim(),
    };
    writeApplied(normalised);
    setPending(normalised);
  }, [pending, writeApplied]);

  const reset = useCallback(() => setPending(applied), [applied]);

  const clearAll = useCallback(() => {
    const empty: ProjectsFiltersState = {
      search: "",
      statuses: [],
      salesPersonId: "",
      projectType: "",
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
    setProjectType,
    apply,
    reset,
    clearAll,
  };
}


export type ProjectsFiltersHandle = ReturnType<typeof useProjectsFiltersState>;


export function ProjectsFilterBar({
  orgId,
  filters,
}: {
  orgId: string;
  filters: ProjectsFiltersHandle;
}) {
  const t = useTranslations("formulations");
  const tProject = useTranslations("project_overview");

  // Enter anywhere in the bar = apply. Chips, the date inputs, and
  // the search box all share this handler so users can drive
  // commits from the keyboard without hunting for the Apply button.
  const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Enter" && filters.dirty) {
      e.preventDefault();
      filters.apply();
    }
  };

  const pending = filters.pending;

  return (
    // No ``overflow-hidden`` on the outer wrapper — the member picker
    // renders an absolutely-positioned dropdown panel that must
    // escape this card's box. The corners stay rounded via the inner
    // padding; the panel's own rounded corners + shadow give it a
    // sharp visual edge regardless.
    <div
      className="rounded-2xl bg-ink-0 shadow-sm ring-1 ring-ink-200"
      onKeyDown={handleKeyDown}
    >
      <div className="flex flex-col gap-3 p-3 sm:p-4">
        {/* ── Search + sales picker + Apply / Reset ──────────── */}
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
              placeholder={t("search_placeholder")}
              aria-label={t("search_placeholder")}
              className="h-10 w-full rounded-xl bg-ink-50 pl-9 pr-9 text-sm text-ink-1000 ring-1 ring-inset ring-transparent placeholder:text-ink-400 focus:bg-ink-0 focus:outline-none focus:ring-orange-400"
            />
            {pending.search ? (
              <button
                type="button"
                onClick={() => filters.setSearch("")}
                aria-label={t("search_clear")}
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
            label={t("filters.sales_person_label")}
            allLabel={t("filters.sales_person_all")}
            unassignedLabel={t("filters.sales_person_unassigned")}
            searchPlaceholder={t("filters.sales_person_search_placeholder")}
            emptyHint={t("filters.sales_person_no_matches")}
            group="sales"
          />

          {/* Right-rail action cluster. The Apply button is ALWAYS
           *  rendered so the bar's right edge doesn't jump when
           *  pending changes appear / disappear — disabled state
           *  carries the "nothing to apply" signal instead. Reset
           *  and Clear use ``invisible`` so they keep their slot
           *  width without showing the control. */}
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
              {t("filters.apply")}
            </button>
            <button
              type="button"
              onClick={filters.reset}
              aria-label={t("filters.reset")}
              title={t("filters.reset")}
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
              title={t("filters.clear_all_tooltip")}
              aria-hidden={!filters.appliedAnyActive}
              tabIndex={filters.appliedAnyActive ? 0 : -1}
              className={`inline-flex h-10 items-center gap-1.5 rounded-xl px-3 text-xs font-medium text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-1000 ${
                filters.appliedAnyActive ? "" : "invisible"
              }`}
            >
              <X className="h-3.5 w-3.5" />
              {t("filters.clear_all", {
                count: Math.max(filters.appliedActiveCount, 1),
              })}
            </button>
          </div>
        </div>

        {/* ── Chip strips (pending state) ────────────────────── */}
        <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center lg:gap-x-6 lg:gap-y-2">
          <ChipStrip
            icon={<ListFilter className="h-3 w-3" aria-hidden />}
            legend={t("filters.status_legend")}
            activeCount={pending.statuses.length}
            onClear={() => filters.setStatuses([])}
            clearLabel={t("filters.clear_dimension")}
            items={PROJECT_STATUSES.map((s) => ({
              value: s,
              label: tProject(`status.${s}` as "status.concept"),
              active: pending.statuses.includes(s),
            }))}
            onToggle={(value) => filters.toggleStatus(value as ProjectStatus)}
          />
          <ChipStrip
            legend={t("filters.project_type_legend")}
            activeCount={pending.projectType ? 1 : 0}
            onClear={() => filters.setProjectType("")}
            clearLabel={t("filters.clear_dimension")}
            items={PROJECT_TYPES.map((typeKey) => ({
              value: typeKey,
              label: t(`project_type.${typeKey}` as "project_type.custom"),
              active: pending.projectType === typeKey,
            }))}
            onToggle={(value) =>
              filters.setProjectType(
                pending.projectType === value ? "" : (value as ProjectType),
              )
            }
          />
        </div>
      </div>
    </div>
  );
}




/**
 * One chip row. The legend doubles as the section label and the
 * "clear this dimension" affordance — it shows a count + a small X
 * when this dimension has selections, vanishes back to a quiet
 * label when it doesn't. Cleaner than a permanent "All" pill on the
 * left of every row.
 */
function ChipStrip({
  icon,
  legend,
  activeCount,
  onClear,
  clearLabel,
  items,
  onToggle,
}: {
  icon?: React.ReactNode;
  legend: string;
  activeCount: number;
  onClear: () => void;
  clearLabel: string;
  items: readonly { value: string; label: string; active: boolean }[];
  onToggle: (value: string) => void;
}) {
  const isFiltering = activeCount > 0;
  return (
    <fieldset className="flex flex-wrap items-center gap-1.5">
      {/* Legend pill keeps the same geometry whether or not the
       *  dimension has selections — only colour shifts. The count
       *  badge and clear ✕ are always in the DOM but ``invisible``
       *  when inactive, so toggling a chip doesn't push the rest of
       *  the row sideways. ``role="button"`` + onClick let the user
       *  clear the dimension by clicking the pill when active; the
       *  pointer-events drop disables that affordance when nothing
       *  is selected. */}
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
        {legend}
        <span
          className={`rounded-full bg-orange-500 px-1.5 text-[10px] leading-4 text-ink-0 ${
            isFiltering ? "" : "invisible"
          }`}
          aria-hidden={!isFiltering}
        >
          {activeCount || 1}
        </span>
        <X
          className={`h-3 w-3 ${isFiltering ? "" : "invisible"}`}
          aria-hidden
        />
      </span>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          onClick={() => onToggle(item.value)}
          aria-pressed={item.active}
          className={`inline-flex h-7 items-center rounded-full px-2.5 text-[11px] font-medium transition-colors ${
            item.active
              ? "bg-orange-500 text-ink-0 shadow-sm ring-1 ring-inset ring-orange-500"
              : "bg-ink-50 text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-100 hover:ring-ink-300"
          }`}
        >
          {item.label}
        </button>
      ))}
    </fieldset>
  );
}
