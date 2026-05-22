"use client";

import { Kanban, FileSignature } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Link } from "@/i18n/navigation";

import type { HeaderNavHref, HeaderNavItem } from "./header-nav";
import type { ProtectedNavKey } from "./protected-header";


/**
 * Map from a nav key to the icon that represents it in the side
 * cluster. Kept here (rather than on the item itself) so the icon
 * choice stays an internal layout concern — :class:`HeaderNavItem`
 * is still a pure label+href tuple shared with the link bar and the
 * mobile drawer.
 */
const SIDE_ICONS: Partial<Record<ProtectedNavKey, LucideIcon>> = {
  pipeline: Kanban,
  signed: FileSignature,
};


/**
 * Icon-only entries that sit next to the messenger bell — Pipeline
 * and Signed. They have always been peers of the lifecycle nav, but
 * the link bar grew long enough that surfacing them as text inflated
 * the row visually without giving them prominence; collapsing them
 * to icons reads as "utility" alongside the bell.
 *
 * Desktop only. The mobile drawer surfaces the same destinations as
 * full text rows via :class:`HeaderNav`, so the discoverability cost
 * of the icon-only treatment lives only on the larger viewport where
 * the hover tooltip is available.
 */
export function HeaderSideIcons({
  items,
  active,
}: {
  readonly items: readonly HeaderNavItem[];
  readonly active: ProtectedNavKey | undefined;
}) {
  if (items.length === 0) return null;
  return (
    <nav
      aria-label="Workspace shortcuts"
      className="hidden items-center gap-1 md:flex"
    >
      {items.map((item) => (
        <SideIcon key={item.key} item={item} active={active} />
      ))}
    </nav>
  );
}


function SideIcon({
  item,
  active,
}: {
  item: HeaderNavItem;
  active: ProtectedNavKey | undefined;
}) {
  const Icon = SIDE_ICONS[item.key];
  if (!Icon) return null;
  const isActive = item.key === active;
  return (
    <Link
      href={item.href as HeaderNavHref}
      title={item.label}
      aria-label={item.label}
      aria-current={isActive ? "page" : undefined}
      className={
        isActive
          ? "relative inline-flex h-9 w-9 items-center justify-center rounded-full bg-orange-50 text-orange-700 ring-1 ring-inset ring-orange-200"
          : "relative inline-flex h-9 w-9 items-center justify-center rounded-full text-ink-700 transition-colors hover:bg-ink-100 hover:text-ink-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      }
    >
      <Icon className="h-5 w-5" />
    </Link>
  );
}
