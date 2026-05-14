"use client";

import {
  AlertCircle,
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  FileSignature,
  Inbox,
  Paperclip,
  Plus,
  Send,
  Stamp,
} from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { Link } from "@/i18n/navigation";
import { useProposals, type ProposalDto } from "@/services/proposals";
import {
  useInfiniteSpecifications,
  type SpecificationSheetDto,
} from "@/services/specifications";

import { SpecCreateProposalModal } from "./spec-create-proposal-modal";


type TopTab = "proposals" | "specifications";
type SubTab = "pipeline" | "signed";
type CardMode = "approved" | "sent" | "signed";


/**
 * Two-axis archive view.
 *
 * Top tabs select the document type (proposals vs specification
 * sheets); sub-tabs split each type by where the document sits in
 * its customer-facing lifecycle:
 *
 *   * ``Pipeline`` (default) — documents still moving toward a
 *     customer signature. Split into two sections:
 *       * **Ready to send** (``status=approved``) — director has
 *         signed off, waiting for someone to mail it out.
 *       * **Awaiting customer signature** (``status=sent``) — out
 *         with the client, kiosk link live.
 *   * ``Signed`` — terminal state (``status=accepted``). The kiosk
 *     signature is already on the document.
 *
 * Three queries fire per document type (one per status) regardless
 * of the active sub-tab. They're cheap (filtered by status on a
 * single org column) and firing them eagerly means switching tabs
 * is instant rather than flashing a spinner on every click.
 */
export function SignedDocuments({
  orgId,
  canViewProposals,
  canViewSpecs,
}: {
  orgId: string;
  canViewProposals: boolean;
  canViewSpecs: boolean;
}) {
  const t = useTranslations("signed");
  const [topTab, setTopTab] = useState<TopTab>(
    canViewProposals ? "proposals" : "specifications",
  );
  const [subTab, setSubTab] = useState<SubTab>("pipeline");

  // Empty orgId disables the underlying hook (see the
  // ``enabled: Boolean(orgId)`` guard) so we don't fire a fetch the
  // caller would only get back as 403.
  const approvedProposals = useProposals(canViewProposals ? orgId : "", {
    status: "approved",
  });
  const sentProposals = useProposals(canViewProposals ? orgId : "", {
    status: "sent",
  });
  const signedProposals = useProposals(canViewProposals ? orgId : "", {
    status: "accepted",
  });
  const approvedSpecs = useInfiniteSpecifications(canViewSpecs ? orgId : "", {
    status: "approved",
    pageSize: 100,
  });
  const sentSpecs = useInfiniteSpecifications(canViewSpecs ? orgId : "", {
    status: "sent",
    pageSize: 100,
  });
  const signedSpecs = useInfiniteSpecifications(canViewSpecs ? orgId : "", {
    status: "accepted",
    pageSize: 100,
  });

  const proposalsApproved = canViewProposals
    ? approvedProposals.data ?? []
    : [];
  const proposalsSent = canViewProposals ? sentProposals.data ?? [] : [];
  const proposalsSigned = canViewProposals
    ? signedProposals.data ?? []
    : [];
  // ``Unlinked first`` ranking — specs without a ``linked_proposal``
  // are the action items (no quote has been raised against the sheet
  // yet, so the sales team needs to do something). We surface them
  // at the top of every spec column on this tab; within each bucket
  // the backend's ``-updated_at`` ordering is preserved (the sort is
  // stable in modern JS engines).
  const unlinkedFirst = <T extends { linked_proposal: unknown }>(
    rows: readonly T[],
  ): T[] =>
    [...rows].sort((a, b) => {
      const aLinked = a.linked_proposal == null ? 0 : 1;
      const bLinked = b.linked_proposal == null ? 0 : 1;
      return aLinked - bLinked;
    });

  const specsApproved = useMemo(
    () =>
      canViewSpecs
        ? unlinkedFirst(
            approvedSpecs.data?.pages.flatMap((p) => p.results) ?? [],
          )
        : [],
    [approvedSpecs.data, canViewSpecs],
  );
  const specsSent = useMemo(
    () =>
      canViewSpecs
        ? unlinkedFirst(
            sentSpecs.data?.pages.flatMap((p) => p.results) ?? [],
          )
        : [],
    [sentSpecs.data, canViewSpecs],
  );
  const specsSigned = useMemo(
    () =>
      canViewSpecs
        ? unlinkedFirst(
            signedSpecs.data?.pages.flatMap((p) => p.results) ?? [],
          )
        : [],
    [signedSpecs.data, canViewSpecs],
  );

  // Top-tab counters: every document in any of the lifecycle states
  // tracked on this page. Lets the user see the full volume of
  // customer-facing work in one glance before picking which type.
  const proposalsTotal =
    proposalsApproved.length + proposalsSent.length + proposalsSigned.length;
  const specsTotal =
    specsApproved.length + specsSent.length + specsSigned.length;

  // Sub-tab counters. Per top tab so the badge reflects only the
  // currently-selected document type.
  const pipelineCount =
    topTab === "proposals"
      ? proposalsApproved.length + proposalsSent.length
      : specsApproved.length + specsSent.length;
  const signedCount =
    topTab === "proposals" ? proposalsSigned.length : specsSigned.length;

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
          <TopTabButton
            active={topTab === "proposals"}
            onClick={() => setTopTab("proposals")}
            icon={<FileSignature className="h-4 w-4" />}
            label={t("tabs.proposals")}
            count={proposalsTotal}
          />
        ) : null}
        {canViewSpecs ? (
          <TopTabButton
            active={topTab === "specifications"}
            onClick={() => setTopTab("specifications")}
            icon={<ClipboardCheck className="h-4 w-4" />}
            label={t("tabs.specifications")}
            count={specsTotal}
          />
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap gap-2 border-t border-ink-100 pt-4">
        <SubTabButton
          active={subTab === "pipeline"}
          onClick={() => setSubTab("pipeline")}
          label={t("sub_tabs.pipeline")}
          hint={t("sub_tabs.pipeline_hint")}
          count={pipelineCount}
        />
        <SubTabButton
          active={subTab === "signed"}
          onClick={() => setSubTab("signed")}
          label={t("sub_tabs.signed")}
          hint={t("sub_tabs.signed_hint")}
          count={signedCount}
        />
      </div>

      {topTab === "proposals" && canViewProposals ? (
        subTab === "pipeline" ? (
          <div className="mt-6 flex flex-col gap-8">
            <ProposalsSection
              heading={t("sections.ready_to_send")}
              hint={t("sections.ready_to_send_hint")}
              icon={<Stamp className="h-4 w-4" />}
              emptyMessage={t("empty.ready_to_send_proposals")}
              proposals={proposalsApproved}
              loading={approvedProposals.isLoading}
              errored={approvedProposals.isError}
              mode="approved"
            />
            <ProposalsSection
              heading={t("sections.awaiting")}
              hint={t("sections.awaiting_hint")}
              icon={<Send className="h-4 w-4" />}
              emptyMessage={t("empty.awaiting_proposals")}
              proposals={proposalsSent}
              loading={sentProposals.isLoading}
              errored={sentProposals.isError}
              mode="sent"
            />
          </div>
        ) : (
          <div className="mt-6 flex flex-col gap-8">
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
        )
      ) : null}
      {topTab === "specifications" && canViewSpecs ? (
        subTab === "pipeline" ? (
          <div className="mt-6 flex flex-col gap-8">
            <SpecsSection
              orgId={orgId}
              heading={t("sections.ready_to_send")}
              hint={t("sections.ready_to_send_hint")}
              icon={<Stamp className="h-4 w-4" />}
              emptyMessage={t("empty.ready_to_send_specs")}
              specs={specsApproved}
              loading={approvedSpecs.isLoading}
              errored={approvedSpecs.isError}
              mode="approved"
            />
            <SpecsSection
              orgId={orgId}
              heading={t("sections.awaiting")}
              hint={t("sections.awaiting_hint")}
              icon={<Send className="h-4 w-4" />}
              emptyMessage={t("empty.awaiting_specs")}
              specs={specsSent}
              loading={sentSpecs.isLoading}
              errored={sentSpecs.isError}
              mode="sent"
            />
          </div>
        ) : (
          <div className="mt-6 flex flex-col gap-8">
            <SpecsSection
              orgId={orgId}
              heading={t("sections.signed")}
              icon={<CheckCircle2 className="h-4 w-4" />}
              emptyMessage={t("empty.signed_specs")}
              specs={specsSigned}
              loading={signedSpecs.isLoading}
              errored={signedSpecs.isError}
              mode="signed"
            />
          </div>
        )
      ) : null}
    </section>
  );
}


function TopTabButton({
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


function SubTabButton({
  active,
  onClick,
  label,
  hint,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className={`inline-flex h-8 items-center gap-2 rounded-full px-3 text-xs font-medium ring-1 ring-inset transition-colors ${
        active
          ? "bg-ink-1000 text-ink-0 ring-ink-1000"
          : "bg-ink-0 text-ink-600 ring-ink-200 hover:bg-ink-50"
      }`}
    >
      <span>{label}</span>
      <span
        className={`inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
          active ? "bg-ink-0/20 text-ink-0" : "bg-ink-100 text-ink-700"
        }`}
      >
        {count}
      </span>
    </button>
  );
}


function ProposalsSection({
  heading,
  hint,
  icon,
  emptyMessage,
  proposals,
  loading,
  errored,
  mode,
}: {
  heading: string;
  hint?: string;
  icon: React.ReactNode;
  emptyMessage: string;
  proposals: readonly ProposalDto[];
  loading: boolean;
  errored: boolean;
  mode: CardMode;
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
      {hint ? (
        <p className="mt-1 text-xs text-ink-500">{hint}</p>
      ) : null}
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
  orgId,
  heading,
  hint,
  icon,
  emptyMessage,
  specs,
  loading,
  errored,
  mode,
}: {
  orgId: string;
  heading: string;
  hint?: string;
  icon: React.ReactNode;
  emptyMessage: string;
  specs: readonly SpecificationSheetDto[];
  loading: boolean;
  errored: boolean;
  mode: CardMode;
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
      {hint ? (
        <p className="mt-1 text-xs text-ink-500">{hint}</p>
      ) : null}
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
            <SpecCard key={s.id} orgId={orgId} sheet={s} mode={mode} />
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
  mode: CardMode;
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

  // Pick the timestamp that matches the lifecycle stage being shown.
  // ``approved`` prefers the director-signature timestamp (the
  // moment the doc became sendable); ``signed`` prefers the customer
  // signature; both fall back to ``updated_at`` if the signature
  // stamp is missing — which can happen for legacy data signed
  // before the timestamped flow was wired in.
  const stampSource =
    mode === "approved"
      ? proposal.director_signed_at ?? proposal.updated_at
      : mode === "signed" && proposal.customer_signed_at
        ? proposal.customer_signed_at
        : proposal.updated_at;
  const stampKey =
    mode === "approved"
      ? "card.approved_at"
      : mode === "signed"
        ? "card.signed_at"
        : "card.sent_at";
  const stampLabel = t(stampKey, {
    time: format.relativeTime(new Date(stampSource), now),
  });

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
  orgId,
  sheet,
  mode,
}: {
  orgId: string;
  sheet: SpecificationSheetDto;
  mode: CardMode;
}) {
  const t = useTranslations("signed");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const [createOpen, setCreateOpen] = useState(false);

  const client =
    sheet.client_company ||
    sheet.client_name ||
    sheet.customer_company ||
    sheet.customer_name ||
    t("card.no_client");

  // Spec sheets don't carry a director-signature timestamp on the
  // list DTO (only the render view-model has it), so the
  // ``approved`` mode falls back to ``updated_at`` — the moment
  // the status flipped is the cheapest proxy.
  const stampSource =
    mode === "signed" && sheet.customer_signed_at
      ? sheet.customer_signed_at
      : sheet.updated_at;
  const stampKey =
    mode === "approved"
      ? "card.approved_at"
      : mode === "signed"
        ? "card.signed_at"
        : "card.sent_at";
  const stampLabel = t(stampKey, {
    time: format.relativeTime(new Date(stampSource), now),
  });

  // ``approved`` mode is the "Ready to send" surface, where partners
  // are deciding whether each sheet still needs a quote — surface the
  // linked proposal chip there. We intentionally suppress it on the
  // ``sent`` / ``signed`` modes: by the time a sheet is out for kiosk
  // signature or already signed, the existence of a proposal is no
  // longer the relevant question.
  const showProposalChip = mode === "approved";

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
          {showProposalChip ? (
            <ProposalLinkageChip
              sheet={sheet}
              onCreate={() => setCreateOpen(true)}
            />
          ) : null}
        </div>
        <Link
          href={`/specifications/${sheet.id}`}
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink-0 px-4 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
        >
          <ExternalLink className="h-4 w-4" />
          {t("card.open")}
        </Link>
      </div>
      {showProposalChip && sheet.linked_proposal === null ? (
        <SpecCreateProposalModal
          orgId={orgId}
          sheet={sheet}
          isOpen={createOpen}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}
    </li>
  );
}


/**
 * Inline chip that answers "has a proposal been raised against this
 * sheet yet?" on the Ready-to-send Pipeline view. Two states:
 *
 *   * **Linked** — clickable chip with the proposal code + status.
 *     Clicking jumps to the proposal detail page.
 *   * **Unlinked** — warning chip + a secondary "Create proposal"
 *     button that deep-links to the project workspace's proposals
 *     tab. The workspace's New Proposal modal already pre-selects
 *     the formulation's approved version, so the operator only has
 *     to fill in customer + price.
 */
function ProposalLinkageChip({
  sheet,
  onCreate,
}: {
  sheet: SpecificationSheetDto;
  onCreate: () => void;
}) {
  const t = useTranslations("signed");
  const linked = sheet.linked_proposal;
  if (linked) {
    return (
      <Link
        href={`/proposals/${linked.id}`}
        className="mt-1 inline-flex items-center gap-1.5 self-start rounded-full bg-orange-500/10 px-2 py-0.5 text-[11px] font-medium text-orange-700 ring-1 ring-inset ring-orange-500/30 hover:bg-orange-500/20"
      >
        <Paperclip className="h-3 w-3" />
        {t("card.proposal_linked", {
          code: linked.code,
          status: linked.status,
        })}
      </Link>
    );
  }
  return (
    <span className="mt-1 inline-flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning ring-1 ring-inset ring-warning/30">
        <AlertCircle className="h-3 w-3" />
        {t("card.proposal_missing")}
      </span>
      <button
        type="button"
        onClick={onCreate}
        className="inline-flex items-center gap-1 text-[11px] font-medium text-orange-700 hover:text-orange-800"
      >
        <Plus className="h-3 w-3" />
        {t("card.proposal_create")}
      </button>
    </span>
  );
}
