"use client";

import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  FileText,
  Loader2,
  MessageSquare,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";

import { apiClient } from "@/lib/api";
import { LinkIconSlot } from "@/components/loading/link-pending-spinner";
import { Link } from "@/i18n/navigation";
import { useDebouncedValue } from "@/lib/utils/use-debounced-value";
import {
  useFormulationVersions,
  type FormulationVersionDto,
} from "@/services/formulations";
import {
  useDeleteSpecification,
  useInfiniteSpecifications,
  type PaginatedSpecificationsDto,
  type SpecificationSheetDto,
  type SpecificationStatus,
} from "@/services/specifications";

import { NewSpecSheetButton } from "../new-spec-sheet-button";


// Matches the ``-ORDER-<n>`` suffix that ``_next_checkout_sheet_code``
// on the backend appends when the RTG checkout clones a FINAL
// template for a customer order. Extracting the integer lets the card
// render a compact "Order #N" badge so an operator scanning a
// popular RTG catalog SKU can tell a first purchase apart from a
// repeat immediately.
const ORDER_SUFFIX_REGEX = /-ORDER-(\d+)$/i;


function extractOrderNumber(code: string | null | undefined): number | null {
  if (!code) return null;
  const match = code.match(ORDER_SUFFIX_REGEX);
  if (!match) return null;
  const n = Number.parseInt(match[1]!, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}


const SEARCH_DEBOUNCE_MS = 300;
const PAGE_SIZE = 50;


// Compact, timezone-stable date renderer used on the card. Kept
// deterministic (no ``Intl.DateTimeFormat`` locale reliance) so the
// SSR paint and the client hydration don't flash different strings.
function formatCreatedAt(iso: string): { short: string; iso: string } {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return { short: "—", iso };
  const d = new Date(ms);
  const day = String(d.getDate()).padStart(2, "0");
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][d.getMonth()]!;
  const year = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return { short: `${day} ${month} ${year} · ${hh}:${mm}`, iso };
}


/**
 * Project-scoped spec sheet list. SSR hydrated; one card per sheet
 * with status chip + version link. "+ New spec" opens the same
 * creation modal the builder page uses — we render the button
 * inline with the versions fetched on mount so the modal can lock
 * against a real :class:`FormulationVersion` without the page
 * redirecting somewhere else.
 */
// Cycle payload for the spec-sheets banner. Mirrors
// ``_serialise_cycle_for_scientist`` on the server. Kept local
// because the wire is tab-specific and threading it through the
// shared /services layer would drag half the trial-batches domain
// into every spec-sheets consumer.
interface TrialCycleForSpecTab {
  readonly id: string;
  readonly status: string;
  readonly total_slots: number;
  readonly slots_used: number;
  readonly customer_confirmed_done_at: string | null;
  readonly terminated_reason: string;
  /** Quantity from the proposal line that spawned this project — the
   *  scientist should seed the FINAL spec's ``quantity`` from this
   *  so the invoice math matches what the customer originally
   *  quoted. ``null`` when no signed/accepted proposal exists. */
  readonly proposal_line_quantity: number | null;
  readonly slots: readonly {
    readonly id: string;
    readonly sequence_no: number;
    readonly status: string;
    readonly verdict: "satisfied" | "needs_iteration" | null;
    readonly verdict_at: string | null;
    readonly feedback_summary: string;
    readonly trial_batch_id: string | null;
    readonly formulation_version_id: string;
    readonly formulation_version_label: string;
  }[];
}


export function SpecSheetsList({
  orgId,
  formulationId,
  projectCode,
  projectType,
  initialPage,
  canWrite,
}: {
  orgId: string;
  formulationId: string;
  //: The project's own code, forwarded to the create modal so the
  //: spec sheet's ``code`` field is seeded with the same reference
  //: the scientist already typed at project-creation time — they can
  //: still override before saving.
  projectCode: string;
  //: ``custom`` vs ``ready_to_go`` — RTG hides the run-quantity
  //: input on FINAL creates (run size is per-customer at order time,
  //: not a spec-time decision).
  projectType?: "custom" | "ready_to_go";
  initialPage: PaginatedSpecificationsDto;
  canWrite: boolean;
}) {
  const tSpec = useTranslations("specifications");
  const tTabs = useTranslations("project_tabs");

  const versionsQuery = useFormulationVersions(orgId, formulationId);
  const versions: readonly FormulationVersionDto[] =
    versionsQuery.data ?? [];

  // Cycle lookup — 404 is expected (deposit not yet approved) so we
  // treat any error as "no cycle" and hide the banner rather than
  // showing an error state on a tab where the cycle is optional
  // context, not the main content.
  const cycleQuery = useQuery<TrialCycleForSpecTab | null>({
    queryKey: ["trial-batch-cycle-by-formulation", orgId, formulationId],
    queryFn: async () => {
      try {
        const { data } = await apiClient.get<{ cycle: TrialCycleForSpecTab }>(
          `/api/organizations/${orgId}/formulations/${formulationId}/trial-batch-cycle/`,
        );
        return data.cycle;
      } catch {
        return null;
      }
    },
    staleTime: 30_000,
  });
  const cycle = cycleQuery.data ?? null;

  // Debounced customer / code search. Any input flips the SSR seed
  // off — a filtered result set has a different shape than the "all
  // sheets" first page so re-using the seed would render stale rows
  // for the first frame after the user types.
  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebouncedValue(searchInput, SEARCH_DEBOUNCE_MS);
  const trimmedSearch = debouncedSearch.trim();

  const list = useInfiniteSpecifications(orgId, {
    formulationId,
    pageSize: PAGE_SIZE,
    search: trimmedSearch || undefined,
    initialFirstPage: trimmedSearch ? null : initialPage,
  });

  const sheets = useMemo<readonly SpecificationSheetDto[]>(
    () => list.data?.pages.flatMap((p) => p.results) ?? [],
    [list.data],
  );

  // IntersectionObserver-driven infinite scroll — matches the RTG
  // catalog grid pattern so both surfaces have identical UX at scale.
  // The sentinel re-mounts when the fetch state flips so a fresh
  // page swap gets picked up automatically.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    if (!list.hasNextPage || list.isFetchingNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          void list.fetchNextPage();
        }
      },
      { root: null, rootMargin: "240px", threshold: 0 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [list, sheets.length]);

  // Only ACTIVE final sheets block the banner. A ``rejected`` final
  // means the customer sent us back to trial batches — once they've
  // re-confirmed done we owe them a fresh FINAL against the new
  // approved version, so the banner should re-appear. Mirrors the
  // ``_awaiting_final_projects`` rule on the /final-specs/ kanban.
  //
  // We look at the SSR seed for this check rather than the paged
  // ``sheets`` state because the banner should stay true to the
  // whole-project verdict even when the operator has typed a filter
  // that hides FINAL rows.
  const hasActiveFinalSheet = initialPage.results.some(
    (s) =>
      s.document_kind === "final" &&
      s.status !== "rejected" &&
      s.status !== "draft" &&
      s.status !== "in_review",
  );
  const customerConfirmedDone = cycle?.customer_confirmed_done_at != null;
  const showFinalSpecBanner = customerConfirmedDone && !hasActiveFinalSheet;

  const isSearching = trimmedSearch.length > 0;
  const isBusy = list.isFetching && !list.isFetchingNextPage;

  return (
    <section className="flex flex-col gap-4">
      {showFinalSpecBanner && cycle ? (
        <FinalSpecReadyBanner
          cycle={cycle}
          canWrite={canWrite}
          orgId={orgId}
          projectCode={projectCode}
          versions={versions}
          sheets={initialPage.results}
        />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink-1000">
            {tTabs("spec_sheets")}
          </h2>
          <p className="mt-1 text-sm text-ink-500">
            {isSearching
              ? `Matches for “${trimmedSearch}” · ${sheets.length}${
                  list.hasNextPage ? "+" : ""
                }`
              : tSpec("tab.subtitle", { count: sheets.length })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SpecSheetsSearchBox
            value={searchInput}
            onChange={setSearchInput}
            busy={isBusy}
          />
          {canWrite ? (
            <NewSpecSheetButton
              orgId={orgId}
              projectCode={projectCode}
              projectType={projectType}
              versions={versions}
              existingSheets={sheets}
            />
          ) : null}
        </div>
      </div>

      {sheets.length === 0 && !list.isLoading ? (
        isSearching ? (
          <p className="rounded-2xl bg-ink-50 p-8 text-center text-sm text-ink-500 ring-1 ring-ink-200">
            No spec sheets match “{trimmedSearch}”.
          </p>
        ) : (
          <EmptyState />
        )
      ) : (
        <>
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {sheets.map((sheet) => (
              <SpecSheetCard
                key={sheet.id}
                sheet={sheet}
                orgId={orgId}
                canWrite={canWrite}
              />
            ))}
          </ul>
          {list.hasNextPage ? (
            <div
              ref={sentinelRef}
              className="flex items-center justify-center py-6 text-xs text-ink-500"
            >
              {list.isFetchingNextPage ? (
                <>
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  Loading more…
                </>
              ) : (
                <span aria-hidden />
              )}
            </div>
          ) : sheets.length > PAGE_SIZE ? (
            <p className="py-4 text-center text-xs text-ink-500">
              End of list.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}


function SpecSheetsSearchBox({
  value,
  onChange,
  busy,
}: {
  value: string;
  onChange: (next: string) => void;
  busy: boolean;
}) {
  return (
    <div className="relative w-full sm:w-72">
      <Search
        aria-hidden
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400"
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search customer, company, or code…"
        aria-label="Search spec sheets"
        className="h-10 w-full rounded-full bg-ink-50 pl-9 pr-9 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 placeholder:text-ink-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-400"
      />
      {busy && value ? (
        <Loader2
          aria-hidden
          className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-orange-500"
        />
      ) : value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-ink-500 hover:bg-ink-100 hover:text-ink-1000"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}


// Banner + trial-batch history summary. Renders when the customer
// has clicked "No, we're done" on the portal terminal-choice prompt
// AND no ``final`` spec sheet exists yet. The scientist sees a
// prominent nudge to build the final spec + a compact list of every
// sample worked with, the recipe version, the verdict, and the
// verbatim feedback text — everything they need to decide which
// version becomes the final spec's basis.
function FinalSpecReadyBanner({
  cycle,
  canWrite,
  orgId,
  projectCode,
  versions,
  sheets,
}: {
  cycle: TrialCycleForSpecTab;
  canWrite: boolean;
  orgId: string;
  projectCode: string;
  versions: readonly FormulationVersionDto[];
  sheets: readonly SpecificationSheetDto[];
}) {
  // Only slots the customer actually received or gave a verdict on
  // — awaiting_scientist + closed_cancelled don't have meaningful
  // history for the final-spec decision.
  const meaningfulSlots = cycle.slots.filter((s) =>
    s.status !== "awaiting_scientist" && s.status !== "closed_cancelled",
  );
  const satisfiedSlot = meaningfulSlots.find(
    (s) => s.verdict === "satisfied",
  );
  return (
    <div className="rounded-2xl border border-emerald-500/40 bg-emerald-50/70 p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
          <Sparkles className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-emerald-800">
            Final spec ready to be created
          </p>
          <p className="mt-1 text-sm text-emerald-950">
            The customer confirmed they&rsquo;re done with trial batches
            {satisfiedSlot ? (
              <>
                {" "}
                and approved{" "}
                <strong>
                  Sample #{satisfiedSlot.sequence_no} (
                  {satisfiedSlot.formulation_version_label})
                </strong>
              </>
            ) : null}
            . Review the samples + feedback below, then create the
            final spec sheet against the version they liked.
          </p>
          {canWrite ? (
            <div className="mt-3">
              <NewSpecSheetButton
                orgId={orgId}
                projectCode={projectCode}
                versions={versions}
                existingSheets={sheets}
                documentKind="final"
                defaultQuantity={cycle.proposal_line_quantity ?? undefined}
              />
            </div>
          ) : null}
        </div>
      </div>

      {meaningfulSlots.length > 0 ? (
        <div className="mt-4 border-t border-emerald-500/30 pt-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-emerald-800">
            Trial-batch history ({meaningfulSlots.length} sample
            {meaningfulSlots.length === 1 ? "" : "s"})
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {meaningfulSlots.map((slot) => (
              <TrialHistoryRow key={slot.id} slot={slot} />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}


function TrialHistoryRow({
  slot,
}: {
  slot: TrialCycleForSpecTab["slots"][number];
}) {
  // Collapsed by default so a long feedback text on one slot
  // doesn't push the whole banner off screen. Only expand when
  // there's something meaningful (feedback text) behind the fold —
  // rows without feedback stay non-interactive.
  const hasFeedback = Boolean(slot.feedback_summary?.trim());
  const [open, setOpen] = useState(false);
  const verdictTone =
    slot.verdict === "satisfied"
      ? "bg-emerald-500/15 text-emerald-800 ring-emerald-500/30"
      : slot.verdict === "needs_iteration"
        ? "bg-amber-500/15 text-amber-800 ring-amber-500/30"
        : "bg-ink-100 text-ink-600 ring-ink-200";
  const verdictLabel =
    slot.verdict === "satisfied"
      ? "Satisfied"
      : slot.verdict === "needs_iteration"
        ? "Needs iteration"
        : slot.status.replace(/_/g, " ");
  const verdictAt = slot.verdict_at
    ? new Date(slot.verdict_at).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;
  return (
    <li className="rounded-xl border border-emerald-500/20 bg-white">
      <button
        type="button"
        onClick={() => hasFeedback && setOpen((v) => !v)}
        aria-expanded={hasFeedback ? open : undefined}
        disabled={!hasFeedback}
        className={
          "flex w-full items-center gap-3 p-3 text-left " +
          (hasFeedback ? "hover:bg-emerald-50/50" : "cursor-default")
        }
      >
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink-1000">
            Sample #{slot.sequence_no}{" "}
            <span className="font-mono text-xs text-ink-500">
              {slot.formulation_version_label}
            </span>
          </p>
          {verdictAt ? (
            <p className="mt-0.5 text-[11px] text-ink-500">
              Recorded {verdictAt}
              {hasFeedback ? " · click to read feedback" : ""}
            </p>
          ) : hasFeedback ? (
            <p className="mt-0.5 text-[11px] text-ink-500">
              click to read feedback
            </p>
          ) : null}
        </div>
        <span
          className={
            "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 " +
            verdictTone
          }
        >
          {verdictLabel}
        </span>
        {hasFeedback ? (
          <ChevronDown
            className={
              "h-4 w-4 shrink-0 text-ink-400 transition-transform " +
              (open ? "rotate-180" : "")
            }
          />
        ) : null}
      </button>
      {open && hasFeedback ? (
        <div className="border-t border-emerald-500/10 px-3 pb-3 pt-2">
          <div className="flex items-start gap-2 rounded-lg bg-ink-50 p-2 text-xs text-ink-700">
            <MessageSquare className="mt-0.5 h-3 w-3 shrink-0 text-ink-400" />
            <p className="whitespace-pre-line">{slot.feedback_summary}</p>
          </div>
        </div>
      ) : null}
    </li>
  );
}


function SpecSheetCard({
  sheet,
  orgId,
  canWrite,
}: {
  sheet: SpecificationSheetDto;
  orgId: string;
  canWrite: boolean;
}) {
  const tSpec = useTranslations("specifications");
  // For Custom projects the project-linked customer is authoritative
  // (one customer per project). For RTG projects the formulation
  // itself has no customer — each per-order clone carries the buyer
  // in ``client_name`` / ``client_company``, so the fallback chain
  // still finds a name to show.
  const customerLabel =
    sheet.linked_customer?.name ||
    sheet.linked_customer?.company ||
    sheet.client_name ||
    sheet.client_company ||
    tSpec("no_client_yet");
  const companyLabel =
    sheet.linked_customer?.company || sheet.client_company || "";
  // Show the company on the second line only when it differs from the
  // primary label (otherwise it duplicates the row above).
  const showSubCompany =
    companyLabel && companyLabel !== customerLabel;
  const orderNumber = extractOrderNumber(sheet.code);
  const created = formatCreatedAt(sheet.created_at);
  // Delete is only offered when BOTH: no proposal is attached AND the
  // sheet is still a draft. The backend's ``delete_sheet`` guard is
  // ``status == draft`` — offering it on approved/sent rows would
  // spawn a rejected mutation the user can't act on. RTG clones ship
  // as APPROVED + attached-to-proposal on creation, so this button
  // never surfaces for them (which is the intent — order clones are
  // audit artefacts, not scratch drafts).
  const isDeletable =
    canWrite &&
    sheet.linked_proposal === null &&
    sheet.status === "draft";
  return (
    <li className="group relative">
      <Link
        href={`/specifications/${sheet.id}`}
        className="flex flex-col gap-3 rounded-2xl bg-ink-0 p-5 shadow-sm ring-1 ring-ink-200 transition-shadow hover:shadow-md"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <span className="mt-0.5 flex-shrink-0 text-ink-400">
              <LinkIconSlot
                idleIcon={<FileText className="h-4 w-4" />}
                spinnerSizeClassName="h-4 w-4"
              />
            </span>
            <div className="min-w-0">
              {/* Customer first, code second — on a popular RTG SKU
                  with thousands of order clones the operator scans by
                  buyer, not by opaque code. */}
              <p className="truncate text-sm font-semibold text-ink-1000">
                {customerLabel}
              </p>
              {showSubCompany ? (
                <p className="truncate text-xs text-ink-500">
                  {companyLabel}
                </p>
              ) : null}
              <p className="mt-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-500">
                <span className="truncate">
                  {sheet.code || tSpec("untitled")}
                </span>
                {orderNumber !== null ? (
                  <span
                    className="inline-flex flex-shrink-0 items-center rounded-full bg-orange-50 px-1.5 py-0.5 text-[10px] font-semibold text-orange-700 ring-1 ring-inset ring-orange-200"
                    title="Sheet was auto-cloned from the FINAL template when this customer placed order N"
                  >
                    #{orderNumber}
                  </span>
                ) : null}
              </p>
            </div>
          </div>
          <StatusChip status={sheet.status} tSpec={tSpec} />
        </div>
        <div className="flex items-center justify-between gap-2 text-xs text-ink-500">
          <span className="truncate">
            v{sheet.formulation_version_number} · {sheet.formulation_name}
          </span>
          <time
            dateTime={created.iso}
            title={`Created ${created.iso}`}
            className="flex-shrink-0 whitespace-nowrap text-[11px] tabular-nums text-ink-500"
          >
            {created.short}
          </time>
        </div>
      </Link>
      {isDeletable ? (
        <DeleteSheetButton orgId={orgId} sheet={sheet} />
      ) : null}
    </li>
  );
}


function DeleteSheetButton({
  orgId,
  sheet,
}: {
  orgId: string;
  sheet: SpecificationSheetDto;
}) {
  // Two-click confirmation kept inline in the card so a
  // mis-click can't wipe the row silently. First click flips to a
  // "Delete?" state that auto-resets after 4s; second click within
  // that window fires the mutation. Prevents a modal + keeps the
  // affordance quiet enough that scrolling by never triggers it.
  const [armed, setArmed] = useState(false);
  const disarmRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deleteMut = useDeleteSpecification(orgId);

  useEffect(() => {
    return () => {
      if (disarmRef.current) clearTimeout(disarmRef.current);
    };
  }, []);

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    // The delete affordance sits inside the same <li> as the card's
    // <Link>. Without stopPropagation the click bubbles to the link
    // and navigates away mid-mutation. preventDefault covers the
    // (rare) case where the button is nested inside an <a> ancestor
    // in a future refactor.
    e.stopPropagation();
    e.preventDefault();
    if (deleteMut.isPending) return;
    if (!armed) {
      setArmed(true);
      if (disarmRef.current) clearTimeout(disarmRef.current);
      disarmRef.current = setTimeout(() => setArmed(false), 4000);
      return;
    }
    if (disarmRef.current) clearTimeout(disarmRef.current);
    deleteMut.mutate(sheet.id);
  };

  const label = deleteMut.isPending
    ? "Deleting…"
    : armed
      ? "Click again to confirm"
      : "Delete draft";

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={armed ? "Confirm delete" : "Delete spec sheet"}
      title={
        armed
          ? "Click again within 4s to confirm delete"
          : "Delete this draft spec sheet (no proposal attached)"
      }
      disabled={deleteMut.isPending}
      className={
        "absolute right-3 top-3 z-10 inline-flex h-7 items-center gap-1 rounded-full px-2 text-[11px] font-medium ring-1 ring-inset transition-colors " +
        (armed
          ? "bg-danger text-white ring-danger opacity-100"
          : "bg-white text-ink-500 ring-ink-200 opacity-0 hover:bg-danger/10 hover:text-danger hover:ring-danger/30 group-hover:opacity-100 focus-visible:opacity-100")
      }
    >
      {deleteMut.isPending ? (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      ) : (
        <Trash2 className="h-3 w-3" aria-hidden />
      )}
      <span>{label}</span>
    </button>
  );
}


function StatusChip({
  status,
  tSpec,
}: {
  status: SpecificationStatus;
  tSpec: ReturnType<typeof useTranslations<"specifications">>;
}) {
  const label = tSpec(`status.${status}` as "status.draft");
  // Terminal client-facing states (accepted/approved) render on the
  // success tint so the dashboard reads "this one is through" at a
  // glance. Rejected gets danger. Everything else stays neutral to
  // avoid drawing the eye to in-flight work.
  const isTerminalPass = status === "approved" || status === "accepted";
  const isTerminalFail = status === "rejected";
  const classes = isTerminalPass
    ? "bg-success/10 text-success ring-success/20"
    : isTerminalFail
      ? "bg-danger/10 text-danger ring-danger/20"
      : status === "sent"
        ? "bg-orange-50 text-orange-700 ring-orange-200"
        : "bg-ink-100 text-ink-700 ring-ink-200";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${classes}`}
    >
      {isTerminalPass ? <CheckCircle2 className="h-3 w-3" /> : null}
      {label}
    </span>
  );
}


function EmptyState() {
  const tSpec = useTranslations("specifications");
  return (
    <div className="rounded-2xl bg-ink-0 p-10 text-center shadow-sm ring-1 ring-ink-200">
      <FileText className="mx-auto h-8 w-8 text-ink-300" />
      <p className="mt-3 text-sm font-medium text-ink-1000">
        {tSpec("no_sheets")}
      </p>
      <p className="mt-1 text-xs text-ink-500">{tSpec("no_sheets_hint")}</p>
    </div>
  );
}
