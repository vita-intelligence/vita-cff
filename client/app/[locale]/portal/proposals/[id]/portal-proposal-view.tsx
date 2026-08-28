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
  //: Custom vs Ready-to-Go template. Drives the acknowledgement
  //: copy swap below — RTG customers see order-flow language + no
  //: R&D confidentiality row because those orders skip bespoke
  //: development entirely. Emitted by the backend renderer at
  //: ``apps.proposals.api.views._render_public_proposal_payload``.
  readonly template_type: string | null;
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

  // RTG orders don't route through R&D — the confidentiality
  // acknowledgement is dropped on those proposals, so ``acksAllTicked``
  // only requires the three commercial+spec+lead-times boxes when
  // ``template_type === "ready_to_go"``. Falls back to the four-ack
  // gate on Custom projects so bespoke development still requires the
  // R&D opt-in.
  const isRtg = proposal?.template_type === "ready_to_go";
  const acksAllTicked = isRtg
    ? acks.spec && acks.leadTimes && acks.terms
    : acks.spec && acks.leadTimes && acks.terms && acks.rdTerms;

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
      // Chain finalize onto the same click. The spec sheets are
      // signed first (enforced by the FE ``allSpecsSigned`` gate +
      // the backend ``sign_spec_first`` guard), so by the time the
      // proposal signature lands every document is signed and the
      // deal is ready to accept. A single click covers "I signed
      // the paper" AND "I'm committing" — no separate Accept step
      // needed. The finalize hook is what materialises the DEPOSIT
      // Payment on finance's queue and pushes the accepted state to
      // PSP; without this chain the customer sees the roadmap
      // freeze at "awaiting acceptance" with nothing else to click.
      try {
        await apiClient.post(
          `/api/portal/proposals/${proposalId}/finalize/`,
          {},
        );
        setFinalized(true);
      } catch (finalizeErr: unknown) {
        // Surface finalize failure through the same error banner so
        // the customer sees the retry path. Signature capture
        // already succeeded, so ``load()`` below still updates the
        // roadmap to reflect that.
        setActionError(portalErrorMessage(finalizeErr));
      }
      await load();
    } catch (err: unknown) {
      setActionError(portalErrorMessage(err));
    } finally {
      setBusy(false);
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
  const signedSpecs = proposal.attached_specs.filter((s) => s.has_signature).length;
  const totalSpecs = proposal.attached_specs.length;
  //: Specs must land before the proposal signature. Custom projects
  //: attach a DRAFT spec at proposal time; RTG orders attach a FINAL
  //: spec cloned from the SKU template. The backend enforces the
  //: same order via ``sign_spec_first`` (409) — the FE gate here
  //: keeps the button visibly disabled so the customer sees the
  //: prerequisite before they click.
  const allSpecsSigned = totalSpecs === 0 || signedSpecs === totalSpecs;
  const canSignProposal =
    !proposal.has_signature
    && proposal.status === "sent"
    && acksAllTicked
    && proposalRead
    && allSpecsSigned;

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
          {/* Ordering matters: specs must be signed BEFORE the
              proposal (the backend blocks proposal-sign with a 409
              ``sign_spec_first`` otherwise). Custom flow signs a
              DRAFT spec here; RTG signs the FINAL clone the
              storefront attached at checkout. Either way, the
              customer's commitment to the recipe lands first, the
              commercial commitment lands second. */}
          <ol className="grid gap-2 sm:grid-cols-2">
            <StepRow n={1} text="Read the proposal." done={proposalRead} />
            <StepRow
              n={2}
              text={
                isRtg
                  ? "Tick the three acknowledgements."
                  : "Tick the four acknowledgements."
              }
              done={acksAllTicked}
            />
            <StepRow
              n={3}
              text={`Sign each specification (${signedSpecs}/${totalSpecs}).`}
              done={totalSpecs > 0 && signedSpecs === totalSpecs}
            />
            <StepRow
              n={4}
              text="Sign & finalise the proposal."
              done={isDone}
            />
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

      {/* Specifications — moved ABOVE the acks card so the customer
          walks the flow in one linear direction: read → sign each
          spec → then and only then see the acks + Continue button.
          The old order (acks card above, specs below) made customers
          tick every ack, hit Continue, and get a silently-disabled
          button — no explanation of why. Now: when specs are still
          pending, this is the single visible next step; the acks
          card below stays hidden until every spec is signed. */}
      {totalSpecs > 0 && !proposal.has_signature ? (
        <Card
          className={
            !allSpecsSigned
              ? "border-4 border-orange-500 shadow-[6px_6px_0_#000]"
              : undefined
          }
        >
          <div className="mb-4 flex items-end justify-between">
            <div>
              <Eyebrow>
                {allSpecsSigned
                  ? "02 / Specifications signed"
                  : "02 / Start here — sign your specification"}
              </Eyebrow>
              <h2 className="mt-1 text-xl font-black uppercase tracking-tight">
                {allSpecsSigned
                  ? "Every specification is signed"
                  : totalSpecs === 1
                    ? "Sign your specification"
                    : "Sign each specification"}
              </h2>
            </div>
            <span className="text-[11px] font-bold uppercase tracking-widest text-neutral-600">
              {signedSpecs} / {totalSpecs} signed
            </span>
          </div>
          <p className="mb-5 max-w-prose text-sm leading-relaxed text-neutral-700">
            {allSpecsSigned
              ? "Great — the recipe is locked. Continue to the acknowledgements below to sign the proposal."
              : "This is your first step. Each specification opens on its own page — read it, then sign. Once every specification is signed the proposal signing step will unlock below."}
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
                  {/* Sign / view CTA — highlighted while unsigned so
                      the customer sees exactly one clickable target. */}
                  {spec.has_signature ? (
                    <span className="inline-flex shrink-0 items-center gap-2 text-[11px] font-bold uppercase tracking-widest">
                      Signed <ArrowRight className="h-4 w-4" />
                    </span>
                  ) : (
                    <span className="inline-flex shrink-0 items-center gap-2 border-2 border-black bg-orange-500 px-3 py-1.5 text-[11px] font-black uppercase tracking-widest text-black">
                      Sign now <ArrowRight className="h-4 w-4" />
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* Acks + continue-to-signing. The button on this card does
          NOT sign the proposal — it opens the signature dialog,
          where the customer actually draws + confirms. Wording
          matters: an earlier version that said "Sign proposal"
          here made customers feel like ticking the boxes was the
          sign, so the heading + CTA both explicitly call out
          "before you sign" / "continue to signing".

          Gated on ``allSpecsSigned`` — the whole card is hidden
          until every attached spec has a customer signature. This is
          the linear-flow rule the customer wants to be walked
          through: sign spec → THEN see the acks + Continue button.
          A locked button with a "sign spec first" hint below still
          leaves the customer wondering why the system feels broken;
          collapsing the card entirely removes that failure mode. */}
      {!proposal.has_signature && allSpecsSigned ? (
        <Card>
          <Eyebrow>03 / Sign & finalise</Eyebrow>
          <h2 className="mt-1 mb-4 text-xl font-black uppercase tracking-tight">
            Acknowledge, then sign to commit
          </h2>
          <p className="mb-5 max-w-prose text-sm leading-relaxed text-neutral-700">
            Tick every statement to unlock the signing step — you&rsquo;ll
            draw your signature on the next screen. The proposal is
            the last document you sign, so this click also commits to
            the order: we&rsquo;ll generate the invoice on our finance
            queue and start the production workflow.
          </p>
          {/* RTG orders swap the four Custom ack rows for three
              order-flow-specific ones — no R&D confidentiality box
              because RTG SKUs skip bespoke development. Copy matches
              the web-site portal's ``PROPOSAL_ACKS`` array word-for-
              word so both surfaces speak the same commercial
              language. */}
          <div className="flex flex-col gap-3">
            <AckRow
              checked={acks.spec}
              onChange={(v) => setAcks((s) => ({ ...s, spec: v }))}
              text={
                isRtg
                  ? "I understand that before label printing, Production Specification Sheets must be signed, and label designs must be reviewed and approved. Placing an order initiates the development phase, during which Product Specification Sheets are finalized, and label guidelines are provided to facilitate label design, review, and approval."
                  : "I will sign each attached specification sheet."
              }
            />
            <AckRow
              checked={acks.leadTimes}
              onChange={(v) => setAcks((s) => ({ ...s, leadTimes: v }))}
              text={
                isRtg
                  ? "I understand that manufacturing lead times commence once the Product Specification Sheet(s) are signed and not before."
                  : "I have read and accept the lead times and delivery schedule."
              }
            />
            <AckRow
              checked={acks.terms}
              onChange={(v) => setAcks((s) => ({ ...s, terms: v }))}
              text={
                isRtg
                  ? "I have read the terms and conditions which can be found below."
                  : "I accept the commercial terms and pricing."
              }
            />
            {!isRtg ? (
              <AckRow
                checked={acks.rdTerms}
                onChange={(v) => setAcks((s) => ({ ...s, rdTerms: v }))}
                text="I accept the R&D and confidentiality terms."
              />
            ) : null}
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
              Sign & finalise
            </PortalButton>
            {/* At this point specs are already signed (the whole card
                is gated on ``allSpecsSigned``), so blockers are just
                proposal-read + acks. Ordered by resolution priority
                so the customer sees the actionable one first. */}
            {!proposalRead ? (
              <p className="mt-2 text-[11px] uppercase tracking-widest text-neutral-600">
                Scroll to the bottom of the proposal to enable signing.
              </p>
            ) : !acksAllTicked ? (
              <p className="mt-2 text-[11px] uppercase tracking-widest text-neutral-600">
                Tick every acknowledgement above to enable signing.
              </p>
            ) : null}
          </div>
        </Card>
      ) : null}

      {/* Terminal-state banner + retry surface. In the happy path the
          proposal signature click auto-finalises (see ``onSign``), so
          this card renders one of two terminal badges once the deal
          closes. It only surfaces the "Accept & finalise" button as a
          RETRY when the sign call succeeded but the follow-up
          finalize failed — that's the only window where the
          customer has a captured signature and a non-terminal
          status. Decline stays as a standalone link so the customer
          can back out of the deal before signing anything. */}
      <Card>
        <Eyebrow>04 / Your decision</Eyebrow>
        {isAccepted ? (
          <>
            <h2 className="mt-1 mb-3 text-xl font-black uppercase tracking-tight">
              Accepted
            </h2>
            <div className="border-2 border-black bg-black px-4 py-3 text-sm font-bold uppercase tracking-widest text-white">
              <CheckCircle2 className="mr-2 inline h-4 w-4" />
              Vita has been notified.
            </div>
          </>
        ) : isRejected ? (
          <>
            <h2 className="mt-1 mb-3 text-xl font-black uppercase tracking-tight">
              Declined
            </h2>
            <div className="border-2 border-black bg-red-700 px-4 py-3 text-sm font-bold uppercase tracking-widest text-white">
              <XCircle className="mr-2 inline h-4 w-4" />
              Vita has been notified.
            </div>
          </>
        ) : proposal.has_signature ? (
          <>
            <h2 className="mt-1 mb-3 text-xl font-black uppercase tracking-tight">
              Retry finalising
            </h2>
            <p className="mb-5 max-w-prose text-sm leading-relaxed text-neutral-700">
              We captured your signature but couldn&rsquo;t close the
              deal automatically. Click below to try again — this
              generates the invoice on our finance queue and starts
              the production workflow.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <PortalButton
                type="button"
                disabled={!allSigned || finalizing}
                onClick={onAccept}
                className="flex-1"
              >
                <Sparkles className="h-4 w-4" />
                {finalizing ? "Finalising…" : "Retry finalising"}
              </PortalButton>
            </div>
          </>
        ) : (
          <>
            <h2 className="mt-1 mb-3 text-xl font-black uppercase tracking-tight">
              Decline
            </h2>
            <p className="mb-5 max-w-prose text-sm leading-relaxed text-neutral-700">
              Not ready to move forward? You can decline the proposal
              — we&rsquo;ll be in touch about next steps.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <PortalLinkButton
                variant="secondary"
                href={`/portal/proposals/${proposalId}/reject`}
                className="flex-1"
              >
                <XCircle className="h-4 w-4" />
                Decline proposal
              </PortalLinkButton>
            </div>
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
