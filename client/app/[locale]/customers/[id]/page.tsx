import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  Building2,
  CheckCircle2,
  ClipboardList,
  Clock,
  ExternalLink,
  FileText,
  Mail,
  MapPin,
  Phone,
  ShieldCheck,
  StickyNote,
  UserCircle2,
} from "lucide-react";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { Link, redirect } from "@/i18n/navigation";
import { hasFlatCapability } from "@/lib/auth/capabilities";
import { redirectToLogin } from "@/lib/auth/redirects";
import {
  getActiveOrganizationServer,
  getCurrentUserServer,
  getCustomerOverviewServer,
  getUserOrganizationsServer,
} from "@/lib/auth/server";
import type {
  CustomerCFFSummaryDto,
  CustomerPortalAccountDto,
  CustomerProposalSummaryDto,
} from "@/services/customers/types";

import { APP_VERSION } from "@/config/version";


/**
 * Staff customer detail page.
 *
 * Renders everything the sales team wants to see about a customer in
 * one scroll — company + contact block, portal accounts, proposal
 * history with revenue rollups, and CFF submissions authored via any
 * of the customer's portal logins. All data flows in a single
 * ``/customers/<id>/overview/`` round-trip so the page paints without
 * per-panel spinners.
 *
 * Access rides ``formulations.view`` — the customers surface is a
 * sales tool and shares the projects module gate. There is no
 * separate Customers capability today.
 */
export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  const user = await getCurrentUserServer();
  if (!user) {
    await redirectToLogin(locale);
  }
  const currentUser = user!;

  const organizations = (await getUserOrganizationsServer()) ?? [];
  if (organizations.length === 0) {
    redirect({ href: "/home", locale });
  }
  const primaryOrg = (await getActiveOrganizationServer())!;

  const canView = hasFlatCapability(primaryOrg, "formulations", "view");
  if (!canView) {
    return <AccessDenied />;
  }

  const overview = await getCustomerOverviewServer(primaryOrg.id, id);
  if (!overview) {
    notFound();
  }

  const { customer, portal_accounts, proposals, cff_submissions, totals } =
    overview;

  const tCommon = await getTranslations("common");
  const tNav = await getTranslations("navigation");

  const displayName = customer.company || customer.name || "—";

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={currentUser} active="customers" />

        <section className="mt-10 md:mt-12">
          <Breadcrumbs
            items={[
              { label: tNav("main.dashboard"), href: "/home" },
              { label: tNav("main.customers"), href: "/customers" },
              { label: displayName },
            ]}
          />
        </section>

        <section className="mt-6">
          <Link
            href="/customers"
            className="mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-ink-500 hover:text-ink-800"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            All customers
          </Link>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
                {primaryOrg.name}
              </p>
              <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight text-ink-1000 md:text-3xl">
                {displayName}
              </h1>
              {customer.company && customer.name ? (
                <p className="mt-1 text-sm text-ink-600">
                  Primary contact: {customer.name}
                </p>
              ) : null}
            </div>
            <PortalStatusBadge customer={customer} />
          </div>
        </section>

        {/* Rollup chips — quick glance at where this customer sits
            commercially. Revenue is a sum of accepted proposals only
            (excludes drafts / sent / rejected). */}
        <section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            icon={ClipboardList}
            label="Proposals"
            value={totals.proposals_count}
          />
          <StatCard
            icon={CheckCircle2}
            label="Accepted"
            value={totals.accepted_proposals_count}
          />
          <StatCard
            icon={FileText}
            label="Revenue (accepted)"
            value={formatRevenue(
              totals.accepted_revenue,
              proposals[0]?.currency ?? "GBP",
            )}
          />
          <StatCard
            icon={UserCircle2}
            label="Portal accounts"
            value={totals.portal_accounts_count}
          />
        </section>

        {/* Contact + addresses. Left panel: identity fields; right:
            addresses. Notes render underneath (full-width) so the
            operator gets the freeform context without a hidden
            hover. */}
        <section className="mt-8 grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl bg-white p-5 ring-1 ring-ink-200">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-ink-500">
              Contact
            </p>
            <dl className="mt-3 grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 gap-y-3 text-sm">
              <dt className="pt-0.5 text-ink-400">
                <Building2 className="h-4 w-4" aria-hidden />
              </dt>
              <dd className="text-ink-1000">{customer.company || "—"}</dd>
              <dt className="pt-0.5 text-ink-400">
                <UserCircle2 className="h-4 w-4" aria-hidden />
              </dt>
              <dd className="text-ink-1000">{customer.name || "—"}</dd>
              <dt className="pt-0.5 text-ink-400">
                <Mail className="h-4 w-4" aria-hidden />
              </dt>
              <dd className="min-w-0 truncate text-ink-1000">
                {customer.email ? (
                  <a
                    href={`mailto:${customer.email}`}
                    className="text-orange-700 hover:underline"
                  >
                    {customer.email}
                  </a>
                ) : (
                  "—"
                )}
              </dd>
              <dt className="pt-0.5 text-ink-400">
                <Phone className="h-4 w-4" aria-hidden />
              </dt>
              <dd className="text-ink-1000">
                {customer.phone ? (
                  <a
                    href={`tel:${customer.phone}`}
                    className="hover:underline"
                  >
                    {customer.phone}
                  </a>
                ) : (
                  "—"
                )}
              </dd>
            </dl>
          </div>

          <div className="rounded-2xl bg-white p-5 ring-1 ring-ink-200">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-ink-500">
              Addresses
            </p>
            <dl className="mt-3 grid grid-cols-1 gap-4 text-sm">
              <div className="flex items-start gap-3">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" />
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">
                    Invoice
                  </p>
                  <p className="mt-1 whitespace-pre-line text-ink-1000">
                    {customer.invoice_address || "—"}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" />
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">
                    Delivery
                  </p>
                  <p className="mt-1 whitespace-pre-line text-ink-1000">
                    {customer.delivery_address || "—"}
                  </p>
                </div>
              </div>
            </dl>
          </div>
        </section>

        {customer.notes ? (
          <section className="mt-4">
            <div className="rounded-2xl bg-amber-50 p-5 ring-1 ring-amber-200">
              <div className="flex items-start gap-3">
                <StickyNote className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-amber-800">
                    Internal notes
                  </p>
                  <p className="mt-1 whitespace-pre-line text-sm text-ink-900">
                    {customer.notes}
                  </p>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        <section className="mt-10">
          <h2 className="text-lg font-semibold tracking-tight text-ink-1000">
            Proposals ({proposals.length})
          </h2>
          <ProposalsTable proposals={proposals} />
        </section>

        <section className="mt-10">
          <h2 className="text-lg font-semibold tracking-tight text-ink-1000">
            CFF requests ({cff_submissions.length})
          </h2>
          <p className="mt-1 text-xs text-ink-500">
            Only CFFs submitted through the customer&apos;s portal
            accounts appear here. Anonymous Wix submissions live in
            the CFF inbox and route to their assigned project.
          </p>
          <CFFsTable cffs={cff_submissions} />
        </section>

        <section className="mt-10">
          <h2 className="text-lg font-semibold tracking-tight text-ink-1000">
            Portal accounts ({portal_accounts.length})
          </h2>
          <p className="mt-1 text-xs text-ink-500">
            Customer-side logins tied to this record. Managed via the
            invite flow on the customers list.
          </p>
          <PortalAccountsTable accounts={portal_accounts} />
        </section>

        <section className="mt-10 text-xs text-ink-500">
          <p>
            <Clock className="mr-1 inline h-3 w-3" aria-hidden />
            Created {formatDate(customer.created_at)} · updated{" "}
            {formatDate(customer.updated_at)}
            {customer.dynamics_synced_at ? (
              <>
                {" · "}
                <ShieldCheck className="mx-1 inline h-3 w-3" aria-hidden />
                Synced from Dynamics {formatDate(customer.dynamics_synced_at)}
              </>
            ) : null}
          </p>
        </section>

        <footer className="mt-auto flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v{APP_VERSION}</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}


function PortalStatusBadge({
  customer,
}: {
  customer: { has_portal_account: boolean; portal_account_activated: boolean };
}) {
  if (customer.portal_account_activated) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-800">
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
        Portal active
      </span>
    );
  }
  if (customer.has_portal_account) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-amber-800">
        <Clock className="h-3.5 w-3.5" aria-hidden />
        Portal invite pending
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-ink-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-600">
      No portal account
    </span>
  );
}


function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | string;
}) {
  return (
    <div className="rounded-2xl bg-white p-4 ring-1 ring-ink-200">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-ink-500">
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {label}
      </div>
      <p className="mt-2 text-2xl font-semibold text-ink-1000">{value}</p>
    </div>
  );
}


function ProposalsTable({
  proposals,
}: {
  proposals: readonly CustomerProposalSummaryDto[];
}) {
  if (proposals.length === 0) {
    return (
      <p className="mt-3 rounded-2xl bg-ink-50 p-6 text-center text-sm text-ink-500 ring-1 ring-ink-200">
        No proposals yet. Sales creates them from the projects surface.
      </p>
    );
  }
  return (
    <div className="mt-3 overflow-hidden rounded-2xl bg-white ring-1 ring-ink-200">
      <table className="w-full text-sm">
        <thead className="border-b border-ink-100 bg-ink-50/60 text-[10px] font-semibold uppercase tracking-widest text-ink-500">
          <tr>
            <th className="px-3 py-2 text-left">Code</th>
            <th className="px-3 py-2 text-left">Product</th>
            <th className="px-3 py-2 text-left">Type</th>
            <th className="px-3 py-2 text-left">Status</th>
            <th className="px-3 py-2 text-right">Total</th>
            <th className="px-3 py-2 text-left">Updated</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {proposals.map((p) => (
            <tr key={p.id} className="border-b border-ink-100 last:border-b-0">
              <td className="px-3 py-2.5 font-mono text-xs text-ink-1000">
                {p.code || "—"}
              </td>
              <td className="px-3 py-2.5 text-ink-800">
                <div className="min-w-0">
                  <p className="truncate">{p.formulation?.name ?? "—"}</p>
                  {p.formulation?.code ? (
                    <p className="text-[11px] text-ink-500">
                      {p.formulation.code}
                    </p>
                  ) : null}
                </div>
              </td>
              <td className="px-3 py-2.5">
                <TypeChip templateType={p.template_type} />
              </td>
              <td className="px-3 py-2.5">
                <StatusChip status={p.status} />
              </td>
              <td className="px-3 py-2.5 text-right font-medium text-ink-1000">
                {p.total_excl_vat
                  ? formatRevenue(p.total_excl_vat, p.currency)
                  : "—"}
              </td>
              <td className="px-3 py-2.5 text-xs text-ink-500">
                {formatDate(p.updated_at)}
              </td>
              <td className="px-3 py-2.5 text-right">
                <Link
                  href={`/proposals/${p.id}`}
                  className="inline-flex items-center gap-1 rounded-md bg-ink-50 px-2 py-1 text-[11px] font-medium text-ink-700 hover:bg-ink-100"
                >
                  Open
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


function CFFsTable({
  cffs,
}: {
  cffs: readonly CustomerCFFSummaryDto[];
}) {
  if (cffs.length === 0) {
    return (
      <p className="mt-3 rounded-2xl bg-ink-50 p-6 text-center text-sm text-ink-500 ring-1 ring-ink-200">
        No CFF requests from the portal yet.
      </p>
    );
  }
  return (
    <ul className="mt-3 flex flex-col gap-2">
      {cffs.map((cff) => {
        const projectCode =
          cff.assignments[0]?.project.code ||
          cff.assignments[0]?.project.name ||
          null;
        return (
          <li
            key={cff.id}
            className="rounded-2xl bg-white p-4 ring-1 ring-ink-200"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-ink-500">
                  {formatDate(cff.imported_at)}
                </span>
                {cff.submission_kind === "ready_to_go" ? (
                  <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700">
                    Ready-to-Go
                  </span>
                ) : (
                  <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-600">
                    Custom
                  </span>
                )}
                {cff.is_rejected ? (
                  <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-700">
                    Rejected
                  </span>
                ) : cff.drafted_proposal_code ? (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                    Drafted as {cff.drafted_proposal_code}
                  </span>
                ) : cff.is_assigned && projectCode ? (
                  <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700">
                    Attached to {projectCode}
                  </span>
                ) : (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
                    In triage
                  </span>
                )}
              </div>
              <div className="flex gap-1.5">
                {cff.drafted_proposal_id ? (
                  <Link
                    href={`/proposals/${cff.drafted_proposal_id}`}
                    className="inline-flex items-center gap-1 rounded-md bg-orange-500 px-2 py-1 text-[11px] font-medium text-white hover:bg-orange-600"
                  >
                    View proposal
                    <ExternalLink className="h-3 w-3" aria-hidden />
                  </Link>
                ) : null}
                <Link
                  href={`/cff/${cff.id}`}
                  className="inline-flex items-center gap-1 rounded-md bg-ink-50 px-2 py-1 text-[11px] font-medium text-ink-700 hover:bg-ink-100"
                >
                  Open
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </Link>
              </div>
            </div>
            {cff.is_rejected && cff.rejection_reason ? (
              <p className="mt-2 text-xs text-rose-700">
                Rejected: {cff.rejection_reason}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}


function PortalAccountsTable({
  accounts,
}: {
  accounts: readonly CustomerPortalAccountDto[];
}) {
  if (accounts.length === 0) {
    return (
      <p className="mt-3 rounded-2xl bg-ink-50 p-6 text-center text-sm text-ink-500 ring-1 ring-ink-200">
        No portal accounts on file for this customer.
      </p>
    );
  }
  return (
    <div className="mt-3 overflow-hidden rounded-2xl bg-white ring-1 ring-ink-200">
      <table className="w-full text-sm">
        <thead className="border-b border-ink-100 bg-ink-50/60 text-[10px] font-semibold uppercase tracking-widest text-ink-500">
          <tr>
            <th className="px-3 py-2 text-left">Email</th>
            <th className="px-3 py-2 text-left">Status</th>
            <th className="px-3 py-2 text-left">Activated</th>
            <th className="px-3 py-2 text-left">Last login</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.id} className="border-b border-ink-100 last:border-b-0">
              <td className="px-3 py-2.5 text-ink-1000">{a.email}</td>
              <td className="px-3 py-2.5">
                {a.activated_at ? (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                    Active
                  </span>
                ) : (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
                    Pending
                  </span>
                )}
              </td>
              <td className="px-3 py-2.5 text-xs text-ink-600">
                {a.activated_at ? formatDate(a.activated_at) : "—"}
              </td>
              <td className="px-3 py-2.5 text-xs text-ink-600">
                {a.last_login_at ? formatDate(a.last_login_at) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


function TypeChip({
  templateType,
}: {
  templateType: "custom" | "ready_to_go";
}) {
  if (templateType === "ready_to_go") {
    return (
      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700">
        RTG
      </span>
    );
  }
  return (
    <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-700">
      Custom
    </span>
  );
}


function StatusChip({ status }: { status: string }) {
  const tone =
    status === "accepted"
      ? "bg-emerald-100 text-emerald-800"
      : status === "rejected"
        ? "bg-rose-100 text-rose-700"
        : status === "sent"
          ? "bg-blue-100 text-blue-800"
          : status === "approved"
            ? "bg-teal-100 text-teal-800"
            : status === "in_review"
              ? "bg-amber-100 text-amber-800"
              : "bg-ink-100 text-ink-700";
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone}`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}


function AccessDenied() {
  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center px-6 py-10 text-center">
        <div className="rounded-2xl bg-ink-0 p-10 shadow-sm ring-1 ring-ink-200">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            403
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink-1000">
            Access denied
          </h1>
          <p className="mt-2 text-sm text-ink-500">
            You don&apos;t have permission to view customers for this
            organisation. Customers rides the Projects module — ask an
            admin to grant you Projects → View.
          </p>
          <Link
            href="/home"
            className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-orange-700 hover:text-orange-800"
          >
            ← Dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}


function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}


function formatRevenue(amount: string, currency: string): string {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(parsed);
  } catch {
    return `${currency} ${parsed.toFixed(2)}`;
  }
}
