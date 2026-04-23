"use client";

/**
 * Proposal-centric kiosk interactive surface.
 *
 * The client walks through three phases:
 *
 * 1. **Identify** — a kiosk session cookie must be bound to this
 *    proposal's token before any signature is accepted. If the
 *    visitor has not introduced themselves yet (no localStorage
 *    marker + no session cookie) the identity modal pops
 *    immediately; every subsequent render of this component
 *    assumes we have a session.
 * 2. **Sign each document** — the proposal plus every attached
 *    spec sheet renders as its own card with a "Sign this"
 *    button. Clicking opens :component:`SignatureDialog`; the
 *    captured PNG posts to the per-document endpoint which
 *    writes the signature without advancing status.
 * 3. **Finalize** — enabled only when every card reports
 *    ``has_signature``. The finalize POST flips the whole bundle
 *    (proposal + all specs) to ``accepted`` atomically. Until
 *    then a refresh keeps the partially-signed state.
 *
 * The all-or-nothing rule is load-bearing legally: a deal that
 * landed in ``accepted`` with half the specs unsigned would let
 * the client later dispute the unsigned terms, so we keep every
 * document at ``sent`` until the whole set is complete.
 */

import { Button } from "@heroui/react";
import { CheckCircle2, FileText, PenLine, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { KioskIdentityModal } from "@/components/comments/kiosk/kiosk-identity-modal";
import { SignatureDialog } from "@/components/ui/signature-dialog";
import { ApiError, apiClient } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import type { KioskIdentityEcho } from "@/services/comments/kiosk-api";
import {
  proposalsEndpoints,
  type ProposalKioskDto,
  type ProposalKioskSpecDto,
} from "@/services/proposals";


interface KioskMarker {
  readonly name: string;
  readonly email: string;
  readonly company?: string;
}


/** Keep this key in sync with ``identifiedKey`` in
 *  ``kiosk-comments-panel.tsx`` — the comments and signing flows
 *  both gate on the same marker, so a visitor who identified in
 *  one place can sign in the other without re-entering. */
function readIdentityMarker(token: string): KioskMarker | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(
      `vita_kiosk_${token}_identified`,
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<KioskMarker>;
    if (!parsed.name || !parsed.email) return null;
    return {
      name: parsed.name,
      email: parsed.email,
      company: parsed.company ?? "",
    };
  } catch {
    return null;
  }
}


function writeIdentityMarker(token: string, marker: KioskMarker): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      `vita_kiosk_${token}_identified`,
      JSON.stringify(marker),
    );
  } catch {
    // localStorage disabled — server session cookie still gates
    // signing, so we silently drop the marker rather than block.
  }
}


type Pending =
  | { kind: "proposal" }
  | { kind: "spec"; sheet: ProposalKioskSpecDto };


export function ProposalKioskView({
  token,
  kiosk,
}: {
  token: string;
  kiosk: ProposalKioskDto;
}) {
  const tProposals = useTranslations("proposals");
  const tErrors = useTranslations("errors");
  const router = useRouter();

  // Identity gate — mirrors the spec kiosk's pattern. ``identified``
  // becomes true once localStorage carries a marker for this token,
  // which means the user has completed the identity modal at least
  // once (session cookie already set server-side at that point).
  const [identified, setIdentified] = useState<boolean>(false);
  const [identifying, setIdentifying] = useState<boolean>(false);
  useEffect(() => {
    const marker = readIdentityMarker(token);
    if (marker) {
      setIdentified(true);
    } else {
      setIdentifying(true);
    }
  }, [token]);

  const handleIdentity = (echo: KioskIdentityEcho) => {
    writeIdentityMarker(token, {
      name: echo.name,
      email: echo.email,
      company: echo.company,
    });
    setIdentified(true);
    setIdentifying(false);
  };

  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [finalizing, setFinalizing] = useState<boolean>(false);

  const allSigned = useMemo(() => {
    if (!kiosk.has_signature) return false;
    return kiosk.attached_specs.every((s) => s.has_signature);
  }, [kiosk]);

  const isAccepted = kiosk.status === "accepted";

  const handleSign = async (dataUrl: string) => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const url =
        pending.kind === "proposal"
          ? proposalsEndpoints.publicSign(token)
          : proposalsEndpoints.publicSignSpec(token, pending.sheet.id);
      await apiClient.post(url, { signature_image: dataUrl });
      setPending(null);
      router.refresh();
    } catch (err) {
      setError(extractErrorMessage(err, tErrors));
    } finally {
      setBusy(false);
    }
  };

  const handleFinalize = async () => {
    setFinalizing(true);
    setError(null);
    try {
      await apiClient.post(proposalsEndpoints.publicFinalize(token));
      router.refresh();
    } catch (err) {
      setError(extractErrorMessage(err, tErrors));
    } finally {
      setFinalizing(false);
    }
  };

  return (
    <>
      {identifying ? (
        <KioskIdentityModal
          token={token}
          onIdentified={handleIdentity}
          onDismiss={() => {
            // Identity capture is mandatory for signing; if the
            // visitor dismisses, we drop them back to a read-only
            // view until they click a Sign button which re-opens
            // the modal.
            setIdentifying(false);
          }}
        />
      ) : null}

      {/* -------------------------------------------------------------- */}
      {/* Header                                                          */}
      {/* -------------------------------------------------------------- */}
      <section className="mt-6 rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 md:p-8">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
          {kiosk.code}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink-1000 md:text-3xl">
          {kiosk.customer_company ||
            kiosk.customer_name ||
            tProposals("public.header_fallback")}
        </h1>
        {kiosk.total_excl_vat ? (
          <p className="mt-2 text-sm text-ink-600">
            {tProposals("public.total_hint", {
              total: kiosk.total_excl_vat,
              currency: kiosk.currency,
            })}
          </p>
        ) : null}
        {isAccepted ? (
          <div className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success ring-1 ring-inset ring-success/30">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {tProposals("public.status_accepted")}
          </div>
        ) : null}
      </section>

      {/* -------------------------------------------------------------- */}
      {/* Per-document signature cards                                    */}
      {/* -------------------------------------------------------------- */}
      <section className="mt-6 flex flex-col gap-3">
        <DocumentCard
          icon={<FileText className="h-4 w-4 text-orange-600" />}
          title={tProposals("public.doc.proposal_title")}
          subtitle={tProposals("public.doc.proposal_subtitle")}
          signedAt={kiosk.customer_signed_at}
          hasSignature={kiosk.has_signature}
          locked={isAccepted}
          onSign={() => {
            if (!identified) {
              setIdentifying(true);
              return;
            }
            setError(null);
            setPending({ kind: "proposal" });
          }}
          tProposals={tProposals}
        />

        {kiosk.attached_specs.map((sheet) => (
          <DocumentCard
            key={sheet.id}
            icon={<Sparkles className="h-4 w-4 text-orange-600" />}
            title={
              sheet.formulation_name
                ? tProposals("public.doc.spec_title", {
                    name: sheet.formulation_name,
                  })
                : tProposals("public.doc.spec_title_untitled")
            }
            subtitle={[
              sheet.code,
              sheet.formulation_version_number
                ? `v${sheet.formulation_version_number}`
                : null,
              sheet.document_kind === "final"
                ? tProposals("public.doc.spec_final")
                : tProposals("public.doc.spec_draft"),
            ]
              .filter(Boolean)
              .join(" · ")}
            signedAt={sheet.customer_signed_at}
            hasSignature={sheet.has_signature}
            locked={isAccepted}
            onSign={() => {
              if (!identified) {
                setIdentifying(true);
                return;
              }
              setError(null);
              setPending({ kind: "spec", sheet });
            }}
            tProposals={tProposals}
          />
        ))}
      </section>

      {/* -------------------------------------------------------------- */}
      {/* Finalize                                                        */}
      {/* -------------------------------------------------------------- */}
      {!isAccepted ? (
        <section className="mt-6 rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 md:p-8">
          <p className="text-sm text-ink-600">
            {allSigned
              ? tProposals("public.finalize_ready")
              : tProposals("public.finalize_hint")}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              type="button"
              onClick={handleFinalize}
              isDisabled={!allSigned || finalizing}
              className="inline-flex h-11 items-center gap-1.5 rounded-lg bg-orange-500 px-5 text-sm font-medium text-ink-0 hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <CheckCircle2 className="h-4 w-4" />
              {tProposals("public.finalize_cta")}
            </Button>
          </div>
        </section>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="mt-6 rounded-xl bg-danger/10 px-4 py-3 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
        >
          {error}
        </p>
      ) : null}

      <SignatureDialog
        isOpen={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={
          pending?.kind === "proposal"
            ? tProposals("public.sign_dialog.proposal_title")
            : tProposals("public.sign_dialog.spec_title")
        }
        subtitle={tProposals("public.sign_dialog.subtitle")}
        confirmLabel={tProposals("public.sign_dialog.confirm")}
        cancelLabel={tProposals("public.sign_dialog.cancel")}
        busy={busy}
        errorMessage={error}
        onConfirm={handleSign}
      />
    </>
  );
}


function DocumentCard({
  icon,
  title,
  subtitle,
  signedAt,
  hasSignature,
  locked,
  onSign,
  tProposals,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  signedAt: string | null;
  hasSignature: boolean;
  locked: boolean;
  onSign: () => void;
  tProposals: ReturnType<typeof useTranslations<"proposals">>;
}) {
  return (
    <article className="flex flex-wrap items-start gap-4 rounded-2xl bg-ink-0 p-5 shadow-sm ring-1 ring-ink-200">
      <div className="flex flex-1 min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          {icon}
          <h3 className="text-sm font-semibold text-ink-1000">{title}</h3>
        </div>
        {subtitle ? (
          <p className="text-xs text-ink-500">{subtitle}</p>
        ) : null}
        {hasSignature && signedAt ? (
          <p className="mt-1 text-[11px] text-ink-500">
            {tProposals("public.doc.signed_on", {
              date: signedAt.slice(0, 10),
            })}
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        {hasSignature ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success ring-1 ring-inset ring-success/30">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {tProposals("public.doc.signed_badge")}
          </span>
        ) : null}
        {!locked ? (
          <Button
            type="button"
            variant={hasSignature ? "outline" : "primary"}
            onClick={onSign}
            className={
              hasSignature
                ? "inline-flex h-10 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                : "inline-flex h-10 items-center gap-1.5 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
            }
          >
            <PenLine className="h-4 w-4" />
            {hasSignature
              ? tProposals("public.doc.resign")
              : tProposals("public.doc.sign_cta")}
          </Button>
        ) : null}
      </div>
    </article>
  );
}


function extractErrorMessage(
  error: unknown,
  tErrors: ReturnType<typeof useTranslations<"errors">>,
): string {
  if (error instanceof ApiError) {
    for (const codes of Object.values(error.fieldErrors)) {
      if (Array.isArray(codes) && codes.length > 0) {
        return translateCode(tErrors, String(codes[0]));
      }
    }
  }
  return tErrors("generic");
}
