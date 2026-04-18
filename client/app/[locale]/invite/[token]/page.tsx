import { getTranslations, setRequestLocale } from "next-intl/server";

import { env } from "@/config/env";
import { invitationsEndpoints } from "@/services/invitations/endpoints";
import type { PublicInvitationDto } from "@/services/invitations/types";

import { AcceptInvitationForm } from "./accept-form";

type Status =
  | { kind: "ok"; invitation: PublicInvitationDto }
  | { kind: "not_found" }
  | { kind: "expired" }
  | { kind: "accepted" }
  | { kind: "unreachable" };

async function fetchInvitationStatus(token: string): Promise<Status> {
  try {
    const response = await fetch(
      `${env.NEXT_PUBLIC_API_URL}${invitationsEndpoints.detail(token)}`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      },
    );
    if (response.ok) {
      const invitation = (await response.json()) as PublicInvitationDto;
      return { kind: "ok", invitation };
    }
    if (response.status === 404) {
      return { kind: "not_found" };
    }
    if (response.status === 410) {
      // Disambiguate expired vs already accepted via the error code body.
      try {
        const body = (await response.json()) as { detail?: string[] };
        const code = body.detail?.[0];
        if (code === "invitation_expired") return { kind: "expired" };
        if (code === "invitation_already_accepted") return { kind: "accepted" };
      } catch {
        // Fall through to generic expired state.
      }
      return { kind: "expired" };
    }
    return { kind: "unreachable" };
  } catch {
    return { kind: "unreachable" };
  }
}

export default async function InviteAcceptPage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale, token } = await params;
  setRequestLocale(locale);

  const status = await fetchInvitationStatus(token);
  const tAccept = await getTranslations("invitations");
  const tCommon = await getTranslations("common");

  if (status.kind !== "ok") {
    const errorKey =
      status.kind === "not_found"
        ? "not_found"
        : status.kind === "accepted"
          ? "accepted"
          : "expired";
    return (
      <main className="flex min-h-dvh items-center justify-center bg-ink-0 px-4 py-10 sm:px-6">
        <div className="w-full max-w-md rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 sm:p-8">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {tCommon("brand")}
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink-1000 sm:text-3xl">
            {tAccept(`accept.errors.${errorKey}_title`)}
          </h1>
          <p className="mt-4 text-sm text-ink-500">
            {tAccept(`accept.errors.${errorKey}_body`)}
          </p>
        </div>
      </main>
    );
  }

  const { invitation } = status;
  const expiresAt = new Date(invitation.expires_at).toLocaleString(locale, {
    dateStyle: "long",
    timeStyle: "short",
  });

  return (
    <main className="flex min-h-dvh items-center justify-center bg-ink-0 px-4 py-10 sm:px-6">
      <div className="w-full max-w-md">
        <header className="mb-8">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {tAccept("accept.eyebrow")}
          </p>
          <h1 className="mt-2 text-2xl font-semibold leading-tight tracking-tight text-ink-1000 sm:text-3xl">
            {tAccept("accept.title_template", {
              inviter: invitation.invited_by_name,
              organization: invitation.organization_name,
            })}
          </h1>
          <p className="mt-3 text-sm text-ink-500">
            {tAccept("accept.invited_email", { email: invitation.email })}
          </p>
          <p className="mt-1 text-xs text-ink-500">
            {tAccept("accept.expires_in", { date: expiresAt })}
          </p>
        </header>

        <div className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 sm:p-8">
          <AcceptInvitationForm token={token} />
        </div>
      </div>
    </main>
  );
}
