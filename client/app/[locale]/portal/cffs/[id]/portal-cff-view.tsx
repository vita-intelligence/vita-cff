"use client";

/**
 * Brutalist customer-portal CFF detail view.
 *
 * Layout — header strip, customer responses (full width, brutalist
 * description list), then the conversation panel at the bottom.
 * Deliberately simpler than the staff equivalent at
 * ``/cff/[id]``: the customer doesn't need a sticky dock or quick-
 * contact strip — they're re-reading their own answers, not
 * triaging.
 *
 * The raw_payload rendering uses heuristic-derived labels (Wix
 * doesn't ship field labels in the payload itself); slugs are
 * humanised by stripping the trailing 4-char hash Wix appends and
 * replacing underscores with spaces.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import {
  Card,
  ErrorBanner,
  Eyebrow,
  PageHeader,
  StatusPill,
} from "@/components/portal/brutalist";
import { CFFChatPanel } from "@/components/portal/cff-chat-panel";
import { fetchCFF, type PortalCFFDetail } from "@/services/portal/api";
import { portalErrorMessage } from "@/services/portal/errors";


interface FileEntry {
  readonly displayName?: string;
  readonly fileId?: string;
  readonly url?: string | null;
  readonly fileType?: string;
}


export function PortalCFFView({ submissionId }: { submissionId: string }) {
  const [cff, setCff] = useState<PortalCFFDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const fresh = await fetchCFF(submissionId);
      setCff(fresh);
      setLoadError(null);
    } catch (err: unknown) {
      setLoadError(portalErrorMessage(err));
    }
  }, [submissionId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loadError) {
    return (
      <Card>
        <ErrorBanner>{loadError}</ErrorBanner>
        <Link
          href="/portal/cffs"
          className="text-xs font-bold uppercase tracking-widest underline"
        >
          ← Back to requests
        </Link>
      </Card>
    );
  }

  if (!cff) {
    return (
      <p className="text-center text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-600">
        Loading request…
      </p>
    );
  }

  const submissions = readSubmissions(cff.raw_payload);
  const entries = Object.entries(submissions).filter(
    ([, value]) => !isEmpty(value),
  );

  const submittedAt = new Date(cff.submitted_at);
  const submittedLabel = Number.isNaN(submittedAt.getTime())
    ? "—"
    : submittedAt.toLocaleString();

  const referenceLabel = cff.project_code
    ? `Request · ${cff.project_code}`
    : `Request · ${cff.id.slice(0, 8)}`;

  // Chip prefers the derived lifecycle over the raw Wix status —
  // "Under review" reads cleanly for a customer whereas "Confirmed"
  // (Wix's word for "the form landed on our servers") does not.
  const chipStatus = cff.lifecycle_state || cff.status;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow={referenceLabel}
        title={cff.summary || "Custom formulation request"}
        subtitle={
          cff.provenance === "portal"
            ? `Submitted via portal · ${submittedLabel}`
            : `Submitted ${submittedLabel}`
        }
        back={{ href: "/portal/cffs", label: "Requests" }}
        actions={<StatusPill status={chipStatus} />}
      />

      {/* Rejection banner — the customer needs to see the outcome + the
          reason without hunting for it. Kept above the responses so it's
          the first thing on the page after the header. */}
      {cff.is_rejected ? (
        <Card className="!border-red-700 !bg-red-50">
          <div className="flex flex-col gap-3">
            <span className="text-[11px] font-bold uppercase tracking-widest text-red-800">
              We're not proceeding with this request
            </span>
            {cff.rejection_reason ? (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-black">
                {cff.rejection_reason}
              </p>
            ) : (
              <p className="text-sm text-neutral-700">
                Reach out to your account manager for details on why we&apos;re
                not moving ahead with this one.
              </p>
            )}
          </div>
        </Card>
      ) : null}

      {/* Project-created banner — same treatment on the positive side.
          Points at the eventual project record so the customer can hop
          straight into the workspace once we've spun it up. */}
      {cff.has_project && cff.project_code ? (
        <Card>
          <div className="flex flex-col gap-2">
            <Eyebrow>Project created</Eyebrow>
            <p className="text-sm text-neutral-800">
              We've set up a workspace for this request as{" "}
              <span className="font-bold uppercase tracking-wide">
                {cff.project_code}
              </span>
              . Everything you and our team do from here on lives on the
              project page.
            </p>
          </div>
        </Card>
      ) : null}

      <Card>
        <header className="mb-4 flex items-center justify-between border-b-2 border-black pb-3">
          <Eyebrow>Your responses</Eyebrow>
        </header>
        {entries.length === 0 ? (
          <p className="text-sm text-neutral-700">
            No structured responses captured for this submission.
          </p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-[240px_minmax(0,1fr)]">
            {entries.map(([slug, value]) => (
              <ResponseRow key={slug} slug={slug} value={value} />
            ))}
          </dl>
        )}
      </Card>

      <CFFChatPanel
        submissionId={cff.id}
        submissionLabel={cff.project_code || cff.id.slice(0, 8)}
      />
    </div>
  );
}


function ResponseRow({ slug, value }: { slug: string; value: unknown }) {
  return (
    <>
      <dt
        className="text-[10px] font-bold uppercase tracking-[0.2em] text-neutral-600"
        title={slug}
      >
        {humanise(slug)}
      </dt>
      <dd className="text-sm text-black">{renderValue(value)}</dd>
    </>
  );
}


function renderValue(value: unknown): React.ReactNode {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") {
    if (value.includes("\n")) {
      return <span className="whitespace-pre-line">{value}</span>;
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    if (value.every((v) => typeof v === "string")) {
      return (value as string[]).join(", ");
    }
    if (value.every(isFileEntry)) {
      return (
        <ul className="flex flex-col gap-2">
          {(value as FileEntry[]).map((file, i) => (
            <li key={file.fileId ?? `${file.displayName ?? "file"}-${i}`}>
              <FileEntryRow file={file} />
            </li>
          ))}
        </ul>
      );
    }
    return (
      <span className="font-mono text-xs text-neutral-700">
        {JSON.stringify(value)}
      </span>
    );
  }
  if (typeof value === "object") {
    const parts = Object.values(value as Record<string, unknown>)
      .filter((v) => typeof v === "string" && v.trim())
      .join(", ");
    if (parts) return parts;
    return (
      <span className="font-mono text-xs text-neutral-700">
        {JSON.stringify(value)}
      </span>
    );
  }
  return String(value);
}


function FileEntryRow({ file }: { file: FileEntry }) {
  const label = file.displayName || file.fileId || "Untitled file";
  const hasUrl = Boolean(file.url);
  const meta = file.fileType ?? "";

  const inner = (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate text-sm font-bold uppercase tracking-tight">
        {label}
      </span>
      <span className="text-[10px] uppercase tracking-widest text-neutral-600">
        {meta}
        {meta && hasUrl ? " · " : ""}
        {hasUrl ? "Open" : "Stored on Wix — no direct link"}
      </span>
    </span>
  );

  if (hasUrl) {
    return (
      <a
        href={file.url as string}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-3 border-2 border-black bg-white p-3 hover:bg-paper"
      >
        {inner}
      </a>
    );
  }
  return (
    <span className="flex items-center gap-3 border-2 border-dashed border-black p-3">
      {inner}
    </span>
  );
}


function isFileEntry(v: unknown): v is FileEntry {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return "displayName" in o || "fileId" in o || "fileType" in o;
}


function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isEmpty);
  }
  return false;
}


function humanise(slug: string): string {
  const stripped = slug.replace(/_[a-z0-9]{4}$/, "").replace(/_/g, " ");
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}


function readSubmissions(
  raw: PortalCFFDetail["raw_payload"],
): Record<string, unknown> {
  const submissions = raw?.submissions;
  if (submissions && typeof submissions === "object" && !Array.isArray(submissions)) {
    return submissions as Record<string, unknown>;
  }
  return {};
}
