"use client";

import { Building2, Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";

import { setActiveOrganizationAction } from "@/lib/auth/active-org-action";
import { useRouter } from "@/i18n/navigation";
import type { OrganizationDto } from "@/services/organizations/types";

export interface OrgSwitcherProps {
  readonly organizations: readonly OrganizationDto[];
  readonly activeOrgId: string;
}

/**
 * Header dropdown that lets a multi-org member switch which org the
 * SSR layer treats as active.
 *
 * Rendered only when the caller belongs to two or more orgs — the
 * single-org case (the overwhelming majority of users) stays exactly
 * as it was before the switcher landed: no UI, no cookie, no extra
 * work.
 *
 * Picking an entry calls a server action that writes the
 * ``vita_active_org`` cookie and revalidates the whole route tree,
 * then we ``router.refresh()`` so the current page re-renders against
 * the new active org without a hard navigation.
 */
export function OrgSwitcher({ organizations, activeOrgId }: OrgSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const rootRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (!isOpen) return;
    const onDocClick = (event: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(event.target as Node)) setIsOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [isOpen]);

  if (organizations.length < 2) return null;

  const active = organizations.find((o) => o.id === activeOrgId) ?? organizations[0];
  if (!active) return null;

  const handlePick = (orgId: string) => {
    setIsOpen(false);
    if (orgId === activeOrgId) return;
    startTransition(async () => {
      await setActiveOrganizationAction(orgId);
      router.refresh();
    });
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        disabled={isPending}
        onClick={() => setIsOpen((v) => !v)}
        className="flex h-9 max-w-[14rem] items-center gap-2 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-1000 ring-1 ring-inset ring-ink-200 hover:bg-ink-50 disabled:opacity-60"
      >
        <Building2 className="h-4 w-4 shrink-0 text-ink-500" aria-hidden />
        <span className="truncate">{active.name}</span>
        <ChevronDown
          className="h-3.5 w-3.5 shrink-0 text-ink-500"
          aria-hidden
        />
      </button>

      {isOpen ? (
        <div
          role="menu"
          className="absolute left-0 top-11 z-40 w-72 overflow-hidden rounded-xl bg-ink-0 shadow-lg ring-1 ring-ink-200"
        >
          <ul className="max-h-72 overflow-auto py-1">
            {organizations.map((org) => {
              const isActive = org.id === activeOrgId;
              return (
                <li key={org.id}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => handlePick(org.id)}
                    className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-ink-700 hover:bg-ink-50 hover:text-ink-1000"
                  >
                    <span className="flex-1 truncate">{org.name}</span>
                    {isActive ? (
                      <Check
                        className="h-4 w-4 shrink-0 text-orange-600"
                        aria-hidden
                      />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
