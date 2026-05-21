import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  ArrowRight,
  ClipboardList,
  FileText,
  FlaskConical,
  Settings as SettingsIcon,
} from "lucide-react";

import {
  Card,
  Eyebrow,
  PageHeader,
  PortalShell,
} from "@/components/portal/brutalist";
import { env } from "@/config/env";


/**
 * Portal hub.
 *
 * Previously this route doubled as the proposals list. After
 * customer feedback ("a lot of confusion, too much info") the
 * page restructure splits navigation into a hub of section
 * cards: Proposals / Specifications / Settings. Each card
 * surfaces a small counter so the customer can see "I have N
 * proposals" without clicking through.
 */
export default async function PortalHub() {
  const jar = await cookies();
  const portalCookie = jar.get("vita_portal_access");
  if (!portalCookie) {
    redirect("/portal/login");
  }

  const headers = { Cookie: `vita_portal_access=${portalCookie.value}` };
  const base = env.NEXT_PUBLIC_API_URL;

  const [meRes, propRes, specRes, cffRes] = await Promise.all([
    fetch(`${base}/api/portal/auth/me/`, { cache: "no-store", headers }).catch(() => null),
    fetch(`${base}/api/portal/proposals/`, { cache: "no-store", headers }).catch(() => null),
    fetch(`${base}/api/portal/specs/`, { cache: "no-store", headers }).catch(() => null),
    fetch(`${base}/api/portal/cffs/`, { cache: "no-store", headers }).catch(() => null),
  ]);

  if (!meRes || meRes.status === 401 || meRes.status === 403) {
    redirect("/portal/login");
  }

  const me = meRes.ok ? await meRes.json() : null;
  const proposals = propRes && propRes.ok ? await propRes.json() : { results: [] };
  const specs = specRes && specRes.ok ? await specRes.json() : { results: [] };
  const cffs = cffRes && cffRes.ok ? await cffRes.json() : { results: [] };

  const proposalCount: number = proposals.results?.length ?? 0;
  const specCount: number = specs.results?.length ?? 0;
  const cffCount: number = cffs.results?.length ?? 0;
  const signedProposals: number = (proposals.results || []).filter(
    (p: { status: string }) => p.status === "accepted",
  ).length;
  // Open = anything Wix hasn't marked closed/archived. Lets the
  // customer see at-a-glance how many of their requests are still
  // in-flight vs. historical record. Match Wix's lowercased status
  // strings so a typo in casing doesn't drop the row from the count.
  const openCFFs: number = (cffs.results || []).filter(
    (c: { status?: string }) => {
      const s = (c.status || "").toLowerCase();
      return s !== "closed" && s !== "archived";
    },
  ).length;

  return (
    <PortalShell active="home">
      <PageHeader
        eyebrow="Welcome"
        title={me?.customer_company || "Your portal"}
        subtitle="Everything Vita has shared with you, in one place. Open a card below to dive in."
      />

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <HubCard
          href="/portal/proposals"
          icon={<FileText className="h-7 w-7" />}
          eyebrow="01 / Proposals"
          title="Your proposals"
          stat={proposalCount === 0 ? "No proposals yet" : `${proposalCount} total · ${signedProposals} signed`}
          accent
        />
        <HubCard
          href="/portal/specs"
          icon={<FlaskConical className="h-7 w-7" />}
          eyebrow="02 / Specifications"
          title="Specification sheets"
          stat={specCount === 0 ? "No specs yet" : `${specCount} attached`}
        />
        <HubCard
          href="/portal/cffs"
          icon={<ClipboardList className="h-7 w-7" />}
          eyebrow="03 / Requests"
          title="Custom formulation requests"
          stat={
            cffCount === 0
              ? "No requests yet"
              : `${cffCount} total · ${openCFFs} open`
          }
        />
      </div>

      <div className="mt-8">
        <Card hover className="block">
          <a href="/portal/settings" className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <span className="border-2 border-black bg-white p-3 text-black">
                <SettingsIcon className="h-5 w-5" />
              </span>
              <div>
                <Eyebrow>Settings</Eyebrow>
                <div className="mt-1 text-lg font-black uppercase tracking-tight">
                  Your details, password & avatar
                </div>
              </div>
            </div>
            <ArrowRight className="h-5 w-5" />
          </a>
        </Card>
      </div>
    </PortalShell>
  );
}


function HubCard({
  href,
  icon,
  eyebrow,
  title,
  stat,
  accent = false,
}: {
  href: string;
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  stat: string;
  accent?: boolean;
}) {
  // Inverted ``accent`` styling for the primary card (Proposals)
  // because that's where the customer wants to land first.
  return (
    <Card hover accent={accent} className="block">
      <a href={href} className="flex h-full flex-col gap-6">
        <div className="flex items-start justify-between">
          <span
            className={`inline-flex h-12 w-12 items-center justify-center border-2 ${
              accent ? "border-white bg-white text-black" : "border-black bg-paper text-black"
            }`}
          >
            {icon}
          </span>
          <ArrowRight className="h-5 w-5" />
        </div>
        <div>
          <div className={accent ? "text-white/70" : "text-neutral-500"}>
            <span className="text-[10px] font-bold uppercase tracking-[0.2em]">
              {eyebrow}
            </span>
          </div>
          <h2 className="mt-2 text-2xl font-black uppercase leading-tight tracking-tight">
            {title}
          </h2>
          <p className={`mt-3 text-sm ${accent ? "text-white/80" : "text-neutral-700"}`}>
            {stat}
          </p>
        </div>
      </a>
    </Card>
  );
}
