"use client";

import { CheckCircle2, PenLine, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

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
      await apiClient.post(url, { signature_image: dataUrl });
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
  const allAffirmed =
    !isFinal || FINAL_AFFIRMATIONS.every((a) => affirmations[a.key]);
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
    && (
      isFinal
        ? spec.status === "sent"
        : spec.proposal !== null && spec.proposal.status === "sent"
    );
  const proposalCode = spec.proposal?.code ?? "";

  return (
    <div className="flex flex-col gap-8">
      {isFinal && !spec.has_signature ? (
        <FinalProductionBanner proposalCode={proposalCode} />
      ) : null}

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

        {!spec.has_signature && isFinal ? (
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

        {!spec.has_signature ? (
          <div className="mt-6 border-t-2 border-dashed border-black pt-6">
            <PortalButton
              type="button"
              disabled={!canSign}
              onClick={() => setPending(true)}
            >
              <PenLine className="h-4 w-4" />
              {isFinal ? "Authorise production & sign" : "Sign this specification"}
            </PortalButton>
            {!allRead ? (
              <p className="mt-2 text-[11px] uppercase tracking-widest text-neutral-600">
                Scroll to the bottom to enable signing.
              </p>
            ) : !allAffirmed ? (
              <p className="mt-2 text-[11px] uppercase tracking-widest text-neutral-600">
                Tick the three confirmations above to enable signing.
              </p>
            ) : null}
          </div>
        ) : (
          <SignedConfirmation isFinal={isFinal} />
        )}
      </Card>

      <SpecChatPanel sheetId={sheetId} sheetCode={spec.code} />

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
              ? "Thank you. Your product is now authorised for production. Next up: label design — head to the Labels tab to choose how you'd like the artwork created."
              : "You signed this specification. We'll be in touch with next steps shortly."}
          </p>
          {isFinal ? (
            <Link
              href="/portal/label-designs"
              className="mt-3 inline-flex items-center gap-1 text-xs font-bold uppercase tracking-widest text-orange-400 underline-offset-4 hover:underline"
            >
              Go to label design →
            </Link>
          ) : null}
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
