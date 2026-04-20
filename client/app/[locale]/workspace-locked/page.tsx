"use client";

import { Lock, LogOut, Mail } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import { useLogout } from "@/services/accounts";

/**
 * Landing page shown when the backend rejects a request with
 * ``organization_inactive``. All authed surfaces force-redirect
 * here via the axios interceptor — the page is intentionally
 * standalone (no app shell, no navigation) so there is nothing
 * for a locked workspace to render or mis-render.
 */
export default function WorkspaceLockedPage() {
  const tLock = useTranslations("workspace_locked");
  const router = useRouter();
  const logoutMutation = useLogout();

  const handleLogout = async () => {
    try {
      await logoutMutation.mutateAsync();
    } finally {
      router.replace("/login");
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-ink-50 px-4 py-12">
      <div className="w-full max-w-lg rounded-3xl bg-ink-0 p-8 shadow-sm ring-1 ring-ink-200">
        <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-50 ring-1 ring-inset ring-orange-200">
          <Lock className="h-5 w-5 text-orange-700" aria-hidden />
        </div>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight text-ink-1000">
          {tLock("title")}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-700">
          {tLock("body")}
        </p>

        <div className="mt-6 rounded-2xl bg-ink-50 p-4 ring-1 ring-inset ring-ink-200">
          <div className="flex items-start gap-3">
            <Mail className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" aria-hidden />
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
                {tLock("contact_label")}
              </p>
              <a
                href="mailto:support@vitanpd.com"
                className="text-sm font-medium text-orange-700 hover:text-orange-800 hover:underline"
              >
                support@vitanpd.com
              </a>
            </div>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end">
          <button
            type="button"
            onClick={handleLogout}
            disabled={logoutMutation.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink-0 px-3 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50 disabled:opacity-60"
          >
            <LogOut className="h-4 w-4" />
            {tLock("logout")}
          </button>
        </div>
      </div>
    </main>
  );
}
