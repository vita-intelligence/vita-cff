"use client";

/**
 * Desktop sign-out affordance for the customer portal.
 *
 * Renders an icon-only button so it doesn't visually compete with
 * the inbox bell or the nav links; the tooltip + ``aria-label`` is
 * the discoverability path. On click it hits
 * ``/api/portal/auth/logout/`` to clear the ``vita_portal_access``
 * cookie server-side, then sends the customer back to
 * ``/portal/login`` so they can re-authenticate (or log in as a
 * different user).
 *
 * Errors are swallowed deliberately: even if the API call fails,
 * landing back at the login page is the safest fallback (any stale
 * cookie that didn't clear will get overwritten on the next
 * successful login).
 */

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { logout as portalLogout } from "@/services/portal/api";


export function PortalSignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    if (busy) return;
    setBusy(true);
    try {
      await portalLogout();
    } catch {
      /* swallow — see file-level docstring */
    } finally {
      setBusy(false);
      router.push("/portal/login");
      router.refresh();
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title="Sign out"
      aria-label="Sign out"
      className="inline-flex h-10 w-10 items-center justify-center border-2 border-black bg-white text-black shadow-[3px_3px_0_#000] transition-transform hover:-translate-x-[1px] hover:-translate-y-[1px] hover:shadow-[4px_4px_0_#000] active:translate-x-[1px] active:translate-y-[1px] active:shadow-[2px_2px_0_#000] disabled:opacity-60"
    >
      <LogOut className="h-4 w-4" />
    </button>
  );
}
