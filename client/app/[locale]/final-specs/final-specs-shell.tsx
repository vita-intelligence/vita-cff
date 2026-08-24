"use client";

import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Clock,
  Loader2,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Users,
  XCircle,
} from "lucide-react";
import { useState } from "react";

import { Link } from "@/i18n/navigation";
import { apiClient } from "@/lib/api";


type Stage = "needs_click" | "in_flight" | "closed";

interface FinalSpecCard {
  readonly id: string;
  readonly code: string;
  readonly status:
    | "draft"
    | "in_review"
    | "approved"
    | "sent"
    | "accepted"
    | "rejected";
  readonly formulation: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
  };
  readonly customer: { readonly id: string; readonly name: string } | null;
  readonly final_price: string | null;
  readonly quantity: number;
  readonly currency: string;
  readonly sent_at: string | null;
  readonly customer_signed_at: string | null;
  readonly customer_rejected_at: string | null;
  readonly customer_rejection_reason: string;
  readonly updated_at: string;
  readonly final_payment: {
    readonly id: string;
    readonly status: "pending" | "approved" | "voided";
    readonly amount: string | null;
    readonly currency: string;
  } | null;
}


interface PipelineResponse {
  readonly columns: Record<Stage, readonly FinalSpecCard[]>;
  readonly counts: Record<Stage, number>;
}


// Column meta — same three-column shape as /trial-batches/ so the
// two scientist surfaces read as siblings.
const STAGES: ReadonlyArray<{
  readonly key: Stage;
  readonly title: string;
  readonly blurb: string;
  readonly tone: "amber" | "sky" | "ink";
}> = [
  {
    key: "needs_click",
    title: "Needs your click",
    blurb: "Approved internally — send to the customer to unlock signature.",
    tone: "amber",
  },
  {
    key: "in_flight",
    title: "In flight",
    blurb: "Waiting on the customer to sign, or on finance to approve the invoice.",
    tone: "sky",
  },
  {
    key: "closed",
    title: "Closed",
    blurb: "Signed + paid, or the customer rejected and we're back on trial batches.",
    tone: "ink",
  },
];


export function FinalSpecsShell({ orgId }: { orgId: string }) {
  const [searchInput, setSearchInput] = useState("");
  const search = searchInput.trim().toLowerCase();

  const query = useQuery<PipelineResponse>({
    queryKey: ["final-specs-pipeline", orgId],
    queryFn: async () => {
      const { data } = await apiClient.get<PipelineResponse>(
        `/api/organizations/${orgId}/final-specs/pipeline/`,
      );
      return data;
    },
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  const filterCard = (card: FinalSpecCard) => {
    if (!search) return true;
    return (
      card.code.toLowerCase().includes(search) ||
      card.formulation.code.toLowerCase().includes(search) ||
      card.formulation.name.toLowerCase().includes(search) ||
      (card.customer?.name.toLowerCase().includes(search) ?? false)
    );
  };

  return (
    <section className="mt-6 flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-ink-100 pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink-1000 md:text-2xl">
            Final specs
          </h1>
          <p className="mt-0.5 text-sm text-ink-500">
            Post-trial specifications on their way to signature + invoice
            approval. Left → right: what needs your click, what&rsquo;s in
            flight, what&rsquo;s done.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="search"
            placeholder="Search formulation, customer, code…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="h-10 w-72 rounded-full border border-ink-200 bg-ink-0 px-4 text-sm text-ink-1000 outline-none focus:border-ink-400"
          />
          <button
            type="button"
            onClick={() => query.refetch()}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-ink-200 bg-ink-0 text-ink-600 hover:bg-ink-50"
            title="Refresh"
          >
            {query.isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {STAGES.map((stage) => (
          <StageColumn
            key={stage.key}
            stage={stage}
            cards={
              query.data
                ? query.data.columns[stage.key].filter(filterCard)
                : []
            }
            total={query.data ? query.data.counts[stage.key] : 0}
            filtered={
              query.data
                ? query.data.columns[stage.key].filter(filterCard).length
                : 0
            }
            loading={query.isPending}
            error={query.isError}
            search={search}
          />
        ))}
      </div>
    </section>
  );
}


function StageColumn({
  stage,
  cards,
  total,
  filtered,
  loading,
  error,
  search,
}: {
  stage: (typeof STAGES)[number];
  cards: readonly FinalSpecCard[];
  total: number;
  filtered: number;
  loading: boolean;
  error: boolean;
  search: string;
}) {
  const countTone =
    stage.tone === "amber"
      ? "bg-amber-100 text-amber-800"
      : stage.tone === "sky"
        ? "bg-sky-100 text-sky-800"
        : "bg-ink-100 text-ink-700";
  return (
    <div className="flex min-h-[400px] flex-col rounded-2xl border border-ink-100 bg-ink-0">
      <header className="flex items-center justify-between border-b border-ink-100 p-3">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-1000">
              {stage.title}
            </p>
            <span
              className={
                "rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums " +
                countTone
              }
              title={
                search
                  ? `${filtered} of ${total} matches "${search}"`
                  : `${total} spec${total === 1 ? "" : "s"}`
              }
            >
              {search ? `${filtered}/${total}` : total}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-ink-600">{stage.blurb}</p>
        </div>
      </header>
      <div className="flex flex-1 flex-col gap-2 p-3">
        {loading ? (
          <p className="p-4 text-center text-[11px] text-ink-500">
            <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> Loading…
          </p>
        ) : error ? (
          <p className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs text-danger">
            Couldn&rsquo;t load. Refresh to try again.
          </p>
        ) : cards.length === 0 ? (
          <p className="p-4 text-center text-[11px] text-ink-400">
            {search ? "Nothing matches your search." : "Nothing here."}
          </p>
        ) : (
          cards.map((card) => <SpecKanbanCard key={card.id} card={card} />)
        )}
      </div>
    </div>
  );
}


function SpecKanbanCard({ card }: { card: FinalSpecCard }) {
  return (
    <Link
      href={`/specifications/${card.id}`}
      className="group flex flex-col gap-2 rounded-xl border border-ink-100 bg-ink-0 p-3 shadow-sm transition-shadow hover:border-ink-300 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink-1000">
            {card.formulation.name || "Untitled formulation"}
          </p>
          <p className="mt-0.5 font-mono text-[10px] text-ink-500">
            {card.formulation.code || card.formulation.id.slice(0, 8)}
            {card.code ? (
              <>
                {" · "}
                <span className="text-ink-700">{card.code}</span>
              </>
            ) : null}
          </p>
        </div>
        <StatusPill card={card} />
      </div>

      {card.customer ? (
        <p className="flex items-center gap-1 truncate text-[11px] text-ink-600">
          <Users className="h-3 w-3 shrink-0 text-ink-400" />
          {card.customer.name}
        </p>
      ) : null}

      <MetaLine card={card} />

      {card.status === "rejected" && card.customer_rejection_reason ? (
        <div className="mt-1 rounded-lg border border-red-200 bg-red-50 p-2">
          <p className="flex items-center justify-between gap-1 text-[10px] font-semibold uppercase tracking-wider text-red-800">
            <span className="flex items-center gap-1">
              <AlertCircle className="h-3 w-3" /> Customer rejection reason
            </span>
            {card.customer_rejection_reason.length > 180 ? (
              <span className="font-normal normal-case text-[9px] text-red-600/80">
                open card for full text →
              </span>
            ) : null}
          </p>
          {/* ``line-clamp-3`` fades a long rejection reason after a
              few lines so a customer who paste-bombed a paragraph
              doesn't blow the card height apart. Full text lives on
              the spec detail page — the card is clickable already. */}
          <p className="mt-1 line-clamp-3 whitespace-pre-line text-xs leading-snug text-red-900">
            {card.customer_rejection_reason}
          </p>
        </div>
      ) : null}

      <ChevronRight className="h-3 w-3 self-end text-ink-300 group-hover:text-ink-500" />
    </Link>
  );
}


function StatusPill({ card }: { card: FinalSpecCard }) {
  // Status pill combines the sheet status + payment state into one
  // glanceable chip so the scientist can tell "who owes what" at a
  // glance without expanding.
  if (card.status === "rejected") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-800">
        <XCircle className="h-3 w-3" /> Rejected
      </span>
    );
  }
  if (card.status === "accepted") {
    if (card.final_payment?.status === "approved") {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">
          <CheckCircle2 className="h-3 w-3" /> Signed + paid
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold text-sky-800">
        <Clock className="h-3 w-3" /> Awaiting payment
      </span>
    );
  }
  if (card.status === "sent") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
        <Send className="h-3 w-3" /> Awaiting signature
      </span>
    );
  }
  if (card.status === "approved") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-semibold text-amber-900">
        <ShieldCheck className="h-3 w-3" /> Ready to send
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-semibold text-ink-700">
      <Sparkles className="h-3 w-3" /> {card.status}
    </span>
  );
}


function MetaLine({ card }: { card: FinalSpecCard }) {
  // Show the most informative timestamp for the current lifecycle
  // step + the invoice number when relevant. The scientist should
  // be able to read "sent 3 days ago" without opening the card.
  const bits: string[] = [];
  if (card.status === "approved") {
    bits.push(`Updated ${formatShortDate(card.updated_at)}`);
  } else if (card.status === "sent") {
    bits.push(`Sent ${formatShortDate(card.sent_at)}`);
  } else if (card.status === "accepted") {
    bits.push(`Signed ${formatShortDate(card.customer_signed_at)}`);
  } else if (card.status === "rejected") {
    bits.push(`Rejected ${formatShortDate(card.customer_rejected_at)}`);
  }
  if (card.final_price != null && card.quantity > 0) {
    const total = (
      Number.parseFloat(card.final_price) * card.quantity
    ).toFixed(2);
    bits.push(`${card.currency} ${total}`);
  }

  return (
    <div className="flex items-center gap-2 text-[10px] text-ink-500">
      {bits.map((bit, i) => (
        <span key={i} className="tabular-nums">
          {bit}
        </span>
      ))}
    </div>
  );
}


function formatShortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
