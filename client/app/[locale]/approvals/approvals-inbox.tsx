"use client";

import { CheckCircle2, ClipboardCheck, FileSignature, Inbox } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { Link } from "@/i18n/navigation";
import { useProposals, type ProposalDto } from "@/services/proposals";
import {
  useInfiniteSpecifications,
  type SpecificationSheetDto,
} from "@/services/specifications";


type Tab = "proposals" | "specifications";


/**
 * Two-tab approval queue. Both tabs hit the same ``in_review``
 * filter on their respective list endpoints. Pagination on specs
 * is intentionally not exposed here — director queues stay short
 * by design; the cursor would only matter if the team accumulated
 * a backlog, in which case we want them to see *everything* on a
 * single screen and clear it rather than hide items behind a
 * "load more" button.
 *
 * The two tabs are gated independently — proposals on
 * ``proposals.view_approvals`` and specs on
 * ``formulations.view_approvals``. The page-level guard already
 * ensures the caller has at least one of the two; we hide the tab
 * the caller cannot read here so a sales user without spec access
 * doesn't see an empty "Specifications" tab they can't use.
 */
export function ApprovalsInbox({
  orgId,
  canViewProposals,
  canViewSpecs,
}: {
  orgId: string;
  canViewProposals: boolean;
  canViewSpecs: boolean;
}) {
  const t = useTranslations("approvals");
  // Default the active tab to whichever one the caller can actually
  // see. Proposals takes priority because it's the more common
  // sales-driven queue; specs is the fallback when the caller is
  // spec-only.
  const [tab, setTab] = useState<Tab>(
    canViewProposals ? "proposals" : "specifications",
  );

  // Pass an empty orgId to short-circuit the underlying ``enabled``
  // guard on each hook — that's the cheapest way to skip a fetch
  // the caller is not allowed to make without plumbing a new
  // ``enabled`` option through every consumer of these hooks.
  const proposalsQuery = useProposals(canViewProposals ? orgId : "", {
    status: "in_review",
  });
  const specsQuery = useInfiniteSpecifications(canViewSpecs ? orgId : "", {
    status: "in_review",
    pageSize: 100,
  });

  const proposals = canViewProposals ? proposalsQuery.data ?? [] : [];
  const specs = useMemo(
    () =>
      canViewSpecs
        ? specsQuery.data?.pages.flatMap((p) => p.results) ?? []
        : [],
    [specsQuery.data, canViewSpecs],
  );

  return (
    <section className="mt-6 rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 md:p-8">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-100 pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink-1000 md:text-2xl">
            {t("title")}
          </h1>
          <p className="mt-0.5 text-sm text-ink-500">{t("subtitle")}</p>
        </div>
      </header>

      <div className="mt-4 flex flex-wrap gap-2">
        {canViewProposals ? (
          <TabButton
            active={tab === "proposals"}
            onClick={() => setTab("proposals")}
            icon={<FileSignature className="h-4 w-4" />}
            label={t("tabs.proposals")}
            count={proposals.length}
          />
        ) : null}
        {canViewSpecs ? (
          <TabButton
            active={tab === "specifications"}
            onClick={() => setTab("specifications")}
            icon={<ClipboardCheck className="h-4 w-4" />}
            label={t("tabs.specifications")}
            count={specs.length}
          />
        ) : null}
      </div>

      {tab === "proposals" && canViewProposals ? (
        <ProposalsPanel
          proposals={proposals}
          loading={proposalsQuery.isLoading}
          errored={proposalsQuery.isError}
        />
      ) : null}
      {tab === "specifications" && canViewSpecs ? (
        <SpecificationsPanel
          specs={specs}
          loading={specsQuery.isLoading}
          errored={specsQuery.isError}
        />
      ) : null}
    </section>
  );
}


function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium ring-1 ring-inset transition-colors ${
        active
          ? "bg-orange-500/10 text-orange-700 ring-orange-500/30"
          : "bg-ink-0 text-ink-700 ring-ink-200 hover:bg-ink-50"
      }`}
    >
      {icon}
      <span>{label}</span>
      <span
        className={`inline-flex min-w-[1.5rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${
          active
            ? "bg-orange-500 text-ink-0"
            : "bg-ink-100 text-ink-700"
        }`}
      >
        {count}
      </span>
    </button>
  );
}


function ProposalsPanel({
  proposals,
  loading,
  errored,
}: {
  proposals: readonly ProposalDto[];
  loading: boolean;
  errored: boolean;
}) {
  const t = useTranslations("approvals");

  if (loading) {
    return <p className="mt-6 text-sm text-ink-500">{t("loading")}</p>;
  }
  if (errored) {
    return (
      <p
        role="alert"
        className="mt-6 rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
      >
        {t("errors.load")}
      </p>
    );
  }
  if (proposals.length === 0) {
    return <EmptyState message={t("empty.proposals")} />;
  }
  return (
    <ul className="mt-4 flex flex-col gap-3">
      {proposals.map((p) => (
        <ProposalCard key={p.id} proposal={p} />
      ))}
    </ul>
  );
}


function SpecificationsPanel({
  specs,
  loading,
  errored,
}: {
  specs: readonly SpecificationSheetDto[];
  loading: boolean;
  errored: boolean;
}) {
  const t = useTranslations("approvals");

  if (loading) {
    return <p className="mt-6 text-sm text-ink-500">{t("loading")}</p>;
  }
  if (errored) {
    return (
      <p
        role="alert"
        className="mt-6 rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
      >
        {t("errors.load")}
      </p>
    );
  }
  if (specs.length === 0) {
    return <EmptyState message={t("empty.specifications")} />;
  }
  return (
    <ul className="mt-4 flex flex-col gap-3">
      {specs.map((s) => (
        <SpecificationCard key={s.id} sheet={s} />
      ))}
    </ul>
  );
}


function EmptyState({ message }: { message: string }) {
  return (
    <div className="mt-6 rounded-xl bg-ink-50 px-4 py-10 text-center ring-1 ring-inset ring-ink-200">
      <Inbox className="mx-auto h-7 w-7 text-ink-400" />
      <p className="mt-3 text-sm text-ink-500">{message}</p>
    </div>
  );
}


function ProposalCard({ proposal }: { proposal: ProposalDto }) {
  const t = useTranslations("approvals");
  const format = useFormatter();
  // Pin a stable ``now`` so the SSR-rendered relative time matches
  // the first client paint exactly. Refreshes once a minute so the
  // queue updates without a full re-fetch.
  const now = useNow({ updateInterval: 60_000 });

  const customer =
    proposal.customer_company ||
    proposal.customer_name ||
    t("card.no_customer");
  const productLabel = t(
    proposal.lines.length === 1
      ? "card.products_one"
      : "card.products_other",
    { count: proposal.lines.length },
  );

  return (
    <li className="rounded-xl bg-ink-0 px-4 py-3 ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-50">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm font-semibold tracking-tight text-ink-1000">
            {proposal.code} · {customer}
          </span>
          <span className="text-xs text-ink-500">
            {proposal.formulation_name} · {productLabel}
          </span>
          <span className="text-[11px] text-ink-400">
            {t("card.submitted_at", {
              time: format.relativeTime(new Date(proposal.updated_at), now),
            })}
          </span>
        </div>
        <Link
          href={`/proposals/${proposal.id}?action=approve`}
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
        >
          <CheckCircle2 className="h-4 w-4" />
          {t("card.open")}
        </Link>
      </div>
    </li>
  );
}


function SpecificationCard({ sheet }: { sheet: SpecificationSheetDto }) {
  const t = useTranslations("approvals");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });

  const client =
    sheet.client_company || sheet.client_name || t("card.no_client");

  return (
    <li className="rounded-xl bg-ink-0 px-4 py-3 ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-50">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm font-semibold tracking-tight text-ink-1000">
            {sheet.code || t("card.no_formulation")} · {client}
          </span>
          <span className="text-xs text-ink-500">
            {sheet.formulation_name || t("card.no_formulation")} ·{" "}
            {t("card.version", { version: sheet.formulation_version_number })}
          </span>
          <span className="text-[11px] text-ink-400">
            {t("card.submitted_at", {
              time: format.relativeTime(new Date(sheet.updated_at), now),
            })}
          </span>
        </div>
        <Link
          href={`/specifications/${sheet.id}?action=approve`}
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
        >
          <CheckCircle2 className="h-4 w-4" />
          {t("card.open")}
        </Link>
      </div>
    </li>
  );
}
