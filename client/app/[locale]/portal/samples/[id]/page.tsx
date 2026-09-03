import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  Circle,
  Clock,
  FileText,
  MinusCircle,
  ShieldCheck,
  Truck,
} from "lucide-react";

import {
  Eyebrow,
  PageHeader,
  PortalShell,
} from "@/components/portal/brutalist";
import { env } from "@/config/env";


/**
 * /portal/samples/[id] — per-sample fulfilment detail (NPD portal).
 *
 * Mirrors the web-site portal's ``/portal/samples/[id]`` surface so a
 * customer sees the same information regardless of which branded
 * portal they land on. Data comes from ``GET /api/portal/samples/<id>/``
 * (payment id is the URL segment — same ownership + shape the
 * web-site portal reads).
 *
 * MVP scope: read-only. Dispatch photo lightbox + per-visit
 * confirm-delivery button aren't ported yet (customer can still see
 * the pickup timeline, driver name, tracking number etc.); Release
 * documents render as an inline list with download links straight
 * off the portal proxy.
 */


type StageState = "done" | "current" | "future" | "skipped";


interface PipelineStage {
  readonly key: string;
  readonly label: string;
  readonly state: StageState;
  readonly completed_at?: string | null;
  readonly note?: string | null;
}


interface NextAction {
  readonly kind: string;
  readonly title: string;
  readonly description: string;
}


interface ReleaseDocument {
  readonly uuid: string;
  readonly kind: string;
  readonly filename: string;
  readonly mime: string;
  readonly byte_size: number;
  readonly uploaded_at: string;
}


interface DispatchPickupEventPhoto {
  readonly uuid: string;
  readonly filename: string;
  readonly mime: string;
}


interface DispatchPickupEvent {
  readonly uuid: string;
  readonly qty: string;
  readonly picked_up_at: string;
  readonly driver_name: string | null;
  readonly vehicle_registration: string | null;
  readonly consignment_note_ref: string | null;
  readonly tracking_number: string | null;
  readonly seal_number: string | null;
  readonly temperature_c: string | null;
  readonly delivered_at: string | null;
  readonly recipient_signatory: string | null;
  readonly delivery_notes: string | null;
  readonly photos: readonly DispatchPickupEventPhoto[];
}


interface DispatchSnapshot {
  readonly status: "partially_picked" | "picked_up" | "delivered";
  readonly qty: string | null;
  readonly picked_up_qty: string | null;
  readonly remaining_qty: string | null;
  readonly ready_at: string | null;
  readonly picked_up_at: string | null;
  readonly delivered_at: string | null;
  readonly carrier: string | null;
  readonly pickup_events: readonly DispatchPickupEvent[];
}


interface SampleDetail {
  readonly sample: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly amount: string | null;
    readonly currency: string;
    readonly ordered_at: string | null;
    readonly updated_at: string | null;
    readonly status_key: string;
  };
  readonly pipeline: readonly PipelineStage[];
  readonly next_action: NextAction | null;
  readonly release_documents: readonly ReleaseDocument[];
  readonly dispatch: DispatchSnapshot | null;
}


const RELEASE_DOC_LABEL: Record<string, string> = {
  coa: "Certificate of Analysis",
  bmr: "Batch Manufacturing Record",
  micro: "Microbiology report",
  label_proof: "Approved label proof",
  retain_sample: "Retain-sample record",
};


export default async function PortalSampleDetailPage({
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

  const res = await fetch(`${base}/api/portal/samples/${id}/`, {
    cache: "no-store",
    headers,
  }).catch(() => null);

  if (!res || res.status === 401 || res.status === 403) {
    redirect("/portal/login");
  }
  if (res.status === 404) {
    notFound();
  }
  if (!res.ok) {
    return (
      <PortalShell active="products">
        <BackLink />
        <div className="mt-6 border-2 border-black bg-red-50 p-6">
          <p className="text-sm font-bold uppercase tracking-[0.18em]">
            Couldn&rsquo;t load this sample right now.
          </p>
          <p className="mt-2 text-sm text-neutral-700">
            Refresh the page — if this persists, let us know.
          </p>
        </div>
      </PortalShell>
    );
  }

  const data: SampleDetail = await res.json();
  const currentStage = data.pipeline.find((s) => s.state === "current");
  const lastDoneStage = [...data.pipeline].reverse().find((s) => s.state === "done");
  const headlineStage = currentStage ?? lastDoneStage ?? data.pipeline[0];

  return (
    <PortalShell active="products">
      <BackLink />
      <div className="mt-4">
        <PageHeader
          eyebrow={`Sample kit${data.sample.code ? ` · ${data.sample.code}` : ""}`}
          title={data.sample.name || "Sample kit"}
          subtitle={headlineStage?.note ?? ""}
        />
      </div>

      {/* Summary strip — amount + ordered date. Reinforces "you paid
          X for this on Y" so the customer can reconcile against
          their bank statement without having to open the payment. */}
      <div className="mb-8 flex flex-wrap items-center gap-x-6 gap-y-2 border-2 border-black bg-neutral-50 px-4 py-3 text-xs">
        {data.sample.amount ? (
          <span>
            <span className="font-bold uppercase tracking-[0.18em] text-neutral-500">Paid · </span>
            <span className="font-black tabular-nums">
              {formatMoney(data.sample.amount, data.sample.currency)}
            </span>
          </span>
        ) : null}
        {data.sample.ordered_at ? (
          <span>
            <span className="font-bold uppercase tracking-[0.18em] text-neutral-500">Ordered · </span>
            <span>{formatDate(data.sample.ordered_at)}</span>
          </span>
        ) : null}
        <span>
          <span className="font-bold uppercase tracking-[0.18em] text-neutral-500">Status · </span>
          <span className="uppercase tracking-wide">{data.sample.status_key.replace(/_/g, " ")}</span>
        </span>
      </div>

      {data.next_action ? <NextStatusBanner action={data.next_action} /> : null}

      <section className="mt-8 mb-8">
        <Eyebrow>Your kit&rsquo;s journey</Eyebrow>
        <Stepper stages={data.pipeline} />
      </section>

      {data.dispatch ? (
        <section className="mt-8 mb-8">
          <Eyebrow>Dispatch</Eyebrow>
          <div className="mt-3">
            <DispatchCard dispatch={data.dispatch} />
          </div>
        </section>
      ) : null}

      {data.release_documents.length > 0 ? (
        <section className="mt-8 mb-8">
          <Eyebrow>Release documents</Eyebrow>
          <ReleaseDocumentsCard documents={data.release_documents} sampleId={id} />
        </section>
      ) : null}
    </PortalShell>
  );
}


function BackLink() {
  return (
    <Link
      href="/portal/products"
      className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.18em] text-neutral-500 hover:text-black"
    >
      <ArrowLeft className="h-3.5 w-3.5" /> Back to portal
    </Link>
  );
}


function NextStatusBanner({ action }: { action: NextAction }) {
  const isDelivered = action.kind === "psp:delivered";
  return (
    <div
      className={`mt-2 flex flex-col gap-2 border-2 border-black p-5 sm:flex-row sm:items-start sm:justify-between ${
        isDelivered ? "bg-emerald-100" : "bg-orange-500 text-black"
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`inline-flex h-10 w-10 shrink-0 items-center justify-center border-2 border-black ${
            isDelivered ? "bg-emerald-500 text-black" : "bg-white text-black"
          }`}
        >
          {isDelivered ? <Check className="h-5 w-5" /> : <Clock className="h-5 w-5" />}
        </span>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.25em]">Current status</p>
          <p className="mt-1 text-lg font-black uppercase leading-tight sm:text-xl">
            {action.title}
          </p>
          <p className="mt-1 text-sm">{action.description}</p>
        </div>
      </div>
    </div>
  );
}


function Stepper({ stages }: { stages: readonly PipelineStage[] }) {
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
              {stage.note ? (
                <p className="mt-2 text-xs leading-snug opacity-90 sm:text-sm">{stage.note}</p>
              ) : null}
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
      return "In progress";
    case "skipped":
      return "Not applicable";
    case "future":
    default:
      return "Coming up";
  }
}


function StageDot({ state }: { state: StageState }) {
  const base = "flex h-7 w-7 shrink-0 items-center justify-center border-2 border-black";
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
        <Clock className="h-4 w-4" />
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


function DispatchCard({ dispatch }: { dispatch: DispatchSnapshot }) {
  const statusCopy = dispatch.status === "delivered"
    ? "Delivered"
    : dispatch.status === "picked_up"
      ? "In transit"
      : "Partial pickup";
  return (
    <div className="border-2 border-black bg-white">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-black bg-black px-4 py-3 text-white">
        <div className="flex items-center gap-2">
          <Truck className="h-4 w-4" />
          <p className="text-[10px] font-bold uppercase tracking-[0.25em]">{statusCopy}</p>
        </div>
        {dispatch.qty ? (
          <p className="text-xs">
            <span className="opacity-70">Total qty · </span>
            <span className="font-bold tabular-nums">{dispatch.qty}</span>
            {dispatch.picked_up_qty ? (
              <>
                <span className="ml-3 opacity-70">Picked up · </span>
                <span className="font-bold tabular-nums">{dispatch.picked_up_qty}</span>
              </>
            ) : null}
          </p>
        ) : null}
      </header>
      <div className="p-4">
        {dispatch.pickup_events.length === 0 ? (
          <p className="text-sm text-neutral-600">
            No pickup events yet. We&rsquo;ll update this the moment the carrier collects your kit.
          </p>
        ) : (
          <ol className="space-y-4">
            {dispatch.pickup_events.map((event) => (
              <li key={event.uuid} className="border-l-2 border-black pl-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-bold uppercase tracking-tight">
                    Pickup · qty {event.qty}
                  </p>
                  <p className="text-[10px] uppercase tracking-widest text-neutral-500">
                    {formatDateTime(event.picked_up_at)}
                  </p>
                </div>
                <div className="mt-2 grid gap-x-6 gap-y-1 text-xs text-neutral-700 sm:grid-cols-2">
                  {event.driver_name ? (
                    <span>
                      <span className="font-semibold">Driver:</span> {event.driver_name}
                    </span>
                  ) : null}
                  {event.vehicle_registration ? (
                    <span>
                      <span className="font-semibold">Vehicle:</span> {event.vehicle_registration}
                    </span>
                  ) : null}
                  {event.tracking_number ? (
                    <span>
                      <span className="font-semibold">Tracking:</span> {event.tracking_number}
                    </span>
                  ) : null}
                  {event.consignment_note_ref ? (
                    <span>
                      <span className="font-semibold">Consignment:</span> {event.consignment_note_ref}
                    </span>
                  ) : null}
                  {event.seal_number ? (
                    <span>
                      <span className="font-semibold">Seal:</span> {event.seal_number}
                    </span>
                  ) : null}
                  {event.temperature_c ? (
                    <span>
                      <span className="font-semibold">Temperature:</span> {event.temperature_c}°C
                    </span>
                  ) : null}
                </div>
                {event.delivered_at ? (
                  <p className="mt-2 text-xs text-emerald-700">
                    <Check className="mr-1 inline h-3 w-3" />
                    Delivered {formatDateTime(event.delivered_at)}
                    {event.recipient_signatory ? ` · signed by ${event.recipient_signatory}` : ""}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}


function ReleaseDocumentsCard({
  documents,
  sampleId,
}: {
  documents: readonly ReleaseDocument[];
  sampleId: string;
}) {
  return (
    <div className="mt-3 border-2 border-black bg-white p-4">
      <div className="mb-3 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4" />
        <p className="text-[10px] font-bold uppercase tracking-[0.25em]">Signed by QA</p>
      </div>
      <p className="mb-3 text-xs text-neutral-600">
        Keep these with your compliance records.
      </p>
      <ul className="flex flex-col gap-2">
        {documents.map((doc) => {
          const href = `/api/portal/samples/${encodeURIComponent(sampleId)}/release-documents/${encodeURIComponent(doc.uuid)}`;
          return (
            <li key={doc.uuid} className="border-2 border-black bg-white p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <FileText className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <p className="text-sm font-bold uppercase tracking-tight">
                      {releaseDocLabel(doc.kind)}
                    </p>
                    <p className="mt-0.5 text-[11px] text-neutral-500">
                      {doc.filename} · {formatBytes(doc.byte_size)} · uploaded{" "}
                      {formatDate(doc.uploaded_at)}
                    </p>
                  </div>
                </div>
                <a
                  href={href}
                  className="inline-flex shrink-0 items-center gap-1.5 border-2 border-black bg-black px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-white hover:bg-neutral-800"
                >
                  Download
                </a>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}


function releaseDocLabel(kind: string): string {
  return RELEASE_DOC_LABEL[kind] ?? kind.replace(/_/g, " ");
}


function formatMoney(amount: string, currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${currency || ""}`.trim();
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: currency || "GBP",
      minimumFractionDigits: 2,
    }).format(n);
  } catch {
    return `£${n.toFixed(2)}`;
  }
}


function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}


function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}


function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
