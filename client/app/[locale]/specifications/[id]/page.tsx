import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { redirect } from "@/i18n/navigation";
import {
  getCurrentUserServer,
  getRenderedSpecificationServer,
  getSpecificationServer,
  getUserOrganizationsServer,
} from "@/lib/auth/server";

import { SpecificationSheetView } from "./specification-sheet-view";

function resolveSpecificationsPermission(
  isOwner: boolean,
  permissions: Record<string, unknown>,
): "admin" | "write" | "read" | "none" {
  if (isOwner) return "admin";
  const level = permissions.specifications;
  if (level === "admin" || level === "write" || level === "read") return level;
  return "none";
}

export default async function SpecificationDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  const user = await getCurrentUserServer();
  if (!user) {
    redirect({ href: "/login", locale });
  }
  const currentUser = user!;

  const organizations = (await getUserOrganizationsServer()) ?? [];
  if (organizations.length === 0) {
    redirect({ href: "/home", locale });
  }
  const primaryOrg = organizations[0]!;

  const level = resolveSpecificationsPermission(
    primaryOrg.is_owner,
    primaryOrg.permissions,
  );
  if (level === "none") {
    redirect({ href: "/specifications", locale });
  }

  const [sheet, rendered] = await Promise.all([
    getSpecificationServer(primaryOrg.id, id),
    getRenderedSpecificationServer(primaryOrg.id, id),
  ]);
  if (!sheet || !rendered) {
    notFound();
  }

  const canWrite = level === "write" || level === "admin";
  const canAdmin = level === "admin";

  const tCommon = await getTranslations("common");
  const tNav = await getTranslations("navigation");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-[1400px] flex-col px-6 py-8 md:px-10 md:py-12 print:max-w-none print:p-6">
        <div className="print:hidden">
          <ProtectedHeader user={currentUser} active="specifications" />

          <section className="mt-10 md:mt-12">
            <Breadcrumbs
              items={[
                { label: tNav("main.dashboard"), href: "/home" },
                {
                  label: tNav("main.specifications"),
                  href: "/specifications",
                },
                { label: sheet.code || rendered.formulation.name },
              ]}
            />
          </section>
        </div>

        <SpecificationSheetView
          orgId={primaryOrg.id}
          sheet={sheet}
          rendered={rendered}
          canWrite={canWrite}
          canAdmin={canAdmin}
        />

        <footer className="mt-10 flex items-center justify-between border-t-2 border-ink-1000 pt-6 font-mono text-[10px] tracking-widest uppercase text-ink-500 print:hidden">
          <span>v0.1.0</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
