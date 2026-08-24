"use client";

import { useQuery } from "@tanstack/react-query";
import {
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


type SheetStatus =
  | "draft"
  | "in_review"
  | "approved"
  | "sent"
  | "accepted"
  | "rejected";


interface SheetCard {
  readonly card_kind: "sheet";
  readonly id: string;
  readonly code: string;
  readonly status: SheetStatus;
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


interface AwaitingFinalCard {
  readonly card_kind: "awaiting_final";
  readonly id: string;
  readonly formulation: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
  };
  readonly customer: { readonly id: string; readonly name: string } | null;
  readonly confirmed_done_at: string;
  readonly updated_at: string;
}


type FinalSpecCard = SheetCard | AwaitingFinalCard;


interface PipelineResponse {
  readonly columns: {
    readonly needs_click: readonly AwaitingFinalCard[];
    readonly in_flight: readonly SheetCard[];
    readonly closed_signed: readonly SheetCard[];
    readonly closed_rejected: readonly SheetCard[];
  };
  readonly counts: {
    readonly needs_click: number;
    readonly in_flight: number;
    readonly closed_signed: number;
    readonly closed_rejected: number;
  };
}


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
    const sheetCode =
      card.card_kind === "sheet" ? card.code.toLowerCase() : "";
    return (
      sheetCode.includes(search) ||
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
        <StageColumn
          title="Needs your click"
          blurb="Customer's ready for a final spec — click through to the project and create one."
          tone="amber"
          cards={
            query.data
              ? query.data.columns.needs_click.filter(filterCard)
              : []
          }
          total={query.data ? query.data.counts.needs_click : 0}
          filtered={
            query.data
              ? query.data.columns.needs_click.filter(filterCard).length
              : 0
          }
          loading={query.isPending}
          error={query.isError}
          search={search}
        />
        <StageColumn
          title="In flight"
          blurb="Final spec exists — waiting on us to send, or the customer to sign."
          tone="sky"
          cards={
            query.data
              ? query.data.columns.in_flight.filter(filterCard)
              : []
          }
          total={query.data ? query.data.counts.in_flight : 0}
          filtered={
            query.data
              ? query.data.columns.in_flight.filter(filterCard).length
              : 0
          }
          loading={query.isPending}
          error={query.isError}
          search={search}
        />
        <SplitClosedColumn
          signed={
            query.data
              ? query.data.columns.closed_signed.filter(filterCard)
              : []
          }
          rejected={
            query.data
              ? query.data.columns.closed_rejected.filter(filterCard)
              : []
          }
          totalSigned={query.data ? query.data.counts.closed_signed : 0}
          totalRejected={query.data ? query.data.counts.closed_rejected : 0}
          loading={query.isPending}
          error={query.isError}
          search={search}
        />
      </div>
    </section>
  );
}


function StageColumn({
  title,
  blurb,
  tone,
  cards,
  total,
  filtered,
  loading,
  error,
  search,
}: {
  title: string;
  blurb: string;
  tone: "amber" | "sky" | "ink";
  cards: readonly FinalSpecCard[];
  total: number;
  filtered: number;
  loading: boolean;
  error: boolean;
  search: string;
}) {
  const countTone =
    tone === "amber"
      ? "bg-amber-100 text-amber-800"
      : tone === "sky"
        ? "bg-sky-100 text-sky-800"
        : "bg-ink-100 text-ink-700";
  return (
    <div className="flex min-h-[400px] flex-col rounded-2xl border border-ink-100 bg-ink-0">
      <header className="flex items-center justify-between border-b border-ink-100 p-3">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-1000">
              {title}
            </p>
            <span
              className={
                "rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums " +
                countTone
              }
              title={
                search
                  ? `${filtered} of ${total} matches "${search}"`
                  : `${total} item${total === 1 ? "" : "s"}`
              }
            >
              {search ? `${filtered}/${total}` : total}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-ink-600">{blurb}</p>
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


// Closed column splits into Signed + Rejected sub-groups so the
// scientist can tell at a glance "how many wins vs. how many sent
// back to trial batches?" without expanding each card.
function SplitClosedColumn({
  signed,
  rejected,
  totalSigned,
  totalRejected,
  loading,
  error,
  search,
}: {
  signed: readonly SheetCard[];
  rejected: readonly SheetCard[];
  totalSigned: number;
  totalRejected: number;
  loading: boolean;
  error: boolean;
  search: string;
}) {
  const total = totalSigned + totalRejected;
  const filtered = signed.length + rejected.length;
  const empty = signed.length === 0 && rejected.length === 0;
  return (
    <div className="flex min-h-[400px] flex-col rounded-2xl border border-ink-100 bg-ink-0">
      <header className="border-b border-ink-100 p-3">
        <div className="flex items-center gap-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-1000">
            Closed
          </p>
          <span
            className="rounded-full bg-ink-100 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-ink-700"
            title={
              search
                ? `${filtered} of ${total} matches "${search}"`
                : `${totalSigned} signed · ${totalRejected} rejected`
            }
          >
            {search ? `${filtered}/${total}` : total}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] text-ink-600">
          Customer decided. Signed above, rejected below.
        </p>
      </header>
      <div className="flex flex-1 flex-col gap-4 p-3">
        {loading ? (
          <p className="p-4 text-center text-[11px] text-ink-500">
            <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> Loading…
          </p>
        ) : error ? (
          <p className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs text-danger">
            Couldn&rsquo;t load. Refresh to try again.
          </p>
        ) : empty ? (
          <p className="p-4 text-center text-[11px] text-ink-400">
            {search ? "Nothing matches your search." : "Nothing here."}
          </p>
        ) : (
          <>
            <SubGroup
              label="Signed"
              tone="emerald"
              icon={<CheckCircle2 className="h-3 w-3" />}
              cards={signed}
              totalOverall={totalSigned}
              search={search}
            />
            <SubGroup
              label="Rejected"
              tone="red"
              icon={<XCircle className="h-3 w-3" />}
              cards={rejected}
              totalOverall={totalRejected}
              search={search}
            />
          </>
        )}
      </div>
    </div>
  );
}


function SubGroup({
  label,
  tone,
  icon,
  cards,
  totalOverall,
  search,
}: {
  label: string;
  tone: "emerald" | "red";
  icon: React.ReactNode;
  cards: readonly SheetCard[];
  totalOverall: number;
  search: string;
}) {
  const chipClass =
    tone === "emerald"
      ? "bg-emerald-100 text-emerald-800"
      : "bg-red-100 text-red-800";
  const dividerClass = tone === "emerald" ? "bg-emerald-200" : "bg-red-200";
  const filtered = cards.length;
  if (filtered === 0 && !search) return null;
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <span
          className={
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide " +
            chipClass
          }
        >
          {icon}
          {label}
          <span className="tabular-nums opacity-75">
            {search ? `${filtered}/${totalOverall}` : totalOverall}
          </span>
        </span>
        <span className={"h-px flex-1 " + dividerClass} />
      </div>
      {filtered === 0 ? (
        <p className="pb-2 pl-1 text-[11px] italic text-ink-400">
          {search ? "no matches" : "none"}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {cards.map((card) => (
            <SpecKanbanCard key={card.id} card={card} />
          ))}
        </div>
      )}
    </div>
  );
}


function SpecKanbanCard({ card }: { card: FinalSpecCard }) {
  // Awaiting-final cards link to the spec-sheets tab so the scientist
  // can hit the "Create final spec" banner directly. Sheet cards
  // link to the spec detail page.
  const href =
    card.card_kind === "awaiting_final"
      ? `/formulations/${card.formulation.id}/spec-sheets`
      : `/specifications/${card.id}`;
  return (
    <Link
      href={href}
      className="group flex flex-col gap-2 rounded-xl border border-ink-100 bg-ink-0 p-3 shadow-sm transition-shadow hover:border-ink-300 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink-1000">
            {card.formulation.name || "Untitled formulation"}
          </p>
          <p className="mt-0.5 font-mono text-[10px] text-ink-500">
            {card.formulation.code || card.formulation.id.slice(0, 8)}
            {card.card_kind === "sheet" && card.code ? (
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
      <ChevronRight className="h-3 w-3 self-end text-ink-300 group-hover:text-ink-500" />
    </Link>
  );
}


function StatusPill({ card }: { card: FinalSpecCard }) {
  // Status pill combines the sheet status + payment state into one
  // glanceable chip so the scientist can tell "who owes what" at a
  // glance without expanding.
  if (card.card_kind === "awaiting_final") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-semibold text-amber-900">
        <Sparkles className="h-3 w-3" /> Create final spec
      </span>
    );
  }
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
  if (card.card_kind === "awaiting_final") {
    bits.push(`Customer confirmed ${formatShortDate(card.confirmed_done_at)}`);
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
