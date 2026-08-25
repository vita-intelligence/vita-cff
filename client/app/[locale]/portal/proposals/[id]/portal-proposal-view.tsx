"use client";

/**
 * Portal proposal view — the deal-level surface.
 *
 * After the route restructure, this page no longer renders
 * attached specs inline. Each spec lives on its own
 * ``/portal/specs/<id>`` page (linked from the "Specifications"
 * card here) so a busy proposal with N specs doesn't drown the
 * customer in nested previews.
 *
 * What stays:
 *   * Proposal preview iframe + read-tracking
 *   * Acknowledgement checkboxes + sign-proposal button
 *   * Accept / Decline pair at the bottom
 *   * Proposal-level chat (just the deal, not per-spec)
 *
 * What moved out:
 *   * Inline spec rendering — see ``portal-spec-view.tsx``
 *   * Per-spec chat threads — see ``spec-chat-panel.tsx``
 */

import {
  ArrowRight,
  CheckCircle2,
  Download,
  PenLine,
  Sparkles,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  Card,
  ErrorBanner,
  Eyebrow,
  PageHeader,
  PortalButton,
  PortalLinkButton,
  SignedChip,
  StatusPill,
} from "@/components/portal/brutalist";
import { PortalSignatureDialog } from "@/components/portal/portal-signature-dialog";
import { ProposalChatPanel } from "@/components/portal/proposal-chat-panel";
import { apiClient } from "@/lib/api";
import { portalErrorMessage } from "@/services/portal/errors";


const READ_THRESHOLD = 0.98;


interface SpecRecord {
  readonly id: string;
  readonly code: string;
  readonly document_kind: string;
  readonly formulation_name: string;
  readonly formulation_version_number: number | null;
  readonly has_signature: boolean;
  readonly customer_signed_at: string | null;
}


interface PortalProposalDto {
  readonly id: string;
  readonly code: string;
  readonly status: string;
  //: NPD's own portal navigates around projects — from a proposal
  //: the back link routes here so the customer's mental model is
  //: "always one step back to the project", never to a proposal
  //: list they didn't drill in from.
  readonly formulation_id: string | null;
  readonly has_signature: boolean;
  readonly customer_signed_at: string | null;
  readonly ack_spec_signing: boolean;
  readonly ack_lead_times: boolean;
  readonly ack_terms: boolean;
  readonly ack_rd_terms: boolean;
  readonly attached_specs: ReadonlyArray<SpecRecord>;
}


function proposalIframeVersion(p: PortalProposalDto): string {
  const parts = [
    p.status,
    p.has_signature ? "1" : "0",
    p.customer_signed_at || "",
    p.ack_spec_signing ? "1" : "0",
    p.ack_lead_times ? "1" : "0",
    p.ack_terms ? "1" : "0",
    p.ack_rd_terms ? "1" : "0",
    p.attached_specs.map((s) => s.customer_signed_at || "0").join(","),
  ];
  return encodeURIComponent(parts.join("|"));
}


export function PortalProposalView({ proposalId }: { proposalId: string }) {
  const [proposal, setProposal] = useState<PortalProposalDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [finalized, setFinalized] = useState(false);
  const [acks, setAcks] = useState({
    spec: false, leadTimes: false, terms: false, rdTerms: false,
  });
  const [proposalRead, setProposalRead] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await apiClient.get<PortalProposalDto>(
        `/api/portal/proposals/${proposalId}/`,
      );
      setProposal(data);
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
    && proposal.attached_specs.every((s) => s.has_signature),
  );

  async function onSign(dataUrl: string) {
    setActionError(null);
    setBusy(true);
    try {
      await apiClient.post(`/api/portal/proposals/${proposalId}/sign/`, {
        signature_image: dataUrl,
        ack_spec_signing: acks.spec,
        ack_lead_times: acks.leadTimes,
        ack_terms: acks.terms,
        ack_rd_terms: acks.rdTerms,
      });
      setPending(false);
      await load();
    } catch (err: unknown) {
      setActionError(portalErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onAccept() {
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
      <Card>
        <p>{loadError}</p>
        <Link
          href="/portal/proposals"
          className="text-xs font-bold uppercase tracking-widest underline"
        >
          ← Back to proposals
        </Link>
      </Card>
    );
  }
  if (!proposal) return <p>Loading…</p>;

  const isAccepted = finalized || proposal.status === "accepted";
  const isRejected = proposal.status === "rejected";
  const isDone = isAccepted || isRejected;
  const canSignProposal =
    !proposal.has_signature
    && proposal.status === "sent"
    && acksAllTicked
    && proposalRead;
  const signedSpecs = proposal.attached_specs.filter((s) => s.has_signature).length;
  const totalSpecs = proposal.attached_specs.length;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow={`Proposal ${proposal.code}`}
        title={proposal.code}
        subtitle="Read the proposal, sign it, then sign each specification on its own page."
        back={{
          href: proposal.formulation_id
            ? `/portal/products/${proposal.formulation_id}`
            : "/portal/proposals",
          label: proposal.formulation_id ? "Back to project" : "All proposals",
        }}
        actions={
          <>
            <PortalLinkButton
              variant="secondary"
              size="sm"
              href={`/api/portal/proposals/${proposalId}/download/`}
              target="_blank"
              rel="noreferrer"
            >
              <Download className="h-3.5 w-3.5" />
              PDF
            </PortalLinkButton>
            <StatusPill status={isAccepted ? "accepted" : proposal.status} />
          </>
        }
      />

      {actionError ? <ErrorBanner>{actionError}</ErrorBanner> : null}

      {/* What to do */}
      {!isDone ? (
        <Card>
          <div className="mb-4 flex items-center justify-between">
            <Eyebrow>What to do</Eyebrow>
            <div className="text-[11px] font-bold uppercase tracking-widest text-neutral-600">
              Step-by-step
            </div>
          </div>
          <ol className="grid gap-2 sm:grid-cols-2">
            <StepRow n={1} text="Read the proposal." done={proposalRead} />
            <StepRow n={2} text="Tick the four acknowledgements." done={acksAllTicked} />
            <StepRow n={3} text="Sign the proposal." done={proposal.has_signature} />
            <StepRow
              n={4}
              text={`Sign each specification (${signedSpecs}/${totalSpecs}).`}
              done={totalSpecs > 0 && signedSpecs === totalSpecs}
            />
            <StepRow n={5} text="Accept or decline." done={isDone} />
          </ol>
        </Card>
      ) : null}

      {/* Proposal preview */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <Eyebrow>01 / Proposal</Eyebrow>
            <h2 className="mt-1 text-xl font-black uppercase tracking-tight">
              Read the proposal
            </h2>
          </div>
          {proposal.has_signature ? (
            <SignedChip at={proposal.customer_signed_at} />
          ) : null}
        </div>
        <ScrollTrackingIframe
          src={`/api/portal/proposals/${proposalId}/pdf/?v=${proposalIframeVersion(proposal)}`}
          title={`Proposal ${proposal.code}`}
          onAllReadChange={setProposalRead}
        />
      </Card>

      {/* Acks + continue-to-signing. The button on this card does
          NOT sign the proposal — it opens the signature dialog,
          where the customer actually draws + confirms. Wording
          matters: an earlier version that said "Sign proposal"
          here made customers feel like ticking the boxes was the
          sign, so the heading + CTA both explicitly call out
          "before you sign" / "continue to signing". */}
      {!proposal.has_signature ? (
        <Card>
          <Eyebrow>02 / Before you sign</Eyebrow>
          <h2 className="mt-1 mb-4 text-xl font-black uppercase tracking-tight">
            Acknowledge, then continue to signing
          </h2>
          <p className="mb-5 max-w-prose text-sm leading-relaxed text-neutral-700">
            Tick every statement to unlock the signing step — you&rsquo;ll
            draw your signature on the next screen.
          </p>
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
          {/* Static reference to the live website T&Cs + Privacy.
              These aren't tickboxes because they're not proposal-
              specific opt-ins, they're the standing policies that
              govern every Vita customer. Linking them inline keeps
              the proposal-card uncluttered while still making the
              two surfaces one click away before sign. */}
          <p className="mt-4 text-[12px] leading-relaxed text-neutral-600">
            By continuing you also confirm you&rsquo;ve read our{" "}
            <a
              href="https://www.vitamanufacture.co.uk/termsandcondition"
              target="_blank"
              rel="noopener noreferrer"
              className="font-bold underline underline-offset-2 hover:text-black"
            >
              Terms &amp; Conditions
            </a>{" "}
            and{" "}
            <a
              href="https://www.vitamanufacture.co.uk/privacypolicy"
              target="_blank"
              rel="noopener noreferrer"
              className="font-bold underline underline-offset-2 hover:text-black"
            >
              Privacy Policy
            </a>
            .
          </p>
          <div className="mt-5">
            <PortalButton
              type="button"
              disabled={!canSignProposal}
              onClick={() => setPending(true)}
            >
              <PenLine className="h-4 w-4" />
              Continue to signing
            </PortalButton>
            {!proposalRead ? (
              <p className="mt-2 text-[11px] uppercase tracking-widest text-neutral-600">
                Scroll to the bottom of the proposal to enable signing.
              </p>
            ) : null}
          </div>
        </Card>
      ) : null}

      {/* Attached specs — link list */}
      {totalSpecs > 0 ? (
        <Card>
          <div className="mb-4 flex items-end justify-between">
            <div>
              <Eyebrow>03 / Specifications</Eyebrow>
              <h2 className="mt-1 text-xl font-black uppercase tracking-tight">
                Sign each specification
              </h2>
            </div>
            <span className="text-[11px] font-bold uppercase tracking-widest text-neutral-600">
              {signedSpecs} / {totalSpecs} signed
            </span>
          </div>
          <p className="mb-5 max-w-prose text-sm leading-relaxed text-neutral-700">
            Each specification opens on its own page so you can read and
            sign one at a time.
          </p>
          <ul className="grid gap-3">
            {proposal.attached_specs.map((spec, i) => (
              <li key={spec.id}>
                <Link
                  href={`/portal/specs/${spec.id}`}
                  className={`flex items-center justify-between gap-4 border-2 border-black p-4 transition-transform hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-[5px_5px_0_#000] ${
                    spec.has_signature ? "bg-black text-white" : "bg-white text-black"
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      className={`flex h-9 w-9 shrink-0 items-center justify-center border-2 text-sm font-black ${
                        spec.has_signature
                          ? "border-white bg-white text-black"
                          : "border-black bg-paper text-black"
                      }`}
                    >
                      {spec.has_signature ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
                    </span>
                    <div className="min-w-0">
                      <div className="text-[10px] font-bold uppercase tracking-[0.2em] opacity-70">
                        {spec.code || `Spec ${i + 1}`}
                      </div>
                      <div className="truncate text-sm font-black uppercase tracking-tight">
                        {spec.formulation_name || spec.code || "Specification"}
                      </div>
                    </div>
                  </div>
                  <ArrowRight className="h-5 w-5 shrink-0" />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* Accept / Decline */}
      <Card>
        <Eyebrow>04 / Your decision</Eyebrow>
        <h2 className="mt-1 mb-3 text-xl font-black uppercase tracking-tight">
          Accept or decline
        </h2>
        {isAccepted ? (
          <div className="border-2 border-black bg-black px-4 py-3 text-sm font-bold uppercase tracking-widest text-white">
            <CheckCircle2 className="mr-2 inline h-4 w-4" />
            Accepted — Vita has been notified.
          </div>
        ) : isRejected ? (
          <div className="border-2 border-black bg-red-700 px-4 py-3 text-sm font-bold uppercase tracking-widest text-white">
            <XCircle className="mr-2 inline h-4 w-4" />
            Declined — Vita has been notified.
          </div>
        ) : (
          <>
            <p className="mb-5 max-w-prose text-sm leading-relaxed text-neutral-700">
              When every document above is signed, accept the proposal to
              confirm the deal. Or decline if something isn't right.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <PortalButton
                type="button"
                disabled={!allSigned || finalizing}
                onClick={onAccept}
                className="flex-1"
              >
                <Sparkles className="h-4 w-4" />
                {finalizing ? "Accepting…" : "Accept proposal"}
              </PortalButton>
              <PortalLinkButton
                variant="secondary"
                href={`/portal/proposals/${proposalId}/reject`}
                className="flex-1"
              >
                <XCircle className="h-4 w-4" />
                Decline
              </PortalLinkButton>
            </div>
            {!allSigned ? (
              <p className="mt-2 text-[11px] uppercase tracking-widest text-neutral-600">
                Accept stays disabled until the proposal and every
                specification above are signed.
              </p>
            ) : null}
          </>
        )}
      </Card>

      {/* Conversation */}
      <ProposalChatPanel
        proposalId={proposalId}
        proposalCode={proposal.code}
      />

      <PortalSignatureDialog
        isOpen={pending}
        onOpenChange={(open) => {
          if (!open) {
            setPending(false);
            setActionError(null);
          }
        }}
        title="Draw your signature"
        subtitle="Use your mouse, finger or stylus. This is what gets recorded as your sign-off on the proposal."
        confirmLabel="Sign & submit"
        busy={busy}
        errorMessage={actionError}
        onConfirm={onSign}
      />
    </div>
  );
}


function StepRow({
  n,
  text,
  done,
}: {
  n: number;
  text: string;
  done: boolean;
}) {
  return (
    <li
      className={`flex items-start gap-3 border-2 border-black p-3 text-sm transition-opacity ${
        done ? "bg-paper opacity-60" : "bg-white"
      }`}
    >
      <span
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border-2 border-black text-[10px] font-black ${
          done ? "bg-black text-white" : "bg-white text-black"
        }`}
      >
        {done ? "✓" : n}
      </span>
      <span className={done ? "line-through" : ""}>{text}</span>
    </li>
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
    <label className="flex cursor-pointer items-start gap-3 border-2 border-black bg-white p-3 transition-colors hover:bg-paper">
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


function ScrollTrackingIframe({
  src,
  title,
  onAllReadChange,
}: {
  src: string;
  title: string;
  onAllReadChange: (allRead: boolean) => void;
}) {
  const [progress, setProgress] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const allDone = progress >= READ_THRESHOLD;
  const cbRef = useRef(onAllReadChange);
  useEffect(() => { cbRef.current = onAllReadChange; }, [onAllReadChange]);
  useEffect(() => { cbRef.current(allDone); }, [allDone]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const iframe = iframeRef.current;
      if (!iframe) return;
      const win = iframe.contentWindow;
      const doc = iframe.contentDocument;
      if (!win || !doc) return;
      if (doc.readyState !== "complete") return;
      const docUrl = doc.URL || "";
      if (!docUrl || docUrl === "about:blank") return;
      const root = doc.documentElement;
      if (!root) return;
      const scrollTop = win.scrollY;
      const clientHeight = win.innerHeight;
      const scrollHeight = root.scrollHeight;
      if (scrollHeight <= 0 || clientHeight <= 0) return;
      const scrollable = Math.max(0, scrollHeight - clientHeight);
      if (scrollable <= 0) { setProgress(1); return; }
      const fraction = scrollTop / scrollable;
      setProgress((prev) =>
        fraction > prev ? Math.min(1, fraction) : prev,
      );
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [src]);

  const pct = Math.round(progress * 100);

  return (
    <div className="flex flex-col gap-2">
      <div className="border-2 border-black">
        <iframe
          ref={iframeRef}
          src={src}
          title={title}
          className="block h-[720px] w-full bg-white"
        />
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] font-bold uppercase tracking-widest">
        <span>Read progress</span>
        <span>{pct}%</span>
      </div>
      <div className="h-2 w-full border-2 border-black">
        <div
          className="h-full bg-black transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      {pct < 98 ? (
        <button
          type="button"
          onClick={() => setProgress(1)}
          className="mt-1 self-start text-[10px] font-bold uppercase tracking-widest underline opacity-60 hover:opacity-100"
        >
          Mark as read
        </button>
      ) : null}
    </div>
  );
}
