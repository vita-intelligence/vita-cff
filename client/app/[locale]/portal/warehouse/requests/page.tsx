import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ArrowLeft, History, Package } from "lucide-react";

import {
  Card,
  PageHeader,
  PortalShell,
} from "@/components/portal/brutalist";
import { env } from "@/config/env";

import { RequestList, type DispatchRequest } from "./request-list";


/**
 * /portal/warehouse/requests — customer-facing history of the
 * dispatch requests they've queued (any status). Sibling to
 * /portal/warehouse; the two share the same PSP integration.
 *
 * SSR seeds the summary pills + first page of requests. Search +
 * infinite scroll take over on the client via ``<RequestList>``.
 *
 * Query params:
 *   * ``lot`` — pre-filter to a single lot (deep-linked from the
 *     "View requests" button on the warehouse lot cards).
 *   * ``status`` — pending | completed | cancelled (server-driven
 *     tab filter). Cursor is per-status so a switch resets scroll.
 */


type StatusFilter = "pending" | "completed" | "cancelled" | "all";


interface Envelope {
  readonly customer: { readonly uuid: string | null; readonly name: string | null };
  readonly summary: {
    readonly total: number;
    readonly pending: number;
    readonly completed: number;
    readonly cancelled: number;
  };
  readonly requests: readonly DispatchRequest[];
  readonly next_cursor: string | null;
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
        next_cursor: null,
      };

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

        <div
          className="flex items-center gap-1.5"
          role="tablist"
          aria-label="Filter by status"
        >
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
        {data.requests.length === 0 && !hasAny ? (
          <Card>
            <div className="flex items-start gap-3">
              <History className="mt-0.5 h-6 w-6 shrink-0 text-neutral-500" />
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-neutral-500">
                  Nothing to show
                </p>
                <p className="mt-1 text-sm">
                  You haven&rsquo;t queued any dispatches yet. Head over to
                  Warehouse to request one.
                </p>
              </div>
            </div>
          </Card>
        ) : (
          <RequestList
            initialItems={data.requests}
            initialNextCursor={data.next_cursor}
            statusFilter={statusFilter}
            lotFilter={lot ?? null}
          />
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
      <span
        className={`inline-flex min-w-[1.25rem] justify-center rounded-sm border border-black px-1 tabular-nums ${
          active ? "bg-black text-white" : "bg-neutral-200 text-black"
        }`}
      >
        {count}
      </span>
    </Link>
  );
}
