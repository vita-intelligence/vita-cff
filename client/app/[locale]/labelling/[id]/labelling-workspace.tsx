"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommentsPanel } from "@/components/comments";
import { useCurrentUser } from "@/services/accounts";

import dynamic from "next/dynamic";

import { LabellingCommentsBubble } from "./labelling-comments-bubble";

// PDF.js touches browser-only APIs (``DOMMatrix``, ``Canvas``)
// at module-eval time, so SSR'ing this component throws in
// Node. ``ssr: false`` skips the server pass entirely — the
// preview tab only matters in the browser anyway.
const PdfPreview = dynamic(
  () => import("@/components/pdf-preview").then((m) => m.PdfPreview),
  { ssr: false },
);

import {
  AlertCircle,
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  Clock,
  Copy,
  Download,
  ExternalLink,
  FileImage,
  FileText,
  ImageIcon,
  Loader2,
  Palette,
  Send,
  Sparkles,
  UploadCloud,
  X,
} from "lucide-react";

import { env } from "@/config/env";
import { Link } from "@/i18n/navigation";
import {
  downloadContentBlockPdf,
  downloadContentBlockPng,
  useAssignLabelDesigner,
  useContentBlockHtml,
  useContentBlockJson,
  useContentBlockText,
  useHoldLabelDesign,
  useLabelDesign,
  useLabelDesignReviews,
  useLabelDesignSpec,
  useLabelDesignTransitions,
  useResumeLabelDesign,
  useSubmitDirectorReview,
  useSubmitLabelForReview,
  useSubmitScientistReview,
  useUploadLabelArtwork,
} from "@/services/label-design";
import { useMemberships } from "@/services/members";
import type {
  LabelDesignDto,
  LabelDesignReviewDto,
  LabelDesignStatus,
  LabelDesignTransitionDto,
} from "@/services/label-design/types";

import { SignatureField } from "@/components/ui/signature-field";

import { SpecSheetContent } from "../../specifications/[id]/specification-sheet-view";
import { CHECKLIST_ITEMS, CHECKLIST_SECTIONS } from "./compliance-checklist";


// Artwork uploads accept .pdf, .png, .jpg, .jpeg — the FE has to
// pick the right inline renderer based on the file the customer
// or designer actually sent. URL-extension sniff is enough since
// the backend's ``_safe_extension`` normalises the suffix at
// save-time (see ``apps/label_design/models.py``).
function _stripUrlSuffix(url: string): string {
  // ``split()`` always returns a non-empty array at runtime but
  // the ``noUncheckedIndexedAccess`` compiler flag widens ``[0]``
  // to ``string | undefined``. The ``?? ""`` keeps TS happy
  // without a narrowing dance.
  return ((url.split("?")[0] ?? "").split("#")[0] ?? "").toLowerCase();
}

function isImageArtwork(url: string): boolean {
  if (!url) return false;
  return /\.(png|jpe?g|gif|webp|avif)$/.test(_stripUrlSuffix(url));
}

function isPdfArtwork(url: string): boolean {
  if (!url) return false;
  return _stripUrlSuffix(url).endsWith(".pdf");
}

const STATUS_LABELS: Record<LabelDesignStatus, string> = {
  payment_pending: "Payment pending",
  label_path_pending: "Awaiting customer’s design path choice",
  design_preferences_pending: "Awaiting customer brief",
  design_in_progress: "Design in progress",
  scientist_review: "Awaiting scientist review",
  director_review: "Awaiting director review",
  customer_approval: "Awaiting customer approval",
  label_approved: "Label approved",
  no_label_required: "No label required (customer opted out)",
  on_hold: "On hold",
};

type Tab =
  | "artwork"
  | "content"
  | "brief"
  | "spec"
  | "versions"
  | "chat"
  | "reviews"
  | "audit";


export function LabellingWorkspace({
  orgId,
  labelDesignId,
  canDesign,
  canReviewScientist,
  canReviewDirector,
  canManage,
}: {
  orgId: string;
  labelDesignId: string;
  canDesign: boolean;
  canReviewScientist: boolean;
  canReviewDirector: boolean;
  canManage: boolean;
}) {
  const { data, isLoading, error, refetch } = useLabelDesign(orgId, labelDesignId);
  const currentUserQuery = useCurrentUser();
  const [tab, setTab] = useState<Tab>("artwork");

  const apiBase = env.NEXT_PUBLIC_API_URL;

  if (isLoading) {
    return (
      <p className="mt-6 inline-flex items-center gap-2 text-sm text-ink-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading…
      </p>
    );
  }
  if (error || !data) {
    return (
      <p className="mt-6 text-sm text-danger">Couldn’t load this label.</p>
    );
  }

  return (
    <section className="mt-6 flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            href="/labelling"
            className="inline-flex items-center gap-1 text-xs text-ink-500 hover:text-ink-700"
          >
            <ChevronLeft className="h-3 w-3" /> Back to queue
          </Link>
          <h1 className="mt-1 text-lg font-semibold text-ink-1000">
            {data.formulation_name || "Label design"}{" "}
            <span className="text-ink-500">· {data.formulation_code}</span>
            {/* Spec disambiguator — see queue card comment. */}
            {data.specification_sheet_code ? (
              <span className="ml-1 text-ink-500">
                / {data.specification_sheet_code}
              </span>
            ) : null}
          </h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            <p className="text-xs text-ink-500">{STATUS_LABELS[data.status]}</p>
            {/* Path chip in the header so the designer
                immediately sees who's responsible for uploading
                artwork on this row. Hidden when the customer
                hasn't picked yet. */}
            {data.design_path === "design_by_customer" ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 ring-1 ring-inset ring-amber-200">
                Customer designs
              </span>
            ) : data.design_path === "design_by_us" ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-ink-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-700 ring-1 ring-inset ring-ink-200">
                Vita designs
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canManage && data.status !== "on_hold" ? (
            <HoldButton orgId={orgId} labelDesignId={labelDesignId} />
          ) : null}
          {canManage && data.status === "on_hold" ? (
            <ResumeButton orgId={orgId} labelDesignId={labelDesignId} />
          ) : null}
        </div>
      </header>

      <AssignmentBar
        orgId={orgId}
        labelDesignId={labelDesignId}
        designerId={data.assigned_designer}
        designerEmail={data.assigned_designer_email}
        canManage={canManage}
      />

      <nav className="flex flex-wrap gap-1 border-b border-ink-200">
        {(
          [
            { key: "artwork", label: "Artwork" },
            { key: "content", label: "Content block" },
            { key: "brief", label: "Customer brief" },
            { key: "spec", label: "Spec" },
            { key: "versions", label: "Versions" },
            { key: "chat", label: "Customer chat" },
            { key: "reviews", label: "Reviews" },
            { key: "audit", label: "Audit" },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            aria-pressed={tab === t.key}
            className={`px-3 py-2 text-xs font-semibold uppercase tracking-wide ${
              tab === t.key
                ? "border-b-2 border-orange-500 text-ink-1000"
                : "text-ink-500 hover:text-ink-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "artwork" ? (
        <ArtworkTab
          orgId={orgId}
          labelDesignId={labelDesignId}
          canDesign={canDesign}
          canReviewScientist={canReviewScientist}
          canReviewDirector={canReviewDirector}
          status={data.status}
          designPath={data.design_path}
          artworkPdfUrl={data.current_revision_detail?.artwork_pdf_url ?? ""}
          additionalAssets={data.current_revision_detail?.additional_assets ?? []}
          currentRevisionId={data.current_revision}
          onMutate={() => refetch()}
        />
      ) : null}

      {tab === "content" ? (
        <ContentBlockTab orgId={orgId} labelDesignId={labelDesignId} apiBase={apiBase} />
      ) : null}

      {tab === "brief" ? (
        <BriefTab
          preferences={data.preferences_detail}
          designPath={data.design_path}
        />
      ) : null}

      {tab === "spec" ? (
        <SpecTab
          orgId={orgId}
          labelDesignId={labelDesignId}
          sheetId={data.specification_sheet}
          title={data.formulation_name || ""}
        />
      ) : null}

      {tab === "versions" ? (
        <VersionsTab
          orgId={orgId}
          labelDesignId={labelDesignId}
          revisions={data.revisions}
          currentRevisionId={data.current_revision}
        />
      ) : null}

      {tab === "chat" ? (
        <CustomerChatTab
          orgId={orgId}
          labelDesignId={labelDesignId}
        />
      ) : null}

      {tab === "reviews" ? (
        <ReviewsTab orgId={orgId} labelDesignId={labelDesignId} />
      ) : null}

      {tab === "audit" ? (
        <AuditTab orgId={orgId} labelDesignId={labelDesignId} />
      ) : null}

      {/* Internal-only chat. Sits next to the customer-facing
        * "Customer chat" tab so designers always have a private
        * staff thread + a customer-visible one without ever
        * mixing the two. */}
      {currentUserQuery.data ? (
        <LabellingCommentsBubble
          orgId={orgId}
          labelDesignId={labelDesignId}
          currentUserId={currentUserQuery.data.id}
          designLabel={data.formulation_code || "Label design"}
          canRead
          canWrite
          canModerate={canManage}
        />
      ) : null}
    </section>
  );
}


/** Customer-facing conversation tab. Mirrors ``ProposalConversation``
 *  on the proposal page: a shared thread that the customer portal
 *  reads via :class:`apps.client_portal.api.inbox_views`, scoped to
 *  ``visibility=shared`` so internal-bubble posts never appear
 *  here. */
function CustomerChatTab({
  orgId,
  labelDesignId,
}: {
  orgId: string;
  labelDesignId: string;
}) {
  const currentUserQuery = useCurrentUser();
  if (!currentUserQuery.data) {
    return (
      <p className="rounded-2xl bg-ink-0 p-6 text-xs text-ink-500 ring-1 ring-ink-200">
        Loading conversation…
      </p>
    );
  }
  return (
    <section className="rounded-2xl bg-ink-0 p-5 shadow-sm ring-1 ring-ink-200">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-ink-500">
            Conversation
          </p>
          <h2 className="mt-0.5 text-base font-semibold text-ink-1000">
            About this label design
          </h2>
        </div>
        <span className="text-[11px] text-ink-500">
          Shared with the customer · posts appear in their portal
        </span>
      </header>
      <CommentsPanel
        orgId={orgId}
        entityKind="label_design"
        entityId={labelDesignId}
        currentUserId={currentUserQuery.data.id}
        canRead
        canWrite
        canModerate={false}
        visibilityFilter="shared"
      />
    </section>
  );
}


/** Designer pill + dropdown menu on the labelling workspace header.
 *
 * Visual + interaction mirror of ``LeadScientistMenu`` /
 * ``SalesPersonMenu`` on the project workspace so designer
 * assignment looks and feels identical to the scientist / sales
 * pickers staff already use. Pill is orange to match the labelling
 * brand colour the rest of the workspace uses; the dropdown is
 * scoped to members tagged ``"designer"``.
 */
function AssignmentBar({
  orgId,
  labelDesignId,
  designerId,
  designerEmail,
  canManage,
}: {
  orgId: string;
  labelDesignId: string;
  designerId: string | null;
  designerEmail: string;
  canManage: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Lazy fetch — only hit the roster endpoint once the picker is
  // actually opened, matching ``LeadScientistMenu``'s pattern.
  const designersQuery = useMemberships(orgId, {
    enabled: open && canManage,
    group: "designer",
  });
  const assignDesigner = useAssignLabelDesigner(orgId, labelDesignId);

  // Close the menu on click-outside. Inlined here (rather than a
  // shared hook) to keep the workspace file self-contained.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const members = useMemo(() => {
    const rows = designersQuery.data ?? [];
    const seen = new Set<string>();
    const out: { id: string; name: string; email: string }[] = [];
    for (const row of rows) {
      if (seen.has(row.user.id)) continue;
      seen.add(row.user.id);
      const name =
        (row.user.full_name && row.user.full_name.trim()) || row.user.email;
      out.push({ id: row.user.id, name, email: row.user.email });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [designersQuery.data]);

  const pillLabel = designerId
    ? designerEmail || "Designer"
    : "Designer unassigned";

  const pillClasses = designerId
    ? "bg-orange-100 text-orange-700 ring-orange-200"
    : "bg-ink-50 text-ink-600 ring-ink-200";

  if (!canManage) {
    return (
      <section>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-inset ${pillClasses}`}
          title={
            designerId
              ? `Designer: ${designerEmail || ""}`
              : "Designer unassigned"
          }
        >
          <Palette className="h-3.5 w-3.5" />
          {pillLabel}
        </span>
      </section>
    );
  }

  const handleAssign = async (userId: string | null) => {
    setOpen(false);
    if (userId === (designerId ?? null)) return;
    try {
      await assignDesigner.mutateAsync(userId);
    } catch {
      // Surface noise lives on the mutation result; the menu is
      // already closed so we don't fight the user's flow.
    }
  };

  return (
    <section>
      <div ref={containerRef} className="relative inline-block">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={assignDesigner.isPending}
          aria-haspopup="menu"
          aria-expanded={open}
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-inset transition-opacity hover:opacity-90 disabled:opacity-60 ${pillClasses}`}
        >
          <Palette className="h-3.5 w-3.5" />
          {pillLabel}
          <ChevronDown className="h-3 w-3" />
        </button>
        {open ? (
          <div
            role="menu"
            className="absolute left-0 z-20 mt-2 flex w-72 flex-col gap-0.5 rounded-xl bg-ink-0 p-1.5 shadow-lg ring-1 ring-ink-200"
          >
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
                Designer
              </span>
              {designerId ? (
                <button
                  type="button"
                  onClick={() => handleAssign(null)}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-ink-500 hover:bg-ink-50 hover:text-danger"
                >
                  <X className="h-3 w-3" />
                  Clear
                </button>
              ) : null}
            </div>
            {designersQuery.isLoading ? (
              <p className="px-2 py-3 text-xs text-ink-500">Loading…</p>
            ) : members.length === 0 ? (
              <p className="px-2 py-3 text-xs text-ink-500">
                No members tagged{" "}
                <code className="rounded bg-ink-100 px-1">designer</code>. Add
                the tag in Settings &gt; Members.
              </p>
            ) : (
              <div className="max-h-72 overflow-y-auto">
                {members.map((member) => {
                  const isActive = member.id === designerId;
                  return (
                    <button
                      key={member.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isActive}
                      disabled={assignDesigner.isPending}
                      onClick={() => handleAssign(member.id)}
                      className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-ink-50 disabled:opacity-60 ${
                        isActive ? "bg-orange-100" : ""
                      }`}
                    >
                      <Palette className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-400" />
                      <span className="flex min-w-0 flex-col">
                        <span
                          className={`truncate text-sm ${
                            isActive
                              ? "font-semibold text-ink-1000"
                              : "text-ink-800"
                          }`}
                        >
                          {member.name}
                        </span>
                        <span className="truncate text-[11px] text-ink-500">
                          {member.email}
                        </span>
                      </span>
                      {isActive ? (
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-600" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}


//: Status-driven visual treatment for the artwork hero. Maps a
//: LabelDesignStatus to the chip palette + an icon so a designer
//: gets a single-glance read on "what should I do next".
const STATUS_PRESENTATION: Record<
  LabelDesignStatus,
  {
    tone:
      | "neutral"
      | "amber"
      | "blue"
      | "violet"
      | "emerald"
      | "rose";
    icon: typeof Sparkles;
    headline: string;
    sub: string;
  }
> = {
  payment_pending: {
    tone: "amber",
    icon: AlertCircle,
    headline: "Awaiting payment",
    sub: "The workflow unlocks the moment finance approves the customer payment.",
  },
  label_path_pending: {
    tone: "amber",
    icon: AlertCircle,
    headline: "Awaiting design path",
    sub: "The customer hasn't picked whether we design or they upload their own artwork yet.",
  },
  design_preferences_pending: {
    tone: "amber",
    icon: AlertCircle,
    headline: "Awaiting customer brief",
    sub: "The customer is filling in MA-ST-B-009. Check the Customer brief tab when it lands.",
  },
  design_in_progress: {
    tone: "blue",
    icon: Sparkles,
    headline: "Design in progress",
    sub: "Upload the next revision and submit it for scientist review when you're ready.",
  },
  scientist_review: {
    tone: "violet",
    icon: Clock,
    headline: "Scientist review",
    sub: "Compliance reviewer is checking the artwork against the MA-PD-B-012 checklist.",
  },
  director_review: {
    tone: "violet",
    icon: Clock,
    headline: "Director review",
    sub: "Director sign-off is the last internal step before the customer sees this.",
  },
  customer_approval: {
    tone: "blue",
    icon: Send,
    headline: "Awaiting customer approval",
    sub: "The customer is reviewing the artwork on the portal — they can sign or request changes.",
  },
  label_approved: {
    tone: "emerald",
    icon: CheckCircle2,
    headline: "Label approved",
    sub: "Customer signed off. Ready for production hand-off.",
  },
  no_label_required: {
    tone: "emerald",
    icon: Ban,
    headline: "No label required",
    sub: "Customer opted out at the choose-path step. No artwork to produce; production ships unlabelled.",
  },
  on_hold: {
    tone: "rose",
    icon: AlertCircle,
    headline: "On hold",
    sub: "A team lead paused this workflow. Resume from the workspace header when ready.",
  },
};

const STATUS_TONE_CLASS: Record<string, string> = {
  neutral: "bg-ink-100 text-ink-700 ring-ink-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  blue: "bg-orange-50 text-orange-800 ring-orange-200",
  violet: "bg-violet-50 text-violet-800 ring-violet-200",
  emerald: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  rose: "bg-rose-50 text-rose-800 ring-rose-200",
};


interface AdditionalAssetSummary {
  readonly id: string;
  readonly file_url: string;
  readonly label: string;
  readonly original_filename: string;
  readonly content_type: string;
  readonly size_bytes: number;
  readonly sort_order: number;
}

function ArtworkTab({
  orgId,
  labelDesignId,
  status,
  designPath,
  artworkPdfUrl,
  additionalAssets,
  currentRevisionId,
  canDesign,
  canReviewScientist,
  canReviewDirector,
  onMutate,
}: {
  orgId: string;
  labelDesignId: string;
  status: LabelDesignStatus;
  designPath: string;
  artworkPdfUrl: string;
  additionalAssets: ReadonlyArray<AdditionalAssetSummary>;
  currentRevisionId: string | null;
  canDesign: boolean;
  canReviewScientist: boolean;
  canReviewDirector: boolean;
  onMutate: () => void;
}) {
  const presentation = STATUS_PRESENTATION[status] ?? STATUS_PRESENTATION.design_in_progress;
  const StatusIcon = presentation.icon;
  const toneClass =
    STATUS_TONE_CLASS[presentation.tone] ?? STATUS_TONE_CLASS.neutral;

  // The (revision, kind) UNIQUE constraint on LabelDesignReview
  // means a revision is locked once a reviewer OF THAT KIND
  // touches it. Crucially this is per-kind, not per-revision —
  // the same revision legitimately carries a scientist review
  // (approved) AND a director review (next step), so the stuck
  // check has to scope to the kind that's currently being asked
  // for. Without the kind filter, the director review form
  // disappears the moment the scientist approves.
  const reviewsQuery = useLabelDesignReviews(orgId, labelDesignId);
  const currentKindReviewExists = Boolean(
    currentRevisionId &&
      reviewsQuery.data?.some(
        (r) =>
          r.revision === currentRevisionId &&
          ((status === "scientist_review" && r.kind === "scientist") ||
            (status === "director_review" && r.kind === "director")),
      ),
  );
  const isStuckMidReview =
    (status === "scientist_review" || status === "director_review") &&
    currentKindReviewExists;

  // Hard rule: on the DESIGN_BY_CUSTOMER path the customer owns
  // the artwork pipeline — staff has no upload surface, no
  // "submit for review" surface, and no stuck-mid-review recovery
  // upload. The backend matches with a 400 if either endpoint is
  // hit; hiding the controls keeps the staff workspace honest.
  const isCustomerDesign = designPath === "design_by_customer";
  const showUpload =
    canDesign &&
    !isCustomerDesign &&
    (status === "design_in_progress" ||
      status === "label_path_pending" ||
      isStuckMidReview);
  const showSubmit =
    canDesign && !isCustomerDesign && status === "design_in_progress";

  return (
    <div className="space-y-4">
      {/* Hero — status / context band so designers always see
          "what's the system waiting on right now" at the top. */}
      <header
        className={`flex items-start gap-3 rounded-2xl px-4 py-3 ring-1 ring-inset ${toneClass}`}
      >
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink-0/70 ring-1 ring-inset ring-ink-200">
          <StatusIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider opacity-80">
            Status
          </p>
          <p className="text-sm font-semibold">{presentation.headline}</p>
          <p className="mt-0.5 text-xs opacity-90">{presentation.sub}</p>
        </div>
        {designPath ? (
          <span className="hidden shrink-0 rounded-full bg-ink-0/70 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-ink-700 ring-1 ring-inset ring-ink-200 sm:inline-block">
            {designPath === "design_by_us"
              ? "We design"
              : "Customer uploads"}
          </span>
        ) : null}
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Preview shell — title bar with download / open buttons,
            and a generous inline PDF render or a friendlier empty
            state with a call to action. */}
        <article className="overflow-hidden rounded-2xl bg-ink-0 ring-1 ring-ink-200 lg:col-span-2">
          <header className="flex items-center justify-between gap-2 border-b border-ink-100 px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-ink-50 ring-1 ring-inset ring-ink-200">
                <FileText className="h-3.5 w-3.5 text-ink-600" />
              </span>
              <div>
                <p className="text-xs font-semibold text-ink-1000">
                  Current artwork
                </p>
                <p className="text-[10px] text-ink-500">
                  Latest revision inline
                </p>
              </div>
            </div>
            {artworkPdfUrl ? (
              <div className="flex items-center gap-1.5">
                <a
                  href={artworkPdfUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-8 items-center gap-1 rounded-lg bg-ink-0 px-2.5 text-[11px] font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                >
                  <ExternalLink className="h-3 w-3" /> Open
                </a>
                <a
                  href={artworkPdfUrl}
                  download
                  className="inline-flex h-8 items-center gap-1 rounded-lg bg-ink-1000 px-2.5 text-[11px] font-semibold text-ink-0 hover:bg-ink-900"
                >
                  <Download className="h-3 w-3" /> Download
                </a>
              </div>
            ) : null}
          </header>
          {artworkPdfUrl ? (
            isImageArtwork(artworkPdfUrl) ? (
              // PNG / JPG upload — render the bitmap directly,
              // centred and contained so portrait + landscape labels
              // both look right. ``bg-checker`` would be nicer for
              // transparency but a flat tone matches the PDF tray.
              <div className="flex h-[440px] w-full min-w-0 max-w-full items-center justify-center overflow-hidden bg-ink-50 p-4 sm:h-[560px] lg:h-[680px]">
                <img
                  src={artworkPdfUrl}
                  alt="Current artwork"
                  className="max-h-full max-w-full object-contain"
                />
              </div>
            ) : isPdfArtwork(artworkPdfUrl) ? (
              <PdfPreview
                url={artworkPdfUrl}
                heightClassName="h-[440px] sm:h-[560px] lg:h-[680px]"
              />
            ) : (
              // Unknown file type — give a clear opt-in to open
              // externally rather than guessing wrong.
              <div className="flex h-[440px] flex-col items-center justify-center gap-3 bg-ink-50 px-6 text-center sm:h-[560px] lg:h-[680px]">
                <FileText className="h-8 w-8 text-ink-400" />
                <p className="text-sm text-ink-700">
                  Inline preview unavailable for this file type.
                </p>
                <a
                  href={artworkPdfUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink-1000 px-3 text-xs font-semibold text-ink-0 hover:bg-ink-900"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> Open file
                </a>
              </div>
            )
          ) : (
            <div className="flex h-[440px] flex-col items-center justify-center gap-3 bg-gradient-to-b from-ink-50 to-ink-0 px-6 text-center sm:h-[560px] lg:h-[680px]">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-ink-0 shadow-sm ring-1 ring-ink-200">
                <ImageIcon className="h-6 w-6 text-ink-400" />
              </div>
              <div>
                <p className="text-sm font-semibold text-ink-1000">
                  No artwork yet
                </p>
                <p className="mt-1 max-w-sm text-xs text-ink-500">
                  {designPath === "design_by_customer"
                    ? "The customer is uploading the artwork from their side. It will appear here as soon as they submit."
                    : "Drop the first revision in the upload card on the right to get started."}
                </p>
              </div>
            </div>
          )}
          {additionalAssets.length > 0 ? (
            <div className="border-t border-ink-200 p-4">
              <p className="text-[10px] font-bold uppercase tracking-wider text-ink-500">
                Extra views ({additionalAssets.length})
              </p>
              <ul className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {additionalAssets.map((asset, i) => {
                  const isImage = asset.content_type.startsWith("image/");
                  return (
                    <li
                      key={asset.id}
                      className="overflow-hidden rounded-lg border border-ink-200"
                    >
                      <a
                        href={asset.file_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block"
                        title={asset.original_filename || asset.label}
                      >
                        {isImage ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={asset.file_url}
                            alt={asset.label || `View ${i + 2}`}
                            className="h-24 w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-24 w-full flex-col items-center justify-center gap-1 bg-ink-50">
                            <FileText className="h-5 w-5 text-ink-400" />
                            <span className="text-[10px] font-semibold uppercase text-ink-500">
                              {asset.content_type.includes("pdf") ? "PDF" : "File"}
                            </span>
                          </div>
                        )}
                        <p className="truncate bg-ink-0 px-2 py-1 text-[11px] font-semibold text-ink-700">
                          {asset.label || `View ${i + 2}`}
                        </p>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </article>

        {/* Sidebar — context-driven action cards. Only the cards
            that match the current status + the caller's caps render,
            so the column never shows an action the user can't take. */}
        <aside className="space-y-3">
          {isStuckMidReview ? (
            <div className="rounded-2xl bg-amber-50 p-3 text-[11px] text-amber-900 ring-1 ring-inset ring-amber-200">
              <p className="flex items-start gap-1.5">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  <strong className="font-semibold">
                    This revision was already reviewed.
                  </strong>{" "}
                  The reviewer can&rsquo;t submit a second verdict on the
                  same artwork — upload a new revision below and they can
                  start a fresh review round. The earlier verdict stays on
                  the record.
                </span>
              </p>
            </div>
          ) : null}
          {showUpload ? (
            <UploadCard
              orgId={orgId}
              labelDesignId={labelDesignId}
              onMutate={onMutate}
            />
          ) : null}
          {showSubmit ? (
            <SubmitForReviewCard
              orgId={orgId}
              labelDesignId={labelDesignId}
              hasArtwork={Boolean(artworkPdfUrl)}
              currentRevisionId={currentRevisionId}
              onMutate={onMutate}
            />
          ) : null}
          {canReviewScientist &&
          status === "scientist_review" &&
          !isStuckMidReview ? (
            <ReviewForm
              kind="scientist"
              orgId={orgId}
              labelDesignId={labelDesignId}
              onMutate={onMutate}
            />
          ) : null}
          {canReviewDirector &&
          status === "director_review" &&
          !isStuckMidReview ? (
            <DirectorReviewForm
              orgId={orgId}
              labelDesignId={labelDesignId}
              currentRevisionId={currentRevisionId}
              onMutate={onMutate}
            />
          ) : null}
          {status === "customer_approval" ? (
            <div className="rounded-2xl bg-ink-0 p-4 ring-1 ring-ink-200">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-orange-50 ring-1 ring-inset ring-orange-200">
                  <Send className="h-3.5 w-3.5 text-orange-700" />
                </span>
                <p className="text-xs font-semibold text-ink-1000">
                  With the customer
                </p>
              </div>
              <p className="mt-2 text-xs text-ink-600">
                The portal customer is reviewing. They can sign off or
                send back a change request — both will land in the
                Reviews tab automatically.
              </p>
            </div>
          ) : null}
          {status === "label_approved" ? (
            <div className="rounded-2xl bg-emerald-50 p-4 ring-1 ring-emerald-200">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-100 ring-1 ring-inset ring-emerald-200">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-700" />
                </span>
                <p className="text-xs font-semibold text-emerald-900">
                  Approved &amp; signed
                </p>
              </div>
              <p className="mt-2 text-xs text-emerald-800/90">
                Customer signed off. Hand off to production with the
                final PDF above.
              </p>
            </div>
          ) : null}
          {/* Customer-design specific waiting state — staff has no
              upload affordance on this path, so the generic
              "nothing to do" fallback below would read as
              misleading. This card explains the situation
              explicitly. */}
          {isCustomerDesign &&
          (status === "design_in_progress" ||
            status === "label_path_pending") ? (
            <div className="rounded-2xl border border-dashed border-orange-300 bg-orange-50/40 p-4">
              <p className="text-xs font-semibold text-orange-900">
                Customer is designing
              </p>
              <p className="mt-1 text-[11px] text-orange-800/90">
                On this path the customer owns the artwork. They
                upload the next revision from the portal; the
                workflow will reappear here when they submit it for
                review.
              </p>
            </div>
          ) : null}
          {!showUpload &&
          !showSubmit &&
          status !== "customer_approval" &&
          status !== "label_approved" &&
          !(
            isCustomerDesign &&
            (status === "design_in_progress" ||
              status === "label_path_pending")
          ) ? (
            <div className="rounded-2xl border border-dashed border-ink-200 bg-ink-0 p-4">
              <p className="text-xs text-ink-500">
                Nothing for you to do right now — sit tight and the
                workflow will surface the next action here.
              </p>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}


//: 50 MB matches the backend ``ARTWORK_MAX_BYTES`` ceiling. Keep
//: in lockstep so the FE rejection message stays correct.
const ARTWORK_MAX_BYTES = 50 * 1024 * 1024;
const ARTWORK_ALLOWED_EXT = [".pdf", ".png", ".jpg", ".jpeg"];
const ARTWORK_ALLOWED_MIME = ["application/pdf", "image/png", "image/jpeg"];

function _humanFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function _validateArtworkClient(file: File): string | null {
  const name = file.name.toLowerCase();
  if (!ARTWORK_ALLOWED_EXT.some((ext) => name.endsWith(ext))) {
    return "Unsupported file type — accepted: PDF, PNG, JPEG.";
  }
  if (file.type && !ARTWORK_ALLOWED_MIME.includes(file.type)) {
    return `Unsupported file type (${file.type}) — accepted: PDF, PNG, JPEG.`;
  }
  if (file.size > ARTWORK_MAX_BYTES) {
    return `File too large (${_humanFileSize(file.size)}). Max ${_humanFileSize(ARTWORK_MAX_BYTES)}.`;
  }
  return null;
}


interface UploadAsset {
  readonly file: File;
  readonly label: string;
}

//: Maximum companion files per revision (front + up to 10 extras).
//: Mirrors the backend cap in ``_attach_additional_assets``.
const MAX_ARTWORK_ASSETS = 11;

function UploadCard({
  orgId,
  labelDesignId,
  onMutate,
}: {
  orgId: string;
  labelDesignId: string;
  onMutate: () => void;
}) {
  const upload = useUploadLabelArtwork(orgId, labelDesignId);
  // Multi-file model: the first entry is the "primary" artwork that
  // drives the revision preview + review checklist; the rest ride
  // as supplementary "back / side / mockup" views on the same
  // revision. Reordering is supported so a mis-picked primary can
  // be swapped without re-uploading.
  const [assets, setAssets] = useState<UploadAsset[]>([]);
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const addFiles = (incoming: FileList | File[] | null) => {
    setErr(null);
    if (!incoming) return;
    const picked = Array.from(incoming);
    setAssets((current) => {
      const remaining = MAX_ARTWORK_ASSETS - current.length;
      const next: UploadAsset[] = [];
      for (const f of picked.slice(0, remaining)) {
        const reason = _validateArtworkClient(f);
        if (reason) {
          setErr(`${f.name}: ${reason}`);
          continue;
        }
        next.push({ file: f, label: "" });
      }
      return [...current, ...next];
    });
  };

  const removeAt = (idx: number) => {
    setAssets((cur) => cur.filter((_, i) => i !== idx));
  };
  const relabel = (idx: number, label: string) => {
    setAssets((cur) =>
      cur.map((a, i) => (i === idx ? { ...a, label } : a)),
    );
  };
  const moveUp = (idx: number) => {
    setAssets((cur) => {
      if (idx <= 0 || idx >= cur.length) return cur;
      const next = [...cur];
      [next[idx - 1], next[idx]] = [next[idx]!, next[idx - 1]!];
      return next;
    });
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (assets.length === 0) {
      setErr("Drop a file or click to choose one first.");
      return;
    }
    const [primary, ...extras] = assets;
    try {
      await upload.mutateAsync({
        artwork: primary!.file,
        notes,
        additionalFiles: extras.map((a) => ({
          file: a.file,
          label: a.label.trim(),
        })),
      });
      setAssets([]);
      setNotes("");
      onMutate();
    } catch (e) {
      const data = (e as { response?: { data?: Record<string, unknown> } })
        ?.response?.data;
      const fieldErr = Array.isArray((data as { artwork?: unknown })?.artwork)
        ? ((data as { artwork: string[] }).artwork[0] as string)
        : undefined;
      const detail = (data as { detail?: string })?.detail;
      setErr(fieldErr ?? detail ?? "Upload failed.");
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    addFiles(e.dataTransfer.files);
  };

  const capsReached = assets.length >= MAX_ARTWORK_ASSETS;

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-2xl bg-ink-0 p-4 ring-1 ring-ink-200"
    >
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-orange-50 ring-1 ring-inset ring-orange-200">
          <UploadCloud className="h-3.5 w-3.5 text-orange-700" />
        </span>
        <div>
          <p className="text-xs font-semibold text-ink-1000">Upload artwork</p>
          <p className="text-[10px] text-ink-500">
            PDF, PNG, JPEG · up to 50 MB each · attach multiple views (front / back / side / mockup)
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={() => (capsReached ? undefined : inputRef.current?.click())}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        disabled={capsReached}
        className={`mt-3 flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors ${
          dragOver
            ? "border-orange-400 bg-orange-50"
            : "border-ink-200 bg-ink-50 hover:border-orange-300 hover:bg-orange-50/40 disabled:hover:border-ink-200 disabled:hover:bg-ink-50"
        }`}
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-ink-0 ring-1 ring-inset ring-ink-200">
          <UploadCloud className="h-4 w-4 text-ink-500" />
        </span>
        <div>
          <p className="text-xs font-semibold text-ink-1000">
            {capsReached
              ? `Reached the ${MAX_ARTWORK_ASSETS}-file limit`
              : "Drop file(s) here"}
          </p>
          <p className="text-[10px] text-ink-500">
            {capsReached ? "Remove one to add another" : "or click to browse"}
          </p>
        </div>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,image/png,image/jpeg"
        multiple
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = "";
        }}
        className="hidden"
      />

      {assets.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {assets.map((a, i) => (
            <li
              key={`${a.file.name}-${i}`}
              className="flex items-start gap-2 rounded-lg bg-ink-50 p-2 ring-1 ring-inset ring-ink-200"
            >
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${
                  i === 0
                    ? "bg-emerald-100 text-emerald-700 ring-emerald-200"
                    : "bg-ink-0 text-ink-500 ring-ink-200"
                }`}
              >
                {i === 0 ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <span className="text-[10px] font-bold">{i + 1}</span>
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
                      i === 0
                        ? "bg-emerald-100 text-emerald-800"
                        : "bg-ink-100 text-ink-700"
                    }`}
                  >
                    {i === 0 ? "Primary" : `View ${i + 1}`}
                  </span>
                  <p className="truncate text-[11px] font-semibold text-ink-1000">
                    {a.file.name}
                  </p>
                  <span className="ml-auto text-[10px] text-ink-500">
                    {_humanFileSize(a.file.size)}
                  </span>
                </div>
                {i > 0 ? (
                  <input
                    type="text"
                    value={a.label}
                    onChange={(e) => relabel(i, e.target.value)}
                    placeholder="Optional label (e.g. Back, Left side, Bottle mockup)"
                    maxLength={80}
                    className="mt-1.5 w-full rounded-md border-0 bg-ink-0 px-2 py-1 text-[11px] text-ink-800 ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-orange-400"
                  />
                ) : null}
              </div>
              <div className="flex flex-col gap-1">
                {i > 0 ? (
                  <button
                    type="button"
                    onClick={() => moveUp(i)}
                    className="text-[10px] font-semibold text-ink-500 hover:text-orange-700"
                    title="Move up (becomes new primary)"
                  >
                    ↑
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => removeAt(i)}
                  className="text-[10px] font-semibold text-ink-500 hover:text-rose-600"
                  title="Remove"
                >
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <label className="mt-3 block">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">
          Notes
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What changed in this revision? (optional)"
          rows={3}
          className="mt-1 w-full rounded-lg border-0 bg-ink-50 px-3 py-2 text-xs text-ink-800 ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-orange-400"
        />
      </label>

      {err ? (
        <p className="mt-2 flex items-start gap-1.5 rounded-md bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700 ring-1 ring-inset ring-rose-200">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{err}</span>
        </p>
      ) : null}

      <button
        type="submit"
        disabled={upload.isPending || assets.length === 0}
        className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-ink-1000 px-3 py-2 text-xs font-semibold text-ink-0 hover:bg-ink-900 disabled:opacity-50"
      >
        {upload.isPending ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Uploading…
          </>
        ) : (
          <>
            <UploadCloud className="h-3.5 w-3.5" />
            Upload revision{assets.length > 1 ? ` (${assets.length} files)` : ""}
          </>
        )}
      </button>
    </form>
  );
}


function SubmitForReviewCard({
  orgId,
  labelDesignId,
  hasArtwork,
  currentRevisionId,
  onMutate,
}: {
  orgId: string;
  labelDesignId: string;
  hasArtwork: boolean;
  currentRevisionId: string | null;
  onMutate: () => void;
}) {
  const submit = useSubmitLabelForReview(orgId, labelDesignId);
  const reviewsQuery = useLabelDesignReviews(orgId, labelDesignId);
  const [err, setErr] = useState<string | null>(null);
  // A revision is locked once it's been reviewed — the backend
  // enforces UNIQUE(revision, kind) on the review row. Surfacing
  // that up-front is much friendlier than letting the designer
  // click "Send for review" and read a 400. The fix is always
  // the same: upload a fresh revision.
  const currentReviewed = Boolean(
    currentRevisionId &&
      reviewsQuery.data?.some((r) => r.revision === currentRevisionId),
  );
  // Gate the submit on an actual artwork upload — the backend will
  // reject ``submit-for-review`` with ``no_revision`` if there's
  // no current revision, but disabling the button up-front is
  // friendlier than letting the user click and read a server error.
  const disabled = submit.isPending || !hasArtwork || currentReviewed;
  return (
    <div className="rounded-2xl bg-ink-0 p-4 ring-1 ring-ink-200">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-50 ring-1 ring-inset ring-violet-200">
          <Send className="h-3.5 w-3.5 text-violet-700" />
        </span>
        <p className="text-xs font-semibold text-ink-1000">
          Send for scientist review
        </p>
      </div>
      <p className="mt-2 text-[11px] text-ink-500">
        The scientist runs the MA-PD-B-012 compliance checklist on the latest
        revision and approves or sends it back for changes.
      </p>
      {!hasArtwork ? (
        <p className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800 ring-1 ring-inset ring-amber-200">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>Upload artwork before sending for review.</span>
        </p>
      ) : currentReviewed ? (
        <p className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800 ring-1 ring-inset ring-amber-200">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            This revision was already reviewed. Upload a new artwork
            revision before resubmitting — the previous review stays
            on the record.
          </span>
        </p>
      ) : null}
      {err ? (
        <p className="mt-2 flex items-start gap-1.5 rounded-md bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700 ring-1 ring-inset ring-rose-200">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{err}</span>
        </p>
      ) : null}
      <button
        type="button"
        onClick={async () => {
          setErr(null);
          try {
            await submit.mutateAsync();
            onMutate();
          } catch (e) {
            setErr(
              (e as { response?: { data?: { detail?: string } } })?.response
                ?.data?.detail ?? "Submission failed.",
            );
          }
        }}
        disabled={disabled}
        className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-orange-600 px-3 py-2 text-xs font-semibold text-ink-0 hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submit.isPending ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Sending…
          </>
        ) : (
          <>
            <Send className="h-3.5 w-3.5" /> Send for review
          </>
        )}
      </button>
    </div>
  );
}


type ChecklistAnswer = "pass" | "fail" | null;

function ReviewForm({
  kind,
  orgId,
  labelDesignId,
  onMutate,
}: {
  kind: "scientist" | "director";
  orgId: string;
  labelDesignId: string;
  onMutate: () => void;
}) {
  const scientist = useSubmitScientistReview(orgId, labelDesignId);
  const director = useSubmitDirectorReview(orgId, labelDesignId);
  const mutation = kind === "scientist" ? scientist : director;

  // Every item starts as ``null`` — the reviewer MUST actively pick
  // Pass or Fail. Prevents the "submit with defaults, nothing was
  // actually reviewed" failure mode the previous version had.
  const [responses, setResponses] = useState<
    Record<string, { answer: ChecklistAnswer; comment: string }>
  >(() =>
    Object.fromEntries(
      CHECKLIST_ITEMS.map((item) => [item.key, { answer: null, comment: "" }]),
    ),
  );
  const [finalComments, setFinalComments] = useState("");
  const [signature, setSignature] = useState("");
  const [err, setErr] = useState<string | null>(null);
  // Which item first tripped the validator — drives auto-scroll so
  // the reviewer isn't hunting for what's missing.
  const [errorKey, setErrorKey] = useState<string | null>(null);

  // Progress + auto-outcome derivation. Auto-set to "requires
  // revision" the moment any item is failed; auto-set to "approve"
  // when every item passes. The reviewer can still override before
  // submitting.
  const answered = Object.values(responses).filter((r) => r.answer !== null).length;
  const failed = Object.values(responses).filter((r) => r.answer === "fail").length;
  const passed = Object.values(responses).filter((r) => r.answer === "pass").length;
  const total = CHECKLIST_ITEMS.length;
  const hasAnyFail = failed > 0;
  const allAnswered = answered === total;
  const failedWithoutComment = Object.entries(responses).find(
    ([, r]) => r.answer === "fail" && !r.comment.trim(),
  );

  const [outcomeOverride, setOutcomeOverride] = useState<
    "approved" | "requires_revision" | null
  >(null);
  const effectiveOutcome: "approved" | "requires_revision" =
    outcomeOverride ?? (hasAnyFail ? "requires_revision" : "approved");

  const patch = (key: string, patch: Partial<{ answer: ChecklistAnswer; comment: string }>) => {
    setErr(null);
    setErrorKey(null);
    setResponses((cur) => ({
      ...cur,
      [key]: { ...cur[key]!, ...patch },
    }));
  };

  const scrollToItem = (key: string) => {
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-checklist-item="${key}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setErrorKey(null);
    // Gate 1: every item must be answered.
    if (!allAnswered) {
      const firstUnanswered = CHECKLIST_ITEMS.find(
        (i) => responses[i.key]?.answer === null,
      );
      if (firstUnanswered) {
        setErrorKey(firstUnanswered.key);
        setErr(
          `${total - answered} item${total - answered === 1 ? "" : "s"} still unanswered — every checklist item needs Pass or Fail.`,
        );
        scrollToItem(firstUnanswered.key);
        return;
      }
    }
    // Gate 2: failed items must carry a reason.
    if (failedWithoutComment) {
      setErrorKey(failedWithoutComment[0]);
      setErr("Every failed item needs a short reason so the designer knows what to fix.");
      scrollToItem(failedWithoutComment[0]);
      return;
    }
    // Gate 3: final comments always required (regulatory).
    if (!finalComments.trim()) {
      setErr("Final comments are required — a one-liner summary for the audit trail.");
      return;
    }
    // Gate 4: signature required (regulatory sign-off).
    if (!signature.trim()) {
      setErr("Please sign to record your review.");
      return;
    }
    try {
      const body = {
        outcome: effectiveOutcome,
        checklist: CHECKLIST_ITEMS.map((item) => ({
          item_key: item.key,
          pass_check: responses[item.key]?.answer === "pass",
          comment: responses[item.key]?.comment ?? "",
        })),
        final_comments: finalComments,
        signature_image: signature,
      };
      await mutation.mutateAsync(body);
      onMutate();
    } catch (e) {
      setErr(
        (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
          "Submission failed.",
      );
    }
  };

  return (
    <form onSubmit={onSubmit} className="rounded-2xl bg-ink-0 p-4 ring-1 ring-ink-200">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink-1000">
          {kind === "scientist" ? "Scientist review" : "Director review"}
        </h3>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
          MA-PD-B-012
        </p>
      </div>

      {/* Progress strip — always visible at the top so the reviewer
          sees how far they've gone as they scroll through sections. */}
      <div className="mt-3 rounded-xl border border-ink-200 bg-ink-50 p-3">
        <div className="flex items-center justify-between text-[11px]">
          <span className="font-semibold text-ink-1000">
            {answered} of {total} answered
          </span>
          <span className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">
              <Check className="h-2.5 w-2.5" /> {passed} pass
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                failed > 0 ? "bg-rose-100 text-rose-800" : "bg-ink-100 text-ink-500"
              }`}
            >
              <AlertCircle className="h-2.5 w-2.5" /> {failed} flagged
            </span>
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-200">
          <div
            className={`h-full transition-all ${hasAnyFail ? "bg-rose-500" : "bg-emerald-500"}`}
            style={{ width: `${(answered / total) * 100}%` }}
          />
        </div>
      </div>

      <div className="mt-4 space-y-4">
        {CHECKLIST_SECTIONS.map((section) => {
          const items = CHECKLIST_ITEMS.filter((i) => i.section === section.key);
          if (items.length === 0) return null;
          const sectionAnswered = items.filter((i) => responses[i.key]?.answer !== null).length;
          const sectionFailed = items.filter((i) => responses[i.key]?.answer === "fail").length;
          return (
            <section key={section.key}>
              <header className="flex items-center justify-between border-b border-ink-100 pb-1">
                <h4 className="text-[11px] font-bold uppercase tracking-wider text-ink-700">
                  {section.label}
                </h4>
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                    sectionAnswered === items.length && sectionFailed === 0
                      ? "bg-emerald-100 text-emerald-800"
                      : sectionFailed > 0
                        ? "bg-rose-100 text-rose-800"
                        : "bg-ink-100 text-ink-600"
                  }`}
                >
                  {sectionAnswered}/{items.length}
                </span>
              </header>
              <ul className="mt-2 space-y-2">
                {items.map((item) => {
                  const res = responses[item.key]!;
                  const isFail = res.answer === "fail";
                  const needsComment = isFail && !res.comment.trim();
                  const highlighted = errorKey === item.key;
                  return (
                    <li
                      key={item.key}
                      data-checklist-item={item.key}
                      className={`rounded-xl border p-3 transition-colors ${
                        highlighted
                          ? "border-rose-400 bg-rose-50/70 ring-2 ring-rose-200"
                          : isFail
                            ? "border-rose-200 bg-rose-50/30"
                            : res.answer === "pass"
                              ? "border-emerald-200 bg-emerald-50/30"
                              : "border-ink-200 bg-ink-0"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-semibold text-ink-1000">{item.label}</p>
                          {item.help ? (
                            <p className="mt-0.5 text-[10px] text-ink-500">{item.help}</p>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 gap-1">
                          <button
                            type="button"
                            onClick={() => patch(item.key, { answer: "pass" })}
                            aria-pressed={res.answer === "pass"}
                            className={`inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-[11px] font-bold transition-colors ${
                              res.answer === "pass"
                                ? "bg-emerald-600 text-white shadow-sm"
                                : "bg-ink-0 text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-emerald-50"
                            }`}
                          >
                            <Check className="h-3 w-3" /> Pass
                          </button>
                          <button
                            type="button"
                            onClick={() => patch(item.key, { answer: "fail" })}
                            aria-pressed={res.answer === "fail"}
                            className={`inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-[11px] font-bold transition-colors ${
                              res.answer === "fail"
                                ? "bg-rose-600 text-white shadow-sm"
                                : "bg-ink-0 text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-rose-50"
                            }`}
                          >
                            <AlertCircle className="h-3 w-3" /> Fail
                          </button>
                        </div>
                      </div>
                      {res.answer !== null ? (
                        <div className="mt-2">
                          <input
                            type="text"
                            value={res.comment}
                            onChange={(e) => patch(item.key, { comment: e.target.value })}
                            placeholder={
                              isFail
                                ? "What needs to change? (required)"
                                : "Optional comment"
                            }
                            className={`w-full rounded-md bg-ink-0 px-2 py-1 text-[11px] outline-none ring-1 ring-inset transition-colors focus:ring-2 focus:ring-orange-400 ${
                              needsComment
                                ? "ring-rose-300"
                                : "ring-ink-200"
                            }`}
                          />
                          {needsComment ? (
                            <p className="mt-0.5 text-[10px] font-semibold text-rose-600">
                              Add a short reason so the designer knows what to fix.
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>

      <label className="mt-4 block">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-700">
          Final comments (required)
        </span>
        <textarea
          value={finalComments}
          onChange={(e) => {
            setFinalComments(e.target.value);
            setErr(null);
          }}
          rows={3}
          placeholder="Summary of your findings — one paragraph that lives on the audit record."
          className="mt-1 w-full rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-800 outline-none ring-1 ring-inset ring-ink-200 focus:ring-2 focus:ring-orange-400"
        />
      </label>

      <div className="mt-3">
        <SignatureField
          label="Sign"
          value={signature}
          onChange={(v) => {
            setSignature(v);
            setErr(null);
          }}
          ariaLabel={`${kind === "scientist" ? "Scientist" : "Director"} signature`}
        />
      </div>

      {/* Outcome — big segmented buttons; auto-selected based on the
          checklist state but the reviewer can still override. */}
      <div className="mt-4">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-700">
          Outcome
        </p>
        <div className="mt-1 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setOutcomeOverride("approved")}
            aria-pressed={effectiveOutcome === "approved"}
            className={`flex flex-col items-start gap-0.5 rounded-lg border-2 p-2.5 text-left transition-colors ${
              effectiveOutcome === "approved"
                ? "border-emerald-500 bg-emerald-50"
                : "border-ink-200 bg-ink-0 hover:border-emerald-300"
            }`}
          >
            <span className="flex items-center gap-1 text-[11px] font-bold text-emerald-800">
              <Check className="h-3 w-3" /> Approve
            </span>
            <span className="text-[10px] text-ink-600">
              Everything checks out. Advance the workflow.
            </span>
          </button>
          <button
            type="button"
            onClick={() => setOutcomeOverride("requires_revision")}
            aria-pressed={effectiveOutcome === "requires_revision"}
            className={`flex flex-col items-start gap-0.5 rounded-lg border-2 p-2.5 text-left transition-colors ${
              effectiveOutcome === "requires_revision"
                ? "border-rose-500 bg-rose-50"
                : "border-ink-200 bg-ink-0 hover:border-rose-300"
            }`}
          >
            <span className="flex items-center gap-1 text-[11px] font-bold text-rose-800">
              <AlertCircle className="h-3 w-3" /> Request revisions
            </span>
            <span className="text-[10px] text-ink-600">
              Send back to the designer for fixes.
            </span>
          </button>
        </div>
        {hasAnyFail && effectiveOutcome === "approved" ? (
          <p className="mt-1 text-[10px] font-semibold text-amber-700">
            Heads-up: {failed} item{failed === 1 ? "" : "s"} flagged as Fail. Are you sure this
            should advance?
          </p>
        ) : null}
      </div>

      {err ? (
        <p className="mt-3 flex items-start gap-1.5 rounded-md bg-rose-50 px-2.5 py-2 text-[11px] font-semibold text-rose-700 ring-1 ring-inset ring-rose-200">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{err}</span>
        </p>
      ) : null}

      <button
        type="submit"
        disabled={mutation.isPending}
        className={`mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-white transition-colors disabled:opacity-50 ${
          effectiveOutcome === "approved"
            ? "bg-emerald-600 hover:bg-emerald-700"
            : "bg-rose-600 hover:bg-rose-700"
        }`}
      >
        {mutation.isPending ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Submitting…
          </>
        ) : effectiveOutcome === "approved" ? (
          <>
            <Check className="h-3.5 w-3.5" /> Approve & submit
          </>
        ) : (
          <>
            <AlertCircle className="h-3.5 w-3.5" /> Request revisions
          </>
        )}
      </button>
    </form>
  );
}


/** Read-only render of a scientist's full MA-PD-B-012 checklist.
 *
 *  Grouped by the same 5 sections the scientist saw at fill-time
 *  so the director reads it in workflow order. Failed items
 *  bubble to the top of each section because they're the ones
 *  that actually need attention; passing items collapse beneath
 *  a "show all" toggle. The scientist's per-item comment travels
 *  with the row — those are the WHY the director is signing off
 *  on.
 */
function ScientistChecklistReview({
  responses,
}: {
  responses: LabelDesignReviewDto["checklist_responses"];
}) {
  const [showPassing, setShowPassing] = useState(false);
  const byKey = useMemo(() => {
    const m = new Map<string, { pass: boolean; comment: string }>();
    for (const r of responses) {
      m.set(r.item_key, { pass: r.pass, comment: r.comment });
    }
    return m;
  }, [responses]);

  return (
    <div className="mt-3 rounded-md bg-ink-0/60 p-2 ring-1 ring-inset ring-ink-200">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-600">
          Scientist&rsquo;s checklist
        </p>
        <button
          type="button"
          onClick={() => setShowPassing((v) => !v)}
          className="rounded bg-ink-50 px-2 py-0.5 text-[10px] font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-100"
        >
          {showPassing ? "Failed only" : "Show passing"}
        </button>
      </div>
      <div className="mt-2 space-y-2">
        {CHECKLIST_SECTIONS.map((section) => {
          const items = CHECKLIST_ITEMS.filter(
            (i) => i.section === section.key,
          );
          if (items.length === 0) return null;
          // Render failed items first within each section so the
          // director's eye lands on the problems before the noise.
          const sorted = [...items].sort((a, b) => {
            const ar = byKey.get(a.key);
            const br = byKey.get(b.key);
            const af = ar ? (ar.pass ? 1 : 0) : 2;
            const bf = br ? (br.pass ? 1 : 0) : 2;
            return af - bf;
          });
          const visible = sorted.filter((item) => {
            const r = byKey.get(item.key);
            return showPassing || !r || !r.pass;
          });
          if (visible.length === 0) return null;
          return (
            <div key={section.key}>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
                {section.label}
              </p>
              <ul className="mt-1 space-y-1">
                {visible.map((item) => {
                  const r = byKey.get(item.key);
                  const pass = r?.pass ?? true;
                  return (
                    <li
                      key={item.key}
                      className={`rounded px-2 py-1 text-[11px] ring-1 ring-inset ${
                        pass
                          ? "bg-emerald-50/60 text-ink-900 ring-emerald-200/60"
                          : "bg-rose-50 text-ink-900 ring-rose-200"
                      }`}
                    >
                      <div className="flex items-start gap-1.5">
                        {pass ? (
                          <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-700" />
                        ) : (
                          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0 text-rose-700" />
                        )}
                        <span className="flex-1">{item.label}</span>
                        <span
                          className={`shrink-0 rounded px-1.5 text-[9px] font-semibold uppercase tracking-wide ${
                            pass
                              ? "bg-emerald-100 text-emerald-800"
                              : "bg-rose-100 text-rose-800"
                          }`}
                        >
                          {pass ? "Pass" : "Fail"}
                        </span>
                      </div>
                      {r?.comment ? (
                        <p className="mt-1 whitespace-pre-line pl-4 text-[11px] text-ink-700">
                          {r.comment}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}


/** Director review = sign-off on the scientist's verdict.
 *
 *  The 22-item MA-PD-B-012 checklist belongs to the scientist
 *  (it IS the scientific review). Asking the director to rerun
 *  it would be ceremony — they're approving the work, not
 *  redoing it. This form shows what the scientist concluded
 *  and asks the director for an approve/reject decision plus
 *  comments and a signature. The scientist's full checklist
 *  stays on their own review row, so the regulatory trail is
 *  intact.
 */
function DirectorReviewForm({
  orgId,
  labelDesignId,
  currentRevisionId,
  onMutate,
}: {
  orgId: string;
  labelDesignId: string;
  currentRevisionId: string | null;
  onMutate: () => void;
}) {
  const submit = useSubmitDirectorReview(orgId, labelDesignId);
  const reviewsQuery = useLabelDesignReviews(orgId, labelDesignId);
  const scientistReview = useMemo(() => {
    if (!currentRevisionId) return null;
    return (
      reviewsQuery.data?.find(
        (r) => r.revision === currentRevisionId && r.kind === "scientist",
      ) ?? null
    );
  }, [reviewsQuery.data, currentRevisionId]);

  const [finalComments, setFinalComments] = useState("");
  const [signature, setSignature] = useState("");
  const [err, setErr] = useState<string | null>(null);
  // Tracks which button is in-flight so we can show the right
  // spinner copy. Not used to drive the request — that goes
  // through ``submitWithOutcome`` directly to dodge the
  // ``setState`` batching gotcha (state isn't visible to the
  // sibling event handler that reads it).
  const [pendingOutcome, setPendingOutcome] = useState<
    "approved" | "requires_revision" | null
  >(null);

  const failedChecklistCount = useMemo(() => {
    if (!scientistReview) return 0;
    return scientistReview.checklist_responses.filter((r) => !r.pass).length;
  }, [scientistReview]);

  const submitWithOutcome = async (
    outcome: "approved" | "requires_revision",
  ) => {
    setErr(null);
    if (!finalComments.trim()) {
      setErr("A short comment is required.");
      return;
    }
    setPendingOutcome(outcome);
    try {
      await submit.mutateAsync({
        outcome,
        // Director path — empty checklist by design. Backend
        // accepts it via the ``require_full_checklist=False``
        // context flag on ``ReviewSubmitSerializer``.
        checklist: [],
        final_comments: finalComments,
        signature_image: signature,
      });
      onMutate();
    } catch (e) {
      setErr(
        (e as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Submission failed.",
      );
    } finally {
      setPendingOutcome(null);
    }
  };

  return (
    <div className="rounded-2xl bg-ink-0 p-4 ring-1 ring-ink-200">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-50 ring-1 ring-inset ring-violet-200">
          <CheckCircle2 className="h-3.5 w-3.5 text-violet-700" />
        </span>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-700">
          Director sign-off
        </h3>
      </div>
      <p className="mt-1 text-[11px] text-ink-500">
        The scientist has run the MA-PD-B-012 compliance check.
        Read their verdict and decide.
      </p>

      {/* Scientist's verdict card — the thing the director is
          signing off on. Bare minimum: outcome, who, when, plus
          the comments that travel with the verdict. Failed
          items get a separate count so the director sees at a
          glance whether the scientist flagged anything. */}
      {scientistReview ? (
        <div
          className={`mt-3 rounded-lg px-3 py-2 ring-1 ring-inset ${
            scientistReview.outcome === "approved"
              ? "bg-emerald-50 text-emerald-900 ring-emerald-200"
              : "bg-rose-50 text-rose-900 ring-rose-200"
          }`}
        >
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide">
            {scientistReview.outcome === "approved" ? (
              <CheckCircle2 className="h-3.5 w-3.5" />
            ) : (
              <AlertCircle className="h-3.5 w-3.5" />
            )}
            <span>
              Scientist {scientistReview.outcome === "approved"
                ? "approved"
                : "sent back"}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-ink-700">
            {scientistReview.reviewer_email || "Unknown"}
            {scientistReview.created_at
              ? ` · ${new Date(scientistReview.created_at).toLocaleString()}`
              : ""}
          </p>
          {failedChecklistCount > 0 ? (
            <p className="mt-1 text-[11px] text-rose-800">
              {failedChecklistCount} checklist item
              {failedChecklistCount === 1 ? "" : "s"} flagged.
            </p>
          ) : (
            <p className="mt-1 text-[11px] text-emerald-800">
              All 22 checklist items passed.
            </p>
          )}
          {scientistReview.final_comments ? (
            <p className="mt-2 whitespace-pre-line text-xs text-ink-900">
              “{scientistReview.final_comments}”
            </p>
          ) : null}

          {/* Line-by-line MA-PD-B-012 verdict — every item the
              scientist filled in, grouped the same way they saw
              it, with their per-item comment if any. The director
              needs the comments inline to sign off knowingly;
              hiding them behind a tab switch was making the
              workspace lie about how much context was on screen. */}
          <ScientistChecklistReview
            responses={scientistReview.checklist_responses}
          />
        </div>
      ) : (
        <p className="mt-3 rounded-md bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800 ring-1 ring-inset ring-amber-200">
          No scientist review found on this revision — strange. Check
          the Reviews tab before signing off.
        </p>
      )}

      <label className="mt-3 block text-[10px] font-semibold uppercase tracking-wide text-ink-700">
        Your comment (required)
      </label>
      <textarea
        value={finalComments}
        onChange={(e) => setFinalComments(e.target.value)}
        rows={3}
        placeholder="Anything you want on the record alongside your decision."
        className="mt-1 w-full rounded border border-ink-200 px-2 py-1 text-xs"
      />

      <SignatureField
        label="Sign"
        value={signature}
        onChange={setSignature}
        ariaLabel="Director signature"
      />

      <div className="mt-3 flex flex-col gap-2">
        <button
          type="button"
          onClick={() => submitWithOutcome("approved")}
          disabled={submit.isPending}
          className="inline-flex items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold text-ink-0 hover:bg-emerald-700 disabled:opacity-50"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          {pendingOutcome === "approved" ? "Approving…" : "Approve label"}
        </button>
        <button
          type="button"
          onClick={() => submitWithOutcome("requires_revision")}
          disabled={submit.isPending}
          className="inline-flex items-center justify-center gap-1.5 rounded-md bg-ink-0 px-3 py-2 text-xs font-semibold text-rose-700 ring-1 ring-inset ring-rose-200 hover:bg-rose-50 disabled:opacity-50"
        >
          <AlertCircle className="h-3.5 w-3.5" />
          {pendingOutcome === "requires_revision"
            ? "Sending back…"
            : "Send back for changes"}
        </button>
      </div>
      {err ? <p className="mt-2 text-xs text-danger">{err}</p> : null}
    </div>
  );
}


/** Customer-brief tab — surfaces the MA-ST-B-009 design
 *  preferences the customer submitted on the DESIGN_BY_US path
 *  so the designer can actually act on the brief. Without this
 *  the workspace silently hid the form payload behind a tab the
 *  designer never opened — staff were guessing at the brand
 *  colours and inspiration the customer had explicitly captured.
 */
function BriefTab({
  preferences,
  designPath,
}: {
  preferences: LabelDesignDto["preferences_detail"];
  designPath: string;
}) {
  if (designPath === "design_by_customer") {
    return (
      <div className="rounded-2xl bg-ink-0 p-6 ring-1 ring-ink-200">
        <p className="text-sm text-ink-500">
          The customer is designing their own artwork, so no MA-ST-B-009
          brief was submitted.
        </p>
      </div>
    );
  }
  if (!preferences) {
    return (
      <div className="rounded-2xl bg-ink-0 p-6 ring-1 ring-ink-200">
        <p className="text-sm text-ink-500">
          No brief submitted yet — the workspace will surface the customer&rsquo;s
          design preferences here once they fill in MA-ST-B-009.
        </p>
      </div>
    );
  }

  const submittedAt = preferences.submitted_at
    ? new Date(preferences.submitted_at).toLocaleString()
    : "";

  return (
    <article className="space-y-4">
      <header className="rounded-2xl bg-ink-0 p-5 ring-1 ring-ink-200">
        <h2 className="text-base font-semibold text-ink-1000">
          MA-ST-B-009 · Design preferences
        </h2>
        <p className="mt-1 text-xs text-ink-500">
          Submitted by{" "}
          <span className="text-ink-700">{preferences.submitted_by_client_email}</span>
          {submittedAt ? ` · ${submittedAt}` : ""}
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <BriefSection title="Project">
          <BriefRow label="Company" value={preferences.company_name} />
          <BriefRow label="Brand" value={preferences.brand_name} />
          <BriefRow label="Products" value={preferences.product_names} />
          <BriefRow label="Product codes" value={preferences.product_codes} />
        </BriefSection>

        <BriefSection title="Style + finish">
          <BriefRow label="Design style" value={preferences.design_style} />
          <BriefRow label="Material" value={preferences.material_type} />
        </BriefSection>

        <BriefSection title="Brand colours" className="lg:col-span-2">
          {preferences.brand_colours.length === 0 ? (
            <p className="text-xs text-ink-500">No colours supplied.</p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {preferences.brand_colours.map((c, i) => (
                <div
                  key={`${c.hex}-${i}`}
                  className="flex items-center gap-2 rounded-lg bg-ink-50 px-3 py-2 ring-1 ring-ink-200"
                >
                  <span
                    className="h-6 w-6 rounded ring-1 ring-ink-300"
                    style={{ backgroundColor: c.hex || "#fff" }}
                  />
                  <div className="text-xs">
                    <div className="font-medium text-ink-1000">
                      {c.name || "(unnamed)"}
                    </div>
                    <div className="font-mono text-ink-500">
                      {c.hex || "—"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </BriefSection>

        <BriefSection title="Elements to include" className="lg:col-span-2">
          <p className="whitespace-pre-line text-sm text-ink-800">
            {preferences.elements_to_include || "(none)"}
          </p>
        </BriefSection>

        <BriefSection title="Inspiration URLs" className="lg:col-span-2">
          {preferences.inspiration_urls.length === 0 ? (
            <p className="text-xs text-ink-500">None.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {preferences.inspiration_urls.map((url, i) => (
                <li key={`${url}-${i}`}>
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-orange-700 hover:underline"
                  >
                    {url}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </BriefSection>

        <BriefSection title="Inspiration files" className="lg:col-span-2">
          {preferences.inspiration_file_urls.length === 0 ? (
            <p className="text-xs text-ink-500">None.</p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {preferences.inspiration_file_urls.map((f) => (
                <li key={f.id}>
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between gap-2 rounded-lg bg-ink-50 px-3 py-2 text-xs ring-1 ring-ink-200 hover:bg-ink-100"
                  >
                    <span className="truncate font-medium text-ink-1000">
                      {f.original_name}
                    </span>
                    <span className="text-ink-500">
                      {Math.max(1, Math.round(f.size_bytes / 1024))} KB
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </BriefSection>

        <BriefSection
          title="Additional comments"
          className="lg:col-span-2"
        >
          <p className="whitespace-pre-line text-sm text-ink-800">
            {preferences.additional_comments || "(none)"}
          </p>
        </BriefSection>

        <BriefSection title="Declaration" className="lg:col-span-2">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <BriefRow
              label="Signed at"
              value={
                preferences.declaration_signed_at
                  ? new Date(
                      preferences.declaration_signed_at,
                    ).toLocaleString()
                  : ""
              }
            />
            {preferences.declaration_signature_image ? (
              <div className="rounded-lg bg-ink-50 p-3 ring-1 ring-ink-200">
                <img
                  src={preferences.declaration_signature_image}
                  alt="Customer signature"
                  className="mx-auto max-h-24"
                />
              </div>
            ) : null}
          </div>
        </BriefSection>
      </div>
    </article>
  );
}

function BriefSection({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`rounded-2xl bg-ink-0 p-5 ring-1 ring-ink-200 ${className ?? ""}`}
    >
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-700">
        {title}
      </h3>
      {children}
    </section>
  );
}

function BriefRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-xs">
      <span className="font-medium text-ink-500">{label}</span>
      <span className="truncate text-right text-ink-800">{value || "—"}</span>
    </div>
  );
}


function SpecTab({
  orgId,
  labelDesignId,
  sheetId,
  title,
}: {
  orgId: string;
  labelDesignId: string;
  sheetId: string | null;
  title: string;
}) {
  const renderedQuery = useLabelDesignSpec(
    orgId,
    labelDesignId,
    Boolean(sheetId),
  );

  if (!sheetId) {
    return (
      <div className="rounded-2xl bg-ink-0 p-6 ring-1 ring-ink-200">
        <p className="text-sm text-ink-500">
          No specification sheet is attached to this label design yet.
        </p>
      </div>
    );
  }

  return (
    <article className="rounded-2xl bg-ink-0 p-5 shadow-sm ring-1 ring-ink-200">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <FileText className="h-4 w-4 text-orange-600" />
          <h3 className="text-sm font-semibold text-ink-1000">
            {title || "Specification sheet"}
          </h3>
        </div>
      </header>
      <div className="mt-3 h-[70vh] overflow-auto rounded-xl bg-ink-50 py-6 ring-1 ring-inset ring-ink-200 md:h-[780px]">
        {renderedQuery.data ? (
          <SpecSheetContent rendered={renderedQuery.data} />
        ) : renderedQuery.isError ? (
          <div className="flex h-full items-center justify-center text-sm text-ink-500">
            Couldn’t load the spec sheet.
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-ink-500">
            Loading spec sheet…
          </div>
        )}
      </div>
    </article>
  );
}


function ContentBlockTab({
  orgId,
  labelDesignId,
  apiBase,
}: {
  orgId: string;
  labelDesignId: string;
  apiBase: string;
}) {
  const html = useContentBlockHtml(orgId, labelDesignId);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [iframeHeight, setIframeHeight] = useState<number>(600);

  // Auto-expand the iframe to fit its content so the page has a
  // single scroll rather than a nested one. Re-measures on srcDoc
  // change and on window resize so reflow inside the iframe stays
  // honoured.
  const resizeIframe = useCallback(() => {
    const el = iframeRef.current;
    const doc = el?.contentDocument;
    if (!el || !doc) return;
    // Read both — Safari sometimes underreports one of them.
    const next = Math.max(
      doc.documentElement.scrollHeight,
      doc.body?.scrollHeight ?? 0,
    );
    if (next && Math.abs(next - iframeHeight) > 2) {
      setIframeHeight(next);
    }
  }, [iframeHeight]);

  // Per-region rows for the downloads list. ``slug`` matches the
  // backend REGION_SLUGS tuple; an empty slug means "the full
  // 9-panel document". Order mirrors the on-page preview so the
  // download list reads the same as the panels above.
  const regions = [
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

  const [busy, setBusy] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const handleDownload = async (
    region: string,
    fmt: "pdf" | "png",
  ) => {
    if (!iframeRef.current) {
      setDownloadError(
        "Preview hasn't loaded yet — wait a moment and try again.",
      );
      return;
    }
    const key = `${fmt}:${region}`;
    setBusy(key);
    setDownloadError(null);
    try {
      if (fmt === "pdf") {
        await downloadContentBlockPdf(iframeRef.current, labelDesignId, region);
      } else {
        await downloadContentBlockPng(iframeRef.current, labelDesignId, region);
      }
    } catch (err) {
      const msg =
        err instanceof Error && err.message ? err.message : "Download failed";
      setDownloadError(`${fmt.toUpperCase()} download failed — ${msg}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl bg-ink-0 p-4 ring-1 ring-ink-200">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-700">
          Per-region downloads
        </h3>
        <p className="mt-1 text-[11px] text-ink-500">
          Grab the panel that matches the destination market. Rendered straight from the preview &mdash; no server round-trip, instant download.
        </p>
        {downloadError ? (
          <p className="mt-2 rounded-md bg-danger/10 px-3 py-2 text-[11px] text-danger">
            {downloadError}
          </p>
        ) : null}
        <div className="mt-3 divide-y divide-ink-100">
          {regions.map((r) => (
            <div
              key={r.slug}
              className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
            >
              <span className="text-xs font-medium text-ink-1000">{r.label}</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => handleDownload(r.slug, "pdf")}
                  className="inline-flex items-center gap-1 rounded-md bg-ink-1000 px-3 py-1.5 text-xs font-semibold text-ink-0 hover:bg-ink-900 disabled:opacity-50"
                >
                  {busy === `pdf:${r.slug}` ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Download className="h-3 w-3" />
                  )}{" "}
                  <FileText className="h-3 w-3" /> PDF
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => handleDownload(r.slug, "png")}
                  className="inline-flex items-center gap-1 rounded-md bg-ink-0 px-3 py-1.5 text-xs font-semibold ring-1 ring-ink-200 hover:bg-ink-50 disabled:opacity-50"
                >
                  {busy === `png:${r.slug}` ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Download className="h-3 w-3" />
                  )}{" "}
                  <FileImage className="h-3 w-3" /> PNG
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-2xl bg-ink-0 p-4 ring-1 ring-ink-200">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-700">
          Preview · 9 regional panels
        </h3>
        <p className="mt-1 text-[11px] text-ink-500">
          This is exactly what the &ldquo;All 9 panels&rdquo; PDF / PNG download contains.
        </p>
        {html.isLoading ? (
          <p className="mt-3 text-xs text-ink-500">Loading preview…</p>
        ) : html.error ? (
          <p className="mt-3 text-xs text-danger">
            Couldn&rsquo;t render the content block (no spec attached?)
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
            className="mt-3 block w-full overflow-hidden rounded-lg bg-ink-0 ring-1 ring-inset ring-ink-200"
          />
        ) : null}
      </div>
    </div>
  );
}


/** Versions tab — full artwork history with notes, submitter,
 *  thumbnail, and direct PDF download per revision. The data is
 *  already on ``LabelDesignDto.revisions`` (the backend serialises
 *  every ``LabelDesignRevision`` row); the workspace just hadn't
 *  rendered it before, so the team had no visibility into
 *  "revision 1 was X, revision 2 the customer asked us to change Y".
 */
function VersionsTab({
  orgId,
  labelDesignId,
  revisions,
  currentRevisionId,
}: {
  orgId: string;
  labelDesignId: string;
  revisions: LabelDesignDto["revisions"];
  currentRevisionId: string | null;
}) {
  // Reviews are the journey markers that turn the flat list of
  // revisions into a roadmap — scientist verdict, director
  // verdict, customer verdict, with comments. Without these the
  // tab just shows "here are some PDFs" and the operator has to
  // jump to the Reviews tab to reconstruct the story.
  const reviewsQuery = useLabelDesignReviews(orgId, labelDesignId);
  const transitionsQuery = useLabelDesignTransitions(orgId, labelDesignId);

  const reviewsByRevision = useMemo(() => {
    const map = new Map<string, LabelDesignReviewDto[]>();
    for (const r of reviewsQuery.data ?? []) {
      const existing = map.get(r.revision) ?? [];
      existing.push(r);
      map.set(r.revision, existing);
    }
    // Stable order: scientist first, then director — matches the
    // workflow direction so the eye reads top-to-bottom.
    for (const arr of map.values()) {
      arr.sort((a, b) =>
        a.kind === b.kind ? 0 : a.kind === "scientist" ? -1 : 1,
      );
    }
    return map;
  }, [reviewsQuery.data]);

  // Customer verdicts live as ``LabelDesignTransition`` rows
  // (not reviews) — see the portal approve/reject views which
  // tag the transition with ``metadata.revision_id`` so we can
  // pair them back to the right artwork here. We surface them
  // alongside the staff reviews so the journey reads
  // end-to-end: scientist → director → customer.
  const customerEventsByRevision = useMemo(() => {
    const map = new Map<string, LabelDesignTransitionDto[]>();
    for (const t of transitionsQuery.data ?? []) {
      const revisionId =
        typeof t.metadata?.revision_id === "string"
          ? t.metadata.revision_id
          : null;
      if (!revisionId) continue;
      // Only customer-driven transitions belong in the journey
      // here — director/scientist transitions are already
      // covered by the review rows above. ``actor_client_email``
      // is set iff the actor was a ClientAccount (customer).
      if (!t.actor_client_email) continue;
      const existing = map.get(revisionId) ?? [];
      existing.push(t);
      map.set(revisionId, existing);
    }
    return map;
  }, [transitionsQuery.data]);

  if (revisions.length === 0) {
    return (
      <div className="rounded-2xl bg-ink-0 p-6 ring-1 ring-ink-200">
        <p className="text-sm text-ink-500">
          No artwork has been uploaded yet. Versions will appear here as
          each revision lands.
        </p>
      </div>
    );
  }

  // Reverse-chronological — newest first so the active revision sits
  // at the top of the column without scrolling.
  const ordered = [...revisions].sort(
    (a, b) => b.revision_number - a.revision_number,
  );

  return (
    <section className="space-y-3">
      {ordered.map((r) => {
        const isCurrent = r.id === currentRevisionId;
        const submitter =
          r.submitted_by_user_email ||
          r.submitted_by_client_email ||
          (r.source === "customer_upload" ? "Customer" : "Staff");
        const submittedAt = r.submitted_at
          ? new Date(r.submitted_at).toLocaleString()
          : "";
        return (
          <article
            key={r.id}
            className={`rounded-2xl bg-ink-0 p-5 ring-1 ${
              isCurrent
                ? "ring-orange-300 shadow-sm"
                : "ring-ink-200"
            }`}
          >
            <header className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-ink-1000">
                    Revision {r.revision_number}
                  </h3>
                  {isCurrent ? (
                    <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-700">
                      Current
                    </span>
                  ) : null}
                  <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-600">
                    {r.source === "customer_upload"
                      ? "Customer upload"
                      : "Staff upload"}
                  </span>
                  {r.customer_approved_own_design ? (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                      Customer self-approved
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-ink-500">
                  {submitter}
                  {submittedAt ? ` · ${submittedAt}` : ""}
                </p>
              </div>
              {r.artwork_pdf_url ? (
                <a
                  href={r.artwork_pdf_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink-1000 px-3 text-xs font-semibold text-ink-0 hover:bg-ink-900"
                >
                  <Download className="h-3.5 w-3.5" />
                  {isImageArtwork(r.artwork_pdf_url) ? "Image" : "PDF"}
                </a>
              ) : null}
            </header>

            <div className="mt-3 grid gap-3 sm:grid-cols-[200px_1fr]">
              <div className="overflow-hidden rounded-xl bg-ink-50 ring-1 ring-ink-200">
                {/* Prefer the pre-rendered PNG (for PDF uploads),
                    then fall back to the artwork file itself when
                    the upload IS an image (PNG/JPG), and finally
                    render PDFs inline at thumbnail size via
                    PDF.js — same canvas pipeline as the main
                    artwork preview so it works in Brave too. */}
                {r.artwork_preview_png_url ? (
                  <img
                    src={r.artwork_preview_png_url}
                    alt={`Artwork revision ${r.revision_number}`}
                    className="mx-auto max-h-40 object-contain p-2"
                  />
                ) : isImageArtwork(r.artwork_pdf_url) ? (
                  <img
                    src={r.artwork_pdf_url}
                    alt={`Artwork revision ${r.revision_number}`}
                    className="mx-auto max-h-40 object-contain p-2"
                  />
                ) : r.artwork_pdf_url ? (
                  <PdfPreview
                    url={r.artwork_pdf_url}
                    heightClassName="h-40"
                    compact
                  />
                ) : (
                  <div className="flex h-40 items-center justify-center text-[10px] text-ink-500">
                    No preview
                  </div>
                )}
              </div>
              <div className="text-xs text-ink-800">
                <p className="font-semibold uppercase tracking-wide text-ink-500">
                  Notes
                </p>
                <p className="mt-1 whitespace-pre-line">
                  {r.notes || "(no notes)"}
                </p>

                {/* Journey — every verdict written against this
                    revision, in workflow order (scientist →
                    director → customer). Keeps the audit story
                    attached to the artwork it's about so a
                    reviewer doesn't need to cross-reference the
                    Reviews tab. */}
                <RevisionJourney
                  reviews={reviewsByRevision.get(r.id) ?? []}
                  customerEvents={customerEventsByRevision.get(r.id) ?? []}
                />
              </div>
            </div>
          </article>
        );
      })}
    </section>
  );
}


function RevisionJourney({
  reviews,
  customerEvents,
}: {
  reviews: ReadonlyArray<LabelDesignReviewDto>;
  customerEvents: ReadonlyArray<LabelDesignTransitionDto>;
}) {
  // Build a unified, chronologically-ordered journey across two
  // sources: staff ``LabelDesignReview`` rows (scientist /
  // director) and customer ``LabelDesignTransition`` rows
  // (approve / reject from the portal). Each entry carries the
  // shape needed to render a tone, label, actor, time, and
  // optional comment — uniform read regardless of source.
  type JourneyEntry = {
    key: string;
    kind: "scientist" | "director" | "customer";
    approved: boolean;
    actor: string;
    at: string;
    comment: string;
  };

  const entries: JourneyEntry[] = [];
  for (const r of reviews) {
    entries.push({
      key: `r-${r.id}`,
      kind: r.kind,
      approved: r.outcome === "approved",
      actor: r.reviewer_email || "",
      at: r.created_at || "",
      comment: r.final_comments || "",
    });
  }
  for (const t of customerEvents) {
    // ``approved`` derives from the destination status — the
    // portal-approve endpoint transitions to LABEL_APPROVED, the
    // portal-reject endpoint goes back to DESIGN_IN_PROGRESS.
    const approved = t.to_status === "label_approved";
    entries.push({
      key: `t-${t.id}`,
      kind: "customer",
      approved,
      actor: t.actor_client_email || "Customer",
      at: t.created_at || "",
      comment: t.notes || "",
    });
  }
  entries.sort((a, b) => (a.at || "").localeCompare(b.at || ""));

  if (entries.length === 0) {
    return (
      <div className="mt-3 rounded-md bg-ink-50/50 px-2 py-1.5 text-[11px] text-ink-500">
        Not yet reviewed.
      </div>
    );
  }

  const labelFor = (kind: JourneyEntry["kind"], approved: boolean) => {
    if (kind === "customer") return approved ? "Approved" : "Rejected";
    return approved ? "Approved" : "Sent back";
  };

  return (
    <ol className="mt-3 space-y-1.5">
      {entries.map((e) => {
        const tone = e.approved
          ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
          : "bg-rose-50 text-rose-800 ring-rose-200";
        const at = e.at ? new Date(e.at).toLocaleString() : "";
        return (
          <li
            key={e.key}
            className={`rounded-md px-2 py-1.5 text-[11px] ring-1 ring-inset ${tone}`}
          >
            <div className="flex flex-wrap items-center gap-1.5">
              {e.approved ? (
                <CheckCircle2 className="h-3 w-3" />
              ) : (
                <AlertCircle className="h-3 w-3" />
              )}
              <span className="font-semibold uppercase tracking-wide">
                {e.kind}
              </span>
              <span>·</span>
              <span>{labelFor(e.kind, e.approved)}</span>
              {e.actor ? (
                <>
                  <span>·</span>
                  <span className="text-ink-600">{e.actor}</span>
                </>
              ) : null}
              {at ? (
                <>
                  <span>·</span>
                  <span className="text-ink-500">{at}</span>
                </>
              ) : null}
            </div>
            {e.comment ? (
              <p className="mt-1 whitespace-pre-line text-ink-700">
                {e.comment}
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}


function ReviewsTab({
  orgId,
  labelDesignId,
}: {
  orgId: string;
  labelDesignId: string;
}) {
  const reviewsQ = useLabelDesignReviews(orgId, labelDesignId);
  const transitionsQ = useLabelDesignTransitions(orgId, labelDesignId);
  const isLoading = reviewsQ.isLoading || transitionsQ.isLoading;

  // Reviews tab is the verdict log. The natural mental model is
  // "every time someone said yes or no to the artwork" — that's
  // scientist + director (LabelDesignReview rows) AND customer
  // (LabelDesignTransition rows from the portal approve/reject
  // endpoints). Merging both sources here keeps the reviewer's
  // workflow self-contained on this tab; they don't have to
  // jump to the Audit timeline to reconstruct the customer's
  // decision.
  type Entry =
    | {
        kind: "review";
        id: string;
        at: string;
        review: LabelDesignReviewDto;
      }
    | {
        kind: "customer";
        id: string;
        at: string;
        transition: LabelDesignTransitionDto;
      };

  const entries: Entry[] = [];
  for (const r of reviewsQ.data ?? []) {
    entries.push({ kind: "review", id: r.id, at: r.created_at, review: r });
  }
  for (const t of transitionsQ.data ?? []) {
    // Only customer-driven transitions are verdicts; staff
    // transitions are already captured by the review rows.
    if (!t.actor_client_email) continue;
    if (
      t.to_status !== "label_approved" &&
      t.to_status !== "design_in_progress"
    ) {
      continue;
    }
    entries.push({ kind: "customer", id: t.id, at: t.created_at, transition: t });
  }
  entries.sort((a, b) => (b.at || "").localeCompare(a.at || ""));

  return (
    <div className="rounded-2xl bg-ink-0 p-4 ring-1 ring-ink-200">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-700">
        Reviews
      </h3>
      {isLoading ? (
        <p className="mt-3 text-xs text-ink-500">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="mt-3 text-xs text-ink-500">No reviews yet.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {entries.map((e) => {
            if (e.kind === "review") {
              const r = e.review;
              return (
                <li key={e.id} className="rounded bg-ink-50/50 p-2">
                  <p className="text-xs font-semibold text-ink-1000">
                    {r.kind === "scientist" ? "Scientist" : "Director"} ·{" "}
                    <span
                      className={
                        r.outcome === "approved"
                          ? "text-emerald-700"
                          : "text-rose-700"
                      }
                    >
                      {r.outcome === "approved"
                        ? "Approved"
                        : "Requires revisions"}
                    </span>
                  </p>
                  <p className="text-[11px] text-ink-500">
                    {r.reviewer_email} ·{" "}
                    {new Date(r.created_at).toLocaleString()}
                  </p>
                  {r.final_comments ? (
                    <p className="mt-1 whitespace-pre-line text-[11px] text-ink-700">
                      {r.final_comments}
                    </p>
                  ) : null}
                  {r.checklist_responses?.length ? (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[10px] text-ink-500">
                        Checklist ({r.checklist_responses.length} items)
                      </summary>
                      <ul className="mt-1 space-y-0.5 text-[11px]">
                        {r.checklist_responses.map((c, i) => (
                          <li key={`${r.id}-${c.item_key}-${i}`}>
                            {c.pass ? "✓" : "✗"} {c.item_key}
                            {c.comment ? ` — ${c.comment}` : ""}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </li>
              );
            }
            const t = e.transition;
            const approved = t.to_status === "label_approved";
            return (
              <li key={e.id} className="rounded bg-ink-50/50 p-2">
                <p className="text-xs font-semibold text-ink-1000">
                  Customer ·{" "}
                  <span
                    className={
                      approved ? "text-emerald-700" : "text-rose-700"
                    }
                  >
                    {approved ? "Approved" : "Rejected"}
                  </span>
                </p>
                <p className="text-[11px] text-ink-500">
                  {t.actor_client_email || "Customer"} ·{" "}
                  {new Date(t.created_at).toLocaleString()}
                </p>
                {t.notes ? (
                  <p className="mt-1 whitespace-pre-line text-[11px] text-ink-700">
                    {t.notes}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}


function AuditTab({
  orgId,
  labelDesignId,
}: {
  orgId: string;
  labelDesignId: string;
}) {
  const { data, isLoading } = useLabelDesignTransitions(orgId, labelDesignId);
  return (
    <div className="rounded-2xl bg-ink-0 p-4 ring-1 ring-ink-200">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-700">
        Audit timeline
      </h3>
      {isLoading ? (
        <p className="mt-3 text-xs text-ink-500">Loading…</p>
      ) : !data || data.length === 0 ? (
        <p className="mt-3 text-xs text-ink-500">No transitions yet.</p>
      ) : (
        <ol className="mt-3 space-y-2">
          {data.map((row) => (
            <li
              key={row.id}
              className="border-l-2 border-orange-200 pl-3 text-[11px] text-ink-700"
            >
              <p className="font-semibold text-ink-1000">
                {row.from_status || "—"} → {row.to_status}
              </p>
              <p className="text-ink-500">
                {row.actor_email || row.actor_client_email || "system"} ·{" "}
                {new Date(row.created_at).toLocaleString()}
              </p>
              {row.notes ? <p className="text-ink-700">{row.notes}</p> : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}


function HoldButton({
  orgId,
  labelDesignId,
}: {
  orgId: string;
  labelDesignId: string;
}) {
  const hold = useHoldLabelDesign(orgId, labelDesignId);
  return (
    <button
      type="button"
      onClick={() => {
        const notes = window.prompt("Reason for hold (optional):") ?? "";
        hold.mutate(notes);
      }}
      disabled={hold.isPending}
      className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-200 disabled:opacity-50"
    >
      <Clock className="h-3 w-3" /> Put on hold
    </button>
  );
}


function ResumeButton({
  orgId,
  labelDesignId,
}: {
  orgId: string;
  labelDesignId: string;
}) {
  const resume = useResumeLabelDesign(orgId, labelDesignId);
  return (
    <button
      type="button"
      onClick={() => resume.mutate("resumed")}
      disabled={resume.isPending}
      className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-3 py-1.5 text-xs font-semibold text-emerald-900 hover:bg-emerald-200 disabled:opacity-50"
    >
      Resume
    </button>
  );
}
