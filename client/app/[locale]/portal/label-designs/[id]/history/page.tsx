"use client";

import { use } from "react";

import {
  Card,
  Eyebrow,
  PageHeader,
  PortalShell,
} from "@/components/portal/brutalist";
import { usePortalLabelDesign } from "@/services/label-design";


export default function CustomerHistoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data, isLoading } = usePortalLabelDesign(id);

  return (
    <PortalShell active="products">
      <PageHeader
        eyebrow="HISTORY"
        title="Revision history"
        subtitle="Every version of the artwork and what the reviewers said."
      />

      {isLoading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : !data || data.revisions.length === 0 ? (
        <Card>
          <p className="text-sm text-neutral-500">
            No revisions yet. As the artwork moves through the review loop,
            you’ll see each version here.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {[...data.revisions]
            .sort((a, b) => b.revision_number - a.revision_number)
            .map((rev) => (
              <Card key={rev.id}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <Eyebrow>
                      Revision {rev.revision_number}
                    </Eyebrow>
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
                        rev.artwork_pdf_url
                      )
                        ? "Open image"
                        : "Open PDF"}
                    </a>
                  ) : null}
                </div>
              </Card>
            ))}
        </div>
      )}
    </PortalShell>
  );
}
