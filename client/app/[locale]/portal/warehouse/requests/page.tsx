import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  History,
  Package,
  XCircle,
} from "lucide-react";

import {
  Card,
  Eyebrow,
  PageHeader,
  PortalShell,
} from "@/components/portal/brutalist";
import { env } from "@/config/env";


/**
 * /portal/warehouse/requests — customer-facing history of the
 * dispatch requests they've queued (any status). Sibling to
 * /portal/warehouse; the two share the same PSP integration.
 *
 * Query params:
 *   * ``lot`` — pre-filter to a single lot (deep-linked from the
 *     "View requests" button on the warehouse lot cards).
 *   * ``status`` — pending | completed | cancelled (server-driven
 *     tab filter).
 */


type StatusFilter = "pending" | "completed" | "cancelled" | "all";


interface LotSummary {
  readonly uuid: string;
  readonly code: string | null;
  readonly item: {
    readonly name: string | null;
    readonly code: string | null;
  };
  readonly unit_of_measurement: { readonly symbol: string };
}


interface DispatchRequest {
  readonly uuid: string;
  readonly status: "pending" | "completed" | "cancelled";
  readonly qty: string;
  readonly reference: string | null;
  readonly notes: string | null;
  readonly source: string;
  readonly external_reference: string | null;
  readonly requested_at: string | null;
  readonly dispatched_at: string | null;
  readonly lot: LotSummary | null;
}


interface Envelope {
  readonly customer: { readonly uuid: string | null; readonly name: string | null };
  readonly summary: {
    readonly total: number;
    readonly pending: number;
    readonly completed: number;
    readonly cancelled: number;
  };
  readonly requests: readonly DispatchRequest[];
}


export default async function PortalDispatchRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ lot?: string; status?: string }>;
}) {
  const { lot, status } = await searchParams;
  const statusFilter = normaliseStatus(status);

  const jar = await cookies();
  const portalCookie = jar.get("vita_portal_access");
  if (!portalCookie) {
    redirect("/portal/login");
  }

  const headers = { Cookie: `vita_portal_access=${portalCookie.value}` };
  const base = env.NEXT_PUBLIC_API_URL;

  const qs = new URLSearchParams();
  if (lot) qs.set("lot_uuid", lot);
  if (statusFilter !== "all") qs.set("status", statusFilter);
  const url = `${base}/api/portal/warehouse/dispatch-requests/${qs.size ? `?${qs.toString()}` : ""}`;

  const res = await fetch(url, { cache: "no-store", headers }).catch(() => null);

  if (!res || res.status === 401 || res.status === 403) {
    redirect("/portal/login");
  }

  const data: Envelope = res?.ok
    ? await res.json()
    : {
        customer: { uuid: null, name: null },
        summary: { total: 0, pending: 0, completed: 0, cancelled: 0 },
        requests: [],
      };

  const requests = data.requests;
  const hasAny = data.summary.total > 0;

  return (
    <PortalShell active="warehouse">
      <PageHeader
        eyebrow="Warehouse"
        title="My dispatch requests"
        subtitle={
          hasAny
            ? `${data.summary.total} request${data.summary.total === 1 ? "" : "s"} on record — ${data.summary.pending} pending, ${data.summary.completed} completed${data.summary.cancelled > 0 ? `, ${data.summary.cancelled} cancelled` : ""}.`
            : "You haven't queued any dispatches yet. Head to Warehouse to request one."
        }
      />

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/portal/warehouse"
          className="inline-flex items-center gap-1.5 border-2 border-black bg-white px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-black transition-all hover:bg-neutral-100"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to warehouse
        </Link>

        <div className="flex items-center gap-1.5" role="tablist" aria-label="Filter by status">
          <StatusPill
            label="All"
            count={data.summary.total}
            active={statusFilter === "all"}
            href={buildFilterHref({ lot, status: "all" })}
          />
          <StatusPill
            label="Pending"
            count={data.summary.pending}
            active={statusFilter === "pending"}
            href={buildFilterHref({ lot, status: "pending" })}
            tone="orange"
          />
          <StatusPill
            label="Completed"
            count={data.summary.completed}
            active={statusFilter === "completed"}
            href={buildFilterHref({ lot, status: "completed" })}
            tone="green"
          />
          <StatusPill
            label="Cancelled"
            count={data.summary.cancelled}
            active={statusFilter === "cancelled"}
            href={buildFilterHref({ lot, status: "cancelled" })}
            tone="red"
          />
        </div>
      </div>

      {lot ? (
        <div className="mt-4 flex items-center gap-2 border-2 border-black bg-neutral-100 px-3 py-2 text-xs">
          <Package className="h-3.5 w-3.5 text-neutral-600" />
          <span>
            Filtered to a single lot.{" "}
            <Link
              href={`/portal/warehouse/requests${statusFilter === "all" ? "" : `?status=${statusFilter}`}`}
              className="font-semibold underline"
            >
              Clear filter
            </Link>
          </span>
        </div>
      ) : null}

      <div className="mt-6">
        {requests.length === 0 ? (
          <Card>
            <div className="flex items-start gap-3">
              <History className="mt-0.5 h-6 w-6 shrink-0 text-neutral-500" />
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-neutral-500">
                  Nothing to show
                </p>
                <p className="mt-1 text-sm">
                  {statusFilter === "all"
                    ? "You haven't queued any dispatches yet. Head over to Warehouse to request one."
                    : `No ${statusFilter} requests match this filter.`}
                </p>
              </div>
            </div>
          </Card>
        ) : (
          <>
            <Eyebrow>Requests</Eyebrow>
            <ul className="mt-3 flex flex-col gap-3">
              {requests.map((r) => (
                <li key={r.uuid}>
                  <RequestRow request={r} />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </PortalShell>
  );
}


function normaliseStatus(raw: string | undefined): StatusFilter {
  if (raw === "pending" || raw === "completed" || raw === "cancelled") return raw;
  return "all";
}


function buildFilterHref({
  lot,
  status,
}: {
  lot: string | undefined;
  status: StatusFilter;
}): string {
  const qs = new URLSearchParams();
  if (lot) qs.set("lot", lot);
  if (status !== "all") qs.set("status", status);
  const suffix = qs.size ? `?${qs.toString()}` : "";
  return `/portal/warehouse/requests${suffix}`;
}


function StatusPill({
  label,
  count,
  active,
  href,
  tone,
}: {
  label: string;
  count: number;
  active: boolean;
  href: string;
  tone?: "orange" | "green" | "red";
}) {
  const activeTone =
    tone === "orange"
      ? "bg-orange-500 text-black"
      : tone === "green"
        ? "bg-emerald-500 text-black"
        : tone === "red"
          ? "bg-red-500 text-white"
          : "bg-black text-white";
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-1.5 border-2 border-black px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.18em] transition-all ${
        active ? activeTone : "bg-white text-black hover:bg-neutral-100"
      }`}
    >
      {label}
      <span className={`inline-flex min-w-[1.25rem] justify-center rounded-sm border border-black px-1 tabular-nums ${
        active ? "bg-black text-white" : "bg-neutral-200 text-black"
      }`}>
        {count}
      </span>
    </Link>
  );
}


function RequestRow({ request }: { request: DispatchRequest }) {
  const lot = request.lot;
  const symbol = lot?.unit_of_measurement.symbol ?? "";
  return (
    <article className="border-2 border-black bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <StatusBadge status={request.status} />
            {request.reference ? (
              <span className="font-mono text-[11px] text-neutral-600">
                Ref: {request.reference}
              </span>
            ) : null}
          </div>
          <h3 className="mt-2 text-base font-black uppercase leading-tight">
            {lot?.item.name ?? "—"}
          </h3>
          <p className="mt-0.5 text-[11px] text-neutral-600">
            {lot?.item.code ?? "—"}
            {lot?.code ? ` · ${lot.code}` : ""}
          </p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-black tabular-nums">
            {formatDecimal(request.qty, 0)}
            <span className="ml-1 text-sm text-neutral-500">{symbol}</span>
          </p>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 border-t border-neutral-200 pt-3 text-xs sm:grid-cols-3">
        <MetaCell label="Requested" value={formatDateTime(request.requested_at)} />
        <MetaCell
          label="Dispatched"
          value={
            request.status === "completed"
              ? formatDateTime(request.dispatched_at)
              : request.status === "cancelled"
                ? "Cancelled"
                : "Awaiting pickup"
          }
        />
        <MetaCell label="Source" value={humaniseSource(request.source)} />
      </div>

      {request.notes ? (
        <p className="mt-3 border-t border-neutral-200 pt-3 text-xs italic text-neutral-700">
          &ldquo;{request.notes}&rdquo;
        </p>
      ) : null}
    </article>
  );
}


function StatusBadge({ status }: { status: DispatchRequest["status"] }) {
  const shared =
    "inline-flex items-center gap-1 border-2 border-black px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.18em]";
  if (status === "completed") {
    return (
      <span className={`${shared} bg-emerald-500 text-black`}>
        <CheckCircle2 className="h-3 w-3" />
        Completed
      </span>
    );
  }
  if (status === "cancelled") {
    return (
      <span className={`${shared} bg-red-500 text-white`}>
        <XCircle className="h-3 w-3" />
        Cancelled
      </span>
    );
  }
  return (
    <span className={`${shared} bg-orange-500 text-black`}>
      <Clock className="h-3 w-3" />
      Pending
    </span>
  );
}


function MetaCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-neutral-500">
        {label}
      </p>
      <p className="mt-0.5 font-mono tabular-nums">{value}</p>
    </div>
  );
}


function humaniseSource(source: string): string {
  switch (source) {
    case "portal":
      return "This portal";
    case "shopify_webhook":
      return "Shopify webhook";
    case "custom_api":
      return "Custom API";
    case "staff":
      return "Our team (on your behalf)";
    default:
      return source;
  }
}


function formatDecimal(v: string | null, dp: number): string {
  const n = Number(v ?? "0");
  if (!Number.isFinite(n)) return v ?? "—";
  return n.toLocaleString("en-GB", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}


function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso.slice(0, 16).replace("T", " ");
  }
}
