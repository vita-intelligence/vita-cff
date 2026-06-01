"use client";

/**
 * Unified customer-portal workspace for a single label-design row.
 *
 * Replaces the fragmented detail page + ``/upload`` + ``/content-block``
 * + ``/history`` + ``/preferences`` route tree with one tabbed
 * surface so the customer never has to navigate between pages mid-
 * workflow. Mirrors the staff workspace shape:
 *
 * - **Artwork** — status-driven action card (upload form for
 *   DESIGN_BY_CUSTOMER, brief CTA for DESIGN_BY_US, payment / hold
 *   notices for the intermediate states) plus the latest reviewer
 *   feedback and a preview of the current revision.
 * - **Content block** — full 9-region label preview + per-region
 *   PDF / PNG downloads (same surface the staff has, gated to the
 *   DESIGN_BY_CUSTOMER path).
 * - **Brief** — read-only view of the customer's submitted
 *   MA-ST-B-009 preferences (DESIGN_BY_US only).
 * - **Templates** — Vita-curated downloadable design resources.
 * - **History** — every revision with its review journey.
 * - **Chat** — the existing comments panel.
 *
 * Each tab is a small component declared at the bottom of this
 * file so the navigation hub stays readable.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Download,
  FileImage,
  FilePlus,
  FileText,
  Layers,
  Loader2,
  MessageCircle,
  PencilLine,
  Sparkles,
  UploadCloud,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";

import {
  Card,
  Eyebrow,
  PageHeader,
  PortalShell,
} from "@/components/portal/brutalist";
import { LabelDesignChatPanel } from "@/components/portal/label-design-chat-panel";
import { ScientistChecklistView } from "@/components/label-design/scientist-checklist-view";
import { SignatureField } from "@/components/ui/signature-field";
import { Link } from "@/i18n/navigation";
import {
  downloadContentBlockPdf,
  downloadContentBlockPng,
  usePortalContentBlockHtml,
  usePortalContentBlockJson,
  usePortalContentBlockText,
  usePortalLabelDesign,
  usePortalUploadArtwork,
} from "@/services/label-design";
import type {
  LabelDesignDto,
  LabelDesignPath,
  LabelDesignReviewDto,
  LabelDesignRevisionDto,
  LabelDesignStatus,
} from "@/services/label-design/types";

import { TemplatesCard } from "./templates-card";


const PdfPreview = dynamic(
  () => import("@/components/pdf-preview").then((m) => m.PdfPreview),
  { ssr: false },
);


type TabKey =
  | "artwork"
  | "content-block"
  | "brief"
  | "templates"
  | "history"
  | "chat";


const TAB_DEFS: ReadonlyArray<{
  readonly key: TabKey;
  readonly label: string;
  readonly icon: ReactNode;
}> = [
  { key: "artwork", label: "Artwork", icon: <FileImage className="h-3.5 w-3.5" /> },
  {
    key: "content-block",
    label: "Content block",
    icon: <Sparkles className="h-3.5 w-3.5" />,
  },
  { key: "brief", label: "Brief", icon: <PencilLine className="h-3.5 w-3.5" /> },
  { key: "templates", label: "Templates", icon: <Layers className="h-3.5 w-3.5" /> },
  { key: "history", label: "History", icon: <FileText className="h-3.5 w-3.5" /> },
  { key: "chat", label: "Chat", icon: <MessageCircle className="h-3.5 w-3.5" /> },
];


const STATUS_LABELS: Record<LabelDesignStatus, string> = {
  payment_pending: "Payment pending",
  label_path_pending: "Choose design path",
  design_preferences_pending: "Brief needed",
  design_in_progress: "Design in progress",
  scientist_review: "Scientist review",
  director_review: "Director review",
  customer_approval: "Your approval needed",
  label_approved: "Approved",
  on_hold: "On hold",
};


export function PortalLabelDesignWorkspace({ id }: { id: string }) {
  const { data, isLoading, error } = usePortalLabelDesign(id);
  const searchParams = useSearchParams();
  const router = useRouter();

  // Read the active tab from the URL so a deep-link (e.g. a
  // redirect from the legacy ``/portal/label-designs/<id>/upload``
  // route) lands on the right surface.
  const tabFromUrl = searchParams.get("tab") as TabKey | null;
  const [tab, setTabState] = useState<TabKey>(tabFromUrl ?? "artwork");

  // Keep URL in sync so refresh + share preserve the tab.
  const setTab = useCallback(
    (next: TabKey) => {
      setTabState(next);
      const params = new URLSearchParams(searchParams.toString());
      params.set("tab", next);
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  useEffect(() => {
    if (tabFromUrl && tabFromUrl !== tab) {
      setTabState(tabFromUrl);
    }
    // We intentionally exclude ``tab`` so URL-driven changes (back/
    // forward navigation) always sync into state; the inverse is
    // handled by ``setTab`` above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabFromUrl]);

  if (isLoading) {
    return (
      <PortalShell active="products">
        <p className="inline-flex items-center gap-2 text-sm text-neutral-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      </PortalShell>
    );
  }
  if (error || !data) {
    return (
      <PortalShell active="products">
        <Card>
          <p className="text-sm text-red-700">Couldn’t load this label.</p>
        </Card>
      </PortalShell>
    );
  }

  // Trim tab list to what's relevant for this design path.
  const tabs = TAB_DEFS.filter((t) => {
    if (t.key === "content-block")
      return data.design_path === "design_by_customer";
    if (t.key === "brief") return data.design_path === "design_by_us";
    if (t.key === "templates")
      return data.design_path === "design_by_customer";
    return true;
  });

  return (
    <PortalShell active="products">
      <PageHeader
        eyebrow={data.formulation_code || "LABEL"}
        title={data.formulation_name || "Label design"}
        subtitle={
          <span className="mt-2 inline-flex flex-wrap items-center gap-3">
            <StatusBadge status={data.status} />
            {data.specification_sheet_code ? (
              <span className="text-[11px] font-bold uppercase tracking-[0.15em] text-neutral-500">
                Spec {data.specification_sheet_code}
              </span>
            ) : null}
            {data.design_path ? (
              <span className="text-[11px] font-bold uppercase tracking-[0.15em] text-neutral-500">
                {data.design_path === "design_by_us"
                  ? "Vita is designing"
                  : "You are designing"}
              </span>
            ) : null}
          </span>
        }
      />

      <TabBar tabs={tabs} active={tab} onChange={setTab} />

      <div className="mt-4">
        {tab === "artwork" ? (
          <ArtworkTab id={id} data={data} onJumpTab={setTab} />
        ) : null}
        {tab === "content-block" ? <ContentBlockTab id={id} /> : null}
        {tab === "brief" ? <BriefTab id={id} data={data} /> : null}
        {tab === "templates" ? <TemplatesCard /> : null}
        {tab === "history" ? <HistoryTab data={data} /> : null}
        {tab === "chat" ? (
          <LabelDesignChatPanel
            labelDesignId={id}
            designLabel={data.formulation_code || "this label"}
          />
        ) : null}
      </div>
    </PortalShell>
  );
}


// ---------------------------------------------------------------------------
// Tab bar
// ---------------------------------------------------------------------------


function TabBar({
  tabs,
  active,
  onChange,
}: {
  tabs: ReadonlyArray<{ key: TabKey; label: string; icon: ReactNode }>;
  active: TabKey;
  onChange: (next: TabKey) => void;
}) {
  return (
    <nav className="-mx-1 mt-6 flex flex-wrap items-center gap-1 border-b-2 border-black pb-px">
      {tabs.map((t) => {
        const isActive = t.key === active;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            className={`inline-flex items-center gap-1.5 border-2 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.18em] transition-colors ${
              isActive
                ? "border-black bg-black text-white"
                : "border-black bg-white text-black hover:bg-neutral-100"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}


function StatusBadge({ status }: { status: LabelDesignStatus }) {
  const label = STATUS_LABELS[status] ?? status;
  const tone =
    status === "label_approved"
      ? "bg-emerald-100 text-emerald-900 ring-emerald-600/30"
      : status === "on_hold"
      ? "bg-amber-100 text-amber-900 ring-amber-600/30"
      : "bg-neutral-100 text-neutral-900 ring-neutral-600/30";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ring-1 ring-inset ${tone}`}
    >
      {label}
    </span>
  );
}


// ---------------------------------------------------------------------------
// Artwork tab — the workflow centre. Status + path decide what
// action card the customer sees.
// ---------------------------------------------------------------------------


function ArtworkTab({
  id,
  data,
  onJumpTab,
}: {
  id: string;
  data: LabelDesignDto;
  onJumpTab: (t: TabKey) => void;
}) {
  // Latest review (newest first) across every revision. Drives the
  // post-rejection feedback card and the in-review status block.
  const latestReview = useMemo(() => {
    const flat: Array<{
      review: LabelDesignReviewDto;
      revision: LabelDesignRevisionDto;
    }> = [];
    for (const rev of data.revisions ?? []) {
      for (const r of rev.reviews ?? []) {
        flat.push({ review: r, revision: rev });
      }
    }
    flat.sort((a, b) =>
      (b.review.created_at || "").localeCompare(a.review.created_at || ""),
    );
    return flat[0] ?? null;
  }, [data.revisions]);

  const current = data.current_revision_detail;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
      <div className="flex flex-col gap-4">
        <CurrentArtworkCard revision={current} />
        {latestReview ? (
          <LatestReviewCard
            review={latestReview.review}
            revisionNumber={latestReview.revision.revision_number}
          />
        ) : null}
      </div>

      <div className="flex flex-col gap-4">
        <ActionPanel data={data} id={id} onJumpTab={onJumpTab} />
      </div>
    </div>
  );
}


function CurrentArtworkCard({
  revision,
}: {
  revision: LabelDesignRevisionDto | null;
}) {
  if (!revision || !revision.artwork_pdf_url) {
    return (
      <Card>
        <Eyebrow>CURRENT ARTWORK</Eyebrow>
        <div className="mt-3 flex h-64 flex-col items-center justify-center gap-2 border-2 border-dashed border-black bg-neutral-50 text-center sm:h-80 lg:h-96">
          <FileImage className="h-6 w-6 text-neutral-400" />
          <p className="text-sm text-neutral-600">
            No artwork uploaded yet.
          </p>
        </div>
      </Card>
    );
  }
  const url = revision.artwork_pdf_url;
  const isImage = /\.(png|jpe?g|gif|webp|avif)(?:\?|#|$)/i.test(url);
  const isPdf = /\.pdf(?:\?|#|$)/i.test(url);
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Eyebrow>CURRENT ARTWORK · revision {revision.revision_number}</Eyebrow>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 border-2 border-black bg-white px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.15em] hover:bg-neutral-100"
        >
          {isImage ? "Open image" : isPdf ? "Open PDF" : "Open file"}
        </a>
      </div>
      <div className="mt-3 overflow-hidden border-2 border-black">
        {isImage ? (
          <div className="flex h-[400px] w-full min-w-0 max-w-full items-center justify-center overflow-hidden bg-neutral-50 p-4 sm:h-[480px] lg:h-[540px]">
            <img
              src={url}
              alt="Current artwork"
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : isPdf ? (
          <PdfPreview
            url={url}
            heightClassName="h-[400px] sm:h-[480px] lg:h-[540px]"
          />
        ) : (
          <p className="p-4 text-xs text-neutral-500">
            Inline preview unavailable. Use the link above to open the file.
          </p>
        )}
      </div>
    </Card>
  );
}


function LatestReviewCard({
  review,
  revisionNumber,
}: {
  review: LabelDesignReviewDto;
  revisionNumber: number;
}) {
  const negative = review.outcome === "requires_revision";
  const hasChecklist =
    review.kind === "scientist" &&
    (review.checklist_responses?.length ?? 0) > 0;
  return (
    <Card
      className={
        negative
          ? "border-red-700 bg-red-50"
          : "border-emerald-700 bg-emerald-50"
      }
    >
      <div className="flex items-start gap-3">
        {negative ? (
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-700" />
        ) : (
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
        )}
        <div className="flex-1">
          <Eyebrow>
            {review.kind === "scientist" ? "Scientist" : "Director"}{" "}
            {negative ? "sent it back" : "approved"} · revision{" "}
            {revisionNumber}
          </Eyebrow>
          {review.final_comments ? (
            <p className="mt-2 whitespace-pre-line text-sm">
              {review.final_comments}
            </p>
          ) : null}
          {review.reviewer_email || review.created_at ? (
            <p className="mt-2 text-[11px] text-neutral-600">
              {review.reviewer_email}
              {review.reviewer_email && review.created_at ? " · " : ""}
              {review.created_at
                ? new Date(review.created_at).toLocaleString()
                : ""}
            </p>
          ) : null}
        </div>
      </div>
      {/* Full MA-PD-B-012 readout — line-by-line so the customer
          can act on the same data the director used to decide.
          Defaults to failed-only when items were flagged so the
          actionable bits surface; toggle reveals the rest. */}
      {hasChecklist ? (
        <div className="mt-3">
          <ScientistChecklistView
            responses={review.checklist_responses}
            tone="portal"
            heading="Scientist's full review"
            defaultShowPassing={!negative}
          />
        </div>
      ) : null}
    </Card>
  );
}


function ActionPanel({
  id,
  data,
  onJumpTab,
}: {
  id: string;
  data: LabelDesignDto;
  onJumpTab: (t: TabKey) => void;
}) {
  const status = data.status;
  const path = data.design_path as LabelDesignPath;

  if (status === "payment_pending") {
    return (
      <Card>
        <Eyebrow>NEXT STEP</Eyebrow>
        <h3 className="mt-1 text-lg font-bold">Awaiting payment</h3>
        <p className="mt-1 text-sm text-neutral-600">
          Our finance team will confirm your payment shortly. The
          next step opens here as soon as that lands.
        </p>
      </Card>
    );
  }

  if (status === "label_path_pending") {
    return (
      <Card>
        <Eyebrow>NEXT STEP</Eyebrow>
        <h3 className="mt-1 text-lg font-bold">Pick your design path</h3>
        <p className="mt-1 text-sm text-neutral-600">
          Have Vita design the label for you, or design it yourself
          using our spec-derived content block + downloadable
          templates.
        </p>
        <Link
          href={`/portal/label-designs/${id}/choose-path`}
          className="mt-4 inline-flex items-center gap-2 border-2 border-black bg-black px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-white hover:bg-neutral-800"
        >
          Choose <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </Card>
    );
  }

  if (status === "design_preferences_pending") {
    return (
      <Card>
        <Eyebrow>NEXT STEP</Eyebrow>
        <h3 className="mt-1 text-lg font-bold">Share your brief</h3>
        <p className="mt-1 text-sm text-neutral-600">
          Tell us brand colours, inspiration, and your design
          preferences so our team can craft the right look.
        </p>
        <Link
          href={`/portal/label-designs/${id}/preferences`}
          className="mt-4 inline-flex items-center gap-2 border-2 border-black bg-black px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-white hover:bg-neutral-800"
        >
          <PencilLine className="h-3.5 w-3.5" /> Fill in preferences
        </Link>
      </Card>
    );
  }

  if (status === "design_in_progress" && path === "design_by_customer") {
    return <InlineUploadCard id={id} onJumpTab={onJumpTab} />;
  }

  if (status === "design_in_progress" && path === "design_by_us") {
    return (
      <Card>
        <Eyebrow>IN PROGRESS</Eyebrow>
        <h3 className="mt-1 text-lg font-bold">Our team is designing</h3>
        <p className="mt-1 text-sm text-neutral-600">
          We&rsquo;ll share the first draft for your review shortly.
        </p>
        <button
          type="button"
          onClick={() => onJumpTab("brief")}
          className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-black underline-offset-4 hover:underline"
        >
          View your brief
        </button>
      </Card>
    );
  }

  if (status === "scientist_review" || status === "director_review") {
    return (
      <Card>
        <Eyebrow>IN REVIEW</Eyebrow>
        <h3 className="mt-1 text-lg font-bold">Our team is reviewing</h3>
        <p className="mt-1 text-sm text-neutral-600">
          {status === "scientist_review"
            ? "Our scientist is checking compliance with regulation."
            : "Our director is doing the final sign-off."}
        </p>
      </Card>
    );
  }

  if (status === "customer_approval") {
    return (
      <Card>
        <Eyebrow>YOUR TURN</Eyebrow>
        <h3 className="mt-1 text-lg font-bold">Review and sign</h3>
        <p className="mt-1 text-sm text-neutral-600">
          Our team has approved the design internally. Open the
          artwork to read it through — you can sign off or request
          changes from the same page.
        </p>
        <Link
          href={`/portal/label-designs/${id}/approve`}
          className="mt-4 inline-flex items-center gap-2 border-2 border-black bg-black px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-white hover:bg-neutral-800"
        >
          <ArrowRight className="h-3.5 w-3.5" /> See the artwork
        </Link>
      </Card>
    );
  }

  if (status === "label_approved") {
    return (
      <Card>
        <div className="flex items-center gap-3">
          <CheckCircle2 className="h-6 w-6 text-emerald-600" />
          <div>
            <h3 className="text-lg font-bold">Your label is approved</h3>
            <p className="text-sm text-neutral-600">
              We&rsquo;ll be in touch with the next steps for production.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  if (status === "on_hold") {
    return (
      <Card>
        <div className="flex items-start gap-3">
          <Clock className="mt-0.5 h-6 w-6 shrink-0 text-amber-600" />
          <div className="flex-1">
            <h3 className="text-lg font-bold">Label is on hold</h3>
            {data.hold_reason ? (
              <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 ring-1 ring-amber-200">
                <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
                  Note from our team
                </p>
                <p className="mt-1 whitespace-pre-line text-sm text-amber-900">
                  {data.hold_reason}
                </p>
              </div>
            ) : (
              <p className="mt-1 text-sm text-neutral-600">
                Our team has paused this workflow. We&rsquo;ll be in touch.
              </p>
            )}
          </div>
        </div>
      </Card>
    );
  }

  return null;
}


// ---------------------------------------------------------------------------
// Inline upload card — replaces the /upload route. Captures file +
// notes + signature on the same screen the customer is already on.
// ---------------------------------------------------------------------------


function InlineUploadCard({
  id,
  onJumpTab,
}: {
  id: string;
  onJumpTab: (t: TabKey) => void;
}) {
  const upload = usePortalUploadArtwork(id);
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState("");
  const [signature, setSignature] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!file) {
      setError("Pick a file to upload.");
      return;
    }
    if (!signature) {
      setError("Draw your signature to confirm this is your design.");
      return;
    }
    try {
      await upload.mutateAsync({
        artwork: file,
        signature_image: signature,
        notes,
      });
      // Reset on success so the next round-trip starts clean.
      setFile(null);
      setNotes("");
      setSignature("");
    } catch (e) {
      const detail =
        (e as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Upload failed.";
      setError(detail);
    }
  };

  return (
    <Card>
      <Eyebrow>UPLOAD ARTWORK</Eyebrow>
      <h3 className="mt-1 text-lg font-bold">Submit your design</h3>
      <p className="mt-1 text-sm text-neutral-600">
        PDF, PNG or JPG. Use the{" "}
        <button
          type="button"
          onClick={() => onJumpTab("content-block")}
          className="underline underline-offset-2 hover:text-black"
        >
          content block
        </button>{" "}
        and{" "}
        <button
          type="button"
          onClick={() => onJumpTab("templates")}
          className="underline underline-offset-2 hover:text-black"
        >
          our templates
        </button>{" "}
        as a starting point if you haven&rsquo;t already.
      </p>

      <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-bold uppercase tracking-[0.15em] text-neutral-700">
            File <span className="text-red-600">*</span>
          </span>
          <input
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="border-2 border-black bg-white px-2 py-1.5 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-bold uppercase tracking-[0.15em] text-neutral-700">
            Notes (optional)
          </span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Anything our scientist + director should know"
            className="border-2 border-black bg-white px-2 py-1.5 text-sm"
          />
        </label>
        <SignatureField
          label="Signature"
          value={signature}
          onChange={setSignature}
          ariaLabel="Customer signature"
          required
          tone="portal"
        />
        {error ? (
          <p className="flex items-center gap-1.5 text-sm text-red-700">
            <AlertCircle className="h-3.5 w-3.5" />
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={upload.isPending}
          className="inline-flex w-full items-center justify-center gap-2 border-2 border-black bg-black px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-white hover:bg-neutral-800 disabled:opacity-50"
        >
          <UploadCloud className="h-4 w-4" />
          {upload.isPending ? "Uploading…" : "Submit for review"}
        </button>
      </form>
    </Card>
  );
}


// ---------------------------------------------------------------------------
// Content block tab — full feature parity with the staff surface.
// 9-region HTML preview + per-region PDF / PNG downloads rendered
// straight from the iframe via the same FE helpers.
// ---------------------------------------------------------------------------


const REGIONS = [
  { slug: "all", label: "All 9 panels (full document)" },
  { slug: "uk-eu", label: "UK / EU — Reg (EU) 1169/2011" },
  { slug: "us", label: "US — FDA 21 CFR 101.9" },
  { slug: "japan", label: "Japan — 健康増進法" },
  { slug: "china", label: "China — GB 28050" },
  { slug: "australia-nz", label: "Australia / NZ — FSANZ 1.2.8" },
  { slug: "codex-asean", label: "Codex / ASEAN — CXG 2-1985" },
  { slug: "gso-dubai", label: "Middle East — GSO 9:2013" },
  { slug: "africa", label: "Africa — ZA R146-2010" },
] as const;


function ContentBlockTab({ id }: { id: string }) {
  const html = usePortalContentBlockHtml(id);
  const jsonQ = usePortalContentBlockJson(id);
  const textQ = usePortalContentBlockText(id);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [iframeHeight, setIframeHeight] = useState<number>(600);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const resizeIframe = useCallback(() => {
    const el = iframeRef.current;
    const doc = el?.contentDocument;
    if (!el || !doc) return;
    const next = Math.max(
      doc.documentElement.scrollHeight,
      doc.body?.scrollHeight ?? 0,
    );
    if (next && Math.abs(next - iframeHeight) > 2) {
      setIframeHeight(next);
    }
  }, [iframeHeight]);

  const handleDownload = async (region: string, fmt: "pdf" | "png") => {
    if (!iframeRef.current) {
      setError("Preview hasn't loaded yet — wait a moment and try again.");
      return;
    }
    const key = `${fmt}:${region}`;
    setBusy(key);
    setError(null);
    try {
      if (fmt === "pdf") {
        await downloadContentBlockPdf(iframeRef.current, id, region);
      } else {
        await downloadContentBlockPng(iframeRef.current, id, region);
      }
    } catch (e) {
      setError(
        `${fmt.toUpperCase()} download failed — ${
          (e as Error)?.message ?? "unknown error"
        }`,
      );
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!copiedKey) return;
    const t = setTimeout(() => setCopiedKey(null), 1500);
    return () => clearTimeout(t);
  }, [copiedKey]);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <Eyebrow>PER-REGION DOWNLOADS</Eyebrow>
        <p className="mt-1 text-[12px] text-neutral-600">
          Grab the panel that matches the destination market — rendered straight
          from the preview, no server round-trip.
        </p>
        {error ? (
          <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-[11px] text-red-700 ring-1 ring-red-200">
            {error}
          </p>
        ) : null}
        <div className="mt-3 divide-y divide-neutral-200">
          {REGIONS.map((r) => (
            <div
              key={r.slug}
              className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
            >
              <span className="text-xs font-medium text-black">{r.label}</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => handleDownload(r.slug, "pdf")}
                  className="inline-flex items-center gap-1 border-2 border-black bg-black px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.15em] text-white hover:bg-neutral-800 disabled:opacity-50"
                >
                  {busy === `pdf:${r.slug}` ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Download className="h-3 w-3" />
                  )}
                  <FileText className="h-3 w-3" /> PDF
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => handleDownload(r.slug, "png")}
                  className="inline-flex items-center gap-1 border-2 border-black bg-white px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.15em] text-black hover:bg-neutral-100 disabled:opacity-50"
                >
                  {busy === `png:${r.slug}` ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Download className="h-3 w-3" />
                  )}
                  <FileImage className="h-3 w-3" /> PNG
                </button>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <Eyebrow>PREVIEW · 9 REGIONAL PANELS</Eyebrow>
        <p className="mt-1 text-[12px] text-neutral-600">
          This is exactly what the &ldquo;All 9 panels&rdquo; PDF / PNG download
          contains.
        </p>
        {html.isLoading ? (
          <p className="mt-3 inline-flex items-center gap-2 text-sm text-neutral-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading preview…
          </p>
        ) : html.error ? (
          <p className="mt-3 text-sm text-red-700">
            Couldn&rsquo;t render the content block. If you&rsquo;ve just
            picked your design path, give it a moment and refresh.
          </p>
        ) : html.data ? (
          <iframe
            ref={iframeRef}
            title="Content block preview"
            srcDoc={html.data}
            sandbox="allow-same-origin"
            onLoad={resizeIframe}
            scrolling="no"
            style={{ height: iframeHeight }}
            className="mt-3 block w-full overflow-hidden border-2 border-black"
          />
        ) : null}
      </Card>

      {textQ.data ? (
        <Card>
          <Eyebrow>COPY-PASTE TEXT</Eyebrow>
          <p className="mt-1 text-[12px] text-neutral-600">
            Plain text per section — useful when pasting into a text-only
            design field.
          </p>
          <div className="mt-3 flex flex-col gap-3">
            {Object.entries(textQ.data.sections).map(([section, body]) => {
              const key = `text:${section}`;
              return (
                <div
                  key={section}
                  className="border-2 border-black bg-white p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-neutral-600">
                      {section.replace(/_/g, " ")}
                    </p>
                    <button
                      type="button"
                      onClick={async () => {
                        await navigator.clipboard.writeText(body);
                        setCopiedKey(key);
                      }}
                      className="inline-flex items-center gap-1 border-2 border-black bg-white px-2 py-1 text-[10px] font-bold uppercase tracking-[0.15em] hover:bg-neutral-100"
                    >
                      {copiedKey === key ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <pre className="mt-2 whitespace-pre-wrap text-[11px] leading-relaxed text-neutral-700">
                    {body}
                  </pre>
                </div>
              );
            })}
          </div>
        </Card>
      ) : null}

      {jsonQ.data ? null : null}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Brief tab — read-only preferences for DESIGN_BY_US. Edit deep-
// links to the existing preferences form.
// ---------------------------------------------------------------------------


function BriefTab({ id, data }: { id: string; data: LabelDesignDto }) {
  const prefs = data.preferences_detail;
  if (!prefs) {
    return (
      <Card>
        <Eyebrow>BRIEF</Eyebrow>
        <p className="mt-2 text-sm text-neutral-600">
          You haven&rsquo;t shared a brief yet.
        </p>
        <Link
          href={`/portal/label-designs/${id}/preferences`}
          className="mt-3 inline-flex items-center gap-2 border-2 border-black bg-black px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-white hover:bg-neutral-800"
        >
          <PencilLine className="h-3.5 w-3.5" /> Fill it in
        </Link>
      </Card>
    );
  }
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <Eyebrow>BRIEF · MA-ST-B-009</Eyebrow>
          {prefs.submitted_at ? (
            <p className="mt-1 text-[11px] text-neutral-500">
              Submitted {new Date(prefs.submitted_at).toLocaleString()}
            </p>
          ) : null}
        </div>
        <Link
          href={`/portal/label-designs/${id}/preferences`}
          className="inline-flex items-center gap-1 border-2 border-black bg-white px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.15em] hover:bg-neutral-100"
        >
          Edit
        </Link>
      </div>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <BriefField label="Company">{prefs.company_name}</BriefField>
        <BriefField label="Brand">{prefs.brand_name}</BriefField>
        <BriefField label="Products">{prefs.product_names}</BriefField>
        <BriefField label="Product codes">{prefs.product_codes}</BriefField>
        <BriefField label="Design style">{prefs.design_style}</BriefField>
        <BriefField label="Material">{prefs.material_type}</BriefField>
        <BriefField label="Elements to include" wide>
          {prefs.elements_to_include}
        </BriefField>
        <BriefField label="Additional comments" wide>
          {prefs.additional_comments}
        </BriefField>
      </dl>
      {prefs.brand_colours.length > 0 ? (
        <div className="mt-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-neutral-600">
            Brand colours
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {prefs.brand_colours.map((c, i) => (
              <span
                key={`${c.hex}-${i}`}
                className="inline-flex items-center gap-2 border-2 border-black bg-white px-2 py-1 text-[11px]"
              >
                <span
                  className="inline-block h-4 w-4 border border-black"
                  style={{ background: c.hex }}
                />
                {c.name} · {c.hex}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </Card>
  );
}


function BriefField({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const value = typeof children === "string" ? children.trim() : children;
  return (
    <div className={wide ? "sm:col-span-2" : ""}>
      <dt className="text-[10px] font-bold uppercase tracking-[0.2em] text-neutral-600">
        {label}
      </dt>
      <dd className="mt-1 whitespace-pre-line text-sm text-black">
        {value || <span className="text-neutral-400">—</span>}
      </dd>
    </div>
  );
}


// ---------------------------------------------------------------------------
// History tab — every revision with its per-revision review
// journey. Mirrors the staff Versions tab structure.
// ---------------------------------------------------------------------------


function HistoryTab({ data }: { data: LabelDesignDto }) {
  if (data.revisions.length === 0) {
    return (
      <Card>
        <p className="text-sm text-neutral-500">
          No revisions yet. As the artwork moves through the review loop,
          you&rsquo;ll see each version here.
        </p>
      </Card>
    );
  }
  const ordered = [...data.revisions].sort(
    (a, b) => b.revision_number - a.revision_number,
  );
  return (
    <div className="flex flex-col gap-3">
      {ordered.map((rev) => {
        const reviews = [...(rev.reviews ?? [])].sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === "scientist" ? -1 : 1;
          return (a.created_at || "").localeCompare(b.created_at || "");
        });
        return (
          <Card key={rev.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <Eyebrow>Revision {rev.revision_number}</Eyebrow>
                <p className="mt-1 text-sm text-neutral-700">
                  {rev.source === "customer_upload"
                    ? "Uploaded by you"
                    : "Submitted by Vita"}{" "}
                  · {new Date(rev.submitted_at).toLocaleString()}
                </p>
                {rev.notes ? (
                  <p className="mt-2 text-sm text-neutral-600">
                    Note: {rev.notes}
                  </p>
                ) : null}
              </div>
              {rev.artwork_pdf_url ? (
                <a
                  href={rev.artwork_pdf_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="border-2 border-black bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-[0.18em] hover:bg-neutral-100"
                >
                  {/\.(png|jpe?g|gif|webp|avif)(?:\?|#|$)/i.test(
                    rev.artwork_pdf_url,
                  )
                    ? "Open image"
                    : "Open PDF"}
                </a>
              ) : null}
            </div>
            <div className="mt-4 border-t-2 border-black pt-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-neutral-600">
                Reviewer feedback
              </p>
              {reviews.length === 0 ? (
                <p className="mt-2 text-xs text-neutral-500">
                  Not reviewed yet.
                </p>
              ) : (
                <ul className="mt-2 flex flex-col gap-2">
                  {reviews.map((r) => {
                    const approved = r.outcome === "approved";
                    const tone = approved
                      ? "border-emerald-700 bg-emerald-50 text-emerald-900"
                      : "border-red-700 bg-red-50 text-red-900";
                    const hasChecklist =
                      r.kind === "scientist" &&
                      (r.checklist_responses?.length ?? 0) > 0;
                    return (
                      <li key={r.id} className={`border-2 ${tone} p-3`}>
                        <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-[0.15em]">
                          {approved ? (
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          ) : (
                            <AlertCircle className="h-3.5 w-3.5" />
                          )}
                          <span>
                            {r.kind === "scientist" ? "Scientist" : "Director"}{" "}
                            {approved ? "approved" : "sent back"}
                          </span>
                          {r.created_at ? (
                            <span className="font-mono text-[10px] opacity-70">
                              · {new Date(r.created_at).toLocaleString()}
                            </span>
                          ) : null}
                        </div>
                        {r.final_comments ? (
                          <p className="mt-2 whitespace-pre-line text-sm">
                            {r.final_comments}
                          </p>
                        ) : null}
                        {hasChecklist ? (
                          <div className="mt-3">
                            <ScientistChecklistView
                              responses={r.checklist_responses}
                              tone="portal"
                              heading="Full checklist"
                              defaultShowPassing={approved}
                            />
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
