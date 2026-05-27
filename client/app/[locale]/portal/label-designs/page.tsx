"use client";

import { ChevronRight, Tag } from "lucide-react";

import {
  Card,
  Eyebrow,
  PageHeader,
  PortalShell,
} from "@/components/portal/brutalist";
import { Link } from "@/i18n/navigation";
import {
  usePortalLabelDesigns,
} from "@/services/label-design";
import type {
  LabelDesignDto,
  LabelDesignStatus,
} from "@/services/label-design/types";


const STATUS_LABELS: Record<LabelDesignStatus, string> = {
  payment_pending: "Awaiting payment",
  label_path_pending: "Choose design path",
  design_preferences_pending: "Design preferences needed",
  design_in_progress: "Design in progress",
  scientist_review: "In scientist review",
  director_review: "In director review",
  customer_approval: "Awaiting your approval",
  label_approved: "Approved",
  on_hold: "On hold",
};


function nextActionFor(item: LabelDesignDto): string | null {
  switch (item.status) {
    case "label_path_pending":
      return "Choose how the label will be designed";
    case "design_preferences_pending":
      return "Tell us what you want";
    case "customer_approval":
      return "Approve the design";
    default:
      return null;
  }
}


export default function PortalLabelDesignsPage() {
  const { data, isLoading, error } = usePortalLabelDesigns();

  return (
    <PortalShell active="products">
      <PageHeader
        eyebrow="LABELS"
        title="Label design"
        subtitle="Track your label artwork from payment through final approval."
      />

      {isLoading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : error ? (
        <p className="text-sm text-red-700">Couldn’t load your labels.</p>
      ) : !data || data.length === 0 ? (
        <Card>
          <Eyebrow>Nothing here yet</Eyebrow>
          <p className="mt-2 text-sm text-neutral-600">
            Once your spec sheet is signed and payment is recorded, your label
            workflow will appear here.
          </p>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {data.map((item) => {
            const action = nextActionFor(item);
            return (
              <Link
                key={item.id}
                href={`/portal/label-designs/${item.id}`}
                className="group block"
              >
                <Card>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <Eyebrow>
                        <Tag className="mr-1 inline h-3 w-3" />
                        {item.formulation_code || "Project"}
                      </Eyebrow>
                      <h2 className="mt-1 text-lg font-bold leading-tight text-black">
                        {item.formulation_name || "Untitled project"}
                      </h2>
                      <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.15em] text-neutral-500">
                        {STATUS_LABELS[item.status]}
                      </p>
                      {action ? (
                        <p className="mt-3 text-sm font-semibold text-black">
                          {action} →
                        </p>
                      ) : null}
                    </div>
                    <ChevronRight className="h-5 w-5 shrink-0 text-neutral-400 transition-transform group-hover:translate-x-0.5" />
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </PortalShell>
  );
}
