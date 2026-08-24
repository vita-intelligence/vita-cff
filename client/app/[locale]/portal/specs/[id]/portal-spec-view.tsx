"use client";

import { AlertTriangle, CheckCircle2, PenLine, ShieldCheck, XCircle } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  Card,
  ErrorBanner,
  Eyebrow,
  PageHeader,
  PortalButton,
  SignedChip,
  StatusPill,
} from "@/components/portal/brutalist";
import { PortalSignatureDialog } from "@/components/portal/portal-signature-dialog";
import { SpecChatPanel } from "@/components/portal/spec-chat-panel";
import { apiClient } from "@/lib/api";
import { portalErrorMessage } from "@/services/portal/errors";
import { fetchSpec, type PortalSpecListItem } from "@/services/portal/api";
import { SpecSheetContent } from "../../../specifications/[id]/specification-sheet-view";


// Three affirmations a customer must check before the FINAL signature
// pad opens — turns the click into a deliberate "I'm done, ship it"
// rather than a follow-the-arrow auto-sign. Phrasing mirrors the
// industry-standard production-authorisation language.
const FINAL_AFFIRMATIONS: ReadonlyArray<{
  readonly key: string;
  readonly label: string;
}> = [
  {
    key: "reviewed_trial",
    label: "I have reviewed the trial batch results.",
  },
  {
    key: "recipe_matches",
    label:
      "I confirm the recipe matches what was agreed and the product meets my expectations.",
  },
  {
    key: "authorise_production",
    label:
      "I authorise production at the quantity and terms agreed in the original proposal.",
  },
];


const READ_THRESHOLD = 0.98;


type SpecDetail = PortalSpecListItem & { render_context: unknown };


export function PortalSpecView({ sheetId }: { sheetId: string }) {
  const [spec, setSpec] = useState<SpecDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const [allRead, setAllRead] = useState(false);
  // Affirmation checkboxes — only used on FINAL specs. All three
  // must be ticked before the Sign button enables.
  const [affirmations, setAffirmations] = useState<Record<string, boolean>>(
    () => Object.fromEntries(FINAL_AFFIRMATIONS.map((a) => [a.key, false])),
  );

  const load = useCallback(async () => {
    try {
      const fresh = await fetchSpec(sheetId);
      setSpec(fresh);
      setLoadError(null);
    } catch (err: unknown) {
      setLoadError(portalErrorMessage(err));
    }
  }, [sheetId]);

  useEffect(() => {
    load();
  }, [load]);

  const [acknowledgedUpdatedTotal, setAcknowledgedUpdatedTotal] =
    useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);

  async function onReject(reason: string) {
    setActionError(null);
    setBusy(true);
    try {
      await apiClient.post(`/api/portal/specs/${sheetId}/reject/`, {
        reason,
      });
      setRejectOpen(false);
      await load();
    } catch (err: unknown) {
      setActionError(portalErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSign(dataUrl: string) {
    setActionError(null);
    setBusy(true);
    try {
      // FINAL specs are standalone (not bundled into a proposal),
      // so they sign via the standalone ``/portal/specs/<id>/sign/``
      // endpoint. Proposal-bundled drafts still use the existing
      // proposal-scoped path so the proposal + spec sign in the same
      // kiosk session as before.
      const url =
        spec?.document_kind === "final" || !spec?.proposal?.id
          ? `/api/portal/specs/${sheetId}/sign/`
          : `/api/portal/proposals/${spec.proposal.id}/specs/${sheetId}/sign/`;
      // ``acknowledged_updated_total`` is the server-side gate for
      // FINAL specs whose auto-computed invoice deviates > 15% from
      // the original proposal remainder. Always safe to send; server
      // ignores it on DRAFT / no-delta signs.
      await apiClient.post(url, {
        signature_image: dataUrl,
        acknowledged_updated_total: acknowledgedUpdatedTotal,
      });
      setPending(false);
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
          href="/portal/specs"
          className="text-xs font-bold uppercase tracking-widest underline"
        >
          ← Back to specifications
        </Link>
      </Card>
    );
  }

  if (!spec) return <p>Loading…</p>;

  const isFinal = spec.document_kind === "final";
  const isRejected = spec.status === "rejected";
  const allAffirmed =
    !isFinal || FINAL_AFFIRMATIONS.every((a) => affirmations[a.key]);
  // Delta-info drives an additional acknowledgement gate on FINALs
  // whose auto-computed invoice deviates from the original proposal
  // remainder by more than the ``threshold_percent``. Belt-and-
  // braces: server enforces the same rule; the FE just prevents the
  // customer from submitting without seeing the number first.
  const needsPriceAck = Boolean(
    spec.delta_info?.requires_acknowledgement && !spec.has_signature,
  );
  const priceAcked = !needsPriceAck || acknowledgedUpdatedTotal;
  // The proposal-sent gate only applies to DRAFT specs — they're
  // bundled into a proposal that has to still be at status=sent for
  // the kiosk's two-document sign flow. FINAL specs are standalone,
  // post-trial documents; their parent proposal has long since been
  // accepted, so we drop the gate on this path and rely on the
  // spec's own ``status=sent`` (backend-enforced) instead.
  const canSign =
    !spec.has_signature
    && allRead
    && allAffirmed
    && priceAcked
    && (
      isFinal
        ? spec.status === "sent"
        : spec.proposal !== null && spec.proposal.status === "sent"
    );
  const proposalCode = spec.proposal?.code ?? "";

  return (
    <div className="flex flex-col gap-8">
      {isFinal && !spec.has_signature && !isRejected ? (
        <FinalProductionBanner proposalCode={proposalCode} />
      ) : null}

      {isRejected ? <RejectedBanner spec={spec} /> : null}

      <PageHeader
        eyebrow={
          isFinal
            ? "FINAL — PRODUCTION AUTHORISATION"
            : spec.proposal
              ? `Proposal ${spec.proposal.code}`
              : "Specification"
        }
        title={
          isFinal
            ? `Final specification · ${spec.formulation_name || spec.code || "your product"}`
            : spec.formulation_name || spec.code || "Specification"
        }
        subtitle={spec.code ? `Reference: ${spec.code}` : undefined}
        back={
          spec.proposal
            ? {
                href: `/portal/proposals/${spec.proposal.id}`,
                label: `Proposal ${spec.proposal.code}`,
              }
            : { href: "/portal/specs", label: "Specifications" }
        }
        actions={
          <>
            {spec.has_signature ? (
              <SignedChip at={spec.customer_signed_at} />
            ) : (
              <StatusPill status={spec.status} />
            )}
          </>
        }
      />

      {actionError ? <ErrorBanner>{actionError}</ErrorBanner> : null}

      <Card>
        <div className="mb-4 flex items-center justify-between">
          <Eyebrow>Document</Eyebrow>
        </div>
        <ScrollTrackingDiv
          className="max-h-[760px] overflow-y-auto border-2 border-black bg-white p-6 sm:p-8"
          onAllReadChange={setAllRead}
        >
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          <SpecSheetContent rendered={spec.render_context as any} />
        </ScrollTrackingDiv>

        {!spec.has_signature && !isRejected && isFinal && spec.delta_info ? (
          <UpdatedPriceBlock
            delta={spec.delta_info}
            acknowledged={acknowledgedUpdatedTotal}
            onAcknowledgedChange={setAcknowledgedUpdatedTotal}
          />
        ) : null}

        {!spec.has_signature && !isRejected && isFinal ? (
          <div className="mt-6 border-t-2 border-dashed border-black pt-6">
            <p className="text-[11px] font-bold uppercase tracking-widest text-neutral-700">
              Before signing, please confirm:
            </p>
            <ul className="mt-3 space-y-2">
              {FINAL_AFFIRMATIONS.map((a) => (
                <li key={a.key} className="flex items-start gap-3">
                  <input
                    id={`aff-${a.key}`}
                    type="checkbox"
                    checked={Boolean(affirmations[a.key])}
                    onChange={(e) =>
                      setAffirmations({
                        ...affirmations,
                        [a.key]: e.target.checked,
                      })
                    }
                    className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer border-2 border-black accent-black"
                  />
                  <label
                    htmlFor={`aff-${a.key}`}
                    className="cursor-pointer text-sm text-black"
                  >
                    {a.label}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {!spec.has_signature && !isRejected ? (
          <div className="mt-6 border-t-2 border-dashed border-black pt-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <PortalButton
                type="button"
                disabled={!canSign}
                onClick={() => setPending(true)}
              >
                <PenLine className="h-4 w-4" />
                {isFinal ? "Authorise production & sign" : "Sign this specification"}
              </PortalButton>
              {isFinal ? (
                <button
                  type="button"
                  onClick={() => setRejectOpen(true)}
                  className="inline-flex items-center gap-2 border-2 border-red-700 bg-white px-4 py-2 text-xs font-bold uppercase tracking-widest text-red-800 transition-transform hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-[3px_3px_0_0_black]"
                >
                  <XCircle className="h-4 w-4" />
                  Reject
                </button>
              ) : null}
            </div>
            {!allRead ? (
              <p className="mt-2 text-[11px] uppercase tracking-widest text-neutral-600">
                Scroll to the bottom to enable signing.
              </p>
            ) : !allAffirmed ? (
              <p className="mt-2 text-[11px] uppercase tracking-widest text-neutral-600">
                Tick the three confirmations above to enable signing.
              </p>
            ) : !priceAcked ? (
              <p className="mt-2 text-[11px] uppercase tracking-widest text-amber-700">
                Tick "I accept the updated total" above to enable signing.
              </p>
            ) : null}
          </div>
        ) : (
          <SignedConfirmation isFinal={isFinal} />
        )}
      </Card>

      <SpecChatPanel sheetId={sheetId} sheetCode={spec.code} />

      <RejectDialog
        isOpen={rejectOpen}
        onClose={() => {
          setRejectOpen(false);
          setActionError(null);
        }}
        onConfirm={onReject}
        busy={busy}
        errorMessage={actionError}
      />

      <PortalSignatureDialog
        isOpen={pending}
        onOpenChange={(open) => {
          if (!open) {
            setPending(false);
            setActionError(null);
          }
        }}
        title={
          isFinal
            ? `Authorise production — ${spec.code || "final specification"}`
            : `Sign — ${spec.code || "specification"}`
        }
        subtitle={
          isFinal
            ? `By signing, you confirm you're satisfied with the product and authorise Vita Manufacture to produce the quantity agreed in proposal ${proposalCode || "(see your proposals)"}.`
            : "Draw your signature with your mouse, finger or stylus."
        }
        confirmLabel={isFinal ? "I authorise production" : "Submit signature"}
        busy={busy}
        errorMessage={actionError}
        onConfirm={onSign}
      />
    </div>
  );
}


// Reject confirmation dialog for FINAL specs. The wording is
// deliberately explicit about the downstream consequence — a
// rejection re-opens the trial-batch cycle and the customer will
// have to pay for more samples before we can send another FINAL.
// This is the only place on the portal where the customer can
// escalate a "no" back into the pipeline, so we want the trade-off
// to be un-missable.
function RejectDialog({
  isOpen,
  onClose,
  onConfirm,
  busy,
  errorMessage,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  busy: boolean;
  errorMessage: string | null;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose, busy]);
  if (!isOpen) return null;
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="reject-title"
      className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="relative w-full max-w-lg border-2 border-black bg-white p-5 shadow-[6px_6px_0_0_black]"
        onClick={(e) => e.stopPropagation()}
      >
        <p
          id="reject-title"
          className="text-[10px] font-bold uppercase tracking-[0.3em] text-red-800"
        >
          Reject this final specification?
        </p>
        <div className="mt-3 border-2 border-amber-500 bg-amber-50 p-3 text-xs text-amber-900">
          <p className="font-bold uppercase tracking-widest">
            What happens next
          </p>
          <p className="mt-1">
            Rejecting means we go back to trial batches. Before we can
            send another final specification you&rsquo;ll need to:
          </p>
          <ol className="mt-2 list-decimal space-y-0.5 pl-5">
            <li>Order more samples on the portal (we invoice for each).</li>
            <li>Wait for finance to approve the invoice.</li>
            <li>Receive the new samples and give us feedback.</li>
            <li>Confirm you&rsquo;re happy with the recipe again.</li>
          </ol>
          <p className="mt-2">
            Only reject if the recipe truly needs more work — if you&rsquo;re
            unsure, message us in the project chat first.
          </p>
        </div>
        <label className="mt-4 flex flex-col gap-1.5">
          <span className="text-xs font-medium text-black">
            Why are you rejecting? (required)
          </span>
          <textarea
            rows={4}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Taste is off in the last sample — we need to revisit sweetness levels."
            className="border-2 border-black bg-white px-3 py-2 text-sm focus:outline-none"
          />
        </label>
        {errorMessage ? (
          <p className="mt-3 border-2 border-red-700 bg-red-100 px-3 py-2 text-sm text-red-900">
            {errorMessage}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="border-2 border-black bg-white px-4 py-2 text-xs font-bold uppercase tracking-widest text-black transition-transform hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-[3px_3px_0_0_black] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(reason.trim())}
            disabled={busy || reason.trim().length === 0}
            className="inline-flex items-center gap-2 border-2 border-red-700 bg-red-700 px-4 py-2 text-xs font-bold uppercase tracking-widest text-white transition-transform hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-[3px_3px_0_0_black] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <XCircle className="h-3.5 w-3.5" />
            Reject &amp; restart trial batches
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}


// Delta-info renderer: shows the customer what the final invoice
// actually looks like when the recipe evolved during trials and the
// price moved beyond the ``threshold_percent`` window vs. the
// proposal remainder. Always renders when ``delta_info`` is present
// (so the customer sees the full breakdown even for small
// deviations), but the acknowledgement checkbox is only shown +
// mandatory when ``requires_acknowledgement`` is true.
function UpdatedPriceBlock({
  delta,
  acknowledged,
  onAcknowledgedChange,
}: {
  delta: NonNullable<PortalSpecListItem["delta_info"]>;
  acknowledged: boolean;
  onAcknowledgedChange: (v: boolean) => void;
}) {
  const money = (v: string) => `${delta.currency} ${v}`;
  const deltaPercent = Number.parseFloat(delta.delta_percent);
  const deltaAmount = Number.parseFloat(delta.delta_amount);
  const isPricier = deltaAmount > 0;
  return (
    <div
      className={
        "mt-6 border-2 p-4 " +
        (delta.requires_acknowledgement
          ? "border-amber-600 bg-amber-50"
          : "border-black bg-white")
      }
    >
      <div className="flex items-start gap-3">
        <AlertTriangle
          className={
            "mt-0.5 h-5 w-5 shrink-0 " +
            (delta.requires_acknowledgement ? "text-amber-700" : "text-black")
          }
        />
        <div className="flex-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-black">
            {delta.requires_acknowledgement
              ? "Updated price — please review"
              : "Your invoice"}
          </p>
          <p className="mt-2 text-sm text-black">
            The recipe evolved during trials, so the final invoice
            differs from what was quoted in the original proposal.
            Here&rsquo;s the breakdown:
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-[13px]">
            <dt className="text-neutral-700">Final spec total</dt>
            <dd className="text-right font-mono">
              {money(delta.final_spec_total)}
            </dd>
            <dt className="text-neutral-700">Deposit already paid</dt>
            <dd className="text-right font-mono text-neutral-700">
              −{money(delta.deposit_paid)}
            </dd>
            <dt className="border-t border-black/30 pt-1 font-semibold">
              You pay now
            </dt>
            <dd className="border-t border-black/30 pt-1 text-right font-mono font-bold">
              {money(delta.amount_due)}
            </dd>
          </dl>
          <p className="mt-3 text-xs text-neutral-700">
            Original proposal remainder was {money(delta.proposal_remainder)}.
            That&rsquo;s {isPricier ? "+" : ""}
            {money(delta.delta_amount)} ({isPricier ? "+" : ""}
            {deltaPercent.toFixed(1)}%) vs. the new number.
          </p>
          {delta.requires_acknowledgement ? (
            <label className="mt-4 flex cursor-pointer items-start gap-3 border-t border-amber-600/40 pt-3">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => onAcknowledgedChange(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 border-2 border-black accent-amber-600"
              />
              <span className="text-sm font-semibold text-black">
                I accept the updated total of {money(delta.amount_due)}.
              </span>
            </label>
          ) : null}
        </div>
      </div>
    </div>
  );
}


function RejectedBanner({ spec }: { spec: PortalSpecListItem }) {
  const at = spec.customer_rejected_at
    ? new Date(spec.customer_rejected_at).toLocaleString()
    : null;
  return (
    <div className="relative border-2 border-red-700 bg-red-50 px-5 py-4">
      <div className="flex items-start gap-3">
        <XCircle className="mt-0.5 h-6 w-6 shrink-0 text-red-700" />
        <div className="flex-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-red-800">
            You rejected this final specification
          </p>
          <p className="mt-1 text-sm font-medium leading-snug text-red-900">
            We&rsquo;ve reopened trial batches on your project — head back
            to the project page to order more samples and iterate towards
            a new final specification.
          </p>
          {spec.customer_rejection_reason ? (
            <div className="mt-3 border-2 border-red-300 bg-white p-3">
              <p className="text-[10px] font-bold uppercase tracking-widest text-red-800">
                Reason you gave
              </p>
              <p className="mt-1 whitespace-pre-line text-sm text-neutral-900">
                {spec.customer_rejection_reason}
              </p>
            </div>
          ) : null}
          {at ? (
            <p className="mt-2 text-[11px] text-red-700/70">Rejected {at}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}


function FinalProductionBanner({
  proposalCode,
}: {
  proposalCode: string;
}) {
  return (
    <div className="relative border-2 border-black bg-orange-500 px-5 py-4 text-black">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-6 w-6 shrink-0" />
        <div className="flex-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.3em]">
            Final · Production authorisation
          </p>
          <p className="mt-1 text-sm font-medium leading-snug">
            This is the production-ready version of your specification. Signing
            it authorises Vita Manufacture to begin production at the
            quantities and terms agreed in
            {proposalCode ? (
              <>
                {" "}
                <span className="font-bold underline">proposal {proposalCode}</span>.
              </>
            ) : (
              <> your original proposal.</>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}


function SignedConfirmation({ isFinal }: { isFinal: boolean }) {
  return (
    <div className="mt-6 border-2 border-black bg-black p-5 text-white">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.3em]">
            {isFinal ? "Production authorised" : "Specification signed"}
          </p>
          <p className="mt-1 text-sm font-medium leading-snug">
            {isFinal
              ? "Thank you — your product is now authorised for production. We'll invoice you and get moving as soon as payment lands."
              : "You signed this specification. We'll be in touch with next steps shortly."}
          </p>
        </div>
      </div>
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
      if (!el) return;
      const scrollTop = el.scrollTop;
      const clientHeight = el.clientHeight;
      const scrollHeight = el.scrollHeight;
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
    tick();
    const id = window.setInterval(tick, 250);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const pct = Math.round(progress * 100);

  return (
    <div className="flex flex-col gap-2">
      <div ref={ref} className={className}>
        {children}
      </div>
      <div className="mt-2 flex items-center justify-between text-[10px] font-bold uppercase tracking-widest">
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
