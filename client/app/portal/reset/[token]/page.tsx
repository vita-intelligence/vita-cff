import { PortalShell } from "@/components/portal/brutalist";

import { ResetForm } from "./reset-form";


export default async function PortalResetPasswordPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <PortalShell>
      <ResetForm token={token} />
    </PortalShell>
  );
}
