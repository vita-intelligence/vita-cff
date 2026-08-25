"use client";

import { use, useState } from "react";

import {
  Card,
  Eyebrow,
  PageHeader,
  PortalShell,
} from "@/components/portal/brutalist";
import { useRouter } from "@/i18n/navigation";
import { usePortalLabelDesign, usePortalReject } from "@/services/label-design";


export default function CustomerRejectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const reject = usePortalReject(id);
  // Fetch the label so the back link routes to the parent project.
  // Falls back to /portal/products while the query is in flight so
  // the arrow never points at a dead URL.
  const ld = usePortalLabelDesign(id);
  const projectHref = ld.data?.formulation
    ? `/portal/products/${ld.data.formulation}`
    : "/portal/products";

  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await reject.mutateAsync(reason);
      router.replace(`/portal/label-designs/${id}`);
    } catch (e) {
      const detail =
        (e as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail || "Could not submit your request.";
      setError(detail);
    }
  };

  return (
    <PortalShell active="products">
      <PageHeader
        eyebrow="REQUEST CHANGES"
        title="Tell us what to fix"
        subtitle="Our team will revise the artwork and re-submit it for your approval."
        back={{ href: projectHref, label: "Back to project" }}
      />
      <form onSubmit={onSubmit} className="space-y-4">
        <Card>
          <label className="text-xs font-bold uppercase tracking-[0.15em] text-neutral-700">
            What needs to change?
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={6}
            placeholder="Be as specific as you can — colours, copy, layout, icons…"
            className="mt-2 w-full border-2 border-black px-2 py-1.5 text-sm"
          />
        </Card>
        {error ? (
          <p className="text-sm text-red-700">{error}</p>
        ) : null}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={reject.isPending}
            className="border-2 border-black bg-black px-5 py-2 text-sm font-bold uppercase tracking-[0.18em] text-white hover:bg-neutral-800 disabled:opacity-50"
          >
            {reject.isPending ? "Sending…" : "Request changes"}
          </button>
        </div>
      </form>
    </PortalShell>
  );
}
