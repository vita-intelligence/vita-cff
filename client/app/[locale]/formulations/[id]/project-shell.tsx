"use client";

import {
  ArrowLeft,
  FileText,
  FlaskConical,
  LayoutDashboard,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { Link, usePathname } from "@/i18n/navigation";
import type { ProjectOverviewDto } from "@/services/formulations";
import type { OrganizationDto } from "@/services/organizations/types";

import { ProjectHeaderActions } from "./project-header-actions";


export type ProjectTabKey =
  | "overview"
  | "builder"
  | "spec-sheets"
  | "trial-batches"
  | "qc";


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

  const tabs: {
    key: ProjectTabKey;
    label: string;
    href: string;
    icon: ReactNode;
    count?: number;
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
    },
    {
      key: "trial-batches",
      label: tTabs("trial_batches"),
      href: `/formulations/${overview.id}/trial-batches`,
      icon: <FlaskConical className="h-4 w-4" />,
      count: overview.trial_batches.total,
    },
    {
      key: "qc",
      label: tTabs("qc"),
      href: `/formulations/${overview.id}/qc`,
      icon: <ShieldCheck className="h-4 w-4" />,
      count: overview.qc.total,
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
      <TabBar tabs={tabs} activeTab={activeTab} />
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
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col">
        {overview.code ? (
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {overview.code}
          </p>
        ) : null}
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
        projectStatus={overview.project_status}
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
                {typeof tab.count === "number" ? (
                  <span
                    className={
                      active
                        ? "inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-ink-1000 px-1.5 text-[10px] font-semibold text-ink-0"
                        : "inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-ink-100 px-1.5 text-[10px] font-semibold text-ink-500"
                    }
                  >
                    {tab.count}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
