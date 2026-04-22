"use client";

import { LogOut, Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { UserAvatar } from "@/components/ui/user-avatar";
import { Link, useRouter } from "@/i18n/navigation";
import { useLogout } from "@/services/accounts";


export interface UserMenuProps {
  readonly fullName: string;
  readonly email: string;
  /** Opaque avatar URL — base64 data URL today, blob-storage URL
   *  tomorrow. Empty string falls back to initials. */
  readonly avatarUrl?: string;
  readonly labels: {
    readonly settings: string;
    readonly signOut: string;
    readonly openMenu: string;
  };
}


/**
 * Avatar button that opens a popover with the signed-in user's name,
 * a Settings link, and a Sign-out action.
 *
 * Replaces the old inline ``[avatar] [Sign out]`` pair. Consolidating
 * the per-user actions into a menu makes room for future entries
 * (switch organization, appearance, etc.) without cluttering the
 * header itself.
 */
export function UserMenu({
  fullName,
  email,
  avatarUrl,
  labels,
}: UserMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const logout = useLogout();

  // Click-outside to close. Esc key too — users expect both.
  useEffect(() => {
    if (!isOpen) return;
    const onDocClick = (event: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
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

  const handleSignOut = async () => {
    setIsOpen(false);
    try {
      await logout.mutateAsync();
    } finally {
      router.replace("/login");
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={labels.openMenu}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        onClick={() => setIsOpen((v) => !v)}
        className="flex h-10 w-10 items-center justify-center rounded-full outline-none transition-shadow focus:ring-2 focus:ring-orange-400 focus:ring-offset-2 focus:ring-offset-ink-0"
      >
        <UserAvatar
          name={fullName}
          email={email}
          imageUrl={avatarUrl || null}
          size={40}
        />
      </button>

      {isOpen ? (
        <div
          role="menu"
          className="absolute right-0 top-12 z-40 w-60 overflow-hidden rounded-xl bg-ink-0 shadow-lg ring-1 ring-ink-200"
        >
          <div className="border-b border-ink-100 px-4 py-3">
            <p className="truncate text-sm font-medium text-ink-1000">
              {fullName}
            </p>
            <p className="mt-0.5 truncate text-xs text-ink-500">{email}</p>
          </div>
          <ul className="py-1">
            <li>
              <Link
                role="menuitem"
                href="/settings"
                onClick={() => setIsOpen(false)}
                className="flex items-center gap-2 px-4 py-2 text-sm text-ink-700 hover:bg-ink-50 hover:text-ink-1000"
              >
                <Settings className="h-4 w-4" />
                {labels.settings}
              </Link>
            </li>
            <li>
              <button
                type="button"
                role="menuitem"
                onClick={handleSignOut}
                disabled={logout.isPending}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-ink-700 hover:bg-ink-50 hover:text-ink-1000 disabled:opacity-50"
              >
                <LogOut className="h-4 w-4" />
                {labels.signOut}
              </button>
            </li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}
