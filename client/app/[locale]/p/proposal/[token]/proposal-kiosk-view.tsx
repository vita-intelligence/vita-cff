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

import { Button, Modal } from "@heroui/react";
import {
  CheckCircle2,
  Download,
  FileText,
  MessageCircle,
  PenLine,
  Sparkles,
  XCircle,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { Link } from "@/i18n/navigation";
import { KioskIdentityModal } from "@/components/comments/kiosk/kiosk-identity-modal";
import { SignatureDialog } from "@/components/ui/signature-dialog";
import { apiClient } from "@/lib/api";
import { extractApiErrorMessage } from "@/lib/errors/translate";
import type { KioskIdentityEcho } from "@/services/comments/kiosk-api";
import {
  proposalsEndpoints,
  type ProposalKioskDto,
  type ProposalKioskSpecDto,
} from "@/services/proposals";
import {
  specificationsEndpoints,
  type RenderedSheetContext,
} from "@/services/specifications";
import { SpecSheetContent } from "../../../specifications/[id]/specification-sheet-view";



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

  // Three required acknowledgement tickboxes mirrored on the docx
  // proposal — must all be true before the customer can sign the
  // proposal. Seeded from the server payload so a refresh after
  // signing keeps the boxes ticked. Spec sheets sign without acks
  // (their own consents live on each spec's signature page).
  const [acks, setAcks] = useState<{
    spec_signing: boolean;
    lead_times: boolean;
    terms: boolean;
    rd_terms: boolean;
  }>(() => ({
    spec_signing: kiosk.ack_spec_signing,
    lead_times: kiosk.ack_lead_times,
    terms: kiosk.ack_terms,
    rd_terms: kiosk.ack_rd_terms,
  }));
  useEffect(() => {
    setAcks({
      spec_signing: kiosk.ack_spec_signing,
      lead_times: kiosk.ack_lead_times,
      terms: kiosk.ack_terms,
      rd_terms: kiosk.ack_rd_terms,
    });
  }, [
    kiosk.ack_spec_signing,
    kiosk.ack_lead_times,
    kiosk.ack_terms,
    kiosk.ack_rd_terms,
  ]);
  // R&D Terms tick only required on Custom proposals — Ready-to-Go
  // has no R&D phase so the row is hidden and the gate ignores the
  // value. Backend mirrors this conditional check.
  const isCustom = kiosk.template_type === "custom";
  const allAcksTicked =
    acks.spec_signing &&
    acks.lead_times &&
    acks.terms &&
    (!isCustom || acks.rd_terms);

  // Reading-progress gate. ``ScrollTrackingIframe`` polls its
  // contentWindow's scrollY every 250 ms and flips these once the
  // customer reaches ``READ_THRESHOLD`` of the document. Sign
  // buttons stay disabled until the matching flag is true:
  //
  // * ``allSectionsRead`` gates the proposal's own Sign button.
  // * ``specsRead[<sheet-id>]`` gates each spec card independently —
  //   each spec has its own iframe + its own scroll-to-bottom gate
  //   (mirrors the proposal's UX so the customer can't sign a spec
  //   they haven't actually skimmed).
  const [allSectionsRead, setAllSectionsRead] = useState<boolean>(false);
  const [specsRead, setSpecsRead] = useState<Record<string, boolean>>({});

  const allSigned = useMemo(() => {
    if (!kiosk.has_signature) return false;
    return kiosk.attached_specs.every((s) => s.has_signature);
  }, [kiosk]);

  const isAccepted = kiosk.status === "accepted";
  // The customer can decline a proposal from the kiosk via the
  // "Decline this proposal" button. Once rejected, the page renders
  // a terminal "Declined" banner and hides every sign / finalize
  // affordance — the deal is closed from the customer's side.
  const isRejected = kiosk.status === "rejected";
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [declining, setDeclining] = useState(false);

  const handleSign = async (dataUrl: string) => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const url =
        pending.kind === "proposal"
          ? proposalsEndpoints.publicSign(token)
          : proposalsEndpoints.publicSignSpec(token, pending.sheet.id);
      // Proposal sign carries the three ack flags; spec signs skip
      // them (the spec's own consent lives on its sign page).
      const payload =
        pending.kind === "proposal"
          ? {
              signature_image: dataUrl,
              ack_spec_signing: acks.spec_signing,
              ack_lead_times: acks.lead_times,
              ack_terms: acks.terms,
              // R&D ack is only meaningful on Custom proposals;
              // Ready-to-Go always sends ``false`` and the backend
              // ignores it on that template.
              ack_rd_terms: isCustom ? acks.rd_terms : false,
            }
          : { signature_image: dataUrl };
      await apiClient.post(url, payload);
      setPending(null);
      router.refresh();
    } catch (err) {
      setError(extractApiErrorMessage(err, tErrors));
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
      setError(extractApiErrorMessage(err, tErrors));
    } finally {
      setFinalizing(false);
    }
  };

  const handleDecline = async () => {
    if (!identified) {
      // Identity is also required for the decline path so the audit
      // log captures *who* declined, not just that someone with the
      // public token did. The modal stays open until they finish
      // the identify step.
      setIdentifying(true);
      return;
    }
    setDeclining(true);
    setError(null);
    try {
      await apiClient.post(proposalsEndpoints.publicReject(token), {
        reason: declineReason,
      });
      setDeclineOpen(false);
      setDeclineReason("");
      router.refresh();
    } catch (err) {
      setError(extractApiErrorMessage(err, tErrors));
    } finally {
      setDeclining(false);
    }
  };

  return (
    <>
      {identifying ? (
        <KioskIdentityModal
          token={token}
          basePath={`/api/public/proposals/${token}`}
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
      <section className="mt-6 rounded-2xl bg-ink-0 p-5 shadow-sm ring-1 ring-ink-200 sm:p-6 md:p-8">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
          {kiosk.code}
        </p>
        <h1 className="mt-1 break-words text-xl font-semibold tracking-tight text-ink-1000 sm:text-2xl md:text-3xl">
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
        {isRejected ? (
          <div className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-danger/10 px-3 py-1 text-xs font-medium text-danger ring-1 ring-inset ring-danger/30">
            <XCircle className="h-3.5 w-3.5" />
            {tProposals("public.status_rejected")}
          </div>
        ) : null}
      </section>

      {/* -------------------------------------------------------------- */}
      {/* Per-document signature cards                                    */}
      {/* -------------------------------------------------------------- */}
      <section className="mt-6 flex flex-col gap-3">
        <DocumentCard
          key="proposal"
          icon={<FileText className="h-4 w-4 text-orange-600" />}
          title={tProposals("public.doc.proposal_title")}
          subtitle={tProposals("public.doc.proposal_subtitle")}
          // Proposal preview is the same HTML the in-app proposal
          // page iframes — single template, single rendering
          // engine, so kiosk and in-app are pixel-identical. The
          // scroll-tracking iframe wrapper attaches a scroll
          // listener to the same-origin contentWindow and gates
          // the Sign button on "scrolled to the bottom".
          previewSrc={null}
          previewContent={
            <ScrollTrackingIframe
              // Cache-bust the iframe URL on every state change that
              // affects the rendered HTML (sign timestamp, ack flags).
              // Without this the browser serves the stale HTML after
              // ``router.refresh()`` and the customer doesn't see
              // their ticked boxes / signature image right after
              // signing.
              src={`/api/public/proposals/${token}/pdf/?v=${encodeURIComponent(
                [
                  kiosk.customer_signed_at ?? "",
                  String(kiosk.ack_spec_signing),
                  String(kiosk.ack_lead_times),
                  String(kiosk.ack_terms),
                  String(kiosk.ack_rd_terms),
                ].join("|"),
              )}`}
              title={tProposals("public.doc.preview_label")}
              onAllReadChange={setAllSectionsRead}
              tProposals={tProposals}
            />
          }
          previewLabel={tProposals("public.doc.preview_label")}
          signedAt={kiosk.customer_signed_at}
          hasSignature={kiosk.has_signature}
          locked={isAccepted}
          // Server-rendered WeasyPrint PDF, same content the iframe
          // shows but as a downloadable file the customer can keep
          // for their records.
          downloadHref={proposalsEndpoints.publicDownload(token)}
          downloadLabel={tProposals("public.doc.download_cta")}
          // Two independent gates on the Sign button — both must
          // pass before the signature pad opens:
          //   1. all three acknowledgement tickboxes ticked;
          //   2. every required reading section dwelt-on long
          //      enough that the panel marked it read.
          // The API also enforces (1) server-side. Section tracking
          // is client-side only for now (server-side audit is a
          // follow-up).
          signDisabled={!allAcksTicked || !allSectionsRead}
          signDisabledHint={
            !allSectionsRead
              ? tProposals("public.doc.sign_disabled_sections_hint")
              : !allAcksTicked
                ? tProposals("public.doc.sign_disabled_hint")
                : undefined
          }
          // Pre-sign consent block — three required tickboxes that
          // mirror the ☐ rows on the docx proposal. Toggling them
          // updates ``acks``; the ☐ → ☑ swap happens server-side at
          // render time so the rendered PDF reflects what the
          // customer confirmed at sign time.
          extraBody={
            !isAccepted ? (
              <AcknowledgementBlock
                acks={acks}
                onChange={(next) => setAcks(next)}
                isCustom={isCustom}
                tProposals={tProposals}
              />
            ) : null
          }
          onSign={() => {
            if (!identified) {
              setIdentifying(true);
              return;
            }
            if (!allAcksTicked || !allSectionsRead) return;
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
            // Spec preview renders the spec inline as React from
            // the JSON ``render_context`` the server sent in the
            // kiosk payload — same component the standalone spec
            // kiosk uses at ``/p/<token>``. No iframe, no PDF
            // render, no extra round-trip when the page opens. A
            // sentinel ``<div>`` at the bottom of the content
            // hooks into ``IntersectionObserver`` and flips
            // ``specsRead[sheet.id]`` once it scrolls into view —
            // that's the per-spec "you've reached the end" gate
            // for the Sign button.
            previewSrc={null}
            previewContent={
              <InlineSpecPreview
                sheetId={sheet.id}
                rendered={sheet.render_context as RenderedSheetContext}
                onReadChange={(read) =>
                  setSpecsRead((prev) =>
                    prev[sheet.id] === read
                      ? prev
                      : { ...prev, [sheet.id]: read },
                  )
                }
                tProposals={tProposals}
              />
            }
            previewLabel={tProposals("public.doc.preview_label")}
            downloadHref={
              sheet.public_token
                ? specificationsEndpoints.publicPdf(sheet.public_token, {
                    download: true,
                  })
                : null
            }
            downloadLabel={tProposals("public.doc.download_cta")}
            signDisabled={!specsRead[sheet.id]}
            signDisabledHint={
              !specsRead[sheet.id]
                ? tProposals("public.doc.sign_disabled_sections_hint")
                : undefined
            }
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
            // Per-spec public page anchored at its comments panel.
            // ``public_token`` is the spec sheet's own kiosk link;
            // sheets without a public link (rare for sheets bundled
            // into a proposal, but possible if the link was revoked)
            // simply hide the chat button.
            commentsHref={
              sheet.public_token ? `/p/${sheet.public_token}#comments` : null
            }
            commentsLabel={tProposals("public.doc.spec_comments_cta")}
            tProposals={tProposals}
          />
        ))}
      </section>

      {/* -------------------------------------------------------------- */}
      {/* Finalize                                                        */}
      {/* -------------------------------------------------------------- */}
      {!isAccepted && !isRejected ? (
        <section className="mt-6 rounded-2xl bg-ink-0 p-5 shadow-sm ring-1 ring-ink-200 sm:p-6 md:p-8">
          <p className="text-sm text-ink-600">
            {allSigned
              ? tProposals("public.finalize_ready")
              : tProposals("public.finalize_hint")}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {/* Accept (primary) + Decline (secondary outline) sit
                in the same row so the customer sees both choices at
                the moment they're considering the deal. Decline
                stays accessible even before every document is signed
                — they may know it's a "no" up-front and we don't
                want to force them through the sign flow to reach
                the no button. The confirm modal still gates the
                destructive action. */}
            <Button
              type="button"
              onClick={handleFinalize}
              isDisabled={!allSigned || finalizing}
              className="inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-lg bg-orange-500 px-5 text-sm font-medium text-ink-0 hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:justify-start"
            >
              <CheckCircle2 className="h-4 w-4" />
              {tProposals("public.finalize_cta")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeclineOpen(true)}
              isDisabled={finalizing || declining}
              className="inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-lg bg-ink-0 px-5 text-sm font-medium text-danger ring-1 ring-inset ring-danger/30 hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:justify-start"
            >
              <XCircle className="h-4 w-4" />
              {tProposals("public.decline_cta")}
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

      {/* Decline confirmation modal. Kept inline (rather than a
          separate file) because it's small, only used here, and
          sharing state with the kiosk view (the reason textarea
          + busy flag) is simpler with co-located components. */}
      <Modal
        isOpen={declineOpen}
        onOpenChange={(open) => {
          if (declining) return;
          setDeclineOpen(open);
        }}
      >
        <Modal.Backdrop>
          <Modal.Container size="md">
            <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
              <Modal.Header className="border-b border-ink-200 px-6 py-4">
                <Modal.Heading className="text-base font-semibold text-ink-1000">
                  {tProposals("public.decline_dialog.title")}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-4 px-6 py-5">
                <p className="text-sm text-ink-600">
                  {tProposals("public.decline_dialog.subtitle")}
                </p>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-ink-700">
                    {tProposals("public.decline_dialog.reason_label")}
                  </span>
                  <textarea
                    value={declineReason}
                    onChange={(e) => setDeclineReason(e.target.value)}
                    disabled={declining}
                    rows={4}
                    placeholder={tProposals(
                      "public.decline_dialog.reason_placeholder",
                    )}
                    className="w-full resize-y rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:bg-ink-50"
                  />
                </label>
              </Modal.Body>
              <Modal.Footer className="flex items-center justify-end gap-3 border-t border-ink-200 px-6 py-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDeclineOpen(false)}
                  isDisabled={declining}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50 disabled:opacity-50"
                >
                  {tProposals("public.decline_dialog.cancel")}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  onClick={handleDecline}
                  isDisabled={declining}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-danger px-4 py-2 text-sm font-medium text-ink-0 hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <XCircle className="h-4 w-4" />
                  {declining
                    ? tProposals("public.decline_dialog.declining")
                    : tProposals("public.decline_dialog.confirm")}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  );
}


function DocumentCard({
  icon,
  title,
  subtitle,
  previewSrc,
  previewContent,
  previewLabel,
  signedAt,
  hasSignature,
  locked,
  onSign,
  signDisabled,
  signDisabledHint,
  extraBody,
  commentsHref,
  commentsLabel,
  downloadHref,
  downloadLabel,
  tProposals,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  /** Iframe source URL — used for documents that still render as
   *  PDF (spec sheets via WeasyPrint). Mutually exclusive with
   *  ``previewContent``: when ``previewContent`` is set it wins. */
  previewSrc: string | null;
  /** Native React content to render in place of the iframe. Used by
   *  the proposal card so we can render every section as a real DOM
   *  block (and track "read" state with IntersectionObserver). */
  previewContent?: React.ReactNode;
  previewLabel: string;
  signedAt: string | null;
  hasSignature: boolean;
  locked: boolean;
  onSign: () => void;
  /** Set to ``true`` when consent gates haven't been satisfied
   *  yet (e.g. the proposal card needs all three ack checkboxes
   *  ticked). The Sign button still renders but greys out so the
   *  customer can see the next step is consent, not a hidden form
   *  state. */
  signDisabled?: boolean;
  signDisabledHint?: string;
  /** Optional in-card slot for content that lives between the
   *  preview iframe and the actions row — used by the proposal
   *  card to render its three required acknowledgement
   *  tickboxes. */
  extraBody?: React.ReactNode;
  /** Per-document chat link. Set on attached spec sheets (the
   *  spec's own ``/p/<token>#comments`` page); ``null`` on the
   *  proposal card itself, where the kiosk's main comments panel
   *  already lives one step down. */
  commentsHref?: string | null;
  commentsLabel?: string;
  /** PDF-download endpoint (token-gated, server-rendered via
   *  WeasyPrint). When set, a "Download PDF" anchor renders next to
   *  Sign so the customer can save the document for their records. */
  downloadHref?: string | null;
  downloadLabel?: string;
  tProposals: ReturnType<typeof useTranslations<"proposals">>;
}) {
  return (
    <article className="flex flex-col gap-4 rounded-2xl bg-ink-0 p-4 shadow-sm ring-1 ring-ink-200 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:gap-4">
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
        {/* Action row. On mobile each control stacks full-width so
            the buttons are thumb-sized and the labels never wrap
            inside narrow side-by-side slots. On ≥sm everything
            flows into one row to the right of the title. */}
        <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center">
          {hasSignature ? (
            <span className="inline-flex items-center justify-center gap-1.5 rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success ring-1 ring-inset ring-success/30 sm:justify-start">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {tProposals("public.doc.signed_badge")}
            </span>
          ) : null}
          {commentsHref ? (
            <Link
              href={commentsHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-10 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-50 sm:w-auto sm:justify-start"
            >
              <MessageCircle className="h-4 w-4" />
              {commentsLabel}
            </Link>
          ) : null}
          {downloadHref ? (
            // Anchor tag with ``download`` attribute so the browser
            // saves the file instead of streaming it inline. The
            // backend already sets ``Content-Disposition: attachment``
            // — the attribute is belt-and-braces for browsers that
            // ignore it (mobile Safari).
            <a
              href={downloadHref}
              download
              className="inline-flex h-10 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-50 sm:w-auto sm:justify-start"
            >
              <Download className="h-4 w-4" />
              {downloadLabel}
            </a>
          ) : null}
          {!locked ? (
            <span
              title={signDisabled ? signDisabledHint : undefined}
              className="w-full sm:w-auto"
            >
              <Button
                type="button"
                variant={hasSignature ? "outline" : "primary"}
                onClick={onSign}
                isDisabled={signDisabled}
                className={
                  hasSignature
                    ? "inline-flex h-10 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:justify-start"
                    : "inline-flex h-10 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:justify-start"
                }
              >
                <PenLine className="h-4 w-4" />
                {hasSignature
                  ? tProposals("public.doc.resign")
                  : tProposals("public.doc.sign_cta")}
              </Button>
            </span>
          ) : null}
        </div>
      </div>
      {extraBody}
      {previewContent ? (
        previewContent
      ) : previewSrc ? (
        <div className="overflow-hidden rounded-xl bg-ink-50 ring-1 ring-inset ring-ink-200">
          <iframe
            src={previewSrc}
            title={previewLabel}
            className="h-[70vh] w-full border-0 md:h-[780px]"
          />
        </div>
      ) : null}
    </article>
  );
}


/**
 * Required consent tickboxes shown above the proposal preview in
 * the kiosk. Mirrors the ☐ rows on the proposal HTML — ticking
 * them flips the matching boxes to ☑ on the rendered acceptance
 * form once the customer signs. The Sign button stays disabled
 * until every visible box is true; the API also enforces it.
 *
 * Custom proposals show 4 rows (the long lead-times wording + the
 * R&D / Sampling acknowledgement). Ready-to-Go proposals show 3
 * (a shorter lead-times wording, no R&D row).
 */
function AcknowledgementBlock({
  acks,
  onChange,
  isCustom,
  tProposals,
}: {
  acks: {
    spec_signing: boolean;
    lead_times: boolean;
    terms: boolean;
    rd_terms: boolean;
  };
  onChange: (next: typeof acks) => void;
  isCustom: boolean;
  tProposals: ReturnType<typeof useTranslations<"proposals">>;
}) {
  type AckKey = keyof typeof acks;
  type AckTranslationKey =
    | "public.doc.ack_spec_signing"
    | "public.doc.ack_lead_times_custom"
    | "public.doc.ack_lead_times_ready"
    | "public.doc.ack_rd_terms"
    | "public.doc.ack_terms";

  const ROWS: ReadonlyArray<{
    readonly key: AckKey;
    readonly translationKey: AckTranslationKey;
  }> = isCustom
    ? [
        {
          key: "spec_signing",
          translationKey: "public.doc.ack_spec_signing",
        },
        {
          key: "lead_times",
          translationKey: "public.doc.ack_lead_times_custom",
        },
        { key: "rd_terms", translationKey: "public.doc.ack_rd_terms" },
        { key: "terms", translationKey: "public.doc.ack_terms" },
      ]
    : [
        {
          key: "spec_signing",
          translationKey: "public.doc.ack_spec_signing",
        },
        {
          key: "lead_times",
          translationKey: "public.doc.ack_lead_times_ready",
        },
        { key: "terms", translationKey: "public.doc.ack_terms" },
      ];

  return (
    <div className="rounded-xl bg-amber-50 px-4 py-3 ring-1 ring-inset ring-amber-200">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-amber-900">
        {tProposals("public.doc.ack_heading")}
      </p>
      <ul className="flex flex-col gap-2">
        {ROWS.map(({ key, translationKey }) => (
          <li key={key} className="flex items-start gap-2 text-xs text-ink-1000">
            <input
              type="checkbox"
              id={`ack-${key}`}
              checked={acks[key]}
              onChange={(e) => onChange({ ...acks, [key]: e.target.checked })}
              className="mt-[2px] h-4 w-4 cursor-pointer rounded border-ink-300 text-orange-500 focus:ring-2 focus:ring-orange-400"
            />
            <label
              htmlFor={`ack-${key}`}
              className="cursor-pointer leading-snug"
            >
              {tProposals(translationKey)}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}


/**
 * Inline-render variant for spec previews on the proposal kiosk.
 *
 * Instead of iframing the WeasyPrint PDF render (heavy on the
 * server, occasionally fails to load, blows worker memory on
 * multi-spec proposals), we feed the spec's ``render_context``
 * JSON into :component:`SpecSheetContent` and render it as React.
 *
 * The "you've scrolled to the end" gate that the proposal's
 * iframe-based version uses is reproduced here via an
 * ``IntersectionObserver`` watching a sentinel ``<div>`` placed
 * after the content. When that sentinel becomes visible, the
 * customer has reached the bottom and the parent flips its
 * per-spec ``specsRead`` flag, which unlocks the Sign button.
 */
function InlineSpecPreview({
  sheetId,
  rendered,
  onReadChange,
  tProposals,
}: {
  sheetId: string;
  rendered: RenderedSheetContext;
  onReadChange: (read: boolean) => void;
  tProposals: ReturnType<typeof useTranslations<"proposals">>;
}) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [progress, setProgress] = useState<number>(0);
  const allDone = progress >= READ_THRESHOLD;

  useEffect(() => {
    onReadChange(allDone);
  }, [allDone, onReadChange]);

  useEffect(() => {
    // Mirror the ``ScrollTrackingIframe`` polling pattern — same
    // monotone-progress contract, same 98% threshold, same "fits
    // in the window = counts as read" branch. Polling instead of
    // a ``scroll`` listener so a parent re-render that replaces
    // the container ref doesn't drop the listener silently.
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const root = scrollContainerRef.current;
      if (root === null) return;
      const scrollTop = root.scrollTop;
      const clientHeight = root.clientHeight;
      const scrollHeight = root.scrollHeight;
      if (scrollHeight <= 0 || clientHeight <= 0) return;
      const scrollable = Math.max(0, scrollHeight - clientHeight);
      if (scrollable <= 0) {
        // Content fits the window — short specs count as fully
        // read on the first measurement. Without this branch a
        // one-section spec would never unlock the Sign button.
        setProgress(1);
        return;
      }
      // Pure scroll-position fraction: 0 at the top, 1 when
      // scrolled to the very bottom. The earlier formula
      // ``(scrollTop + clientHeight) / scrollHeight`` showed the
      // initial reading at ~35% on a tall doc because the visible
      // window already covered the first third of the content —
      // mathematically right but unintuitive ("progress" should
      // start at zero when you haven't done anything yet).
      const fraction = scrollTop / scrollable;
      setProgress((prev) =>
        fraction > prev ? Math.min(1, fraction) : prev,
      );
    };

    tick();
    const interval = window.setInterval(tick, 250);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [sheetId]);

  return (
    <div className="flex flex-col gap-3">
      {/* Progress strip — mirrors the proposal's reading-progress
       *  pill so the customer sees a consistent "you've reached
       *  the end" signal across all documents on the page. */}
      <div
        className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-2 text-xs ${
          allDone
            ? "border-success/30 bg-success/10 text-success"
            : "border-ink-200 bg-ink-50 text-ink-700"
        }`}
      >
        <span className="font-medium">
          {allDone
            ? tProposals("public.reading.progress.all_done")
            : tProposals("public.reading.progress.percent", {
                percent: Math.round(progress * 100),
              })}
        </span>
        <div className="h-1.5 w-32 overflow-hidden rounded-full bg-ink-200">
          <div
            className={`h-full transition-all ${
              allDone ? "bg-success" : "bg-orange-500"
            }`}
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      </div>

      {/* Fixed-height window with internal scroll — same footprint
       *  as the proposal iframe. The customer scrolls inside the
       *  window; the polling loop above tracks how far they got
       *  through the spec content.
       *
       *  Mobile: zero horizontal padding so ``SpecSheetContent``'s
       *  own ``px-6`` (24px each side) is the only inset — without
       *  this we'd double-stack padding from the page wrapper,
       *  the section card, this container, AND the spec content,
       *  eating ~150 px of horizontal real estate and pushing
       *  wide tables off-screen. ``overflow-auto`` (both axes) so
       *  any table that does overflow horizontally scrolls inside
       *  the box rather than the body. */}
      <div
        ref={scrollContainerRef}
        className="h-[70vh] w-full overflow-auto rounded-xl bg-ink-50 py-6 ring-1 ring-inset ring-ink-200 md:h-[780px]"
      >
        <SpecSheetContent rendered={rendered} />
      </div>
    </div>
  );
}


/**
 * Same-origin iframe wrapper that tracks how far the customer has
 * scrolled through the embedded proposal HTML, and exposes a
 * "scrolled to bottom" signal upward via ``onAllReadChange``.
 *
 * The iframe loads ``/api/public/proposals/<token>/pdf/`` — same
 * HTML the in-app proposal page iframes, so the kiosk and the
 * internal preview are pixel-identical. Because the iframe is
 * served from the same origin (Next.js ``/api/*`` rewrite proxies
 * Django on the same host), we can attach a ``scroll`` listener
 * to its ``contentWindow`` from the parent page; no cross-origin
 * permission games.
 *
 * Progress is monotone — scrolling back up doesn't drop the gate.
 * 98% is the "fully read" threshold to forgive sub-pixel rounding
 * at the bottom of the document.
 */
const READ_THRESHOLD = 0.98;

function ScrollTrackingIframe({
  src,
  title,
  onAllReadChange,
  tProposals,
}: {
  src: string;
  title: string;
  onAllReadChange: (allRead: boolean) => void;
  tProposals: ReturnType<typeof useTranslations<"proposals">>;
}) {
  const [progress, setProgress] = useState<number>(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const allDone = progress >= READ_THRESHOLD;

  useEffect(() => {
    onAllReadChange(allDone);
  }, [allDone, onAllReadChange]);

  useEffect(() => {
    // Poll-based progress tracking. Previous implementation listened
    // for the iframe's ``load`` event and bound a ``scroll`` listener
    // inside; that's brittle for two reasons:
    //
    // 1. If the iframe was cached or rendered quickly, the ``load``
    //    event fired before useEffect could attach — the listener
    //    was registered too late, and no scroll signal ever
    //    propagated. Symptom: ticking a consent box before scrolling
    //    "broke" progress because the user had just enough time for
    //    the underlying race to manifest.
    // 2. Even when the listener attached, parent re-renders driven by
    //    other state (consent ticks, signed timestamp cache-busts)
    //    could replace the iframe document, dropping the listener
    //    silently.
    //
    // Polling sidesteps both: every 250 ms we read
    // ``contentWindow.scrollY`` / ``documentElement.scrollHeight``
    // and feed the same monotone setter the old listener used. No
    // listener lifecycle, no race. The cost is one cheap closure
    // call four times a second — unmeasurable.
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const iframe = iframeRef.current;
      if (iframe === null) return;
      const win = iframe.contentWindow;
      const doc = iframe.contentDocument;
      if (win === null || doc === null) return;

      // Three guards on "is the iframe document actually ready to
      // measure":
      //
      // 1. ``readyState === "complete"`` — DOMContentLoaded + every
      //    subresource has loaded. Before this, the document's
      //    ``scrollHeight`` reflects whatever fragment has been
      //    parsed so far, not the real height.
      // 2. URL is not ``about:blank`` — the placeholder document a
      //    fresh iframe shows before the real ``src`` finishes
      //    loading. Its ``scrollHeight`` matches ``clientHeight``,
      //    which our "scrollable <= 0 → fully read" branch would
      //    otherwise misread as "already done".
      // 3. URL is not empty string — same reasoning, alternate UA.
      //
      // Without these three, the first poll fires on the placeholder
      // doc, ``setProgress(1)`` runs, and the consent gate unlocks
      // before the customer has seen any of the actual proposal.
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
        // Document fits in the iframe — counts as fully read on
        // first measurement.
        setProgress(1);
        return;
      }
      // Pure scroll-position fraction (0 → 1) to match the spec
      // preview's progress strip. The previous formula counted the
      // visible window as "read", which made progress start at
      // ~35% on tall documents before the customer had actually
      // scrolled anywhere.
      const fraction = scrollTop / scrollable;
      setProgress((prev) =>
        fraction > prev ? Math.min(1, fraction) : prev,
      );
    };

    // First tick fires immediately so a fast-loading document
    // doesn't have to wait 250 ms for the initial measurement.
    tick();
    const interval = window.setInterval(tick, 250);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [src]);

  return (
    <div className="flex flex-col gap-3">
      <div
        className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-2 text-xs ${
          allDone
            ? "border-success/30 bg-success/10 text-success"
            : "border-ink-200 bg-ink-50 text-ink-700"
        }`}
      >
        <span className="font-medium">
          {allDone
            ? tProposals("public.reading.progress.all_done")
            : tProposals("public.reading.progress.percent", {
                percent: Math.round(progress * 100),
              })}
        </span>
        <div className="h-1.5 w-32 overflow-hidden rounded-full bg-ink-200">
          <div
            className={`h-full transition-all ${
              allDone ? "bg-success" : "bg-orange-500"
            }`}
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      </div>
      <div className="overflow-hidden rounded-xl bg-ink-50 ring-1 ring-inset ring-ink-200">
        <iframe
          ref={iframeRef}
          src={src}
          title={title}
          className="h-[70vh] w-full border-0 md:h-[780px]"
        />
      </div>
    </div>
  );
}
