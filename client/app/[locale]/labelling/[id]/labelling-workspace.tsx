"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  Clock,
  Copy,
  Download,
  FileImage,
  FileText,
  Loader2,
  Palette,
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
import type { LabelDesignStatus } from "@/services/label-design/types";

import { SpecSheetContent } from "../../specifications/[id]/specification-sheet-view";
import { CHECKLIST_ITEMS, CHECKLIST_SECTIONS } from "./compliance-checklist";


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

type Tab = "artwork" | "content" | "spec" | "reviews" | "audit";


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
            { key: "spec", label: "Spec" },
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

      {tab === "spec" ? (
        <SpecTab
          orgId={orgId}
          labelDesignId={labelDesignId}
          sheetId={data.specification_sheet}
          title={data.formulation_name || ""}
        />
      ) : null}

      {tab === "reviews" ? (
        <ReviewsTab orgId={orgId} labelDesignId={labelDesignId} />
      ) : null}

      {tab === "audit" ? (
        <AuditTab orgId={orgId} labelDesignId={labelDesignId} />
      ) : null}
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
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <div className="rounded-2xl bg-ink-0 p-3 ring-1 ring-ink-200">
          {artworkPdfUrl ? (
            <object
              data={artworkPdfUrl}
              type="application/pdf"
              className="h-[640px] w-full"
            >
              <p className="p-4 text-sm text-ink-500">
                Your browser can’t preview PDFs inline.{" "}
                <a href={artworkPdfUrl} className="underline" target="_blank" rel="noopener noreferrer">
                  Open in a new tab
                </a>
                .
              </p>
            </object>
          ) : (
            <div className="flex h-[640px] items-center justify-center text-sm text-ink-500">
              No artwork uploaded yet.
            </div>
          )}
        </div>
      </div>
      <div className="space-y-3">
        {canDesign && (status === "design_in_progress" || status === "label_path_pending") ? (
          <UploadCard orgId={orgId} labelDesignId={labelDesignId} onMutate={onMutate} />
        ) : null}
        {canDesign && status === "design_in_progress" ? (
          <SubmitForReviewCard orgId={orgId} labelDesignId={labelDesignId} onMutate={onMutate} />
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
          <div className="rounded-2xl bg-ink-0 p-3 ring-1 ring-ink-200">
            <p className="text-xs text-ink-500">
              Awaiting the customer’s sign-off on the portal.
            </p>
          </div>
        ) : null}
        {status === "label_approved" ? (
          <div className="rounded-2xl bg-emerald-50 p-3 ring-1 ring-emerald-200">
            <p className="text-xs font-semibold text-emerald-900">
              Label approved. Ready for production.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
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

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!file) {
      setErr("Pick a file first.");
      return;
    }
    try {
      await upload.mutateAsync({ artwork: file, notes });
      setFile(null);
      setNotes("");
      onMutate();
    } catch (e) {
      setErr(
        (e as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Upload failed.",
      );
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-2xl bg-ink-0 p-3 ring-1 ring-ink-200"
    >
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-700">
        Upload artwork
      </h3>
      <input
        type="file"
        accept="application/pdf,image/png,image/jpeg"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="mt-2 block w-full text-xs"
      />
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes (optional)"
        rows={2}
        className="mt-2 w-full rounded border border-ink-200 px-2 py-1 text-xs"
      />
      {err ? <p className="mt-2 text-xs text-danger">{err}</p> : null}
      <button
        type="submit"
        disabled={upload.isPending}
        className="mt-2 inline-flex items-center gap-1 rounded-md bg-ink-1000 px-3 py-1.5 text-xs font-semibold text-ink-0 hover:bg-ink-900 disabled:opacity-50"
      >
        <UploadCloud className="h-3 w-3" />
        {upload.isPending ? "Uploading…" : "Upload"}
      </button>
    </form>
  );
}


function SubmitForReviewCard({
  orgId,
  labelDesignId,
  onMutate,
}: {
  orgId: string;
  labelDesignId: string;
  onMutate: () => void;
}) {
  const submit = useSubmitLabelForReview(orgId, labelDesignId);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="rounded-2xl bg-ink-0 p-3 ring-1 ring-ink-200">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-700">
        Send for scientist review
      </h3>
      <p className="mt-1 text-[11px] text-ink-500">
        Make sure the latest revision is uploaded. The scientist will get the
        compliance checklist.
      </p>
      {err ? <p className="mt-2 text-xs text-danger">{err}</p> : null}
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
        disabled={submit.isPending}
        className="mt-2 inline-flex items-center gap-1 rounded-md bg-orange-600 px-3 py-1.5 text-xs font-semibold text-ink-0 hover:bg-orange-700 disabled:opacity-50"
      >
        {submit.isPending ? "Sending…" : "Send for review"}
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
  const handleDownload = async (
    region: string,
    fmt: "pdf" | "png",
  ) => {
    const key = `${fmt}:${region}`;
    setBusy(key);
    try {
      if (fmt === "pdf") {
        await downloadContentBlockPdf(orgId, labelDesignId, region);
      } else {
        await downloadContentBlockPng(orgId, labelDesignId, region);
      }
    } catch {
      // Fall through — the user will see no file; surfacing axios
      // detail noise here would be more confusing than helpful.
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
          Grab the panel that matches the destination market. PDF stays sharp in any tool; PNG is for image-only paste targets.
        </p>
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
