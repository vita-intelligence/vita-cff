import { setRequestLocale } from "next-intl/server";

import { loadProjectForTab } from "../_shared/load-project";
import { PageBuilderClient } from "./page-builder-client";


/**
 * Full-viewport page builder route. Puck's UI wants the whole
 * screen (sidebars + canvas + viewport picker), so we don't wrap
 * it in the standard project shell — the sole responsibility here
 * is to hydrate the formulation server-side and hand it to the
 * client wrapper.
 */
export default async function RTGPageBuilderPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  const { organization, formulation, canWrite } = await loadProjectForTab(
    locale,
    id,
  );

  return (
    <main className="h-dvh w-dvw overflow-hidden bg-white">
      <PageBuilderClient
        orgId={organization.id}
        formulation={formulation}
        canEdit={canWrite}
      />
    </main>
  );
}
