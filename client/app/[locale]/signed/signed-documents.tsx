"use client";

import {
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  FileSignature,
  Inbox,
  Send,
} from "lucide-react";
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
 * Two-tab archive view. Each tab fires two queries — one for
 * ``status=sent`` and one for ``status=accepted`` — so the user
 * sees both halves of the customer-facing flow on a single screen
 * without a sub-tab click. The list endpoints already support the
 * ``status`` filter (added when the approvals inbox was wired in),
 * so no new backend surface is needed here.
 */
export function SignedDocuments({ orgId }: { orgId: string }) {
  const t = useTranslations("signed");
  const [tab, setTab] = useState<Tab>("proposals");

  const sentProposals = useProposals(orgId, { status: "sent" });
  const signedProposals = useProposals(orgId, { status: "accepted" });
  const sentSpecs = useInfiniteSpecifications(orgId, {
    status: "sent",
    pageSize: 100,
  });
  const signedSpecs = useInfiniteSpecifications(orgId, {
    status: "accepted",
    pageSize: 100,
  });

  const proposalsSent = sentProposals.data ?? [];
  const proposalsSigned = signedProposals.data ?? [];
  const specsSent = useMemo(
    () => sentSpecs.data?.pages.flatMap((p) => p.results) ?? [],
    [sentSpecs.data],
  );
  const specsSigned = useMemo(
    () => signedSpecs.data?.pages.flatMap((p) => p.results) ?? [],
    [signedSpecs.data],
  );

  const proposalsTotal = proposalsSent.length + proposalsSigned.length;
  const specsTotal = specsSent.length + specsSigned.length;

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
        <TabButton
          active={tab === "proposals"}
          onClick={() => setTab("proposals")}
          icon={<FileSignature className="h-4 w-4" />}
          label={t("tabs.proposals")}
          count={proposalsTotal}
        />
        <TabButton
          active={tab === "specifications"}
          onClick={() => setTab("specifications")}
          icon={<ClipboardCheck className="h-4 w-4" />}
          label={t("tabs.specifications")}
          count={specsTotal}
        />
      </div>

      {tab === "proposals" ? (
        <div className="mt-6 flex flex-col gap-8">
          <ProposalsSection
            heading={t("sections.awaiting")}
            icon={<Send className="h-4 w-4" />}
            emptyMessage={t("empty.awaiting_proposals")}
            proposals={proposalsSent}
            loading={sentProposals.isLoading}
            errored={sentProposals.isError}
            mode="sent"
          />
          <ProposalsSection
            heading={t("sections.signed")}
            icon={<CheckCircle2 className="h-4 w-4" />}
            emptyMessage={t("empty.signed_proposals")}
            proposals={proposalsSigned}
            loading={signedProposals.isLoading}
            errored={signedProposals.isError}
            mode="signed"
          />
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-8">
          <SpecsSection
            heading={t("sections.awaiting")}
            icon={<Send className="h-4 w-4" />}
            emptyMessage={t("empty.awaiting_specs")}
            specs={specsSent}
            loading={sentSpecs.isLoading}
            errored={sentSpecs.isError}
            mode="sent"
          />
          <SpecsSection
            heading={t("sections.signed")}
            icon={<CheckCircle2 className="h-4 w-4" />}
            emptyMessage={t("empty.signed_specs")}
            specs={specsSigned}
            loading={signedSpecs.isLoading}
            errored={signedSpecs.isError}
            mode="signed"
          />
        </div>
      )}
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


function ProposalsSection({
  heading,
  icon,
  emptyMessage,
  proposals,
  loading,
  errored,
  mode,
}: {
  heading: string;
  icon: React.ReactNode;
  emptyMessage: string;
  proposals: readonly ProposalDto[];
  loading: boolean;
  errored: boolean;
  mode: "sent" | "signed";
}) {
  const t = useTranslations("signed");
  return (
    <div>
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ink-700">
        {icon}
        <span>{heading}</span>
        <span className="ml-1 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-ink-100 px-1.5 text-[11px] font-semibold text-ink-700">
          {proposals.length}
        </span>
      </h2>
      {loading ? (
        <p className="mt-3 text-sm text-ink-500">{t("loading")}</p>
      ) : errored ? (
        <p
          role="alert"
          className="mt-3 rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
        >
          {t("errors.load")}
        </p>
      ) : proposals.length === 0 ? (
        <EmptyState message={emptyMessage} />
      ) : (
        <ul className="mt-3 flex flex-col gap-3">
          {proposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} mode={mode} />
          ))}
        </ul>
      )}
    </div>
  );
}


function SpecsSection({
  heading,
  icon,
  emptyMessage,
  specs,
  loading,
  errored,
  mode,
}: {
  heading: string;
  icon: React.ReactNode;
  emptyMessage: string;
  specs: readonly SpecificationSheetDto[];
  loading: boolean;
  errored: boolean;
  mode: "sent" | "signed";
}) {
  const t = useTranslations("signed");
  return (
    <div>
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ink-700">
        {icon}
        <span>{heading}</span>
        <span className="ml-1 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-ink-100 px-1.5 text-[11px] font-semibold text-ink-700">
          {specs.length}
        </span>
      </h2>
      {loading ? (
        <p className="mt-3 text-sm text-ink-500">{t("loading")}</p>
      ) : errored ? (
        <p
          role="alert"
          className="mt-3 rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
        >
          {t("errors.load")}
        </p>
      ) : specs.length === 0 ? (
        <EmptyState message={emptyMessage} />
      ) : (
        <ul className="mt-3 flex flex-col gap-3">
          {specs.map((s) => (
            <SpecCard key={s.id} sheet={s} mode={mode} />
          ))}
        </ul>
      )}
    </div>
  );
}


function EmptyState({ message }: { message: string }) {
  return (
    <div className="mt-3 rounded-xl bg-ink-50 px-4 py-8 text-center ring-1 ring-inset ring-ink-200">
      <Inbox className="mx-auto h-6 w-6 text-ink-400" />
      <p className="mt-2 text-sm text-ink-500">{message}</p>
    </div>
  );
}


function ProposalCard({
  proposal,
  mode,
}: {
  proposal: ProposalDto;
  mode: "sent" | "signed";
}) {
  const t = useTranslations("signed");
  const format = useFormatter();
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

  // Signed cards prefer the kiosk acceptance timestamp; sent cards
  // fall back to ``updated_at`` since that's the moment the
  // proposal flipped into ``sent`` and got the public link.
  const stampSource =
    mode === "signed" && proposal.customer_signed_at
      ? proposal.customer_signed_at
      : proposal.updated_at;
  const stampLabel = t(
    mode === "signed" ? "card.signed_at" : "card.sent_at",
    { time: format.relativeTime(new Date(stampSource), now) },
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
          <span className="text-[11px] text-ink-400">{stampLabel}</span>
        </div>
        <Link
          href={`/proposals/${proposal.id}`}
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink-0 px-4 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
        >
          <ExternalLink className="h-4 w-4" />
          {t("card.open")}
        </Link>
      </div>
    </li>
  );
}


function SpecCard({
  sheet,
  mode,
}: {
  sheet: SpecificationSheetDto;
  mode: "sent" | "signed";
}) {
  const t = useTranslations("signed");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });

  const client =
    sheet.client_company ||
    sheet.client_name ||
    sheet.customer_company ||
    sheet.customer_name ||
    t("card.no_client");

  const stampSource =
    mode === "signed" && sheet.customer_signed_at
      ? sheet.customer_signed_at
      : sheet.updated_at;
  const stampLabel = t(
    mode === "signed" ? "card.signed_at" : "card.sent_at",
    { time: format.relativeTime(new Date(stampSource), now) },
  );

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
          <span className="text-[11px] text-ink-400">{stampLabel}</span>
        </div>
        <Link
          href={`/specifications/${sheet.id}`}
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink-0 px-4 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
        >
          <ExternalLink className="h-4 w-4" />
          {t("card.open")}
        </Link>
      </div>
    </li>
  );
}
