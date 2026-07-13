import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { PortalShell } from "@/components/portal/brutalist";
import { env } from "@/config/env";

import { NewCFFWizard, type SalesPerson } from "./new-cff-wizard";


interface ProfileShape {
  readonly customer_id: string;
  readonly email: string;
  readonly name: string;
  readonly company: string;
  readonly phone: string;
  readonly invoice_address: string;
  readonly delivery_address: string;
}


interface SalesPeopleResponse {
  readonly results: ReadonlyArray<SalesPerson>;
  readonly default_email: string | null;
}


/**
 * Server component that server-side fetches the customer's profile
 * and the sales-people directory, then hands both to the client
 * wizard for prefill + the account-manager dropdown.
 *
 * The vita_portal_access cookie gates access — no cookie or a 401
 * bounces to /portal/login the same way every other portal page
 * does.
 */
export default async function NewCFFPage() {
  const jar = await cookies();
  const portalCookie = jar.get("vita_portal_access");
  if (!portalCookie) {
    redirect("/portal/login");
  }

  const headers = { Cookie: `vita_portal_access=${portalCookie.value}` };
  const base = env.NEXT_PUBLIC_API_URL;

  const [profileRes, salesRes] = await Promise.all([
    fetch(`${base}/api/portal/profile/`, {
      cache: "no-store",
      headers,
    }).catch(() => null),
    fetch(`${base}/api/portal/cffs/sales-people/`, {
      cache: "no-store",
      headers,
    }).catch(() => null),
  ]);

  if (!profileRes || profileRes.status === 401 || profileRes.status === 403) {
    redirect("/portal/login");
  }

  const profile: ProfileShape | null =
    profileRes && profileRes.ok ? await profileRes.json() : null;

  if (!profile) {
    redirect("/portal/login");
  }

  const salesData: SalesPeopleResponse =
    salesRes && salesRes.ok
      ? await salesRes.json()
      : { results: [], default_email: null };

  return (
    <PortalShell active="products">
      <NewCFFWizard
        profile={profile}
        salesPeople={salesData.results ?? []}
        defaultAccountManagerEmail={salesData.default_email ?? ""}
      />
    </PortalShell>
  );
}
