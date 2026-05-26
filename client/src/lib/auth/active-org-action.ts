"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import {
  ACTIVE_ORG_COOKIE,
  getUserOrganizationsServer,
} from "@/lib/auth/server";

/**
 * Server action invoked by the header org switcher.
 *
 * Validates that the caller actually has a membership on ``orgId``
 * before writing the cookie — a tampered request that posts an org
 * the user does not belong to is silently dropped. After writing the
 * cookie we revalidate the whole tree so the next navigation (and the
 * router.refresh() the switcher triggers) re-runs every Server
 * Component against the new active org.
 *
 * No cookie write happens for users with zero or one orgs — those
 * callers never see the switcher in the first place, and silently
 * refusing the call here means the cookie can never accidentally
 * pin a single-org user to a stale value if the membership churns.
 */
export async function setActiveOrganizationAction(orgId: string) {
  const organizations = (await getUserOrganizationsServer()) ?? [];
  if (organizations.length < 2) return;
  const match = organizations.find((o) => o.id === orgId);
  if (!match) return;

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_ORG_COOKIE, orgId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath("/", "layout");
}
