"use client";

import { Button } from "@heroui/react";
import { CheckCircle2, ExternalLink, FileText, Plus } from "lucide-react";
import { useTranslations } from "next-intl";

import { Link, useRouter } from "@/i18n/navigation";
import type {
  PaginatedSpecificationsDto,
  SpecificationSheetDto,
  SpecificationStatus,
} from "@/services/specifications";


/**
 * Project-scoped spec sheet list. SSR hydrated; one card per sheet
 * with status chip + version link. "+ New spec sheet" routes back
 * to the builder's existing create modal by way of the ``?create=1``
 * query param the modal trigger listens for.
 */
export function SpecSheetsList({
  orgId,
  formulationId,
  initialPage,
  canWrite: _canWrite,
}: {
  orgId: string;
  formulationId: string;
  initialPage: PaginatedSpecificationsDto;
  canWrite: boolean;
}) {
  const tSpec = useTranslations("specifications");
  const tTabs = useTranslations("project_tabs");
  const router = useRouter();
  // Referenced to keep the prop in the signature typed — suppressed
  // while deeper-linking actions live on the builder page.
  void _canWrite;
  void orgId;

  const sheets = initialPage.results;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink-1000">
            {tTabs("spec_sheets")}
          </h2>
          <p className="mt-1 text-sm text-ink-500">
            {tSpec("tab.subtitle", { count: sheets.length })}
          </p>
        </div>
        <Button
          type="button"
          variant="primary"
          size="sm"
          className="rounded-lg bg-orange-500 px-4 py-2 font-medium text-ink-0 hover:bg-orange-600"
          onClick={() =>
            router.push(`/formulations/${formulationId}/builder`)
          }
        >
          <span className="inline-flex items-center gap-1.5">
            <Plus className="h-4 w-4" /> {tSpec("new_sheet")}
          </span>
        </Button>
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
            <FileText className="mt-0.5 h-4 w-4 flex-shrink-0 text-ink-400" />
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
                {sheet.code || tSpec("untitled")}
              </p>
              <p className="text-sm font-medium text-ink-1000">
                {sheet.client_name ||
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
