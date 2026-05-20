import { PortalShell } from "@/components/portal/brutalist";

import { ForgotForm } from "./forgot-form";


export default async function PortalForgotPasswordPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  await params;
  return (
    <PortalShell>
      <ForgotForm />
    </PortalShell>
  );
}
