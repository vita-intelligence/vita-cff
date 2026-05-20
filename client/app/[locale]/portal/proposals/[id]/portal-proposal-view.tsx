"use client";

/**
 * Portal proposal view — restructured to match the kiosk's UX
 * after customer-test feedback flagged the previous layout as
 * "too much information, too confusing".
 *
 * The page is now a single linear column with five blocks:
 *
 *   1. **What to do** — up-front guidance card listing the steps
 *      so the customer never wonders "what's next". Same idea as
 *      the staff onboarding wizard.
 *   2. **Progress** — small strip showing N / N signed.
 *   3. **One card per document** — proposal first, then each
 *      attached spec. Each card has:
 *        - Download (proposal-level only)
 *        - Scroll-tracked content (iframe for the proposal,
 *          inline ``SpecSheetContent`` for specs)
 *        - Read-progress bar
 *        - Acknowledgement checkboxes (proposal card only)
 *        - Sign button — DISABLED until the document has been
 *          scrolled to ~98% AND the proposal's acks are ticked
 *   4. **Final decision** — Accept and Decline as paired CTAs,
 *      same visual weight, no buried decline link.
 *   5. **Messages** — unchanged, kept at the bottom and visually
 *      separated from the signing flow.
 *
 * Scroll tracking: 98% threshold (matches the kiosk). For
 * iframes, we poll ``contentWindow.scrollY`` / ``scrollHeight``
 * every 250ms — same robustness reasons as the kiosk: ``load``
 * event listeners get dropped on parent re-renders, polling
 * sidesteps that race. For inline content (the spec cards),
 * a plain ``scroll`` event on the wrapping div is enough since
 * the document never gets re-mounted by sibling state changes.
 */

import { CheckCircle2, Download, PenLine, Sparkles, XCircle } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

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
import { PortalSignatureDialog } from "@/components/portal/portal-signature-dialog";
import { apiClient } from "@/lib/api";
import { portalErrorMessage } from "@/services/portal/errors";
import { SpecSheetContent } from "../../../specifications/[id]/specification-sheet-view";


const READ_THRESHOLD = 0.98;


/**
 * Compose a stable string from every state we want to cache-bust
 * the proposal iframe against. Whenever any of these change
 * (proposal signed, spec signed, acks flipped, status moves) the
 * query param changes too, React swaps the iframe src, the browser
 * fetches the fresh HTML, and the customer sees the updated render
 * without a hard refresh. ``"v=|||"`` is fine for a never-signed
 * proposal — the only requirement is monotonic uniqueness.
 */
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


interface SpecRecord {
  readonly id: string;
  readonly code: string;
  readonly document_kind: string;
  readonly formulation_name: string;
  readonly formulation_version_number: number | null;
  readonly has_signature: boolean;
  readonly customer_signed_at: string | null;
  readonly render_context: unknown;
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
  readonly attached_specs: ReadonlyArray<SpecRecord>;
}


type PendingSign =
  | { kind: "proposal"; label: string }
  | { kind: "spec"; sheetId: string; label: string };


export function PortalProposalView({ proposalId }: { proposalId: string }) {
  const [proposal, setProposal] = useState<PortalProposalDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingSign | null>(null);
  const [busy, setBusy] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [finalized, setFinalized] = useState(false);
  const [acks, setAcks] = useState({
    spec: false, leadTimes: false, terms: false, rdTerms: false,
  });
  // Per-document "have I been read enough?" booleans. Keyed by
  // ``"proposal"`` for the cover doc, ``"spec:<id>"`` for each
  // attached spec. The tracker components own the percentage
  // internally and only call back here when the threshold flips —
  // this design mirrors the kiosk verbatim and avoids the
  // "Maximum update depth exceeded" loop the previous
  // percentage-driven design produced.
  const [readState, setReadState] = useState<Record<string, boolean>>({});

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
    && proposal.attached_specs.every((spec) => spec.has_signature),
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
      } else {
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
      <Card className="max-w-2xl">
        <H1>Couldn&apos;t load proposal</H1>
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

  const proposalReadEnough = readState["proposal"] ?? false;
  const canSignProposal =
    !proposal.has_signature
    && proposal.status === "sent"
    && acksAllTicked
    && proposalReadEnough;

  const isAccepted = finalized || proposal.status === "accepted";
  const isRejected = proposal.status === "rejected";
  const isDone = isAccepted || isRejected;
  const totalDocs = 1 + proposal.attached_specs.length;
  const signedDocs =
    (proposal.has_signature ? 1 : 0)
    + proposal.attached_specs.filter((s) => s.has_signature).length;

  const guidanceSteps = [
    { text: "Read the proposal — scroll to the bottom.", done: proposalReadEnough },
    { text: "Tick the four acknowledgements.", done: acksAllTicked },
    { text: "Sign the proposal.", done: proposal.has_signature },
    {
      text: `Read & sign ${proposal.attached_specs.length} attached specification${proposal.attached_specs.length === 1 ? "" : "s"}.`,
      done: proposal.attached_specs.length > 0
        && proposal.attached_specs.every((s) => s.has_signature),
    },
    { text: "Choose Accept or Decline.", done: isDone },
  ];

  return (
    <div className="flex flex-col gap-8">
      {/* ----- Header ----- */}
      <header className="flex items-center justify-between">
        <H1>{proposal.code}</H1>
        <StatusPill status={isAccepted ? "accepted" : proposal.status} />
      </header>

      {actionError ? <ErrorBanner>{actionError}</ErrorBanner> : null}

      {/* ----- 1. Guidance ----- */}
      {!isDone ? (
        <Card>
          <H2>What to do</H2>
          <ol className="flex flex-col gap-2">
            {guidanceSteps.map((step, i) => (
              <li
                key={i}
                className={`flex items-start gap-3 border-2 border-black bg-white px-3 py-2 text-sm ${
                  step.done ? "opacity-50" : ""
                }`}
              >
                <span
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border-2 border-black text-[10px] font-black ${
                    step.done ? "bg-black text-white" : "bg-white text-black"
                  }`}
                >
                  {step.done ? "✓" : i + 1}
                </span>
                <span className={step.done ? "line-through" : ""}>
                  {step.text}
                </span>
              </li>
            ))}
          </ol>
        </Card>
      ) : null}

      {/* ----- 2. Progress ----- */}
      {!isDone ? (
        <ProgressStrip signed={signedDocs} total={totalDocs} />
      ) : null}

      {/* ----- 3a. Proposal document ----- */}
      <Card>
        <DocumentHeader
          number={1}
          label="Proposal"
          signed={proposal.has_signature}
          signedAt={proposal.customer_signed_at}
          downloadHref={`/api/portal/proposals/${proposalId}/download/`}
          downloadLabel="Download proposal PDF"
        />
        <ScrollTrackingIframe
          // ``?v=...`` busts the iframe cache whenever the proposal
          // OR any attached spec gets a new signature — Django's
          // proposal HTML render shows ticked acks + the embedded
          // customer signature once those columns are populated, so
          // the iframe needs to re-fetch to surface the freshly-signed
          // state. Browser-level caching would otherwise leave the
          // pre-signature HTML on screen until a hard refresh.
          src={`/api/portal/proposals/${proposalId}/pdf/?v=${proposalIframeVersion(proposal)}`}
          title={`Proposal ${proposal.code}`}
          onAllReadChange={(done) =>
            setReadState((s) =>
              s["proposal"] === done ? s : { ...s, proposal: done }
            )
          }
        />

        {!proposal.has_signature ? (
          <div className="mt-6 flex flex-col gap-4 border-t-2 border-dashed border-black pt-6">
            <span className="text-xs font-bold uppercase tracking-widest">
              Tick all four to enable signing:
            </span>
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
            <div>
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
              {!proposalReadEnough ? (
                <p className="mt-2 text-[11px] uppercase tracking-widest text-neutral-600">
                  Scroll to the bottom of the proposal to enable signing.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </Card>

      {/* ----- 3b. Each attached spec ----- */}
      {proposal.attached_specs.map((spec, index) => (
        <SpecCard
          key={spec.id}
          number={index + 2}
          spec={spec}
          read={readState[`spec:${spec.id}`] ?? false}
          onAllReadChange={(done) =>
            setReadState((s) => {
              const key = `spec:${spec.id}`;
              return s[key] === done ? s : { ...s, [key]: done };
            })
          }
          onSign={() =>
            setPending({
              kind: "spec",
              sheetId: spec.id,
              label: `Spec ${spec.code || index + 1}`,
            })
          }
        />
      ))}

      {/* ----- 4. Accept / Decline pair ----- */}
      <Card>
        <H2>Your decision</H2>
        {isAccepted ? (
          <DecisionBanner kind="accepted" />
        ) : isRejected ? (
          <DecisionBanner kind="rejected" />
        ) : (
          <>
            <P>
              When every document is signed, accept the proposal to confirm
              the deal. If something isn&apos;t right, decline and tell us
              why.
            </P>
            <div className="flex flex-col gap-3 sm:flex-row">
              <PortalButton
                type="button"
                disabled={!allSigned || finalizing}
                onClick={onAccept}
                className="flex-1"
              >
                <Sparkles className="mr-2 h-4 w-4" />
                {finalizing ? "Accepting…" : "Accept proposal"}
              </PortalButton>
              <Link
                href={`/portal/proposals/${proposalId}/reject`}
                className="flex-1"
              >
                <PortalButton
                  type="button"
                  variant="secondary"
                  className="w-full"
                >
                  <XCircle className="mr-2 h-4 w-4" />
                  Decline proposal
                </PortalButton>
              </Link>
            </div>
            {!allSigned ? (
              <p className="mt-2 text-[11px] uppercase tracking-widest text-neutral-600">
                Accept stays disabled until every document above is signed.
              </p>
            ) : null}
          </>
        )}
      </Card>

      {/* ----- 5. Messages ----- */}
      <MessagesPanel proposalId={proposalId} />

      {/* ----- Signature dialog (brutalist port of staff SignatureDialog) ----- */}
      <PortalSignatureDialog
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


function DocumentHeader({
  number,
  label,
  signed,
  signedAt,
  downloadHref,
  downloadLabel,
}: {
  number: number;
  label: string;
  signed: boolean;
  signedAt: string | null;
  downloadHref?: string;
  downloadLabel?: string;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <span
          className={`flex h-8 w-8 items-center justify-center border-2 border-black text-sm font-black ${
            signed ? "bg-black text-white" : "bg-white text-black"
          }`}
        >
          {signed ? <CheckCircle2 className="h-4 w-4" /> : number}
        </span>
        <H2>{label}</H2>
      </div>
      <div className="flex items-center gap-3">
        {downloadHref ? (
          <a href={downloadHref} target="_blank" rel="noreferrer">
            <PortalButton type="button" variant="secondary">
              <Download className="mr-2 h-4 w-4" />
              {downloadLabel || "Download"}
            </PortalButton>
          </a>
        ) : null}
        {signed ? <SignedPill at={signedAt} /> : null}
      </div>
    </div>
  );
}


function SpecCard({
  number,
  spec,
  read,
  onAllReadChange,
  onSign,
}: {
  number: number;
  spec: SpecRecord;
  read: boolean;
  onAllReadChange: (allRead: boolean) => void;
  onSign: () => void;
}) {
  return (
    <Card>
      <DocumentHeader
        number={number}
        label={`Specification ${spec.code || ""}`.trim() || `Specification ${number - 1}`}
        signed={spec.has_signature}
        signedAt={spec.customer_signed_at}
      />
      {spec.formulation_name ? (
        <p className="mb-3 text-[11px] uppercase tracking-widest text-neutral-600">
          {spec.formulation_name}
        </p>
      ) : null}
      <ScrollTrackingDiv
        className="max-h-[700px] overflow-y-auto border-2 border-black bg-white p-6"
        onAllReadChange={onAllReadChange}
      >
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <SpecSheetContent rendered={spec.render_context as any} />
      </ScrollTrackingDiv>
      {!spec.has_signature ? (
        <div className="mt-6 border-t-2 border-dashed border-black pt-6">
          <PortalButton type="button" disabled={!read} onClick={onSign}>
            <PenLine className="mr-2 h-4 w-4" />
            Sign this specification
          </PortalButton>
          {!read ? (
            <p className="mt-2 text-[11px] uppercase tracking-widest text-neutral-600">
              Scroll to the bottom to enable signing.
            </p>
          ) : null}
        </div>
      ) : null}
    </Card>
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
  // Port of the legacy kiosk's ScrollTrackingIframe — self-owned
  // progress state, parent only learns about the
  // crossed-the-threshold boolean. The previous portal
  // implementation drove parent state directly on every poll;
  // that caused the parent to recreate inline callbacks each
  // render, blowing the useEffect dep + producing the
  // "Maximum update depth exceeded" loop. Owning the state here
  // ends the round-trip.
  const [progress, setProgress] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const allDone = progress >= READ_THRESHOLD;
  // Stash the parent callback so the threshold-effect can fire on
  // ``allDone`` flips without re-running on every callback identity
  // change.
  const cbRef = useRef(onAllReadChange);
  useEffect(() => {
    cbRef.current = onAllReadChange;
  }, [onAllReadChange]);
  useEffect(() => {
    cbRef.current(allDone);
  }, [allDone]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const iframe = iframeRef.current;
      if (iframe === null) return;
      const win = iframe.contentWindow;
      const doc = iframe.contentDocument;
      if (win === null || doc === null) return;
      // Three guards (verbatim from the kiosk):
      //   1. ``readyState === "complete"`` — DOMContentLoaded + every
      //      subresource has loaded. Before this the iframe's
      //      ``scrollHeight`` is the height of the fragment parsed
      //      so far, not the real document.
      //   2. URL is not ``about:blank`` — the placeholder document
      //      a fresh iframe carries before the real ``src`` finishes
      //      loading. Its ``scrollHeight`` matches ``clientHeight``,
      //      which the "scrollable ≤ 0 → fully read" branch would
      //      otherwise misread as "already done".
      //   3. URL is not "" — same reasoning, alternate UA.
      if (doc.readyState !== "complete") return;
      const docUrl = doc.URL || "";
      if (docUrl === "" || docUrl === "about:blank") return;

      const root = doc.documentElement;
      if (root === null) return;

      const scrollTop = win.scrollY;
      const clientHeight = win.innerHeight;
      const scrollHeight = root.scrollHeight;
      if (scrollHeight <= 0 || clientHeight <= 0) return;
      const scrollable = Math.max(0, scrollHeight - clientHeight);
      if (scrollable <= 0) {
        setProgress(1);
        return;
      }
      const fraction = scrollTop / scrollable;
      setProgress((prev) =>
        fraction > prev ? Math.min(1, fraction) : prev,
      );
    };

    // First tick fires immediately so a fast-loading document
    // doesn't wait 250ms for the initial measurement.
    tick();
    const id = window.setInterval(tick, 250);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [src]);

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
      <ReadProgressBar
        value={progress}
        onForceRead={() => setProgress(1)}
      />
    </div>
  );
}


function ScrollTrackingDiv({
  className,
  children,
  onAllReadChange,
}: {
  className: string;
  children: React.ReactNode;
  onAllReadChange: (allRead: boolean) => void;
}) {
  // Mirrors the kiosk's InlineSpecPreview tracking — self-owned
  // monotone progress state; parent only learns when the
  // threshold flips. Polling instead of pure scroll listener
  // because ``ResizeObserver`` + ``scroll`` listeners both miss
  // the "content grew after I sat at the bottom" edge case
  // (image loads, height jumps, scroll position no longer at
  // bottom relative to new total) — 4Hz polling catches it.
  const [progress, setProgress] = useState(0);
  const ref = useRef<HTMLDivElement | null>(null);
  const allDone = progress >= READ_THRESHOLD;
  const cbRef = useRef(onAllReadChange);
  useEffect(() => {
    cbRef.current = onAllReadChange;
  }, [onAllReadChange]);
  useEffect(() => {
    cbRef.current(allDone);
  }, [allDone]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const el = ref.current;
      if (el === null) return;
      const scrollTop = el.scrollTop;
      const clientHeight = el.clientHeight;
      const scrollHeight = el.scrollHeight;
      if (scrollHeight <= 0 || clientHeight <= 0) return;
      const scrollable = Math.max(0, scrollHeight - clientHeight);
      if (scrollable <= 0) {
        // Content fits in the box without scrolling — fully read
        // on first measurement.
        setProgress(1);
        return;
      }
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
  }, []);

  return (
    <div className="flex flex-col gap-2">
      <div ref={ref} className={className}>
        {children}
      </div>
      <ReadProgressBar
        value={progress}
        onForceRead={() => setProgress(1)}
      />
    </div>
  );
}


function ReadProgressBar({
  value,
  onForceRead,
}: {
  value: number;
  /** Escape hatch — clicking "Mark as read" sets the progress to
   *  100% manually. Kept around because some iframe content
   *  templates (legacy quirks-mode) report ``scrollHeight ===
   *  clientHeight`` even when content overflows, leaving the
   *  customer unable to advance. The button is small + secondary
   *  so it doesn't tempt customers to skip the actual reading. */
  onForceRead?: () => void;
}) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between text-[10px] font-bold uppercase tracking-widest">
        <span>Read progress</span>
        <span>{pct}%</span>
      </div>
      <div className="h-2 w-full border-2 border-black">
        <div
          className="h-full bg-black transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      {pct < 98 && onForceRead ? (
        <button
          type="button"
          onClick={onForceRead}
          className="mt-2 text-[10px] font-bold uppercase tracking-widest underline opacity-60 hover:opacity-100"
        >
          Mark as read
        </button>
      ) : null}
    </div>
  );
}


function ProgressStrip({
  signed,
  total,
}: {
  signed: number;
  total: number;
}) {
  const pct = total === 0 ? 0 : Math.round((signed / total) * 100);
  return (
    <div className="border-2 border-black bg-white p-3">
      <div className="mb-2 flex items-center justify-between text-[11px] font-bold uppercase tracking-widest">
        <span>Signing progress</span>
        <span>
          {signed} / {total} signed
        </span>
      </div>
      <div className="flex h-2 w-full border-2 border-black">
        <div className="h-full bg-black transition-all" style={{ width: `${pct}%` }} />
      </div>
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


function DecisionBanner({ kind }: { kind: "accepted" | "rejected" }) {
  const accepted = kind === "accepted";
  return (
    <div
      className={`border-2 border-black px-4 py-3 text-sm font-bold uppercase tracking-widest ${
        accepted ? "bg-black text-white" : "bg-white text-black"
      }`}
    >
      {accepted ? (
        <>
          <CheckCircle2 className="mr-2 inline h-4 w-4" /> Accepted — the Vita
          team has been notified.
        </>
      ) : (
        <>
          <XCircle className="mr-2 inline h-4 w-4" /> Declined — the Vita team
          has been notified.
        </>
      )}
    </div>
  );
}
