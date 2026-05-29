"use client";

import { use } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  Copy,
  FileSignature,
  PencilLine,
  UploadCloud,
} from "lucide-react";

import {
  Card,
  Eyebrow,
  PageHeader,
  PortalShell,
} from "@/components/portal/brutalist";
import { LabelDesignChatPanel } from "@/components/portal/label-design-chat-panel";
import { Link } from "@/i18n/navigation";
import { usePortalLabelDesign } from "@/services/label-design";
import type { LabelDesignStatus } from "@/services/label-design/types";


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


const STATUS_LABELS: Record<LabelDesignStatus, string> = {
  payment_pending: "Payment pending",
  label_path_pending: "Choose path",
  design_preferences_pending: "Preferences needed",
  design_in_progress: "Design in progress",
  scientist_review: "Scientist review",
  director_review: "Director review",
  customer_approval: "Your approval needed",
  label_approved: "Approved",
  on_hold: "On hold",
};


export default function PortalLabelDesignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data, isLoading, error } = usePortalLabelDesign(id);

  if (isLoading) {
    return (
      <PortalShell active="products">
        <p className="text-sm text-neutral-500">Loading…</p>
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

  return (
    <PortalShell active="products">
      <PageHeader
        eyebrow={data.formulation_code || "LABEL"}
        title={data.formulation_name || "Label design"}
        subtitle={
          // ``PageHeader`` wraps the subtitle in a ``<p>``, so this
          // node must be a span — a ``<div>`` here triggers a React
          // hydration warning ("div cannot be a descendant of p").
          <span className="mt-2 inline-flex flex-wrap items-center gap-3">
            <StatusBadge status={data.status} />
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

      <div className="mt-4 grid gap-4">
        {data.status === "payment_pending" ? (
          <Card>
            <Eyebrow>NEXT STEP</Eyebrow>
            <h3 className="mt-1 text-lg font-bold">Awaiting payment</h3>
            <p className="mt-1 text-sm text-neutral-600">
              Once our finance team confirms your payment, we’ll unlock the next
              step here.
            </p>
          </Card>
        ) : null}

        {data.status === "label_path_pending" ? (
          <Card>
            <Eyebrow>NEXT STEP</Eyebrow>
            <h3 className="mt-1 text-lg font-bold">Choose your design path</h3>
            <p className="mt-1 text-sm text-neutral-600">
              You can have Vita’s team design the label for you, or design it
              yourself using our spec-derived content block as a starting point.
            </p>
            <Link
              href={`/portal/label-designs/${id}/choose-path`}
              className="mt-4 inline-flex items-center gap-2 border-2 border-black bg-black px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-white hover:bg-neutral-800"
            >
              Choose <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Card>
        ) : null}

        {data.status === "design_preferences_pending" ? (
          <Card>
            <Eyebrow>NEXT STEP</Eyebrow>
            <h3 className="mt-1 text-lg font-bold">Tell us what you want</h3>
            <p className="mt-1 text-sm text-neutral-600">
              Share brand colours, inspiration, and design preferences so our
              team can craft the right look.
            </p>
            <Link
              href={`/portal/label-designs/${id}/preferences`}
              className="mt-4 inline-flex items-center gap-2 border-2 border-black bg-black px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-white hover:bg-neutral-800"
            >
              <PencilLine className="h-3.5 w-3.5" /> Fill in preferences
            </Link>
          </Card>
        ) : null}

        {data.status === "design_in_progress" &&
        data.design_path === "design_by_customer" ? (
          <Card>
            <Eyebrow>NEXT STEP</Eyebrow>
            <h3 className="mt-1 text-lg font-bold">Design your label</h3>
            <p className="mt-1 text-sm text-neutral-600">
              Use the spec-derived content block as a starting point, design in
              your favourite tool, then upload the finished artwork.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                href={`/portal/label-designs/${id}/content-block`}
                className="inline-flex items-center gap-2 border-2 border-black bg-white px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-black hover:bg-neutral-100"
              >
                <Copy className="h-3.5 w-3.5" /> Get content block
              </Link>
              <Link
                href={`/portal/label-designs/${id}/upload`}
                className="inline-flex items-center gap-2 border-2 border-black bg-black px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-white hover:bg-neutral-800"
              >
                <UploadCloud className="h-3.5 w-3.5" /> Upload finished artwork
              </Link>
            </div>
          </Card>
        ) : null}

        {data.status === "design_in_progress" &&
        data.design_path === "design_by_us" ? (
          <Card>
            <Eyebrow>IN PROGRESS</Eyebrow>
            <h3 className="mt-1 text-lg font-bold">Our team is designing</h3>
            <p className="mt-1 text-sm text-neutral-600">
              We’ll share the first draft for your review shortly. Need to tweak
              your brief?
            </p>
            <Link
              href={`/portal/label-designs/${id}/preferences`}
              className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-black underline-offset-4 hover:underline"
            >
              View your preferences
            </Link>
          </Card>
        ) : null}

        {data.status === "scientist_review" || data.status === "director_review" ? (
          <Card>
            <Eyebrow>IN REVIEW</Eyebrow>
            <h3 className="mt-1 text-lg font-bold">
              Our team is reviewing the artwork
            </h3>
            <p className="mt-1 text-sm text-neutral-600">
              {data.status === "scientist_review"
                ? "Our scientist is checking compliance with regulation."
                : "Our director is doing the final sign-off."}
            </p>
          </Card>
        ) : null}

        {data.status === "customer_approval" ? (
          <Card>
            <Eyebrow>YOUR TURN</Eyebrow>
            <h3 className="mt-1 text-lg font-bold">Approve the artwork</h3>
            <p className="mt-1 text-sm text-neutral-600">
              Our team has approved the design internally. Review the artwork
              and sign off, or request changes.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                href={`/portal/label-designs/${id}/approve`}
                className="inline-flex items-center gap-2 border-2 border-black bg-black px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-white hover:bg-neutral-800"
              >
                <FileSignature className="h-3.5 w-3.5" /> Approve & sign
              </Link>
              <Link
                href={`/portal/label-designs/${id}/reject`}
                className="inline-flex items-center gap-2 border-2 border-black bg-white px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-black hover:bg-neutral-100"
              >
                Request changes
              </Link>
            </div>
          </Card>
        ) : null}

        {data.status === "label_approved" ? (
          <Card>
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-6 w-6 text-emerald-600" />
              <div>
                <h3 className="text-lg font-bold">Your label is approved</h3>
                <p className="text-sm text-neutral-600">
                  We’ll be in touch with the next steps for production.
                </p>
              </div>
            </div>
          </Card>
        ) : null}

        {data.status === "on_hold" ? (
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
                {data.hold_started_at ? (
                  <p className="mt-2 text-xs text-neutral-500">
                    Paused {new Date(data.hold_started_at).toLocaleDateString()}
                  </p>
                ) : null}
              </div>
            </div>
          </Card>
        ) : null}

        {/* Always-available links. The content block is gated behind
            payment + design path: it's only meaningful once the
            customer has paid AND chosen to design the label
            themselves. Hiding it here keeps the surface in sync with
            the server-side gate in
            ``apps/client_portal/api/label_design_views.py``. */}
        <Card>
          <Eyebrow>QUICK ACCESS</Eyebrow>
          <div className="mt-3 flex flex-wrap gap-2">
            {data.status !== "payment_pending" &&
            data.design_path === "design_by_customer" ? (
              <Link
                href={`/portal/label-designs/${id}/content-block`}
                className="inline-flex items-center gap-2 border-2 border-black bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-[0.18em] text-black hover:bg-neutral-100"
              >
                <Copy className="h-3.5 w-3.5" /> Content block
              </Link>
            ) : null}
            <Link
              href={`/portal/label-designs/${id}/history`}
              className="inline-flex items-center gap-2 border-2 border-black bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-[0.18em] text-black hover:bg-neutral-100"
            >
              History
            </Link>
          </div>
        </Card>

        {/* Customer chat with the Vita team about this label.
            Backed by the SHARED comments thread the staff
            labelling workspace also surfaces. Internal staff
            chatter (visibility=internal) never appears here. */}
        <LabelDesignChatPanel
          labelDesignId={id}
          designLabel={data.formulation_code || "this label"}
        />
      </div>
    </PortalShell>
  );
}
