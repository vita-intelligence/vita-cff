"use client";

import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  FileText,
  MessageSquare,
  Sparkles,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { apiClient } from "@/lib/api";
import { LinkIconSlot } from "@/components/loading/link-pending-spinner";
import { Link } from "@/i18n/navigation";
import {
  useFormulationVersions,
  type FormulationVersionDto,
} from "@/services/formulations";
import type {
  PaginatedSpecificationsDto,
  SpecificationSheetDto,
  SpecificationStatus,
} from "@/services/specifications";

import { NewSpecSheetButton } from "../new-spec-sheet-button";


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

  const sheets = initialPage.results;
  // Only ACTIVE final sheets block the banner. A ``rejected`` final
  // means the customer sent us back to trial batches — once they've
  // re-confirmed done we owe them a fresh FINAL against the new
  // approved version, so the banner should re-appear. Mirrors the
  // ``_awaiting_final_projects`` rule on the /final-specs/ kanban.
  const hasActiveFinalSheet = sheets.some(
    (s) =>
      s.document_kind === "final" &&
      s.status !== "rejected" &&
      s.status !== "draft" &&
      s.status !== "in_review",
  );
  const customerConfirmedDone = cycle?.customer_confirmed_done_at != null;
  const showFinalSpecBanner = customerConfirmedDone && !hasActiveFinalSheet;

  return (
    <section className="flex flex-col gap-4">
      {showFinalSpecBanner && cycle ? (
        <FinalSpecReadyBanner
          cycle={cycle}
          canWrite={canWrite}
          orgId={orgId}
          projectCode={projectCode}
          versions={versions}
          sheets={sheets}
        />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink-1000">
            {tTabs("spec_sheets")}
          </h2>
          <p className="mt-1 text-sm text-ink-500">
            {tSpec("tab.subtitle", { count: sheets.length })}
          </p>
        </div>
        {canWrite ? (
          <NewSpecSheetButton
            orgId={orgId}
            projectCode={projectCode}
            versions={versions}
            existingSheets={sheets}
          />
        ) : null}
      </div>

      {sheets.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {sheets.map((sheet) => (
            <SpecSheetCard key={sheet.id} sheet={sheet} />
          ))}
        </ul>
      )}
    </section>
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


function SpecSheetCard({ sheet }: { sheet: SpecificationSheetDto }) {
  const tSpec = useTranslations("specifications");
  return (
    <li>
      <Link
        href={`/specifications/${sheet.id}`}
        className="flex flex-col gap-3 rounded-2xl bg-ink-0 p-5 shadow-sm ring-1 ring-ink-200 transition-shadow hover:shadow-md"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <span className="mt-0.5 flex-shrink-0 text-ink-400">
              <LinkIconSlot
                idleIcon={<FileText className="h-4 w-4" />}
                spinnerSizeClassName="h-4 w-4"
              />
            </span>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
                {sheet.code || tSpec("untitled")}
              </p>
              <p className="text-sm font-medium text-ink-1000">
                {/* One customer per project — prefer the project-linked
                    customer over the sheet's own client fields (which
                    are scientist-typed at draft time and often left
                    empty). Falls back to the sheet fields only for
                    legacy sheets whose formulation still has no
                    customer linked. */}
                {sheet.linked_customer?.name ||
                  sheet.linked_customer?.company ||
                  sheet.client_name ||
                  sheet.client_company ||
                  tSpec("no_client_yet")}
              </p>
            </div>
          </div>
          <StatusChip status={sheet.status} tSpec={tSpec} />
        </div>
        <div className="flex items-center justify-between text-xs text-ink-500">
          <span>
            v{sheet.formulation_version_number} · {sheet.formulation_name}
          </span>
          <ExternalLink className="h-3 w-3" />
        </div>
      </Link>
    </li>
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
