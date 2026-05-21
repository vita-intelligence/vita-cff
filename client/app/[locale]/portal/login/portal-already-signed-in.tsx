"use client";

/**
 * Card shown on ``/portal/login`` when the caller already holds a
 * valid portal cookie.
 *
 * Two affordances:
 *
 *   * "Go to your portal" — primary path for the common case
 *     where the customer landed here by accident.
 *   * "Sign out & switch account" — clears the cookie via
 *     ``/api/portal/auth/logout/`` then re-renders this same page
 *     so the empty form appears. Lets a household / shared device
 *     hand off without a manual cache clear.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Card,
  ErrorBanner,
  Eyebrow,
  H1,
  P,
  PortalButton,
  PortalLinkButton,
} from "@/components/portal/brutalist";
import { logout as portalLogout } from "@/services/portal/api";
import { portalErrorMessage } from "@/services/portal/errors";


export function PortalAlreadySignedIn({
  email,
  company,
}: {
  email: string;
  company: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSignOut() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await portalLogout();
      // ``router.refresh()`` re-runs the parent server component;
      // with the cookie cleared, the form path takes over.
      router.refresh();
    } catch (err: unknown) {
      setError(portalErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card as="section" className="mx-auto max-w-xl">
      <Eyebrow>Already signed in</Eyebrow>
      <H1>You&apos;re still signed in.</H1>
      <P>
        {company ? (
          <>
            <strong>{company}</strong> — signed in as{" "}
            <span className="font-mono">{email}</span>.
          </>
        ) : (
          <>
            Signed in as <span className="font-mono">{email}</span>.
          </>
        )}
        {" "}
        Continue to your portal, or sign out to switch to a
        different account.
      </P>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <PortalLinkButton href="/portal">
          Go to your portal →
        </PortalLinkButton>
        <PortalButton
          type="button"
          variant="secondary"
          onClick={onSignOut}
          disabled={busy}
        >
          {busy ? "Signing out…" : "Sign out & switch account"}
        </PortalButton>
      </div>
    </Card>
  );
}
