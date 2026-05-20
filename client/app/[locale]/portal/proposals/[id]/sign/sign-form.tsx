"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import {
  Card,
  ErrorBanner,
  H1,
  H2,
  P,
  PortalButton,
  StatusPill,
} from "@/components/portal/brutalist";
import {
  SignaturePad,
  type SignaturePadHandle,
} from "@/components/ui/signature-pad";
import { signProposal } from "@/services/portal/api";


export function ProposalSignForm({
  proposalId,
  code,
  status,
}: {
  proposalId: string;
  code: string;
  status: string;
}) {
  const router = useRouter();
  const padRef = useRef<SignaturePadHandle>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [ackSpec, setAckSpec] = useState(false);
  const [ackLeadTimes, setAckLeadTimes] = useState(false);
  const [ackTerms, setAckTerms] = useState(false);
  const [ackRdTerms, setAckRdTerms] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const allAcksTicked =
    ackSpec && ackLeadTimes && ackTerms && ackRdTerms;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!signature) {
      setError("Please draw your signature.");
      return;
    }
    if (!allAcksTicked) {
      setError("Tick every acknowledgement to continue.");
      return;
    }
    setSubmitting(true);
    try {
      await signProposal(proposalId, {
        signature_image: signature,
        ack_spec_signing: ackSpec,
        ack_lead_times: ackLeadTimes,
        ack_terms: ackTerms,
        ack_rd_terms: ackRdTerms,
      });
      router.push(`/portal/proposals/${proposalId}`);
    } catch (err: unknown) {
      const e = err as {
        response?: { data?: { code?: string; detail?: string[] } };
      };
      const code = e.response?.data?.code;
      if (code === "proposal_acknowledgements_required") {
        setError("Every acknowledgement must be ticked.");
      } else if (code === "signature_required") {
        setError("Signature image was rejected. Try again.");
      } else if (code === "invalid_proposal_transition") {
        setError("This proposal can no longer be signed.");
      } else {
        setError("Something went wrong. Try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid gap-6">
      <div className="flex items-center justify-between">
        <H1>Sign {code}</H1>
        <StatusPill status={status} />
      </div>

      <Card>
        <H2>Acknowledgements</H2>
        <P>
          Read each statement carefully. All four must be ticked before
          you can sign.
        </P>
        <div className="flex flex-col gap-3">
          {[
            {
              v: ackSpec,
              set: setAckSpec,
              t: "I will sign each attached specification sheet.",
            },
            {
              v: ackLeadTimes,
              set: setAckLeadTimes,
              t: "I have read and accept the lead times and delivery schedule.",
            },
            {
              v: ackTerms,
              set: setAckTerms,
              t: "I accept the commercial terms and pricing.",
            },
            {
              v: ackRdTerms,
              set: setAckRdTerms,
              t: "I accept the R&D and confidentiality terms.",
            },
          ].map((row, i) => (
            <label
              key={i}
              className="flex cursor-pointer items-start gap-3 border-2 border-black bg-white p-3"
            >
              <input
                type="checkbox"
                checked={row.v}
                onChange={(e) => row.set(e.target.checked)}
                className="mt-1 h-5 w-5 cursor-pointer accent-black"
              />
              <span className="text-sm font-medium">{row.t}</span>
            </label>
          ))}
        </div>
      </Card>

      <Card>
        <H2>Signature</H2>
        <P>Draw with your mouse, finger or stylus.</P>
        <div className="border-2 border-black bg-white">
          <SignaturePad
            ref={padRef}
            onChange={setSignature}
            ariaLabel="Customer signature"
          />
        </div>
        <div className="mt-3">
          <PortalButton
            type="button"
            variant="secondary"
            onClick={() => padRef.current?.clear()}
          >
            Clear
          </PortalButton>
        </div>
      </Card>

      <ErrorBanner>{error}</ErrorBanner>

      <form onSubmit={onSubmit} className="flex gap-3">
        <PortalButton type="submit" disabled={submitting}>
          {submitting ? "Signing…" : "Sign proposal"}
        </PortalButton>
        <PortalButton
          type="button"
          variant="secondary"
          onClick={() => router.push(`/portal/proposals/${proposalId}`)}
        >
          Cancel
        </PortalButton>
      </form>
    </div>
  );
}
