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
import { useCallback, useMemo, useState } from "react";
import type { UseInfiniteQueryResult, InfiniteData } from "@tanstack/react-query";

import { Link } from "@/i18n/navigation";
import type { ApiError } from "@/lib/api";
import { extractApiErrorMessage } from "@/lib/errors/translate";
import {
  useDeleteProposal,
  useInfiniteProposals,
  type PaginatedProposalsDto,
  type ProposalListItemDto,
  type ProposalStatus,
} from "@/services/proposals";

import {
  ProposalsFilterBar,
  useProposalsFiltersState,
  type ProposalsFiltersState,
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

  // Pipeline columns each fire their own paginated query so a big
  // "Signed" archive can't starve the small "Needs attention" list
  // (previously all four columns shared one cursor and the smaller
  // buckets refused to fill until later pages arrived). Hooks must
  // be unrolled — PIPELINE_STAGES is a fixed constant so the count
  // stays the same across renders.
  const needsAttentionQ = useStageInfiniteQuery(
    orgId,
    applied,
    PIPELINE_STAGES[0]!,
  );
  const inFlightQ = useStageInfiniteQuery(
    orgId,
    applied,
    PIPELINE_STAGES[1]!,
  );
  const signedQ = useStageInfiniteQuery(
    orgId,
    applied,
    PIPELINE_STAGES[2]!,
  );
  const rejectedQ = useStageInfiniteQuery(
    orgId,
    applied,
    PIPELINE_STAGES[3]!,
  );
  const stageQueries = useMemo(
    () => [needsAttentionQ, inFlightQ, signedQ, rejectedQ] as const,
    [needsAttentionQ, inFlightQ, signedQ, rejectedQ],
  );

  const deleteMutation = useDeleteProposal(orgId);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  const anyFetching = stageQueries.some((q) => q.isFetching);

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
          isFetching={anyFetching}
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

      {/* Pipeline board — four side-by-side stage columns, each
       *  with its own paginated query and its own "Load more"
       *  button. Per-column search stays client-side (filters the
       *  bucket that's already loaded); the shared filter bar
       *  above narrows every column's server request.
       */}
      <ProposalsPipeline
        stageQueries={stageQueries}
        appliedAnyActive={filters.appliedAnyActive}
        onDelete={handleDelete}
        deletePending={deleteMutation.isPending}
      />
    </section>
  );
}


type StageInfiniteQuery = UseInfiniteQueryResult<
  InfiniteData<PaginatedProposalsDto, string | null>,
  ApiError
>;


function useStageInfiniteQuery(
  orgId: string,
  applied: ProposalsFiltersState,
  stage: (typeof PIPELINE_STAGES)[number],
): StageInfiniteQuery {
  // Effective per-column statuses = intersection of the stage's
  // fixed statuses and the user's status filter (or the stage's
  // own list when no filter is applied). An empty intersection
  // means the filter has ruled every status in this column out,
  // so we disable the query rather than fetch a bucket we already
  // know will be empty.
  const stageStatuses = stage.statuses;
  const effective = useMemo<readonly ProposalStatus[]>(() => {
    if (applied.statuses.length === 0) return stageStatuses;
    return stageStatuses.filter((s) => applied.statuses.includes(s));
  }, [applied.statuses, stageStatuses]);

  return useInfiniteProposals(orgId, {
    statuses: effective,
    search: applied.search || undefined,
    salesPersonId: applied.salesPersonId || undefined,
    validUntilFrom: applied.validUntilFrom || undefined,
    validUntilTo: applied.validUntilTo || undefined,
    templateType: applied.templateType || undefined,
    enabled: effective.length > 0,
  });
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
  stageQueries,
  appliedAnyActive,
  onDelete,
  deletePending,
}: {
  stageQueries: ReadonlyArray<StageInfiniteQuery>;
  appliedAnyActive: boolean;
  onDelete: (id: string) => void;
  deletePending: boolean;
}) {
  const tProposals = useTranslations("proposals");
  const [searchByKey, setSearchByKey] = useState<Record<string, string>>({});

  const allLoading = stageQueries.every((q) => q.isLoading);
  const showEmpty =
    !allLoading &&
    stageQueries.every(
      (q) => (q.data?.pages.flatMap((p) => p.results) ?? []).length === 0,
    );

  if (allLoading) {
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
    <div className="mt-4 grid gap-4 lg:grid-cols-4">
      {PIPELINE_STAGES.map((stage, idx) => {
        const query = stageQueries[idx]!;
        return (
          <ProposalsPipelineColumn
            key={stage.key}
            stage={stage}
            query={query}
            search={searchByKey[stage.key] ?? ""}
            onSearchChange={(next) =>
              setSearchByKey((prev) => ({ ...prev, [stage.key]: next }))
            }
            onDelete={onDelete}
            deletePending={deletePending}
          />
        );
      })}
    </div>
  );
}


function ProposalsPipelineColumn({
  stage,
  query,
  search,
  onSearchChange,
  onDelete,
  deletePending,
}: {
  stage: (typeof PIPELINE_STAGES)[number];
  query: StageInfiniteQuery;
  search: string;
  onSearchChange: (next: string) => void;
  onDelete: (id: string) => void;
  deletePending: boolean;
}) {
  const rows = useMemo<readonly ProposalListItemDto[]>(
    () => query.data?.pages.flatMap((p) => p.results) ?? [],
    [query.data],
  );
  const needle = search.trim().toLowerCase();
  const filtered = needle
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
          .includes(needle),
      )
    : rows;

  return (
    <article className="flex min-h-[24rem] flex-col rounded-2xl bg-ink-0 shadow-sm ring-1 ring-ink-200">
      <header className="border-b border-ink-100 p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink-1000">{stage.label}</h2>
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
              {query.hasNextPage ? "+" : ""}
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
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search…"
            className="h-9 w-full rounded-lg bg-ink-50 pl-9 pr-9 text-xs text-ink-1000 ring-1 ring-inset ring-transparent placeholder:text-ink-400 focus:bg-ink-0 focus:outline-none focus:ring-orange-400"
          />
          {search ? (
            <button
              type="button"
              onClick={() => onSearchChange("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-500 hover:bg-ink-100 hover:text-ink-1000"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </header>
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {query.isLoading ? (
          <p className="p-4 text-center text-xs text-ink-500">
            <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
            Loading…
          </p>
        ) : filtered.length === 0 ? (
          <p className="p-4 text-center text-xs text-ink-500">
            {needle
              ? `Nothing matches "${needle}".`
              : stage.attention
                ? "Nothing waiting on you here."
                : "Empty."}
          </p>
        ) : (
          <>
            {filtered.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                onDelete={onDelete}
                deletePending={deletePending}
              />
            ))}
            {/* Per-column load-more — no cross-column starvation.
             *  Hidden while a client-side search is narrowing the
             *  visible set: "Load more" would fetch more rows the
             *  filter would immediately hide, which reads as a
             *  broken button. */}
            {query.hasNextPage && !needle ? (
              <button
                type="button"
                onClick={() => query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
                className="w-full rounded-lg px-3 py-1.5 text-[11px] font-semibold text-ink-600 hover:bg-ink-50 disabled:opacity-50"
              >
                {query.isFetchingNextPage ? "Loading…" : "Load more"}
              </button>
            ) : null}
          </>
        )}
      </div>
    </article>
  );
}


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
  // Product line under the customer: for one-line proposals the
  // formulation name is enough; multi-line quotes append "+N more".
  // Prefer ``formulation_display_name`` (RTG storefront name, e.g.
  // "Ultimate Fat Burner Drink") and fall back to the internal
  // ``formulation_name``. RTG rows also carry ``formulation_code``
  // parenthesised so the reader can pattern-match on RTG00001
  // without opening the detail. Omitted entirely when the linked
  // formulation is nameless.
  const productLine = (() => {
    const display = (
      proposal.formulation_display_name ||
      proposal.formulation_name ||
      ""
    ).trim();
    if (!display) return "";
    let base = display;
    if (proposal.template_type === "ready_to_go") {
      const code = (proposal.formulation_code || "").trim();
      if (code && code !== display) base = `${display} (${code})`;
    }
    const extras = Math.max(0, proposal.lines_count - 1);
    return extras > 0 ? `${base} +${extras} more` : base;
  })();

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
          {productLine ? (
            <p className="mt-0.5 truncate text-[11px] font-medium text-ink-700">
              {productLine}
            </p>
          ) : null}
          <p className="mt-0.5 truncate text-[11px] text-ink-600">
            {proposal.customer_company ||
              proposal.customer_name ||
              tProposals("list.no_customer")}
          </p>
        </Link>
        <Link
          href={`/proposals/${proposal.id}`}
          className="text-ink-400 hover:text-ink-700"
          aria-label={tProposals("list.view")}
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
          {proposal.created_at
            ? new Date(proposal.created_at).toLocaleDateString()
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


