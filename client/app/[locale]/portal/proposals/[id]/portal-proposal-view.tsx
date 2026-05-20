"use client";

/**
 * Portal proposal view — same UX shape as the legacy public kiosk.
 *
 * The customer:
 *   1. Reads the proposal in an iframe (same HTML render the staff
 *      preview and the email PDF use).
 *   2. Reads each attached spec sheet rendered inline via
 *      :component:`SpecSheetContent` (the same component the staff
 *      side uses on the spec detail page — no second render path).
 *   3. Ticks the four acknowledgement boxes on the proposal.
 *   4. Signs each document (proposal + every spec) via
 *      :component:`SignatureDialog`.
 *   5. Clicks Finalize. The Finalize button only enables once every
 *      document carries a signature; the backend re-checks and
 *      atomically flips the bundle to ``accepted``.
 *
 * Identity is sourced from the JWT session cookie — there's no
 * kiosk identity modal because the customer is already
 * authenticated. That replaces the old "type your name + email"
 * gate the public kiosk needed.
 */

import { CheckCircle2, PenLine, Sparkles } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import {
  Card,
  ErrorBanner,
  H1,
  H2,
  P,
  PortalButton,
  StatusPill,
} from "@/components/portal/brutalist";
import { MessagesPanel } from "@/components/portal/messages-panel";
import { SignatureDialog } from "@/components/ui/signature-dialog";
import { apiClient } from "@/lib/api";
import { portalErrorMessage } from "@/services/portal/errors";
import { SpecSheetContent } from "../../../specifications/[id]/specification-sheet-view";


// Shape of the portal proposal endpoint response. Mirrors what
// ``_render_public_proposal_payload`` returns on the Django side —
// declared here (not pulled from a typed module) because the legacy
// services types are coupled to kiosk-session helpers we don't
// import on the portal.
interface SpecRecord {
  readonly id: string;
  readonly code: string;
  readonly document_kind: string;
  readonly formulation_name: string;
  readonly formulation_version_number: number | null;
  readonly has_signature: boolean;
  readonly customer_signed_at: string | null;
  readonly rendered: unknown;
}


interface PortalProposalDto {
  readonly id: string;
  readonly code: string;
  readonly status: string;
  readonly has_signature: boolean;
  readonly customer_signed_at: string | null;
  readonly ack_spec_signing: boolean;
  readonly ack_lead_times: boolean;
  readonly ack_terms: boolean;
  readonly ack_rd_terms: boolean;
  readonly specs: ReadonlyArray<SpecRecord>;
}


type DocumentKind = "proposal" | "spec";


interface PendingSign {
  readonly kind: DocumentKind;
  readonly sheetId?: string;
  readonly label: string;
}


export function PortalProposalView({ proposalId }: { proposalId: string }) {
  const [proposal, setProposal] = useState<PortalProposalDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingSign | null>(null);
  const [busy, setBusy] = useState(false);
  const [acks, setAcks] = useState({
    spec: false, leadTimes: false, terms: false, rdTerms: false,
  });
  const [finalizing, setFinalizing] = useState(false);
  const [finalized, setFinalized] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await apiClient.get<PortalProposalDto>(
        `/api/portal/proposals/${proposalId}/`,
      );
      setProposal(data);
      // Seed the ack checkboxes from whatever's already on the proposal —
      // the customer may have ticked some, navigated away, and come back.
      setAcks({
        spec: data.ack_spec_signing,
        leadTimes: data.ack_lead_times,
        terms: data.ack_terms,
        rdTerms: data.ack_rd_terms,
      });
      setLoadError(null);
    } catch (err: unknown) {
      setLoadError(portalErrorMessage(err));
    }
  }, [proposalId]);

  useEffect(() => {
    load();
  }, [load]);

  const acksAllTicked =
    acks.spec && acks.leadTimes && acks.terms && acks.rdTerms;

  const allSigned = Boolean(
    proposal?.has_signature
    && proposal.specs.every((spec) => spec.has_signature),
  );

  async function onSignSubmit(dataUrl: string): Promise<void> {
    if (!pending) return;
    setActionError(null);
    setBusy(true);
    try {
      if (pending.kind === "proposal") {
        await apiClient.post(`/api/portal/proposals/${proposalId}/sign/`, {
          signature_image: dataUrl,
          ack_spec_signing: acks.spec,
          ack_lead_times: acks.leadTimes,
          ack_terms: acks.terms,
          ack_rd_terms: acks.rdTerms,
        });
      } else if (pending.kind === "spec" && pending.sheetId) {
        await apiClient.post(
          `/api/portal/proposals/${proposalId}/specs/${pending.sheetId}/sign/`,
          { signature_image: dataUrl },
        );
      }
      setPending(null);
      await load();
    } catch (err: unknown) {
      setActionError(portalErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onFinalize() {
    setActionError(null);
    setFinalizing(true);
    try {
      await apiClient.post(`/api/portal/proposals/${proposalId}/finalize/`, {});
      setFinalized(true);
      await load();
    } catch (err: unknown) {
      setActionError(portalErrorMessage(err));
    } finally {
      setFinalizing(false);
    }
  }

  if (loadError) {
    return (
      <Card className="max-w-2xl">
        <H1>Couldn't load proposal</H1>
        <P>{loadError}</P>
        <Link
          href="/portal"
          className="text-xs font-bold uppercase tracking-widest underline"
        >
          ← Back to dashboard
        </Link>
      </Card>
    );
  }

  if (!proposal) {
    return <P>Loading…</P>;
  }

  const canSignProposal =
    !proposal.has_signature
    && proposal.status === "sent"
    && acksAllTicked;
  const canFinalize =
    proposal.status === "sent" && allSigned && !finalized;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <H1>{proposal.code}</H1>
        <StatusPill status={finalized ? "accepted" : proposal.status} />
      </div>

      {actionError ? <ErrorBanner>{actionError}</ErrorBanner> : null}

      {/* ----- Proposal document ----- */}
      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <H2>Proposal</H2>
          {proposal.has_signature ? (
            <SignedPill at={proposal.customer_signed_at} />
          ) : null}
        </div>
        <div className="border-2 border-black">
          <iframe
            src={`/api/portal/proposals/${proposalId}/pdf/`}
            title={`Proposal ${proposal.code}`}
            className="block h-[720px] w-full bg-white"
          />
        </div>
      </Card>

      {/* ----- Attached specs ----- */}
      {proposal.specs.length > 0 ? (
        <Card>
          <H2>Attached specifications ({proposal.specs.length})</H2>
          <P>
            Read each specification and sign it. The proposal cannot be
            finalised until every attached document is signed.
          </P>
          <div className="flex flex-col gap-6">
            {proposal.specs.map((spec, index) => (
              <SpecBlock
                key={spec.id}
                index={index + 1}
                spec={spec}
                onSign={() =>
                  setPending({
                    kind: "spec",
                    sheetId: spec.id,
                    label: `Spec ${spec.code || index + 1}`,
                  })
                }
              />
            ))}
          </div>
        </Card>
      ) : null}

      {/* ----- Acknowledgements ----- */}
      {!proposal.has_signature ? (
        <Card>
          <H2>Acknowledgements</H2>
          <P>Tick every statement, then sign below.</P>
          <div className="flex flex-col gap-3">
            <AckRow
              checked={acks.spec}
              onChange={(v) => setAcks((s) => ({ ...s, spec: v }))}
              text="I will sign each attached specification sheet."
            />
            <AckRow
              checked={acks.leadTimes}
              onChange={(v) => setAcks((s) => ({ ...s, leadTimes: v }))}
              text="I have read and accept the lead times and delivery schedule."
            />
            <AckRow
              checked={acks.terms}
              onChange={(v) => setAcks((s) => ({ ...s, terms: v }))}
              text="I accept the commercial terms and pricing."
            />
            <AckRow
              checked={acks.rdTerms}
              onChange={(v) => setAcks((s) => ({ ...s, rdTerms: v }))}
              text="I accept the R&D and confidentiality terms."
            />
          </div>
          <div className="mt-5">
            <PortalButton
              type="button"
              disabled={!canSignProposal}
              onClick={() =>
                setPending({ kind: "proposal", label: "Proposal" })
              }
            >
              <PenLine className="mr-2 h-4 w-4" />
              Sign proposal
            </PortalButton>
          </div>
        </Card>
      ) : null}

      {/* ----- Finalize ----- */}
      <Card>
        <H2>Finalise</H2>
        <P>
          Click Finalise once you have signed the proposal and every
          attached specification. This locks the bundle and notifies
          the Vita team.
        </P>
        {finalized || proposal.status === "accepted" ? (
          <div className="border-2 border-black bg-black px-4 py-3 text-sm font-bold uppercase tracking-widest text-white">
            <CheckCircle2 className="mr-2 inline h-4 w-4" />
            Accepted
          </div>
        ) : (
          <PortalButton
            type="button"
            disabled={!canFinalize || finalizing}
            onClick={onFinalize}
          >
            <Sparkles className="mr-2 h-4 w-4" />
            {finalizing ? "Finalising…" : "Finalise bundle"}
          </PortalButton>
        )}
      </Card>

      {/* ----- Decline + messages ----- */}
      {proposal.status === "sent" && !proposal.has_signature ? (
        <div>
          <Link
            href={`/portal/proposals/${proposalId}/reject`}
            className="text-xs font-bold uppercase tracking-widest underline"
          >
            Decline this proposal →
          </Link>
        </div>
      ) : null}

      <MessagesPanel proposalId={proposalId} />

      {/* ----- Signature dialog ----- */}
      <SignatureDialog
        isOpen={pending !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPending(null);
            setActionError(null);
          }
        }}
        title={pending ? `Sign — ${pending.label}` : ""}
        subtitle="Draw your signature with your mouse, finger or stylus."
        confirmLabel="Submit signature"
        busy={busy}
        errorMessage={actionError}
        onConfirm={onSignSubmit}
      />
    </div>
  );
}


function AckRow({
  checked,
  onChange,
  text,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  text: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 border-2 border-black bg-white p-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-5 w-5 cursor-pointer accent-black"
      />
      <span className="text-sm font-medium">{text}</span>
    </label>
  );
}


function SignedPill({ at }: { at: string | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 border-2 border-black bg-black px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-white">
      <CheckCircle2 className="h-3 w-3" />
      Signed
      {at ? ` · ${new Date(at).toLocaleDateString()}` : ""}
    </span>
  );
}


function SpecBlock({
  index,
  spec,
  onSign,
}: {
  index: number;
  spec: SpecRecord;
  onSign: () => void;
}) {
  return (
    <article className="border-2 border-black">
      <header className="flex items-center justify-between border-b-2 border-black bg-black px-4 py-2 text-xs font-bold uppercase tracking-widest text-white">
        <span>
          {index}. {spec.code || `Specification ${index}`}
          {spec.formulation_name ? ` · ${spec.formulation_name}` : null}
        </span>
        {spec.has_signature ? (
          <SignedPill at={spec.customer_signed_at} />
        ) : null}
      </header>
      {/* Reuse the staff app's SpecSheetContent so the customer sees
          the same render the staff team built/reviewed — no second
          template to drift. */}
      <div className="max-h-[700px] overflow-y-auto bg-white p-6">
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <SpecSheetContent rendered={spec.rendered as any} />
      </div>
      {!spec.has_signature ? (
        <div className="border-t-2 border-black bg-white px-4 py-3">
          <PortalButton type="button" onClick={onSign}>
            <PenLine className="mr-2 h-4 w-4" />
            Sign this specification
          </PortalButton>
        </div>
      ) : null}
    </article>
  );
}
