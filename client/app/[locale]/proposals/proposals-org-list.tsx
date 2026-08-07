"use client";

import {
  ExternalLink,
  Loader2,
  Plus,
  PoundSterling,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Link } from "@/i18n/navigation";
import { extractApiErrorMessage } from "@/lib/errors/translate";
import {
  useDeleteProposal,
  useInfiniteProposals,
  type ProposalListItemDto,
  type ProposalStatus,
} from "@/services/proposals";

import {
  ProposalsFilterBar,
  useProposalsFiltersState,
  type ProposalsTemplateType,
} from "./proposals-filter-bar";


/**
 * Org-wide proposals list. Same shape as the per-project panel but
 * un-scoped — renders every proposal in the caller's organization
 * so a sales user can find a quote without knowing which project
 * it started on.
 *
 * The create modal asks for a formulation + version to seed the
 * first line; scientists add additional products (potentially from
 * different projects) from the proposal detail page's lines panel.
 */
export function ProposalsOrgList({ orgId }: { orgId: string }) {
  const tProposals = useTranslations("proposals");
  const tErrors = useTranslations("errors");

  const filters = useProposalsFiltersState();
  // Backend queries on ``applied`` only — the pending state stays
  // local to the bar until the user hits Apply.
  const applied = filters.applied;
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetching,
    isFetchingNextPage,
    isLoading,
  } = useInfiniteProposals(orgId, {
    statuses: applied.statuses,
    search: applied.search || undefined,
    salesPersonId: applied.salesPersonId || undefined,
    validUntilFrom: applied.validUntilFrom || undefined,
    validUntilTo: applied.validUntilTo || undefined,
    templateType: applied.templateType || undefined,
  });
  const deleteMutation = useDeleteProposal(orgId);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Flatten the cursor pages into a single roster. ``useMemo`` keeps
  // the array reference stable across re-renders that didn't touch
  // the data — the row components are otherwise free to re-render
  // on every parent paint, which is wasted work when only the
  // filter bar's pending state changed.
  const proposals: readonly ProposalListItemDto[] = useMemo(
    () => data?.pages.flatMap((page) => page.results) ?? [],
    [data],
  );

  const handleDelete = useCallback(
    async (proposalId: string) => {
      if (!confirm(tProposals("list.delete_confirm"))) return;
      setDeleteError(null);
      try {
        await deleteMutation.mutateAsync(proposalId);
      } catch (err) {
        setDeleteError(extractApiErrorMessage(err, tErrors));
      }
    },
    [deleteMutation, tErrors, tProposals],
  );

  // IntersectionObserver-driven infinite scroll. A sentinel ``<li>``
  // rendered just past the last row triggers ``fetchNextPage`` when
  // it enters the viewport — the standard pagination pattern,
  // without the layout fragility a window virtualiser would add for
  // what is realistically a few-hundred-row list. The real perf win
  // is server-side (pagination + dropped ``lines`` array); on the
  // client, plain DOM rows perform fine until the page count is in
  // the thousands, at which point swapping in a virtualiser is a
  // localised change.
  const sentinelRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    if (!hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (
            entry.isIntersecting &&
            hasNextPage &&
            !isFetchingNextPage &&
            !isFetching
          ) {
            void fetchNextPage();
            // One trigger per observe cycle — the next page's render
            // re-mounts the sentinel below the new tail, which then
            // arms a fresh observation. Avoids back-to-back fires
            // while React is still committing the new rows.
            break;
          }
        }
      },
      // ``rootMargin: 200px`` so the load fires while the sentinel
      // is still ~200px below the viewport edge — the next page lands
      // on screen before the user actually reaches the bottom, so
      // scrolling feels continuous rather than stutter-loading at
      // each cursor boundary.
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, isFetching, fetchNextPage]);

  const showEmpty = !isLoading && proposals.length === 0;

  return (
    <section className="mt-6 rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 md:p-8">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-100 pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink-1000 md:text-2xl">
            {tProposals("list.title")}
          </h1>
          <p className="mt-0.5 text-sm text-ink-500">
            {tProposals("list.org_subtitle")}
          </p>
        </div>
        {/* Proposal creation flows through /signed now — pick one or
            more director-approved spec sheets there and the "Create
            proposal" action turns them into a single quote. Keeps
            everyone on one path instead of two divergent modals. */}
        <Link
          href="/signed"
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-orange-500 px-3 text-sm font-medium text-ink-0 hover:bg-orange-600"
        >
          <Plus className="h-4 w-4" />
          {tProposals("create.trigger")}
        </Link>
      </header>

      {/* Top-of-list tab strip splits manually authored proposals
          from the auto-drafted RTG orders coming out of the
          customer portal. Tab click applies immediately — the tab
          is a navigation pivot, not a filter, and shouldn't cost
          the operator an Apply gesture. */}
      <div className="mt-4">
        <TemplateTypeTabs
          value={filters.applied.templateType}
          onChange={filters.setTemplateType}
        />
      </div>

      <div className="mt-4">
        <ProposalsFilterBar
          orgId={orgId}
          filters={filters}
          isFetching={isFetching}
        />
      </div>

      {deleteError ? (
        <p
          role="alert"
          className="mt-4 rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
        >
          {deleteError}
        </p>
      ) : null}

      {/* Pipeline board — four side-by-side stage columns visible
       *  at once. The single infinite-scroll query fetches every
       *  status the filter bar allows, and we split client-side
       *  into buckets so no column can hide a new order. Each
       *  column has its own local search that further narrows its
       *  bucket without disturbing the others.
       */}
      <ProposalsPipeline
        proposals={proposals}
        isLoading={isLoading}
        showEmpty={showEmpty}
        appliedAnyActive={filters.appliedAnyActive}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        sentinelRef={sentinelRef}
        onDelete={handleDelete}
        deletePending={deleteMutation.isPending}
      />
    </section>
  );
}


// --------------------------------------------------------------
// Pipeline board layout — 4 stage columns, each with own search.
// --------------------------------------------------------------


const PIPELINE_STAGES: ReadonlyArray<{
  readonly key: string;
  readonly label: string;
  readonly statuses: ReadonlyArray<ProposalStatus>;
  readonly attention: boolean;
}> = [
  {
    key: "needs_attention",
    label: "Needs attention",
    statuses: ["draft", "in_review"],
    attention: true,
  },
  {
    key: "in_flight",
    label: "In flight",
    statuses: ["approved", "sent"],
    attention: false,
  },
  {
    key: "signed",
    label: "Signed",
    statuses: ["accepted"],
    attention: false,
  },
  {
    key: "rejected",
    label: "Rejected",
    statuses: ["rejected"],
    attention: false,
  },
];


function ProposalsPipeline({
  proposals,
  isLoading,
  showEmpty,
  appliedAnyActive,
  hasNextPage,
  isFetchingNextPage,
  sentinelRef,
  onDelete,
  deletePending,
}: {
  proposals: readonly ProposalListItemDto[];
  isLoading: boolean;
  showEmpty: boolean;
  appliedAnyActive: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  sentinelRef: React.RefObject<HTMLLIElement | null>;
  onDelete: (id: string) => void;
  deletePending: boolean;
}) {
  const tProposals = useTranslations("proposals");
  // Per-column search boxes. Kept as an object keyed by stage.key
  // so we can late-bind lookups without a dozen useState calls.
  const [searchByKey, setSearchByKey] = useState<Record<string, string>>({});

  // Split the flat feed into stage buckets. ``useMemo`` keeps
  // reference stability across parent re-renders — the ledger
  // rows are pure and memoise off the bucket identity.
  const buckets = useMemo(() => {
    const map: Record<string, ProposalListItemDto[]> = {};
    for (const stage of PIPELINE_STAGES) map[stage.key] = [];
    for (const p of proposals) {
      const stage = PIPELINE_STAGES.find((s) =>
        s.statuses.includes(p.status as ProposalStatus),
      );
      if (stage) map[stage.key]!.push(p);
    }
    return map;
  }, [proposals]);

  if (isLoading) {
    return (
      <p className="mt-6 text-sm text-ink-500">{tProposals("list.loading")}</p>
    );
  }
  if (showEmpty) {
    return (
      <div className="mt-6 rounded-xl bg-ink-50 px-4 py-8 text-center ring-1 ring-inset ring-ink-200">
        <PoundSterling className="mx-auto h-6 w-6 text-ink-400" />
        <p className="mt-2 text-sm text-ink-500">
          {appliedAnyActive
            ? tProposals("list.no_matches_filtered")
            : tProposals("list.empty")}
        </p>
        {appliedAnyActive ? (
          <p className="mt-1 text-xs text-ink-400">
            {tProposals("list.no_matches_hint")}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <div className="mt-4 grid gap-4 lg:grid-cols-4">
        {PIPELINE_STAGES.map((stage) => {
          const rows = buckets[stage.key] ?? [];
          const q = (searchByKey[stage.key] ?? "").trim().toLowerCase();
          const filtered = q
            ? rows.filter((p) =>
                (
                  (p.code || "") +
                  " " +
                  (p.customer_company || "") +
                  " " +
                  (p.customer_name || "") +
                  " " +
                  (p.reference || "")
                )
                  .toLowerCase()
                  .includes(q),
              )
            : rows;
          return (
            <article
              key={stage.key}
              className="flex min-h-[24rem] flex-col rounded-2xl bg-ink-0 shadow-sm ring-1 ring-ink-200"
            >
              <header className="border-b border-ink-100 p-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-ink-1000">
                    {stage.label}
                  </h2>
                  {rows.length > 0 ? (
                    <span
                      className={
                        "rounded-full px-2 py-0.5 text-[10px] font-semibold " +
                        (stage.attention
                          ? "bg-amber-100 text-amber-800"
                          : "bg-ink-100 text-ink-700")
                      }
                    >
                      {rows.length}
                    </span>
                  ) : null}
                </div>
                <div className="relative mt-2.5">
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400"
                    aria-hidden
                  />
                  <input
                    type="search"
                    value={searchByKey[stage.key] ?? ""}
                    onChange={(e) =>
                      setSearchByKey((prev) => ({
                        ...prev,
                        [stage.key]: e.target.value,
                      }))
                    }
                    placeholder="Search…"
                    className="h-9 w-full rounded-lg bg-ink-50 pl-9 pr-9 text-xs text-ink-1000 ring-1 ring-inset ring-transparent placeholder:text-ink-400 focus:bg-ink-0 focus:outline-none focus:ring-orange-400"
                  />
                  {searchByKey[stage.key] ? (
                    <button
                      type="button"
                      onClick={() =>
                        setSearchByKey((prev) => ({
                          ...prev,
                          [stage.key]: "",
                        }))
                      }
                      aria-label="Clear search"
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-500 hover:bg-ink-100 hover:text-ink-1000"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              </header>
              <div className="flex-1 space-y-2 overflow-y-auto p-3">
                {filtered.length === 0 ? (
                  <p className="p-4 text-center text-xs text-ink-500">
                    {q
                      ? `Nothing matches "${q}".`
                      : stage.attention
                        ? "Nothing waiting on you here."
                        : "Empty."}
                  </p>
                ) : (
                  filtered.map((proposal) => (
                    <ProposalCard
                      key={proposal.id}
                      proposal={proposal}
                      onDelete={onDelete}
                      deletePending={deletePending}
                    />
                  ))
                )}
              </div>
            </article>
          );
        })}
      </div>

      {/* Load-more sentinel lives outside the columns so the shared
       *  cursor still advances regardless of which stage the user
       *  is looking at. */}
      {hasNextPage ? (
        <ul className="mt-2">
          <li ref={sentinelRef} aria-hidden className="h-1" />
        </ul>
      ) : null}
      {isFetchingNextPage ? (
        <p className="mt-2 inline-flex items-center gap-1 text-xs text-ink-500">
          <Loader2 className="h-3 w-3 animate-spin" />
          {tProposals("list.loading")}
        </p>
      ) : null}
    </>
  );
}


// Compact card version of OrgProposalRow that fits a narrow column.
function ProposalCard({
  proposal,
  onDelete,
  deletePending,
}: {
  proposal: ProposalListItemDto;
  onDelete: (id: string) => void;
  deletePending: boolean;
}) {
  const tProposals = useTranslations("proposals");
  const total = proposal.total_excl_vat ?? proposal.subtotal ?? null;
  const canDelete =
    proposal.status !== "approved" &&
    proposal.status !== "sent" &&
    proposal.status !== "accepted" &&
    proposal.status !== "rejected";

  return (
    <div className="rounded-xl border border-ink-100 bg-ink-0 p-3 shadow-sm hover:border-ink-200 hover:shadow">
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/proposals/${proposal.id}`}
          className="min-w-0 flex-1"
        >
          <div className="flex items-center gap-1.5">
            <p className="truncate text-xs font-semibold text-ink-1000">
              {proposal.code}
            </p>
            {(proposal.template_type === "ready_to_go" ||
              proposal.template_type === "custom") && (
              <TemplateTypeChip type={proposal.template_type} />
            )}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-ink-600">
            {proposal.customer_company ||
              proposal.customer_name ||
              tProposals("list.no_customer")}
          </p>
        </Link>
        <Link
          href={`/proposals/${proposal.id}`}
          className="text-ink-400 hover:text-ink-700"
          aria-label={tProposals("list.open")}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-2 text-[10px] text-ink-500">
        <span>
          {total !== null ? (
            <>
              <PoundSterling className="mr-0.5 inline h-3 w-3" />
              {total}
            </>
          ) : (
            "—"
          )}
        </span>
        <span>
          {proposal.updated_at
            ? new Date(proposal.updated_at).toLocaleDateString()
            : ""}
        </span>
      </div>
      {canDelete ? (
        <div className="mt-1.5 flex justify-end">
          <button
            type="button"
            onClick={() => onDelete(proposal.id)}
            disabled={deletePending}
            aria-label={tProposals("list.delete")}
            className="rounded p-1 text-ink-400 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}
    </div>
  );
}


function TemplateTypeTabs({
  value,
  onChange,
}: {
  value: ProposalsTemplateType;
  onChange: (next: ProposalsTemplateType) => void;
}) {
  const tabs: readonly {
    key: ProposalsTemplateType;
    label: string;
  }[] = [
    { key: "", label: "All" },
    { key: "custom", label: "Custom" },
    { key: "ready_to_go", label: "Ready-to-Go" },
  ];
  return (
    <div
      role="tablist"
      aria-label="Proposal type"
      className="inline-flex items-center gap-1 rounded-full bg-ink-50 p-1 ring-1 ring-ink-200"
    >
      {tabs.map((tab) => {
        const active = value === tab.key;
        return (
          <button
            key={tab.key || "__all__"}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.key)}
            className={`inline-flex items-center rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
              active
                ? "bg-white text-ink-1000 shadow-sm"
                : "text-ink-500 hover:text-ink-800"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}


function TemplateTypeChip({
  type,
}: {
  type: "custom" | "ready_to_go";
}) {
  // Two-tone treatment so the type is unmissable in the "All" tab
  // view — sales can tell a manually authored quote from an
  // auto-drafted RTG order without reading the metadata line.
  if (type === "ready_to_go") {
    return (
      <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-800">
        RTG
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-700">
      Custom
    </span>
  );
}


function OrgProposalRow({
  proposal,
  onDelete,
  deletePending,
}: {
  proposal: ProposalListItemDto;
  onDelete: (id: string) => void;
  deletePending: boolean;
}) {
  const tProposals = useTranslations("proposals");
  const total = proposal.total_excl_vat ?? proposal.subtotal ?? null;
  // Once the director has approved a proposal the trash button
  // disappears: an approved record carries internal signatures that
  // would orphan on delete, and ``sent`` / ``accepted`` / ``rejected``
  // are part of the audit trail. The backend mirrors this lock via
  // :class:`ProposalNotMutable` so a crafted DELETE can't bypass.
  const isTerminal =
    proposal.status === "approved" ||
    proposal.status === "sent" ||
    proposal.status === "accepted" ||
    proposal.status === "rejected";
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/proposals/${proposal.id}`}
            className="text-sm font-medium text-ink-1000 hover:text-orange-700"
          >
            {proposal.code} ·{" "}
            {proposal.customer_company ||
              proposal.customer_name ||
              tProposals("list.no_customer")}
          </Link>
          {/* Type chip is coloured so it's unmissable inside the
              "All" tab; RTG in blue, Custom in muted grey. Matches
              the same two-tone convention used on the CFF inbox
              and RTG catalog cards. */}
          {(proposal.template_type === "ready_to_go" ||
            proposal.template_type === "custom") && (
            <TemplateTypeChip type={proposal.template_type} />
          )}
        </div>
        <span className="text-xs text-ink-500">
          {/* Project (formulation) name surfaces the recipe the
              proposal is quoting against. Listed first so a scientist
              scanning the page can match a proposal to "what is this
              actually selling" without clicking through. Falls back
              gracefully if the formulation link is missing on a
              legacy row. */}
          {proposal.formulation_name ? (
            <>
              <span className="font-medium text-ink-700">
                {proposal.formulation_name}
              </span>
              {" · "}
            </>
          ) : null}
          {tProposals(
            `template_type.${proposal.template_type}` as "template_type.custom",
          )}
          {" · "}
          {proposal.lines_count}{" "}
          {tProposals("list.products_count", {
            count: proposal.lines_count,
          })}
          {total !== null ? ` · ${total} ${proposal.currency}` : ""}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <StatusChip status={proposal.status} />
        <Link
          href={`/proposals/${proposal.id}`}
          prefetch={false}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
        >
          <ExternalLink className="h-3.5 w-3.5 text-ink-400" />
          {tProposals("list.view")}
        </Link>
        {isTerminal ? null : (
          <button
            type="button"
            aria-label={tProposals("list.delete")}
            onClick={() => onDelete(proposal.id)}
            disabled={deletePending}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-500 transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
    </li>
  );
}


function StatusChip({ status }: { status: ProposalStatus }) {
  const tProposals = useTranslations("proposals");
  const variants: Record<ProposalStatus, string> = {
    draft: "bg-ink-100 text-ink-700 ring-ink-200",
    in_review: "bg-warning/10 text-warning ring-warning/20",
    approved: "bg-orange-500/10 text-orange-700 ring-orange-500/30",
    sent: "bg-orange-500/10 text-orange-700 ring-orange-500/30",
    accepted: "bg-success/10 text-success ring-success/30",
    rejected: "bg-danger/10 text-danger ring-danger/30",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset ${variants[status]}`}
    >
      {tProposals(`status.${status}` as "status.draft")}
    </span>
  );
}
