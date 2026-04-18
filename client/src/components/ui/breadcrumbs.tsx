import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { Link } from "@/i18n/navigation";

export interface BreadcrumbItem {
  readonly label: string;
  readonly href?: string;
}

/**
 * Breadcrumb trail rendered above a page's main heading.
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
      className="flex flex-wrap items-center gap-1 text-xs text-ink-500"
    >
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        return (
          <span
            key={`${item.label}-${index}`}
            className="inline-flex items-center gap-1"
          >
            {index > 0 ? (
              <ChevronRight className="h-3 w-3 text-ink-300" aria-hidden />
            ) : null}
            {isLast || !item.href ? (
              <span className="font-medium text-ink-1000">{item.label}</span>
            ) : (
              <Link
                href={item.href}
                className="text-ink-500 transition-colors hover:text-ink-1000"
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
