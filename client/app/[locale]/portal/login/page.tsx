import { PortalShell } from "@/components/portal/brutalist";

import { PortalLoginForm } from "./portal-login-form";


export default async function PortalLoginPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  await params;
  return (
    <PortalShell>
      <PortalLoginForm />
    </PortalShell>
  );
}
