import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  ArrowRight,
  Check,
  Circle,
  FileText,
  Loader2,
  MinusCircle,
} from "lucide-react";

import {
  Eyebrow,
  PageHeader,
  PortalShell,
} from "@/components/portal/brutalist";
import { env } from "@/config/env";

import { SampleSelectionCard } from "./sample-selection-card";


type StageState = "done" | "current" | "future" | "skipped";


interface PipelineStage {
  readonly key: string;
  readonly label: string;
  readonly state: StageState;
  readonly completed_at: string | null;
  readonly detail: string;
}


interface NextAction {
  readonly label: string;
  readonly subtitle: string;
  readonly url: string;
  readonly urgency: "high" | "medium" | "low";
}


interface DocumentEntry {
  readonly kind: string;
  readonly label: string;
  readonly status: string;
  readonly signed_at: string | null;
  readonly url: string;
}


interface TimelineEntry {
  readonly kind: string;
  readonly title: string;
  readonly notes: string;
  readonly created_at: string;
}


interface ProductDetail {
  readonly product: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly project_status: string;
  };
  readonly pipeline: ReadonlyArray<PipelineStage>;
  readonly next_action: NextAction | null;
  readonly documents: ReadonlyArray<DocumentEntry>;
  readonly timeline: ReadonlyArray<TimelineEntry>;
}


export default async function PortalProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const jar = await cookies();
  const portalCookie = jar.get("vita_portal_access");
  if (!portalCookie) {
    redirect("/portal/login");
  }

  const headers = { Cookie: `vita_portal_access=${portalCookie.value}` };
  const base = env.NEXT_PUBLIC_API_URL;

  const res = await fetch(`${base}/api/portal/products/${id}/`, {
    cache: "no-store",
    headers,
  }).catch(() => null);

  if (!res || res.status === 401 || res.status === 403) {
    redirect("/portal/login");
  }
  if (!res.ok) {
    redirect("/portal/products");
  }

  const data: ProductDetail = await res.json();
  const currentStage = data.pipeline.find((s) => s.state === "current");
  const lastDoneStage = [...data.pipeline]
    .reverse()
    .find((s) => s.state === "done");
  const headlineStage = currentStage ?? lastDoneStage ?? data.pipeline[0];

  return (
    <PortalShell active="products">
      <PageHeader
        eyebrow={data.product.code || "Project"}
        title={data.product.name || "Your project"}
        subtitle={headlineStage?.detail ?? ""}
        back={{ href: "/portal/products", label: "All products" }}
      />

      {/* Universal next-step CTA. Always sits above the stepper so
          the customer never has to hunt for "where do I click next?".
          Hidden when nothing is required from them. */}
      {data.next_action ? (
        <NextActionBanner action={data.next_action} />
      ) : (
        <NoActionBanner
          currentStageKey={currentStage?.key}
          currentStageLabel={currentStage?.label}
        />
      )}

      {/* Sample-selection card — client component, renders whenever
          the pipeline flags ``sample_selection`` as ``current``.
          Handles its own fetch + confirm + router.refresh(); this
          server component just decides whether to mount it. */}
      {data.pipeline.some(
        (s) => s.key === "sample_selection" && s.state === "current",
      ) ? (
        <SampleSelectionCard projectId={id} />
      ) : null}

      <section className="mt-10 mb-10">
        <Eyebrow>Your journey</Eyebrow>
        <Stepper stages={data.pipeline} />
      </section>

      {data.documents.length > 0 ? (
        <section className="mb-10">
          <Eyebrow>Documents</Eyebrow>
          <ul className="mt-3 flex flex-col gap-2">
            {data.documents.map((doc, idx) => (
              <li key={`${doc.kind}-${idx}`}>
                <a
                  href={doc.url}
                  className="group flex flex-col gap-1 border-2 border-black bg-white p-3 transition-all hover:shadow-[3px_3px_0_0_black] sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                >
                  <div className="flex items-center gap-3">
                    <FileText className="h-4 w-4 shrink-0" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold uppercase tracking-tight">
                        {doc.label}
                      </p>
                      <p className="text-[10px] uppercase tracking-widest text-neutral-500">
                        {doc.status}
                        {doc.signed_at
                          ? ` · signed ${new Date(doc.signed_at).toLocaleDateString()}`
                          : ""}
                      </p>
                    </div>
                  </div>
                  <ArrowRight className="hidden h-4 w-4 shrink-0 text-neutral-400 transition-transform group-hover:translate-x-0.5 sm:block" />
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data.timeline.length > 0 ? (
        <section>
          <Eyebrow>Activity</Eyebrow>
          <ol className="mt-3 space-y-3">
            {data.timeline.slice(0, 30).map((entry, idx) => (
              <li
                key={`${entry.created_at}-${idx}`}
                className="border-l-2 border-black pl-4"
              >
                <p className="text-sm font-semibold">{entry.title}</p>
                <p className="text-[10px] uppercase tracking-widest text-neutral-500">
                  {new Date(entry.created_at).toLocaleString()}
                </p>
                {entry.notes ? (
                  <p className="mt-1 text-xs text-neutral-700">{entry.notes}</p>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </PortalShell>
  );
}


// ---------------------------------------------------------------------------
// Universal CTA
// ---------------------------------------------------------------------------


function NextActionBanner({ action }: { action: NextAction }) {
  const isHigh = action.urgency === "high";
  return (
    <a
      href={action.url}
      className={`group mt-2 flex flex-col gap-3 border-2 border-black p-5 transition-all hover:shadow-[4px_4px_0_0_black] sm:flex-row sm:items-center sm:justify-between ${
        isHigh ? "bg-orange-500 text-black" : "bg-white text-black"
      }`}
    >
      <div className="min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-[0.25em]">
          {isHigh ? "Your next step · Urgent" : "Your next step"}
        </p>
        <p className="mt-1 text-lg font-black uppercase leading-tight sm:text-xl">
          {action.label}
        </p>
        <p className="mt-1 text-sm">{action.subtitle}</p>
      </div>
      <span className="inline-flex shrink-0 items-center gap-2 border-2 border-black bg-black px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-white transition-transform group-hover:translate-x-0.5">
        Go
        <ArrowRight className="h-4 w-4" />
      </span>
    </a>
  );
}


function NoActionBanner({
  currentStageKey,
  currentStageLabel,
}: {
  currentStageKey: string | undefined;
  currentStageLabel: string | undefined;
}) {
  // Both payment gates behave the same way from the customer's
  // perspective: the action happens offline (bank transfer, card,
  // Stripe link, etc.) and finance confirms it here. Copy differs
  // only in which invoice the customer is paying against — deposit
  // rides the accepted proposal, final rides the signed spec.
  if (currentStageKey === "deposit") {
    return (
      <div className="mt-2 flex flex-col gap-2 border-2 border-black bg-amber-100 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-amber-900">
            Waiting for deposit
          </p>
          <p className="mt-1 text-base font-bold">
            Deposit unlocks trial production.
          </p>
          <p className="mt-1 text-sm text-amber-900">
            You&apos;ll receive the deposit invoice by email if you
            haven&apos;t already. As soon as our finance team confirms your
            payment, our scientists start producing your trial batch.
            Get in touch if you need the invoice re-sent.
          </p>
        </div>
      </div>
    );
  }
  if (currentStageKey === "payment") {
    return (
      <div className="mt-2 flex flex-col gap-2 border-2 border-black bg-amber-100 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-amber-900">
            Waiting for payment
          </p>
          <p className="mt-1 text-base font-bold">
            Payment is the next step.
          </p>
          <p className="mt-1 text-sm text-amber-900">
            If you&apos;ve already paid, sit tight — our finance team will
            confirm it on our end and update you here within one working day.
            If you haven&apos;t paid yet, expect an email from us shortly with
            the invoice and payment details.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-2 border-2 border-black bg-neutral-100 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-neutral-700">
          You&apos;re up to date
        </p>
        <p className="mt-1 text-base font-bold">
          {currentStageLabel
            ? `We're handling: ${currentStageLabel}.`
            : "All steps so far are complete."}
        </p>
        <p className="mt-1 text-sm text-neutral-700">
          Nothing required from you right now — we&apos;ll notify you the
          moment something is.
        </p>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Stepper — vertical-only so it scales to any number of stages and
// works the same on phone / tablet / desktop.
// ---------------------------------------------------------------------------


function Stepper({ stages }: { stages: ReadonlyArray<PipelineStage> }) {
  return (
    <ol className="mt-4">
      {stages.map((stage, idx) => {
        const isLast = idx === stages.length - 1;
        return (
          <li key={stage.key} className="flex gap-4">
            <div className="flex flex-col items-center">
              <StageDot state={stage.state} />
              {!isLast ? (
                <span
                  aria-hidden
                  className={`w-0.5 flex-1 ${
                    stage.state === "done" ? "bg-black" : "bg-neutral-300"
                  }`}
                  style={{ minHeight: "40px" }}
                />
              ) : null}
            </div>

            <div
              className={`mb-3 flex-1 border-2 p-3 sm:p-4 ${
                stage.state === "current"
                  ? "border-orange-500 bg-orange-500 text-black"
                  : stage.state === "done"
                    ? "border-black bg-white text-black"
                    : stage.state === "skipped"
                      ? "border-dashed border-neutral-400 bg-neutral-50 text-neutral-500"
                      : "border-neutral-300 bg-neutral-50 text-neutral-500"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[10px] font-bold uppercase tracking-[0.18em]">
                  {stateBadge(stage.state)}
                </p>
                {stage.completed_at ? (
                  <p className="text-[10px] uppercase tracking-widest opacity-70">
                    {new Date(stage.completed_at).toLocaleDateString()}
                  </p>
                ) : null}
              </div>
              <p className="mt-1 text-sm font-black uppercase leading-tight sm:text-base">
                {stage.label}
              </p>
              <p className="mt-2 text-xs leading-snug opacity-90 sm:text-sm">
                {stage.detail}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}


function stateBadge(state: StageState): string {
  switch (state) {
    case "done":
      return "Completed";
    case "current":
      return "You are here";
    case "skipped":
      return "Not applicable";
    case "future":
    default:
      return "Coming up";
  }
}


function StageDot({ state }: { state: StageState }) {
  const base =
    "flex h-7 w-7 shrink-0 items-center justify-center border-2 border-black";
  if (state === "done") {
    return (
      <span className={`${base} bg-black text-white`}>
        <Check className="h-4 w-4" />
      </span>
    );
  }
  if (state === "current") {
    return (
      <span className={`${base} bg-orange-500 text-black`}>
        <Loader2 className="h-4 w-4 animate-spin" />
      </span>
    );
  }
  if (state === "skipped") {
    return (
      <span className={`${base} border-dashed bg-white text-neutral-400`}>
        <MinusCircle className="h-3 w-3" />
      </span>
    );
  }
  return (
    <span className={`${base} border-neutral-300 bg-white text-neutral-400`}>
      <Circle className="h-3 w-3" />
    </span>
  );
}
