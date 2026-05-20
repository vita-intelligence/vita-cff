"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Card,
  ErrorBanner,
  H1,
  P,
  PortalButton,
  PortalTextarea,
} from "@/components/portal/brutalist";
import { rejectProposal } from "@/services/portal/api";


export function ProposalRejectForm({ proposalId }: { proposalId: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await rejectProposal(proposalId, reason);
      router.push(`/portal/proposals/${proposalId}`);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { code?: string } } };
      if (e.response?.data?.code === "invalid_proposal_transition") {
        setError("This proposal can no longer be rejected.");
      } else {
        setError("Something went wrong. Try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="max-w-2xl">
      <H1>Decline this proposal</H1>
      <P>
        Tell us briefly why you are declining. This goes straight to the
        Vita sales team.
      </P>
      <ErrorBanner>{error}</ErrorBanner>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <PortalTextarea
          name="reason"
          label="Reason (optional)"
          rows={6}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <div className="flex gap-3">
          <PortalButton type="submit" disabled={submitting}>
            {submitting ? "Sending…" : "Decline proposal"}
          </PortalButton>
          <PortalButton
            type="button"
            variant="secondary"
            onClick={() => router.push(`/portal/proposals/${proposalId}`)}
          >
            Cancel
          </PortalButton>
        </div>
      </form>
    </Card>
  );
}
