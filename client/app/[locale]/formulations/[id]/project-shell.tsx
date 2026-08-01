"use client";

import {
  ArrowLeft,
  ExternalLink,
  FileText,
  FlaskConical,
  History,
  LayoutDashboard,
  PoundSterling,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { Link, usePathname } from "@/i18n/navigation";
import type { ProjectOverviewDto } from "@/services/formulations";
import type { OrganizationDto } from "@/services/organizations/types";

import { DepositGateBanner } from "./deposit-gate-banner";
import { ProjectHeaderActions } from "./project-header-actions";


export type ProjectTabKey =
  | "overview"
  | "builder"
  | "spec-sheets"
  | "proposals"
  | "trial-batches"
  | "qc"
  | "history";


/**
 * Shared chrome for every Project workspace tab.
 *
 * Renders a compact project header (code, name, status pill) and a
 * horizontal tab bar with the five sections. Each tab page calls
 * ``<ProjectShell overview={...} activeTab="overview">children</ProjectShell>``
 * and drops its own content into the slot. The active tab is
 * driven by a prop rather than pathname parsing so tab routes
 * stay deep-linkable without any client-side route listening.
 */
export function ProjectShell({
  organization,
  overview,
  activeTab,
  children,
}: {
  organization: OrganizationDto;
  overview: ProjectOverviewDto;
  activeTab: ProjectTabKey;
  children: ReactNode;
}) {
  const tTabs = useTranslations("project_tabs");
  const tNav = useTranslations("navigation");

  // Wizard-style tab gating — later tabs stay disabled + tooltipped
  // until the earlier gates pass. Rules come server-side on
  // ``overview.stage_gates`` (see StageGates in overview.py).
  const gates = overview.stage_gates;
  const tabs: {
    key: ProjectTabKey;
    label: string;
    href: string;
    icon: ReactNode;
    count?: number;
    lockedReason?: string;
  }[] = [
    {
      key: "overview",
      label: tTabs("overview"),
      href: `/formulations/${overview.id}`,
      icon: <LayoutDashboard className="h-4 w-4" />,
    },
    {
      key: "builder",
      label: tTabs("builder"),
      href: `/formulations/${overview.id}/builder`,
      icon: <Sparkles className="h-4 w-4" />,
    },
    {
      key: "spec-sheets",
      label: tTabs("spec_sheets"),
      href: `/formulations/${overview.id}/spec-sheets`,
      icon: <FileText className="h-4 w-4" />,
      count: overview.spec_sheets.total,
      lockedReason: gates.spec_sheets
        ? undefined
        : gates.builder_complete
          ? "Save an explicit version of the Builder first (auto-snapshots don't count)."
          : "Finish the Builder first — every stage needs at least one ingredient and every ingredient needs a stage assignment.",
    },
    // Proposals live at the customer/order level for RTG catalog
    // SKUs — a single RTG spec can be on N different proposals across
    // N different customers, so a per-project proposals tab doesn't
    // fit. Filtered out below when project_type=ready_to_go.
    {
      key: "proposals",
      label: tTabs("proposals"),
      href: `/formulations/${overview.id}/proposals`,
      icon: <PoundSterling className="h-4 w-4" />,
      lockedReason: gates.proposals
        ? undefined
        : gates.builder_complete
          ? "Get a spec sheet approved (scientist + director sign-off) before drafting a proposal."
          : "Finish the Builder first — every stage needs at least one ingredient and every ingredient needs a stage assignment.",
    },
    {
      key: "trial-batches",
      label: tTabs("trial_batches"),
      href: `/formulations/${overview.id}/trial-batches`,
      icon: <FlaskConical className="h-4 w-4" />,
      count: overview.trial_batches.total,
      lockedReason: gates.trial_batches
        ? // Even if the wizard-gate says "you can visit this tab",
          // we still refuse trial-batch creation until the deposit
          // clears. Surface it as the tab-level lock reason so the
          // scientist sees the block before clicking through.
          overview.deposit_gate.unlocked
          ? undefined
          : `Awaiting deposit on ${overview.deposit_gate.proposal_code ?? "the accepted proposal"} — trial batches unlock once finance approves the payment.`
        : gates.builder_complete
          ? "Send a proposal to the customer and get it signed before running trial batches."
          : "Finish the Builder first — every stage needs at least one ingredient and every ingredient needs a stage assignment.",
    },
    {
      key: "qc",
      label: tTabs("qc"),
      href: `/formulations/${overview.id}/qc`,
      icon: <ShieldCheck className="h-4 w-4" />,
      count: overview.qc.total,
      lockedReason: gates.qc
        ? undefined
        : "Run at least one trial batch to unlock QC.",
    },
    {
      key: "history",
      label: tTabs("history"),
      href: `/formulations/${overview.id}/history`,
      icon: <History className="h-4 w-4" />,
    },
  ];

  return (
    <div className="mt-6 flex flex-col gap-5 md:mt-8">
      <Link
        href="/formulations"
        className="inline-flex w-fit items-center gap-1 text-xs font-medium text-ink-500 transition-colors hover:text-ink-1000"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {tNav("main.formulations")}
      </Link>
      <CompactHeader organization={organization} overview={overview} />
      <DepositGateBanner gate={overview.deposit_gate} />
      <TabBar
        tabs={tabs.filter(
          (t) =>
            !(t.key === "proposals" && overview.project_type === "ready_to_go"),
        )}
        activeTab={activeTab}
      />
      <div>{children}</div>
    </div>
  );
}


function CompactHeader({
  organization,
  overview,
}: {
  organization: OrganizationDto;
  overview: ProjectOverviewDto;
}) {
  const pspHref =
    organization.psp_base_url && overview.psp_finished_product_uuid
      ? `${organization.psp_base_url}/production/items/${overview.psp_finished_product_uuid}`
      : null;
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col">
        <div className="flex flex-wrap items-center gap-2">
          {overview.code ? (
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
              {overview.code}
            </p>
          ) : null}
          {pspHref ? (
            <a
              href={pspHref}
              target="_blank"
              rel="noreferrer noopener"
              title="Opens this project's linked PSP finished-product item + BOM in a new tab"
              className="inline-flex items-center gap-1 rounded-full bg-orange-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-800 ring-1 ring-inset ring-orange-200 hover:bg-orange-100"
            >
              <ExternalLink className="h-3 w-3" />
              Open on PSP
            </a>
          ) : null}
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink-1000 md:text-3xl">
          {overview.name}
        </h1>
        {overview.latest_version !== null ? (
          <p className="mt-1 text-xs text-ink-500">
            v{overview.latest_version}
            {overview.latest_version_label
              ? ` · ${overview.latest_version_label}`
              : ""}
          </p>
        ) : null}
      </div>
      <ProjectHeaderActions
        organization={organization}
        formulationId={overview.id}
        formulationCode={overview.code}
        projectStatus={overview.project_status}
        projectType={overview.project_type}
        salesPerson={overview.sales_person}
        leadScientist={overview.lead_scientist}
        isRtgPublished={overview.is_rtg_published}
        hasApprovedFinalSpec={overview.has_approved_final_spec}
      />
    </header>
  );
}


function TabBar({
  tabs,
  activeTab,
}: {
  tabs: {
    key: ProjectTabKey;
    label: string;
    href: string;
    icon: ReactNode;
    count?: number;
    lockedReason?: string;
  }[];
  activeTab: ProjectTabKey;
}) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Project workspace tabs"
      // ``-mx-*`` bleeds the scroll area to the page gutter so the
      // overflow can swipe under the edge on narrow devices. The inner
      // ``px-*`` puts the first tab back under the content column.
      className="-mx-4 overflow-x-auto border-b border-ink-200 sm:-mx-6 md:mx-0"
    >
      <ul className="flex w-max items-end gap-1 whitespace-nowrap px-4 sm:px-6 md:w-auto md:px-0">
        {tabs.map((tab) => {
          // Prop is the source of truth but we also underline when
          // the path matches, so a link the user just clicked feels
          // instant even before the new page hydrates.
          const active =
            tab.key === activeTab ||
            pathname === tab.href ||
            (tab.key !== "overview" && pathname.startsWith(`${tab.href}/`));
          const locked = Boolean(tab.lockedReason);
          const countBadge =
            typeof tab.count === "number" ? (
              <span
                className={
                  locked
                    ? "inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-ink-100 px-1.5 text-[10px] font-semibold text-ink-300"
                    : active
                      ? "inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-ink-1000 px-1.5 text-[10px] font-semibold text-ink-0"
                      : "inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-ink-100 px-1.5 text-[10px] font-semibold text-ink-500"
                }
              >
                {tab.count}
              </span>
            ) : null;
          if (locked) {
            // Render locked tabs as an inert <span> — no navigation,
            // no Link prefetch, no keyboard focus. Tooltip via ``title``
            // tells the user which gate is still closed.
            return (
              <li key={tab.key} className="shrink-0">
                <span
                  aria-disabled="true"
                  title={tab.lockedReason}
                  className="inline-flex cursor-not-allowed items-center gap-2 border-b-2 border-transparent px-3 py-2.5 text-sm font-medium text-ink-300"
                >
                  {tab.icon}
                  {tab.label}
                  {countBadge}
                </span>
              </li>
            );
          }
          return (
            <li key={tab.key} className="shrink-0">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={
                  active
                    ? "inline-flex items-center gap-2 border-b-2 border-orange-500 px-3 py-2.5 text-sm font-medium text-ink-1000"
                    : "inline-flex items-center gap-2 border-b-2 border-transparent px-3 py-2.5 text-sm font-medium text-ink-500 hover:border-ink-300 hover:text-ink-700"
                }
              >
                {tab.icon}
                {tab.label}
                {countBadge}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
