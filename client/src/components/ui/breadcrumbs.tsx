import type { ReactNode } from "react";

import { Link } from "@/i18n/navigation";

export interface BreadcrumbItem {
  readonly label: string;
  readonly href?: string;
}

/**
 * Brutalist breadcrumb trail rendered above a page's main heading.
 *
 * The last item is always treated as the "current" page and rendered
 * without a link regardless of whether ``href`` is provided, so the
 * caller can hand in a uniform list without having to special-case
 * the final entry.
 */
export function Breadcrumbs({
  items,
}: {
  items: readonly BreadcrumbItem[];
}): ReactNode {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center gap-2 font-mono text-[10px] tracking-widest uppercase text-ink-500"
    >
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        return (
          <span key={`${item.label}-${index}`} className="flex items-center gap-2">
            {index > 0 ? <span aria-hidden>/</span> : null}
            {isLast || !item.href ? (
              <span className="text-ink-1000">{item.label}</span>
            ) : (
              <Link
                href={item.href}
                className="text-ink-500 hover:text-ink-1000"
              >
                {item.label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
