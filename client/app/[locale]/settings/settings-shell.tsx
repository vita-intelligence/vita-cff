"use client";

import {
  ArrowLeft,
  Building2,
  User2,
  Users,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { Link, usePathname } from "@/i18n/navigation";


export type SettingsTabKey = "profile" | "organization" | "members";


const ALL_TABS: readonly SettingsTabKey[] = [
  "profile",
  "organization",
  "members",
] as const;


/**
 * Shared chrome for every ``/settings`` tab.
 *
 * Mirrors :class:`ProjectShell`: a compact "← Dashboard" back-link
 * at the top, a workspace header, and a horizontal tab bar that
 * scrolls on narrow devices. Each tab page calls
 * ``<SettingsShell activeTab="profile">children</SettingsShell>``
 * and drops its own content into the slot.
 *
 * ``allowedTabs`` filters which tabs render at all — callers compute
 * it from the caller's capabilities so a locked-out user never sees
 * a clickable tab that bounces them to an access-denied screen.
 * Defaults to every tab so legacy callers don't break.
 */
export function SettingsShell({
  activeTab,
  allowedTabs = ALL_TABS,
  children,
}: {
  activeTab: SettingsTabKey;
  allowedTabs?: readonly SettingsTabKey[];
  children: ReactNode;
}) {
  const tSettings = useTranslations("settings");

  const tabs: {
    key: SettingsTabKey;
    label: string;
    href: string;
    icon: ReactNode;
  }[] = (
    [
      {
        key: "profile" as const,
        label: tSettings("tabs.profile"),
        href: "/settings",
        icon: <User2 className="h-4 w-4" />,
      },
      {
        key: "organization" as const,
        label: tSettings("tabs.organization"),
        href: "/settings/organization",
        icon: <Building2 className="h-4 w-4" />,
      },
      {
        key: "members" as const,
        label: tSettings("tabs.members"),
        href: "/settings/members",
        icon: <Users className="h-4 w-4" />,
      },
    ] as const
  ).filter((tab) => allowedTabs.includes(tab.key));

  return (
    <div className="mt-6 flex flex-col gap-5 md:mt-8">
      <Link
        href="/home"
        className="inline-flex w-fit items-center gap-1 text-xs font-medium text-ink-500 transition-colors hover:text-ink-1000"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {tSettings("back_to_dashboard")}
      </Link>

      <header className="flex flex-col">
        <h1 className="text-2xl font-semibold tracking-tight text-ink-1000 md:text-3xl">
          {tSettings("title")}
        </h1>
        <p className="mt-1 text-sm text-ink-500">{tSettings("subtitle")}</p>
      </header>

      <TabBar tabs={tabs} activeTab={activeTab} />

      <div>{children}</div>
    </div>
  );
}


function TabBar({
  tabs,
  activeTab,
}: {
  tabs: {
    key: SettingsTabKey;
    label: string;
    href: string;
    icon: ReactNode;
  }[];
  activeTab: SettingsTabKey;
}) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Settings tabs"
      className="-mx-4 overflow-x-auto border-b border-ink-200 sm:-mx-6 md:mx-0"
    >
      <ul className="flex w-max items-end gap-1 whitespace-nowrap px-4 sm:px-6 md:w-auto md:px-0">
        {tabs.map((tab) => {
          const active =
            tab.key === activeTab ||
            pathname === tab.href ||
            (tab.key !== "profile" && pathname.startsWith(`${tab.href}/`));
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
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
