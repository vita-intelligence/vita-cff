"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import {
  Card,
  ErrorBanner,
  H1,
  P,
  PortalButton,
  PortalTextarea,
} from "@/components/portal/brutalist";
import { rejectProposal } from "@/services/portal/api";
import { portalErrorMessage } from "@/services/portal/errors";
import { REJECTION_CATEGORIES } from "@/services/proposals/rejection-categories";


export function ProposalRejectForm({ proposalId }: { proposalId: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  //: Multi-select category ticks. At least one is required — the
  //: Decline button stays disabled until the set is non-empty.
  //: Backend enforces the same gate so a crafted request can't
  //: write a blank reason.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const canSubmit = selected.size > 0 && !submitting;
  const categoriesPayload = useMemo(() => Array.from(selected), [selected]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      await rejectProposal(proposalId, {
        reason,
        categories: categoriesPayload,
      });
      router.push(`/portal/proposals/${proposalId}`);
    } catch (err: unknown) {
      setError(portalErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="max-w-2xl">
      <H1>Decline this proposal</H1>
      <P>
        Tick what pushed you to decline — pick as many as apply.
        The Vita team uses this to decide whether to revise the
        offer or move the project on.
      </P>
      <ErrorBanner>{error}</ErrorBanner>
      <form onSubmit={onSubmit} className="flex flex-col gap-5">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs font-bold uppercase tracking-widest text-neutral-700">
            Reasons · at least one <span className="text-red-700">*</span>
          </legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {REJECTION_CATEGORIES.map((entry) => {
              const checked = selected.has(entry.key);
              return (
                <label
                  key={entry.key}
                  className={`flex cursor-pointer items-start gap-2 border-2 px-3 py-2 text-sm transition-colors ${
                    checked
                      ? "border-black bg-black text-white"
                      : "border-neutral-300 bg-white hover:border-black"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 accent-black"
                    checked={checked}
                    onChange={() => toggle(entry.key)}
                  />
                  <span className="font-medium">{entry.label}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <PortalTextarea
          name="reason"
          label="Anything to add? (optional)"
          rows={5}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Context the ticks above don't capture — specifics the sales team should know."
        />
        <div className="flex gap-3">
          <PortalButton type="submit" disabled={!canSubmit}>
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
