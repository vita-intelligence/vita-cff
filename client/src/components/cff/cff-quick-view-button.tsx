"use client";

/**
 * Floating "CFF" bubble on the project page.
 *
 * Mirrors the comments-bubble affordance the project page already
 * has, but anchored to the **bottom-left** so the two surfaces
 * never overlap. Click → opens the read-only CFF detail layout
 * (same as the inbox). When more than one CFF is attached, a
 * compact chooser appears first.
 *
 * Self-hides when:
 *
 * * The caller lacks ``cff_submissions.view`` on the org, or
 * * No CFF is attached (the project wasn't created from an intake
 *   row — the most common case for legacy projects).
 */

import { FileText, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { CFFDetailModal } from "@/components/cff/cff-detail-modal";
import { hasFlatCapability } from "@/lib/auth/capabilities";
import {
  useCFFFieldLabels,
  useInfiniteCFFSubmissions,
  type CFFSubmissionDto,
} from "@/services/cff-submissions";
import type { OrganizationDto } from "@/services/organizations/types";


export function CFFQuickViewButton({
  organization,
  projectId,
}: {
  organization: OrganizationDto;
  projectId: string;
}) {
  const t = useTranslations("cff");

  const canView = hasFlatCapability(
    organization,
    "cff_submissions",
    "view",
  );

  // Skip the request entirely when the caller can't read CFFs —
  // ``enabled: false`` keeps the query out of the cache and the
  // network panel.
  const listQuery = useInfiniteCFFSubmissions({
    orgId: organization.id,
    projectId,
    pageSize: 25,
    enabled: canView,
  });
  // Field labels share the inbox cache; TanStack dedupes so this
  // is cheap to fire eagerly so the modal opens instantly with
  // human labels (rather than slugs for a frame).
  const labelsQuery = useCFFFieldLabels(organization.id, {
    enabled: canView,
  });

  const rows = useMemo(() => {
    const pages = listQuery.data?.pages ?? [];
    return pages.flatMap((p) => p.results);
  }, [listQuery.data]);

  const [openSubmission, setOpenSubmission] = useState<
    CFFSubmissionDto | null
  >(null);
  const [isChooserOpen, setChooserOpen] = useState(false);

  if (!canView) return null;
  // Hide while the first page is loading so the floating button
  // doesn't pop in and out as the response arrives.
  if (listQuery.isPending) return null;
  if (rows.length === 0) return null;

  const handleClick = () => {
    if (rows.length === 1) {
      // Skip the chooser for the common single-CFF case so the
      // common path is one click.
      const only = rows[0];
      if (only) setOpenSubmission(only);
    } else {
      setChooserOpen(true);
    }
  };

  return (
    <>
      {/* Bottom-left anchor mirrors the comments bubble's
          bottom-right anchor — same vertical rhythm, opposite
          corner so the two affordances never overlap regardless
          of viewport size. ``print:hidden`` keeps the bubble out
          of paper / PDF exports of the project page. */}
      <div className="fixed bottom-6 left-6 z-40 flex flex-col items-start gap-3 print:hidden">
        <button
          type="button"
          onClick={handleClick}
          aria-label={t("project_button.tooltip")}
          title={t("project_button.tooltip")}
          className="relative inline-flex h-12 w-12 items-center justify-center rounded-full bg-blue-600 text-ink-0 shadow-lg ring-1 ring-blue-700/50 transition-transform hover:scale-105 hover:bg-blue-700"
        >
          <FileText className="h-5 w-5" />
          {rows.length > 1 ? (
            <span
              aria-hidden
              className="absolute -right-1 -top-1 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-orange-500 px-1.5 text-[10px] font-semibold text-ink-0 ring-2 ring-ink-0"
            >
              {rows.length}
            </span>
          ) : null}
        </button>
      </div>

      {isChooserOpen ? (
        <ChooserModal
          rows={rows}
          onClose={() => setChooserOpen(false)}
          onPick={(submission) => {
            setOpenSubmission(submission);
            setChooserOpen(false);
          }}
        />
      ) : null}

      {openSubmission ? (
        <CFFDetailModal
          orgId={organization.id}
          submission={openSubmission}
          fieldLabels={labelsQuery.data?.field_labels_by_form ?? {}}
          // Attached to this project already — Assign / Create
          // buttons don't make sense from this entry point. The
          // detail modal hides them automatically when ``project``
          // is non-null, so we forward no-op callbacks defensively.
          canAssign={false}
          onClose={() => setOpenSubmission(null)}
          onAssign={() => undefined}
          onCreateProject={() => undefined}
        />
      ) : null}
    </>
  );
}


/**
 * Compact chooser shown when more than one CFF is attached to the
 * project. Each row shows customer name, market segment, and the
 * submission date so the user can spot the right one quickly.
 */
function ChooserModal({
  rows,
  onClose,
  onPick,
}: {
  rows: ReadonlyArray<CFFSubmissionDto>;
  onClose: () => void;
  onPick: (submission: CFFSubmissionDto) => void;
}) {
  const t = useTranslations("cff");
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cff-chooser-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex w-full max-w-md max-h-[80vh] flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <header className="flex items-start justify-between gap-2 border-b border-ink-100 px-5 py-3">
          <div className="flex flex-col">
            <h2
              id="cff-chooser-title"
              className="text-sm font-semibold text-ink-1000"
            >
              {t("project_button.chooser_title", { count: rows.length })}
            </h2>
            <p className="mt-0.5 text-[11px] text-ink-500">
              {t("project_button.chooser_body")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-ink-500 transition-colors hover:bg-ink-100"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <ul className="flex-1 overflow-y-auto">
          {rows.map((row) => {
            const subs = (row.raw_payload?.submissions ?? {}) as Record<
              string,
              unknown
            >;
            const first =
              pickFirstString(subs, ["first_name"]) +
              " " +
              pickFirstString(subs, ["last_name"]);
            const company = pickFirstString(subs, [
              "company_name_as_per_customer_account_form",
              "company_name",
              "company",
            ]);
            const market = pickFirstString(subs, ["market_segment"]);
            const label = company || first.trim() || row.wix_submission_id;

            return (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => onPick(row)}
                  className="flex w-full flex-col items-start gap-0.5 border-b border-ink-100 px-5 py-3 text-left transition-colors hover:bg-ink-50"
                >
                  <span className="truncate text-sm font-medium text-ink-1000">
                    {label}
                  </span>
                  {market ? (
                    <span className="truncate text-[11px] text-ink-500">
                      {market}
                    </span>
                  ) : null}
                  <span className="text-[11px] text-ink-400">
                    {new Date(
                      row.wix_created_date || row.imported_at,
                    ).toLocaleDateString()}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}


function pickFirstString(
  obj: Record<string, unknown>,
  prefixes: string[],
): string {
  for (const prefix of prefixes) {
    for (const [slug, value] of Object.entries(obj)) {
      if (slug.startsWith(prefix) && typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }
  return "";
}
