"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommentsPanel } from "@/components/comments";
import { useCurrentUser } from "@/services/accounts";

import { LabellingCommentsBubble } from "./labelling-comments-bubble";

import {
  AlertCircle,
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
  LabelDesignStatus,
} from "@/services/label-design/types";

import { SpecSheetContent } from "../../specifications/[id]/specification-sheet-view";
import { CHECKLIST_ITEMS, CHECKLIST_SECTIONS } from "./compliance-checklist";


// Artwork uploads accept .pdf, .png, .jpg, .jpeg — the FE has to
// pick the right inline renderer based on the file the customer
// or designer actually sent. URL-extension sniff is enough since
// the backend's ``_safe_extension`` normalises the suffix at
// save-time (see ``apps/label_design/models.py``).
function isImageArtwork(url: string): boolean {
  if (!url) return false;
  const path = url.split("?")[0].split("#")[0].toLowerCase();
  return /\.(png|jpe?g|gif|webp|avif)$/.test(path);
}

function isPdfArtwork(url: string): boolean {
  if (!url) return false;
  const path = url.split("?")[0].split("#")[0].toLowerCase();
  return path.endsWith(".pdf");
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
          </h1>
          <p className="text-xs text-ink-500">{STATUS_LABELS[data.status]}</p>
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


function ArtworkTab({
  orgId,
  labelDesignId,
  status,
  designPath,
  artworkPdfUrl,
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
  canDesign: boolean;
  canReviewScientist: boolean;
  canReviewDirector: boolean;
  onMutate: () => void;
}) {
  const presentation = STATUS_PRESENTATION[status] ?? STATUS_PRESENTATION.design_in_progress;
  const StatusIcon = presentation.icon;
  const toneClass =
    STATUS_TONE_CLASS[presentation.tone] ?? STATUS_TONE_CLASS.neutral;

  const showUpload =
    canDesign &&
    (status === "design_in_progress" || status === "label_path_pending");
  const showSubmit = canDesign && status === "design_in_progress";

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
              <div className="flex h-[680px] w-full items-center justify-center bg-ink-50 p-4">
                <img
                  src={artworkPdfUrl}
                  alt="Current artwork"
                  className="max-h-full max-w-full object-contain"
                />
              </div>
            ) : isPdfArtwork(artworkPdfUrl) ? (
              <object
                data={artworkPdfUrl}
                type="application/pdf"
                className="block h-[680px] w-full bg-ink-50"
              >
                <p className="p-4 text-sm text-ink-500">
                  Your browser can&rsquo;t preview PDFs inline.{" "}
                  <a
                    href={artworkPdfUrl}
                    className="underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open in a new tab
                  </a>
                  .
                </p>
              </object>
            ) : (
              // Unknown file type — give a clear opt-in to open
              // externally rather than guessing wrong.
              <div className="flex h-[680px] flex-col items-center justify-center gap-3 bg-ink-50 px-6 text-center">
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
            <div className="flex h-[680px] flex-col items-center justify-center gap-3 bg-gradient-to-b from-ink-50 to-ink-0 px-6 text-center">
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
        </article>

        {/* Sidebar — context-driven action cards. Only the cards
            that match the current status + the caller's caps render,
            so the column never shows an action the user can't take. */}
        <aside className="space-y-3">
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
              onMutate={onMutate}
            />
          ) : null}
          {canReviewScientist && status === "scientist_review" ? (
            <ReviewForm
              kind="scientist"
              orgId={orgId}
              labelDesignId={labelDesignId}
              onMutate={onMutate}
            />
          ) : null}
          {canReviewDirector && status === "director_review" ? (
            <ReviewForm
              kind="director"
              orgId={orgId}
              labelDesignId={labelDesignId}
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
          {!showUpload && !showSubmit && status !== "customer_approval" && status !== "label_approved" ? (
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
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const pickFile = (candidate: File | null) => {
    setErr(null);
    if (!candidate) {
      setFile(null);
      return;
    }
    const reason = _validateArtworkClient(candidate);
    if (reason) {
      setErr(reason);
      setFile(null);
      return;
    }
    setFile(candidate);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!file) {
      setErr("Drop a file or click to choose one first.");
      return;
    }
    try {
      await upload.mutateAsync({ artwork: file, notes });
      setFile(null);
      setNotes("");
      onMutate();
    } catch (e) {
      // Surface the backend's structured rejection (size / type
      // / extension) when present — much friendlier than the
      // generic "Upload failed".
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
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) pickFile(dropped);
  };

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
          <p className="text-[10px] text-ink-500">PDF, PNG, JPEG · up to 50 MB</p>
        </div>
      </div>

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`mt-3 flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors ${
          dragOver
            ? "border-orange-400 bg-orange-50"
            : file
              ? "border-emerald-300 bg-emerald-50/50"
              : "border-ink-200 bg-ink-50 hover:border-orange-300 hover:bg-orange-50/40"
        }`}
      >
        {file ? (
          <>
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-100 ring-1 ring-inset ring-emerald-200">
              <Check className="h-4 w-4 text-emerald-700" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold text-ink-1000">
                {file.name}
              </p>
              <p className="text-[10px] text-ink-500">
                {_humanFileSize(file.size)}
              </p>
            </div>
            <span className="text-[10px] text-ink-500 underline-offset-2 hover:underline">
              Replace
            </span>
          </>
        ) : (
          <>
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-ink-0 ring-1 ring-inset ring-ink-200">
              <UploadCloud className="h-4 w-4 text-ink-500" />
            </span>
            <div>
              <p className="text-xs font-semibold text-ink-1000">
                Drop your file here
              </p>
              <p className="text-[10px] text-ink-500">
                or click to browse
              </p>
            </div>
          </>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,image/png,image/jpeg"
        onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
        className="hidden"
      />

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
        disabled={upload.isPending || !file}
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
            Upload revision
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
  onMutate,
}: {
  orgId: string;
  labelDesignId: string;
  hasArtwork: boolean;
  onMutate: () => void;
}) {
  const submit = useSubmitLabelForReview(orgId, labelDesignId);
  const [err, setErr] = useState<string | null>(null);
  // Gate the submit on an actual artwork upload — the backend will
  // reject ``submit-for-review`` with ``no_revision`` if there's
  // no current revision, but disabling the button up-front is
  // friendlier than letting the user click and read a server error.
  const disabled = submit.isPending || !hasArtwork;
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

  const [responses, setResponses] = useState<Record<string, { pass: boolean; comment: string }>>(
    () =>
      Object.fromEntries(
        CHECKLIST_ITEMS.map((item) => [item.key, { pass: true, comment: "" }]),
      ),
  );
  const [finalComments, setFinalComments] = useState("");
  const [outcome, setOutcome] = useState<"approved" | "requires_revision">(
    "approved",
  );
  const [signature, setSignature] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!finalComments.trim()) {
      setErr("Final comments are required (regulatory).");
      return;
    }
    try {
      const body = {
        outcome,
        checklist: CHECKLIST_ITEMS.map((item) => ({
          item_key: item.key,
          pass_check: responses[item.key]?.pass ?? true,
          comment: responses[item.key]?.comment ?? "",
        })),
        final_comments: finalComments,
        signature_image: signature,
      };
      await mutation.mutateAsync(body);
      onMutate();
    } catch (e) {
      setErr(
        (e as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Submission failed.",
      );
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-2xl bg-ink-0 p-3 ring-1 ring-ink-200"
    >
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-700">
        {kind === "scientist" ? "Scientist review" : "Director review"}
      </h3>

      <div className="mt-2 max-h-[420px] overflow-y-auto pr-1">
        {CHECKLIST_SECTIONS.map((section) => {
          const items = CHECKLIST_ITEMS.filter((i) => i.section === section.key);
          if (items.length === 0) return null;
          return (
            <details
              key={section.key}
              open
              className="mb-2 border-t border-ink-100 pt-2 first:border-t-0 first:pt-0"
            >
              <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wide text-ink-500">
                {section.label}
              </summary>
              <ul className="mt-2 space-y-1.5">
                {items.map((item) => {
                  const res = responses[item.key];
                  return (
                    <li key={item.key} className="rounded bg-ink-50/50 px-2 py-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-[11px] text-ink-1000">{item.label}</span>
                        <select
                          value={res?.pass ? "yes" : "no"}
                          onChange={(e) =>
                            setResponses({
                              ...responses,
                              [item.key]: {
                                pass: e.target.value === "yes",
                                comment: res?.comment ?? "",
                              },
                            })
                          }
                          className="shrink-0 rounded border border-ink-200 px-1 py-0.5 text-[11px]"
                        >
                          <option value="yes">Pass</option>
                          <option value="no">Fail</option>
                        </select>
                      </div>
                      <input
                        type="text"
                        placeholder="Comment (optional)"
                        value={res?.comment ?? ""}
                        onChange={(e) =>
                          setResponses({
                            ...responses,
                            [item.key]: {
                              pass: res?.pass ?? true,
                              comment: e.target.value,
                            },
                          })
                        }
                        className="mt-1 w-full rounded border border-ink-200 px-1.5 py-0.5 text-[11px]"
                      />
                    </li>
                  );
                })}
              </ul>
            </details>
          );
        })}
      </div>

      <label className="mt-2 block text-[10px] font-semibold uppercase tracking-wide text-ink-700">
        Final comments (required)
      </label>
      <textarea
        value={finalComments}
        onChange={(e) => setFinalComments(e.target.value)}
        rows={3}
        className="mt-1 w-full rounded border border-ink-200 px-2 py-1 text-xs"
      />

      <label className="mt-2 block text-[10px] font-semibold uppercase tracking-wide text-ink-700">
        Sign (type your name)
      </label>
      <input
        value={signature}
        onChange={(e) => setSignature(e.target.value)}
        className="mt-1 w-full rounded border border-ink-200 px-2 py-1 font-mono text-xs"
      />

      <div className="mt-2 flex items-center gap-2">
        <select
          value={outcome}
          onChange={(e) =>
            setOutcome(e.target.value as "approved" | "requires_revision")
          }
          className="rounded border border-ink-200 px-2 py-1.5 text-xs"
        >
          <option value="approved">Approve</option>
          <option value="requires_revision">Request revisions</option>
        </select>
        <button
          type="submit"
          disabled={mutation.isPending}
          className="rounded-md bg-ink-1000 px-3 py-1.5 text-xs font-semibold text-ink-0 hover:bg-ink-900 disabled:opacity-50"
        >
          {mutation.isPending ? "Submitting…" : "Submit review"}
        </button>
      </div>
      {err ? <p className="mt-2 text-xs text-danger">{err}</p> : null}
    </form>
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
  revisions,
  currentRevisionId,
}: {
  revisions: LabelDesignDto["revisions"];
  currentRevisionId: string | null;
}) {
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

            <div className="mt-3 grid gap-3 sm:grid-cols-[160px_1fr]">
              <div className="rounded-xl bg-ink-50 p-2 ring-1 ring-ink-200">
                {/* Prefer the pre-rendered PNG (for PDF uploads),
                    fall back to the artwork file itself when the
                    upload IS an image (PNG/JPG), and only show "no
                    preview" if neither is usable (e.g. PDF with no
                    preview generator run yet). */}
                {r.artwork_preview_png_url ? (
                  <img
                    src={r.artwork_preview_png_url}
                    alt={`Artwork revision ${r.revision_number}`}
                    className="mx-auto max-h-32 object-contain"
                  />
                ) : isImageArtwork(r.artwork_pdf_url) ? (
                  <img
                    src={r.artwork_pdf_url}
                    alt={`Artwork revision ${r.revision_number}`}
                    className="mx-auto max-h-32 object-contain"
                  />
                ) : r.artwork_pdf_url ? (
                  <div className="flex h-32 flex-col items-center justify-center gap-1 text-[10px] text-ink-500">
                    <FileText className="h-5 w-5 text-ink-400" />
                    PDF
                  </div>
                ) : (
                  <div className="flex h-32 items-center justify-center text-[10px] text-ink-500">
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
              </div>
            </div>
          </article>
        );
      })}
    </section>
  );
}


function ReviewsTab({
  orgId,
  labelDesignId,
}: {
  orgId: string;
  labelDesignId: string;
}) {
  const { data, isLoading } = useLabelDesignReviews(orgId, labelDesignId);
  return (
    <div className="rounded-2xl bg-ink-0 p-4 ring-1 ring-ink-200">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-700">
        Reviews
      </h3>
      {isLoading ? (
        <p className="mt-3 text-xs text-ink-500">Loading…</p>
      ) : !data || data.length === 0 ? (
        <p className="mt-3 text-xs text-ink-500">No reviews yet.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {data.map((r) => (
            <li key={r.id} className="rounded bg-ink-50/50 p-2">
              <p className="text-xs font-semibold text-ink-1000">
                {r.kind === "scientist" ? "Scientist" : "Director"} ·{" "}
                <span
                  className={
                    r.outcome === "approved"
                      ? "text-emerald-700"
                      : "text-rose-700"
                  }
                >
                  {r.outcome === "approved" ? "Approved" : "Requires revisions"}
                </span>
              </p>
              <p className="text-[11px] text-ink-500">
                {r.reviewer_email} · {new Date(r.created_at).toLocaleString()}
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
          ))}
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
