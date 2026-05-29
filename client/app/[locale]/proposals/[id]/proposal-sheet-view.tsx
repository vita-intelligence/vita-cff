"use client";

import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Clock,
  Download,
  Eye,
  ExternalLink,
  FileDown,
  FileSignature,
  FlaskConical,
  KeyRound,
  Link2,
  LogIn,
  MailOpen,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  Undo2,
  UserRound,
  X,
  XCircle,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button, Modal } from "@heroui/react";

import { CustomerPicker } from "@/components/customers/customer-picker";
import { useCustomers, type CustomerDto } from "@/services/customers";
import { SignatureDialog } from "@/components/ui/signature-dialog";

import { ProposalCommentsBubble } from "./proposal-comments-bubble";
import { SendToClientModal } from "./send-to-client-modal";
import { Link } from "@/i18n/navigation";
import { apiClient, ApiError } from "@/lib/api";
import { extractApiErrorMessage } from "@/lib/errors/translate";
import {
  proposalsEndpoints,
  useAddProposalLine,
  useCompleteProposalRequiredFields,
  useDeleteProposalLine,
  usePatchProposalLine,
  useProposal,
  useProposalActivity,
  useProposalAttachedSpec,
  useProposalAudit,
  useTransitionProposalStatus,
  useUpdateProposal,
  type ProposalActivityEventDto,
  type ProposalAuditDocumentDto,
  type ProposalAuditSpecDto,
  type ProposalDto,
  type ProposalLineDto,
  type ProposalStatus,
  type UpdateProposalRequestDto,
} from "@/services/proposals";
import {
  useFormulationVersions,
  useInfiniteFormulations,
  type FormulationVersionDto,
} from "@/services/formulations";
import { useCurrentUser } from "@/services/accounts";
import { useMemberships } from "@/services/members";
import {
  specificationsEndpoints,
  useInfiniteSpecifications,
  useRenderedSpecification,
  type SpecificationSheetDto,
} from "@/services/specifications";
import { SpecSheetContent } from "../../specifications/[id]/specification-sheet-view";

import { CommentsPanel } from "@/components/comments";


/**
 * Thin wrapper around :component:`CommentsPanel` for the proposal-
 * level conversation surface. Lives inline in the proposal sheet
 * view so the staff team sees the customer-portal thread next to
 * the document they're reviewing, instead of a separate page or a
 * floating bubble.
 */
function ProposalConversation({
  orgId,
  proposalId,
  currentUserId,
  canRead,
  canWrite,
  canModerate,
}: {
  orgId: string;
  proposalId: string;
  currentUserId: string;
  canRead: boolean;
  canWrite: boolean;
  canModerate: boolean;
}) {
  return (
    <section className="rounded-2xl bg-ink-0 p-5 shadow-sm ring-1 ring-ink-200">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-ink-500">
            Conversation
          </p>
          <h2 className="mt-0.5 text-base font-semibold text-ink-1000">
            About this proposal
          </h2>
        </div>
        <span className="text-[11px] text-ink-500">
          Shared with the customer · posts appear in the portal
        </span>
      </header>
      <CommentsPanel
        orgId={orgId}
        entityKind="proposal"
        entityId={proposalId}
        currentUserId={currentUserId}
        canRead={canRead}
        canWrite={canWrite}
        canModerate={canModerate}
        // Scope to shared so the customer-facing conversation never
        // surfaces an internal-bubble post next to a customer reply.
        // Pre-bubble proposals are 100% shared anyway, so this is a
        // no-op for legacy data and a hard guard for new comments.
        visibilityFilter="shared"
      />
    </section>
  );
}


/**
 * Authenticated view for one proposal. Renders the backend HTML in
 * an iframe so the offer reads identically to the PDF / kiosk
 * versions, and surfaces the status-machine actions (Send for
 * review / Approve / Mark sent) alongside it.
 */
export function ProposalSheetView({
  orgId,
  proposalId,
}: {
  orgId: string;
  proposalId: string;
}) {
  const tProposals = useTranslations("proposals");
  const tErrors = useTranslations("errors");

  const proposalQuery = useProposal(orgId, proposalId);
  const transitionMutation = useTransitionProposalStatus(orgId, proposalId);
  const updateMutation = useUpdateProposal(orgId, proposalId);
  // Current user's membership on this org — drives the per-button
  // RBAC gates below. ``is_owner`` short-circuits everything (the
  // owner role bypasses capability checks server-side too).
  const currentUserQuery = useCurrentUser();
  const membershipsQuery = useMemberships(orgId);
  const myMembership = useMemo(() => {
    const me = currentUserQuery.data;
    if (!me) return null;
    return (
      membershipsQuery.data?.find((m) => m.user.id === me.id) ?? null
    );
  }, [currentUserQuery.data, membershipsQuery.data]);
  const hasProposalsCap = (cap: string): boolean => {
    if (!myMembership) return false;
    if (myMembership.is_owner) return true;
    const raw = myMembership.permissions["proposals"];
    return Array.isArray(raw) ? raw.includes(cap) : false;
  };
  // ``approve`` and ``manual_close`` are the two new gates. Falls
  // back to ``false`` while the memberships query is still loading
  // so a fast-rendered ``in_review`` proposal doesn't briefly show
  // the Approve button to a viewer who shouldn't see it.
  const canApprove = hasProposalsCap("approve");
  // ``manual_close`` gates the staff-side "mark as accepted /
  // rejected" override on a ``sent`` proposal. Today the rejected
  // edge is exposed via the "Reject on behalf of client" button
  // below; the accepted edge is still kiosk-only. Backend enforces
  // the same gate via :class:`ProposalStatusView.initial`; the UI
  // check here is for affordance.
  const canManualClose = hasProposalsCap("manual_close");
  const [editOpen, setEditOpen] = useState(false);
  //: Missing-fields modal state — set by a 400 response on a status
  //: transition when the backend surfaces ``missing_required_fields``.
  //: Non-null value = modal is open and holding the list to display.
  const [missingFields, setMissingFields] = useState<string[] | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [signatureDialogOpen, setSignatureDialogOpen] = useState<
    false | "in_review" | "approved"
  >(false);
  const [sendToClientOpen, setSendToClientOpen] = useState(false);
  // "Reject on behalf of the client" dialog. Only mounted when the
  // proposal is at ``sent`` (the manual-close gate enforces the
  // same on the backend), and only fully enabled for closers
  // (``proposals.manual_close``). Captures an optional free-text
  // reason that lands in ``customer_rejection_reason`` so the
  // rejection panel renders the same as a kiosk-driven reject.
  const [rejectOnBehalfOpen, setRejectOnBehalfOpen] = useState(false);
  // Proposal body is rendered server-side (Django template → DOCX
  // → PDF via LibreOffice when available, raw HTML fallback
  // otherwise) and streamed into an iframe here. The iframe src
  // cannot point directly at the API origin (cookies aren't sent
  // on cross-site iframes) so we fetch the bytes through
  // ``apiClient`` and expose them to the iframe as a ``blob:`` URL.
  // Re-runs whenever the proposal's ``updated_at`` changes so the
  // preview reflects edits immediately.
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewKind, setPreviewKind] = useState<"pdf" | "html" | null>(null);
  const proposalVersion = proposalQuery.data?.updated_at ?? "";
  useEffect(() => {
    if (!proposalId) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        const response = await apiClient.get<Blob>(
          proposalsEndpoints.render(orgId, proposalId),
          { responseType: "blob" },
        );
        if (cancelled) return;
        const contentType = String(response.headers["content-type"] || "");
        const kind = contentType.startsWith("application/pdf") ? "pdf" : "html";
        objectUrl = URL.createObjectURL(response.data);
        setPreviewSrc(objectUrl);
        setPreviewKind(kind);
      } catch {
        if (!cancelled) {
          setPreviewSrc(null);
          setPreviewKind(null);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [orgId, proposalId, proposalVersion]);

  // Auto-open the director-approve dialog when arriving from the
  // approvals inbox (``?action=approve``). Guarded on status so a
  // stale link can't dispatch an illegal transition; the user lands
  // on the page normally if the proposal has already moved on.
  const searchParams = useSearchParams();
  const autoApproveAction = searchParams?.get("action");
  const proposalStatus = proposalQuery.data?.status;
  useEffect(() => {
    if (autoApproveAction !== "approve") return;
    if (proposalStatus !== "in_review") return;
    setSignatureDialogOpen("approved");
  }, [autoApproveAction, proposalStatus]);

  if (proposalQuery.isLoading || !proposalQuery.data) {
    return (
      <div className="mt-6 text-sm text-ink-500">
        {tProposals("detail.loading")}
      </div>
    );
  }

  const proposal = proposalQuery.data;

  // Proposals lock to read-only once the director has approved them
  // (and stay locked through ``sent``, ``accepted``, ``rejected``).
  // Editing an approved proposal would invalidate the signatures we
  // already have on file; editing a ``sent`` one would diverge from
  // what the customer is reading on the kiosk. Only ``draft`` and
  // ``in_review`` remain mutable. The backend enforces the same
  // guard via :class:`ProposalNotMutable` so a crafted request can't
  // bypass the UI.
  const isLocked =
    proposal.status === "approved" ||
    proposal.status === "sent" ||
    proposal.status === "accepted" ||
    proposal.status === "rejected";
  // Legacy alias used by code that read this variable as
  // ``isTerminal``. Kept until every reference is renamed.
  const isTerminal = isLocked;

  const handleTransition = async (
    nextStatus: ProposalStatus,
    signatureImage?: string,
    notes?: string,
  ) => {
    setError(null);
    setMissingFields(null);
    try {
      await transitionMutation.mutateAsync({
        status: nextStatus,
        signature_image: signatureImage ?? "",
        notes: notes ?? "",
      });
    } catch (err) {
      // The backend surfaces ``missing_required_fields: [...]`` on a
      // 400 when the proposal isn't populated enough to advance.
      // Pop a modal listing the exact fields instead of a banner so
      // the scientist can fix them in one click.
      if (err instanceof ApiError) {
        const missingRaw = (err.fieldErrors as Record<string, unknown>)
          .missing_required_fields;
        if (Array.isArray(missingRaw) && missingRaw.length > 0) {
          setMissingFields(missingRaw.map(String));
          return;
        }
      }
      setError(extractApiErrorMessage(err, tErrors));
    }
  };

  // Which button surface to show depends on the current status. The
  // back-end's state machine is the source of truth — this just
  // matches the legal edges so the UI never shows an action the
  // backend would reject.
  const actionButtons = (() => {
    switch (proposal.status) {
      case "draft":
        return (
          <Button
            type="button"
            onClick={() => setSignatureDialogOpen("in_review")}
            className="h-10 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
          >
            <Send className="mr-1.5 h-4 w-4" />
            {tProposals("detail.actions.send_for_review")}
          </Button>
        );
      case "in_review":
        return (
          <div className="flex gap-2">
            {/* Approve is director-only (``proposals:approve``).
                Members without the cap can still send the proposal
                back to draft so they're not stuck — they just can't
                self-sign the approval. The backend enforces the
                same gate via ``ProposalStatusView.initial``; the UI
                check here is for affordance, not security. */}
            {canApprove ? (
              <Button
                type="button"
                onClick={() => setSignatureDialogOpen("approved")}
                className="h-10 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
              >
                <CheckCircle2 className="mr-1.5 h-4 w-4" />
                {tProposals("detail.actions.approve")}
              </Button>
            ) : (
              <span
                title={tProposals("detail.actions.approve_disabled_no_cap")}
              >
                <Button
                  type="button"
                  isDisabled
                  className="h-10 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <CheckCircle2 className="mr-1.5 h-4 w-4" />
                  {tProposals("detail.actions.approve")}
                </Button>
              </span>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => handleTransition("draft")}
              className="h-10 rounded-lg px-4 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
            >
              <Undo2 className="mr-1.5 h-4 w-4" />
              {tProposals("detail.actions.back_to_draft")}
            </Button>
          </div>
        );
      case "sent": {
        // Manual close-out override. The kiosk path is still the
        // primary route (customer Accepts / Declines from their own
        // link), but staff often gets the outcome by phone or email
        // — surfacing a "Reject on behalf of client" affordance lets
        // the closer terminate the proposal in place rather than
        // chasing the customer to click Decline themselves. The
        // accepted side is intentionally still kiosk-only since it
        // produces a signed PDF that demands the customer's actual
        // signature.
        if (!canManualClose) return null;
        return (
          <Button
            type="button"
            variant="outline"
            onClick={() => setRejectOnBehalfOpen(true)}
            className="h-10 rounded-lg border-danger/30 px-4 text-sm font-medium text-danger hover:bg-danger/5"
          >
            <X className="mr-1.5 h-4 w-4" />
            {tProposals("detail.actions.reject_on_behalf")}
          </Button>
        );
      }
      case "approved": {
        // ``customer_email`` is the only hard prerequisite for
        // sending — the compose modal pre-fills it but we still
        // disable the trigger when it's blank so a sales person
        // sees "fill the customer email first" before opening the
        // modal rather than after they've typed a body.
        const hasRecipient = Boolean(
          (proposal.customer_email || "").trim(),
        );
        return (
          <span
            title={
              hasRecipient
                ? undefined
                : tProposals("detail.actions.send_disabled_no_email")
            }
          >
            <Button
              type="button"
              onClick={() => setSendToClientOpen(true)}
              isDisabled={!hasRecipient}
              className="h-10 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send className="mr-1.5 h-4 w-4" />
              {tProposals("detail.actions.send_to_client")}
            </Button>
          </span>
        );
      }
      default:
        return null;
    }
  })();

  return (
    <div className="mt-6 flex flex-col gap-5">
      <Link
        href="/proposals"
        className="inline-flex w-fit items-center gap-1 text-xs font-medium text-ink-500 transition-colors hover:text-ink-1000"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {tProposals("detail.back_to_list")}
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {proposal.code} · {proposal.formulation_name} v{proposal.formulation_version_number}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink-1000 md:text-3xl">
            {proposal.customer_company ||
              proposal.customer_name ||
              tProposals("detail.no_customer")}
          </h1>
          <p className="mt-1 text-xs text-ink-500">
            {tProposals(`template_type.${proposal.template_type}` as "template_type.custom")} ·{" "}
            {tProposals(`status.${proposal.status}` as "status.draft")}
            {proposal.total_excl_vat
              ? ` · ${proposal.total_excl_vat} ${proposal.currency}`
              : ""}
          </p>
        </div>
        {actionButtons}
      </header>

      {error ? (
        <p
          role="alert"
          className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
        >
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {isTerminal ? null : (
          <ProposalSalesPersonMenu
            orgId={orgId}
            proposal={proposal}
            onError={setError}
            tProposals={tProposals}
            tErrors={tErrors}
          />
        )}
        {proposal.public_token ? (
          <ShareKioskLinkButton
            token={proposal.public_token}
            tProposals={tProposals}
          />
        ) : null}
        {/* Anchor tag with ``download`` so the browser saves the
            PDF instead of streaming inline. The backend sets
            ``Content-Disposition: attachment``; the attribute is
            belt-and-braces for clients that ignore the header
            (mobile Safari). Available in every status — staff often
            grab a copy of a signed proposal for their records, but
            it's just as useful pre-send for an internal review
            handoff or as a draft-state proof. */}
        <a
          href={proposalsEndpoints.download(orgId, proposalId)}
          download
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-50"
        >
          <Download className="h-4 w-4" />
          {tProposals("detail.download_pdf")}
        </a>
        {isTerminal ? null : (
          <Button
            type="button"
            variant="outline"
            onClick={() => setEditOpen(true)}
            className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-50"
          >
            <Pencil className="h-4 w-4" />
            {tProposals("detail.edit")}
          </Button>
        )}
        {/* PDF / docx download buttons removed — proposals are
            view-only in the browser now. Customers who need a PDF
            copy can save the rendered page via the browser's
            Print to PDF, which produces a cleaner export than
            docx2pdf ever did. */}
      </div>

      {editOpen ? (
        <EditProposalPanel
          orgId={orgId}
          proposal={proposal}
          onCancel={() => setEditOpen(false)}
          onSubmit={async (payload) => {
            await updateMutation.mutateAsync(payload);
            setEditOpen(false);
          }}
          busy={updateMutation.isPending}
        />
      ) : null}

      {/* Rejection panel — only renders when the customer has
          declined via the kiosk. Shown high on the page (above the
          lines, the iframe, everything else) because "we just lost
          this deal" is what the sales team needs to see first. */}
      {proposal.customer_rejected_at ? (
        <RejectionPanel proposal={proposal} tProposals={tProposals} />
      ) : null}

      <LinkedResourcesPanel proposal={proposal} tProposals={tProposals} />

      <ProposalLinesPanel
        orgId={orgId}
        proposalId={proposalId}
        lines={proposal.lines}
        locked={isTerminal}
      />

      <InternalApprovalsPanel proposal={proposal} tProposals={tProposals} />

      <CustomerActivityPanel orgId={orgId} proposalId={proposalId} />

      <SignatureEvidencePanel
        orgId={orgId}
        proposalId={proposalId}
        hasCustomerSignature={Boolean(proposal.customer_signature)}
        tProposals={tProposals}
      />

      {missingFields ? (
        <MissingFieldsModal
          orgId={orgId}
          proposalId={proposalId}
          proposal={proposal}
          fields={missingFields}
          onEdit={() => {
            setMissingFields(null);
            setEditOpen(true);
          }}
          onDismiss={() => setMissingFields(null)}
          onCompleted={() => {
            setMissingFields(null);
            // Re-open the send-to-client compose modal so sales can
            // ship the now-complete proposal without re-clicking
            // their way back through the buttons. The compose form
            // re-seeds from the freshly-saved proposal in its
            // ``isOpen`` effect.
            if (proposal.status === "approved") {
              setSendToClientOpen(true);
            }
          }}
        />
      ) : null}

      {previewSrc && previewKind === "pdf" ? (
        <iframe
          src={previewSrc}
          title={`Proposal ${proposal.code}`}
          className="h-[calc(100dvh-260px)] w-full rounded-2xl bg-ink-0 shadow-sm ring-1 ring-ink-200"
        />
      ) : previewSrc && previewKind === "html" ? (
        <iframe
          src={previewSrc}
          title={`Proposal ${proposal.code}`}
          className="h-[calc(100dvh-260px)] w-full rounded-2xl bg-ink-0 shadow-sm ring-1 ring-ink-200"
        />
      ) : (
        <p className="rounded-2xl bg-ink-0 p-8 text-center text-sm text-ink-500 shadow-sm ring-1 ring-ink-200">
          {tProposals("detail.preview_loading")}
        </p>
      )}

      <AttachedSpecPreviews orgId={orgId} proposal={proposal} />

      {/* Proposal-level customer chat. Mirrors the spec-sheet panel
        * the spec page already mounts: same component, same RBAC
        * gates, same WebSocket — only the target entity differs.
        * The customer portal posts here from
        * ``/portal/proposals/[id]/proposal-messages/`` and we
        * surface replies in the same panel without a second
        * surface to learn. */}
      {currentUserQuery.data ? (
        <ProposalConversation
          orgId={orgId}
          proposalId={proposalId}
          currentUserId={currentUserQuery.data.id}
          canRead={hasProposalsCap("view") || myMembership?.is_owner === true}
          canWrite={hasProposalsCap("view") || myMembership?.is_owner === true}
          canModerate={myMembership?.is_owner === true}
        />
      ) : null}

      {/* Floating internal chat — same UX shape as the project
          bubble on the formulation pages, but scoped to the
          proposal entity and ``visibilityFilter="internal"`` so
          the customer never sees it. Lives next to the
          ``ProposalConversation`` panel above (which is the
          customer-facing thread) so the staff has two distinct
          surfaces and no chance of replying internal-only to a
          customer message by accident. */}
      {currentUserQuery.data ? (
        <ProposalCommentsBubble
          orgId={orgId}
          proposalId={proposalId}
          currentUserId={currentUserQuery.data.id}
          proposalLabel={proposal.code || "Proposal"}
          canRead={hasProposalsCap("view") || myMembership?.is_owner === true}
          canWrite={hasProposalsCap("view") || myMembership?.is_owner === true}
          canModerate={myMembership?.is_owner === true}
        />
      ) : null}


      <SignatureDialog
        isOpen={Boolean(signatureDialogOpen)}
        onOpenChange={(open) => {
          if (!open) setSignatureDialogOpen(false);
        }}
        title={tProposals(
          signatureDialogOpen === "in_review"
            ? "detail.signatures.prepared_by_title"
            : "detail.signatures.director_title",
        )}
        confirmLabel={tProposals("detail.signatures.submit")}
        cancelLabel={tProposals("detail.signatures.cancel")}
        busy={transitionMutation.isPending}
        onConfirm={async (image) => {
          await handleTransition(
            signatureDialogOpen === "in_review" ? "in_review" : "approved",
            image,
          );
          setSignatureDialogOpen(false);
        }}
      />

      <SendToClientModal
        orgId={orgId}
        proposal={proposal}
        isOpen={sendToClientOpen}
        onOpenChange={setSendToClientOpen}
        onSent={() => {
          // The mutation hook already swaps the cached detail row
          // with the freshly-returned proposal (now at ``sent``) so
          // the page re-renders with the new status badge + the
          // kiosk-link affordances without an extra refetch.
        }}
        onMissingRequiredFields={(missing) =>
          setMissingFields(Array.from(missing))
        }
      />

      <RejectOnBehalfDialog
        isOpen={rejectOnBehalfOpen}
        busy={transitionMutation.isPending}
        onOpenChange={setRejectOnBehalfOpen}
        onConfirm={async (reason) => {
          await handleTransition("rejected", undefined, reason);
          setRejectOnBehalfOpen(false);
        }}
        tProposals={tProposals}
      />
    </div>
  );
}


/**
 * Expanded edit form for a proposal. The create modal only captures
 * the minimum viable set (customer name, company, margin, price); the
 * rest of the template placeholders — phone, full addresses, dear
 * name, reference, freight, cover notes, valid-until — are filled
 * here so the rendered PDF matches what sales normally types by hand
 * into the Word file.
 */

//: Spec-sheet lifecycle states that mean "director has signed off"
//: at some point — the only sheets that should ever be bindable to a
//: proposal (either as the proposal-level bundled sheet, or as a
//: per-line attachment). ``rejected`` is deliberately omitted: a
//: rejection can land before any director signature, so the status
//: alone doesn't prove the sheet was ever approved. Backend mirrors
//: this set in ``apps.proposals.services`` so a stale client cannot
//: bypass the filter by submitting an unapproved sheet id directly.
const SHEET_DIRECTOR_SIGNED: ReadonlySet<string> = new Set([
  "approved",
  "sent",
  "accepted",
]);


function EditProposalPanel({
  orgId,
  proposal,
  onCancel,
  onSubmit,
  busy,
}: {
  orgId: string;
  proposal: ProposalDto;
  onCancel: () => void;
  onSubmit: (payload: UpdateProposalRequestDto) => Promise<void>;
  busy: boolean;
}) {
  const tProposals = useTranslations("proposals");

  // Org members drive the sales-person dropdown. The list is tiny in
  // practice (single-digit for most tenants) so one round-trip on
  // panel open is fine; no search / pagination needed.
  const membersQuery = useMemberships(orgId);
  //: Org-wide spec-sheet list backs the "bundled sheet" picker. 100
  //: per page covers most tenants in one round-trip; if a huge org
  //: eventually blows past that we can switch to a searchable combo.
  const specSheetsQuery = useInfiniteSpecifications(orgId, { pageSize: 100 });
  const specSheets: readonly SpecificationSheetDto[] =
    specSheetsQuery.data?.pages.flatMap((p) => p.results) ?? [];

  // Seed the "selected customer" state from the proposal's FK when
  // present — the picker shows the right record on first render.
  // ``useCustomers("")`` pulls the full addressbook so we can find
  // the match without an extra lookup endpoint.
  const allCustomersQuery = useCustomers(orgId, "");
  const seededCustomer: CustomerDto | null = useMemo(() => {
    if (!proposal.customer_id) return null;
    return (
      allCustomersQuery.data?.find((c) => c.id === proposal.customer_id) ??
      null
    );
  }, [proposal.customer_id, allCustomersQuery.data]);
  const [customer, setCustomer] = useState<CustomerDto | null>(null);
  // Keep in sync when the proposal FK or addressbook changes.
  useEffect(() => {
    setCustomer(seededCustomer);
  }, [seededCustomer]);

  const [form, setForm] = useState(() => ({
    customer_id: proposal.customer_id ?? "",
    customer_name: proposal.customer_name,
    customer_email: proposal.customer_email,
    customer_phone: proposal.customer_phone,
    customer_company: proposal.customer_company,
    invoice_address: proposal.invoice_address,
    delivery_address: proposal.delivery_address,
    dear_name: proposal.dear_name,
    reference: proposal.reference,
    //: Empty string = "inherit from project" (send null on save).
    //: A user id = explicit override; the dropdown writes through
    //: directly.
    sales_person_id: proposal.sales_person_id ?? "",
    //: Empty string = no bundled sheet; any UUID = attach. One
    //: proposal ↔ one sheet at the DB layer, so swapping the value
    //: here implicitly detaches any previously-linked sheet.
    specification_sheet_id: proposal.specification_sheet_id ?? "",
    freight_amount: proposal.freight_amount ?? "",
    currency: proposal.currency,
    valid_until: proposal.valid_until ?? "",
    cover_notes: proposal.cover_notes,
  }));

  const bind =
    (key: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const handleSave = async () => {
    await onSubmit({
      // Explicit FK write: ``null`` detaches the address-book link,
      // a UUID binds it. The per-proposal text fields below stay
      // sent so they win on overrides — the customer_id is a
      // reference, not a cascading rewrite.
      customer_id: customer?.id ?? null,
      customer_name: form.customer_name,
      customer_email: form.customer_email,
      customer_phone: form.customer_phone,
      customer_company: form.customer_company,
      invoice_address: form.invoice_address,
      delivery_address: form.delivery_address,
      dear_name: form.dear_name,
      reference: form.reference,
      // Explicit ``null`` clears the override on the backend; any
      // non-empty string is a concrete user id. Omitting the key
      // would leave the previous value in place, so we always send
      // one or the other.
      sales_person_id: form.sales_person_id || null,
      // Same convention for the bundled spec. ``null`` detaches any
      // currently-linked sheet; a UUID attaches it (backend rejects
      // if the sheet already has another proposal attached, surfacing
      // ``specification_sheet_not_in_org``).
      specification_sheet_id: form.specification_sheet_id || null,
      currency: form.currency || "GBP",
      freight_amount: form.freight_amount || null,
      valid_until: form.valid_until || null,
      cover_notes: form.cover_notes,
    });
  };

  return (
    <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 md:p-8">
      <h2 className="text-base font-semibold text-ink-1000">
        {tProposals("detail.edit_heading")}
      </h2>
      <p className="mt-0.5 text-sm text-ink-500">
        {tProposals("detail.edit_subtitle")}
      </p>

      {/*
        Address-book picker. Changing the pick auto-populates the
        per-proposal customer fields below — scientists can still
        tweak those for this specific quote (different delivery
        address for one shipment, etc.) without detaching the FK.
      */}
      <div className="mt-5 rounded-xl border border-ink-100 bg-ink-50 p-4">
        <CustomerPicker
          orgId={orgId}
          value={customer}
          onChange={(next) => {
            setCustomer(next);
            if (next) {
              setForm((prev) => ({
                ...prev,
                customer_id: next.id,
                customer_name: next.name || prev.customer_name,
                customer_email: next.email || prev.customer_email,
                customer_phone: next.phone || prev.customer_phone,
                customer_company: next.company || prev.customer_company,
                invoice_address:
                  next.invoice_address || prev.invoice_address,
                delivery_address:
                  next.delivery_address || prev.delivery_address,
                dear_name: next.name || prev.dear_name,
              }));
            } else {
              setForm((prev) => ({ ...prev, customer_id: "" }));
            }
          }}
          onCreateNew={() => {
            /* Create-new escape hatch not wired on edit panel — send
               the scientist to the Customers list to add a record. */
            if (typeof window !== "undefined") {
              window.open("/customers", "_blank");
            }
          }}
        />
        <p className="mt-2 text-[11px] text-ink-500">
          {tProposals("edit.customer_picker_hint")}
        </p>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label={tProposals("edit.customer_name")}>
          <input
            value={form.customer_name}
            onChange={bind("customer_name")}
            className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          />
        </Field>
        <Field label={tProposals("edit.customer_company")}>
          <input
            value={form.customer_company}
            onChange={bind("customer_company")}
            className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          />
        </Field>
        <Field label={tProposals("edit.customer_email")}>
          <input
            type="email"
            value={form.customer_email}
            onChange={bind("customer_email")}
            className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          />
        </Field>
        <Field label={tProposals("edit.customer_phone")}>
          <input
            value={form.customer_phone}
            onChange={bind("customer_phone")}
            className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          />
        </Field>
        <Field label={tProposals("edit.invoice_address")}>
          <textarea
            value={form.invoice_address}
            onChange={bind("invoice_address")}
            rows={3}
            className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          />
        </Field>
        <Field label={tProposals("edit.delivery_address")}>
          <textarea
            value={form.delivery_address}
            onChange={bind("delivery_address")}
            rows={3}
            className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          />
        </Field>
        <Field label={tProposals("edit.dear_name")}>
          <input
            value={form.dear_name}
            onChange={bind("dear_name")}
            placeholder={proposal.customer_name}
            className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          />
        </Field>
        <Field label={tProposals("edit.reference")}>
          <input
            value={form.reference}
            onChange={bind("reference")}
            placeholder={proposal.code}
            className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          />
        </Field>
        <Field label={tProposals("edit.sales_person")}>
          <select
            value={form.sales_person_id}
            onChange={(e) =>
              setForm((prev) => ({
                ...prev,
                sales_person_id: e.target.value,
              }))
            }
            className="w-full cursor-pointer rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          >
            {/* Inherit = clear the override and render the project's
                assigned sales person. We show the effective name here
                as a hint so scientists know what they'll get. */}
            <option value="">
              {proposal.effective_sales_person_name && !proposal.sales_person_id
                ? tProposals("edit.sales_person_inherit_named", {
                    name: proposal.effective_sales_person_name,
                  })
                : tProposals("edit.sales_person_inherit")}
            </option>
            {(membersQuery.data ?? []).map((m) => (
              <option key={m.user.id} value={m.user.id}>
                {m.user.full_name || m.user.email}
                {m.is_owner
                  ? ` · ${tProposals("edit.sales_person_owner_tag")}`
                  : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label={tProposals("edit.specification_sheet")}>
          <select
            value={form.specification_sheet_id}
            onChange={(e) => {
              const nextId = e.target.value;
              setForm((prev) => {
                const next = {
                  ...prev,
                  specification_sheet_id: nextId,
                };
                if (!nextId) return next;
                // Currency on the spec is the source of truth for
                // the proposal currency unless the proposal is
                // already on a non-GBP rate (don't silently flip
                // EUR → GBP). Cost / margin no longer live on this
                // panel — they're owned per-line in the lines
                // table, so we don't seed them here.
                const picked = specSheets.find((s) => s.id === nextId);
                if (picked?.currency &&
                  (next.currency === "" || next.currency === "GBP")
                ) {
                  next.currency = picked.currency.toUpperCase();
                }
                return next;
              });
            }}
            className="w-full cursor-pointer rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          >
            <option value="">
              {tProposals("edit.specification_sheet_none")}
            </option>
            {
              // Legacy OneToOne bundled-spec slot. Scope strictly to
              // sheets attached to the proposal's primary formulation
              // AND already director-signed (status >= approved) so
              // a draft sheet still being iterated on can never be
              // bundled into a customer-facing quote. The currently-
              // bound sheet stays visible even if its formulation
              // changed after binding — avoids the optics of silent
              // data loss.
              (() => {
                const primary = proposal.formulation_id;
                const scoped = primary
                  ? specSheets.filter(
                      (s) =>
                        s.formulation_id === primary &&
                        SHEET_DIRECTOR_SIGNED.has(s.status),
                    )
                  : [];
                const bound = form.specification_sheet_id
                  ? specSheets.find(
                      (s) => s.id === form.specification_sheet_id,
                    )
                  : null;
                const list =
                  bound && !scoped.some((s) => s.id === bound.id)
                    ? [bound, ...scoped]
                    : scoped;
                return list.map((sheet) => {
                  const label = [
                    sheet.code,
                    sheet.formulation_name,
                    `v${sheet.formulation_version_number}`,
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  const kindTag =
                    sheet.document_kind === "final" ? " [FINAL]" : " [DRAFT]";
                  return (
                    <option key={sheet.id} value={sheet.id}>
                      {label}
                      {kindTag}
                    </option>
                  );
                });
              })()
            }
          </select>
        </Field>
        <Field label={tProposals("edit.currency")}>
          <input
            value={form.currency}
            onChange={bind("currency")}
            maxLength={3}
            className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm uppercase text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          />
        </Field>
        <Field label={tProposals("edit.freight_amount")}>
          <input
            type="number"
            step="0.01"
            value={form.freight_amount}
            onChange={bind("freight_amount")}
            className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          />
        </Field>
        <Field label={tProposals("edit.valid_until")}>
          <input
            type="date"
            value={form.valid_until}
            onChange={bind("valid_until")}
            className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          />
        </Field>
      </div>

      <label className="mt-4 flex flex-col gap-1.5">
        <span className="text-xs font-medium text-ink-700">
          {tProposals("edit.cover_notes")}
        </span>
        <textarea
          value={form.cover_notes}
          onChange={bind("cover_notes")}
          rows={3}
          className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
        />
      </label>

      <div className="mt-6 flex justify-end gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          isDisabled={busy}
          className="h-10 rounded-lg px-4 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
        >
          {tProposals("edit.cancel")}
        </Button>
        <Button
          type="button"
          onClick={handleSave}
          isDisabled={busy}
          className="h-10 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
        >
          <Save className="mr-1.5 h-4 w-4" />
          {tProposals("edit.save")}
        </Button>
      </div>
    </section>
  );
}


function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-ink-700">{label}</span>
      {children}
    </label>
  );
}


/**
 * Panel that lists every :class:`ProposalLine` under the proposal
 * with inline quantity / cost / price editing, plus an "Add product"
 * form that picks a formulation + version and appends a new line.
 *
 * Design choice: edit is inline per row (no per-row modal) because
 * scientists edit prices in batches — popping a modal for each row
 * would be a hundred clicks to update ten products. The add flow
 * stays modal-like (collapsible form) because it needs the two-step
 * formulation → version drill-down.
 */
function ProposalLinesPanel({
  orgId,
  proposalId,
  lines,
  locked = false,
}: {
  orgId: string;
  proposalId: string;
  lines: readonly ProposalLineDto[];
  /** Terminal-state lock: hide Add / Trash / inline-edit affordances
   *  on accepted or rejected proposals so the signed bundle stays
   *  byte-identical to what the customer received. The backend
   *  enforces the same rule. */
  locked?: boolean;
}) {
  const tProposals = useTranslations("proposals");
  const addMutation = useAddProposalLine(orgId, proposalId);
  const patchMutation = usePatchProposalLine(orgId, proposalId);
  const deleteMutation = useDeleteProposalLine(orgId, proposalId);
  const [addOpen, setAddOpen] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  //: Org-wide spec sheet list backs the per-line picker. Fetched
  //: once at the panel level and passed down as a flat array so
  //: every row reuses the same cached data instead of each rendering
  //: its own round-trip.
  const specSheetsQuery = useInfiniteSpecifications(orgId, { pageSize: 100 });
  const specSheets: readonly SpecificationSheetDto[] =
    specSheetsQuery.data?.pages.flatMap((p) => p.results) ?? [];

  /** Margin % is the UI-level concept; the backend stores unit_cost
   *  + unit_price. When the user edits either cost or margin we
   *  recompute the price client-side and PATCH both values. */
  const handleField = async (
    line: ProposalLineDto,
    field:
      | "quantity"
      | "unit_cost"
      | "margin_percent"
      | "product_code"
      | "description",
    value: string,
  ) => {
    setRowError(null);
    const payload: Record<string, unknown> = {};
    if (field === "quantity") {
      payload.quantity = Math.max(1, Number.parseInt(value, 10) || 1);
    } else if (field === "product_code" || field === "description") {
      payload[field] = value;
    } else {
      // cost / margin share the same re-price logic: read whichever
      // field the user DIDN'T just edit off the line, compute the
      // new price, and PATCH cost + price together.
      const nextCost =
        field === "unit_cost"
          ? value
          : line.unit_cost ?? "";
      const nextMargin =
        field === "margin_percent"
          ? value
          : _deriveMargin(line.unit_cost, line.unit_price);
      const cost = Number.parseFloat(nextCost);
      const margin = Number.parseFloat(nextMargin);
      if (!Number.isFinite(cost) || cost <= 0) {
        payload.unit_cost = nextCost || null;
        payload.unit_price = null;
      } else if (!Number.isFinite(margin) || margin < 0 || margin >= 100) {
        // Margin must be a valid gross-margin percentage (< 100).
        // 100 would mean price = ∞, which is rejected server-side
        // too — clear the price so the scientist fixes it.
        payload.unit_cost = String(cost);
        payload.unit_price = null;
      } else {
        // Gross margin: price = cost / (1 − margin/100).
        const price = cost / (1 - margin / 100);
        payload.unit_cost = String(cost);
        payload.unit_price = price.toFixed(4);
      }
    }
    try {
      await patchMutation.mutateAsync({ lineId: line.id, payload });
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "update_failed");
    }
  };

  return (
    <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 md:p-8">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 pb-4">
        <div>
          <h2 className="text-base font-semibold text-ink-1000">
            {tProposals("lines.title")}
          </h2>
          <p className="mt-0.5 text-sm text-ink-500">
            {tProposals("lines.subtitle")}
          </p>
        </div>
        {locked ? null : (
          <Button
            type="button"
            variant="outline"
            onClick={() => setAddOpen((v) => !v)}
            className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
          >
            <Plus className="h-4 w-4" />
            {tProposals("lines.add")}
          </Button>
        )}
      </header>

      {addOpen && !locked ? (
        <AddLineForm
          orgId={orgId}
          onCancel={() => setAddOpen(false)}
          busy={addMutation.isPending}
          onSubmit={async (payload) => {
            await addMutation.mutateAsync(payload);
            setAddOpen(false);
          }}
        />
      ) : null}

      {rowError ? (
        <p
          role="alert"
          className="mt-3 rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
        >
          {rowError}
        </p>
      ) : null}

      {lines.length === 0 ? (
        <p className="mt-4 rounded-xl bg-ink-50 px-4 py-6 text-center text-sm text-ink-500 ring-1 ring-inset ring-ink-200">
          {tProposals("lines.empty")}
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs font-medium uppercase tracking-wide text-ink-500">
                <th className="px-2 py-2">{tProposals("lines.col_code")}</th>
                <th className="px-2 py-2">{tProposals("lines.col_description")}</th>
                <th className="px-2 py-2 text-right">{tProposals("lines.col_qty")}</th>
                <th className="px-2 py-2 text-right">{tProposals("lines.col_cost")}</th>
                <th className="px-2 py-2 text-right">{tProposals("lines.col_margin")}</th>
                <th className="px-2 py-2 text-right">{tProposals("lines.col_price")}</th>
                <th className="px-2 py-2 text-right">{tProposals("lines.col_subtotal")}</th>
                <th className="px-2 py-2">{tProposals("lines.col_spec_sheet")}</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr
                  key={line.id}
                  className="border-b border-ink-100 last:border-b-0"
                >
                  <td className="px-2 py-2">
                    <LineInput
                      defaultValue={line.product_code}
                      onCommit={(v) =>
                        handleField(line, "product_code", v)
                      }
                      readOnly={locked}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <LineInput
                      defaultValue={line.description}
                      onCommit={(v) =>
                        handleField(line, "description", v)
                      }
                      readOnly={locked}
                    />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <LineInput
                      defaultValue={String(line.quantity)}
                      type="number"
                      min={1}
                      onCommit={(v) => handleField(line, "quantity", v)}
                      align="right"
                      readOnly={locked}
                    />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <LineInput
                      defaultValue={line.unit_cost ?? ""}
                      type="number"
                      step="0.0001"
                      onCommit={(v) => handleField(line, "unit_cost", v)}
                      align="right"
                      readOnly={locked}
                    />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <LineInput
                      defaultValue={_deriveMargin(
                        line.unit_cost,
                        line.unit_price,
                      )}
                      type="number"
                      step="0.1"
                      onCommit={(v) =>
                        handleField(line, "margin_percent", v)
                      }
                      align="right"
                      readOnly={locked}
                    />
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-ink-700">
                    {line.unit_price ?? "—"}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-ink-700">
                    {line.subtotal ?? "—"}
                  </td>
                  <td className="px-2 py-2">
                    <LineSpecPicker
                      line={line}
                      specs={specSheets}
                      onChange={async (sheetId) => {
                        setRowError(null);
                        try {
                          await patchMutation.mutateAsync({
                            lineId: line.id,
                            payload: {
                              specification_sheet_id: sheetId,
                            },
                          });
                        } catch (err) {
                          setRowError(
                            err instanceof Error
                              ? err.message
                              : "update_failed",
                          );
                        }
                      }}
                      tProposals={tProposals}
                      disabled={locked}
                    />
                  </td>
                  <td className="px-2 py-2 text-right">
                    {locked ? null : (
                      <button
                        type="button"
                        onClick={async () => {
                          if (!confirm(tProposals("lines.delete_confirm"))) return;
                          try {
                            await deleteMutation.mutateAsync(line.id);
                          } catch {
                            setRowError("delete_failed");
                          }
                        }}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-500 hover:bg-danger/10 hover:text-danger"
                        aria-label={tProposals("lines.delete")}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}


/** Compute the implied gross margin % for a (cost, price) pair as
 *  ``(price - cost) / price × 100``. Returns ``""`` when either
 *  side is missing or price is zero. Used to pre-fill the editable
 *  Margin column for proposals that were saved before the
 *  margin-vs-markup switch — the stored (cost, price) pair is
 *  authoritative; we just re-derive the display number. */
function _deriveMargin(cost: string | null, price: string | null): string {
  const c = Number.parseFloat(cost ?? "");
  const p = Number.parseFloat(price ?? "");
  if (!Number.isFinite(c) || c <= 0) return "";
  if (!Number.isFinite(p) || p <= 0) return "";
  return (((p - c) / p) * 100).toFixed(2);
}


/**
 * Per-line specification-sheet picker. Lets the scientist attach a
 * saved spec sheet to each product line on the proposal, so a
 * multi-product deal can bundle one sheet per product instead of
 * one sheet for the whole envelope. The client kiosk uses these
 * attachments to render one signature pad per document.
 *
 * Options are filtered to sheets that pin against the same
 * formulation as this line when we have that link — scientists
 * reported picking the wrong sheet in early usage because the
 * dropdown was dozens of sheets long across the whole org. An
 * "all sheets" escape hatch appears when no formulation-scoped
 * match exists (e.g. a line backed by a formulation snapshot but
 * the scientist wants to bundle a sheet from a different project).
 */
function LineSpecPicker({
  line,
  specs,
  onChange,
  tProposals,
  disabled = false,
}: {
  line: ProposalLineDto;
  specs: readonly SpecificationSheetDto[];
  onChange: (sheetId: string | null) => void;
  tProposals: ReturnType<typeof useTranslations<"proposals">>;
  disabled?: boolean;
}) {
  // Strict scoping: only sheets pinned to the same formulation as
  // this line's snapshot. No fallback to the full list — scientists
  // reported picking the wrong sheet because unrelated sheets bled
  // through. An ad-hoc line (no ``formulation_id``) yields zero
  // matches, which renders the "— none —" option alone so the field
  // stays explicitly empty rather than randomly pre-filling.
  //
  // Exception: if the currently-bound sheet isn't in the filtered
  // set (e.g. the line's formulation was swapped AFTER a spec was
  // attached), keep it visible so the scientist sees what's bound
  // and can deliberately clear or change it — silently hiding it
  // would look like data loss.
  const relevant = useMemo(() => {
    // Only director-signed sheets are quotable — a draft spec still
    // being iterated on shouldn't be bindable to a customer-facing
    // proposal line. The backend mirrors this rule and refuses
    // unapproved sheet bindings.
    const scoped = line.formulation_id
      ? specs.filter(
          (s) =>
            s.formulation_id === line.formulation_id &&
            SHEET_DIRECTOR_SIGNED.has(s.status),
        )
      : [];
    const boundId = line.specification_sheet_id;
    if (boundId && !scoped.some((s) => s.id === boundId)) {
      const bound = specs.find((s) => s.id === boundId);
      if (bound) return [bound, ...scoped];
    }
    return scoped;
  }, [line.formulation_id, line.specification_sheet_id, specs]);

  return (
    <select
      value={line.specification_sheet_id ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      disabled={disabled}
      className={`w-full min-w-[180px] rounded-md px-2 py-1 text-xs text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none ${
        disabled
          ? "cursor-default bg-ink-50 text-ink-700"
          : "cursor-pointer bg-ink-0 focus:ring-2 focus:ring-orange-400"
      }`}
    >
      <option value="">{tProposals("lines.no_spec")}</option>
      {relevant.map((sheet) => {
        const baseLabel = [sheet.code, `v${sheet.formulation_version_number}`]
          .filter(Boolean)
          .join(" · ");
        // ``document_kind`` is the watermark, INDEPENDENT of the
        // lifecycle status. A sheet can be ``approved`` (director-
        // signed) while still carrying a "[DRAFT]" watermark.
        const kindTag =
          sheet.document_kind === "final" ? " [FINAL]" : " [DRAFT]";
        // Mirror the create-modal picker's "busy" semantics so the
        // per-line picker also signals when a spec is already
        // bundled into another non-rejected proposal. We exempt
        // the *current* line's bound sheet from the "busy" rule —
        // otherwise re-saving the same spec on its own line would
        // look impossible.
        const linkedProposalStatus = sheet.linked_proposal?.status;
        const isBusyElsewhere = Boolean(
          sheet.linked_proposal &&
            linkedProposalStatus !== "rejected" &&
            sheet.id !== line.specification_sheet_id,
        );
        // Chip: free + approved → no chip (ideal pick); anything
        // else surfaces the lifecycle stage so the operator can
        // tell at a glance which one is fresh vs in-flight.
        let chip = "";
        if (sheet.linked_proposal && isBusyElsewhere) {
          const statusLabel = tProposals(
            `create.spec_status.${sheet.status}` as
              "create.spec_status.approved",
          );
          chip = ` · ${statusLabel} · ${sheet.linked_proposal.code}`;
        } else if (sheet.status !== "approved") {
          chip = ` · ${tProposals(
            `create.spec_status.${sheet.status}` as
              "create.spec_status.approved",
          )}`;
        }
        return (
          <option
            key={sheet.id}
            value={sheet.id}
            disabled={isBusyElsewhere}
          >
            {baseLabel}
            {kindTag}
            {chip}
          </option>
        );
      })}
    </select>
  );
}


/** Inline cell input — commits on blur rather than on every
 *  keystroke so rapid typing doesn't trigger a dozen PATCHes. */
function LineInput({
  defaultValue,
  onCommit,
  type = "text",
  step,
  min,
  align = "left",
  readOnly = false,
}: {
  defaultValue: string;
  onCommit: (value: string) => void;
  type?: "text" | "number";
  step?: string;
  min?: number;
  align?: "left" | "right";
  readOnly?: boolean;
}) {
  const [value, setValue] = useState(defaultValue);
  useEffect(() => {
    setValue(defaultValue);
  }, [defaultValue]);
  return (
    <input
      type={type}
      step={step}
      min={min}
      value={value}
      readOnly={readOnly}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        if (!readOnly && value !== defaultValue) onCommit(value);
      }}
      className={`w-full rounded-md px-2 py-1 text-sm ring-1 ring-inset ring-ink-200 outline-none ${
        readOnly
          ? "cursor-default bg-ink-50 text-ink-700"
          : "bg-ink-0 focus:ring-2 focus:ring-orange-400"
      } ${align === "right" ? "text-right tabular-nums" : ""}`}
    />
  );
}


/** Compact two-step form for adding a product line. The scientist
 *  picks a formulation first (dropdown loaded from the org), then
 *  the version (dropdown filtered to that formulation), then the
 *  price. Quantity defaults to 1 — most proposals quote single
 *  packs and we'd rather the scientist type a few numbers than
 *  walk through a big form for the common case. */
function AddLineForm({
  orgId,
  onCancel,
  onSubmit,
  busy,
}: {
  orgId: string;
  onCancel: () => void;
  onSubmit: (payload: {
    formulation_version_id: string;
    quantity: number;
    unit_cost: string | null;
    unit_price: string | null;
  }) => Promise<void>;
  busy: boolean;
}) {
  const tProposals = useTranslations("proposals");

  const formulationsQuery = useInfiniteFormulations(orgId, {
    ordering: "name",
    pageSize: 50,
  });
  const [formulationId, setFormulationId] = useState<string>("");
  const versionsQuery = useFormulationVersions(orgId, formulationId);
  const [versionId, setVersionId] = useState<string>("");
  const [quantity, setQuantity] = useState<string>("1");
  const [cost, setCost] = useState<string>("");
  // Pricing model: user enters cost + margin; price is derived as
  // ``cost × (1 + margin/100)``. Defaulting margin to 30% matches
  // the most-common scientist-chosen target so first-time proposal
  // creators land on a plausible quote without extra typing.
  const [margin, setMargin] = useState<string>("30");

  // Only projects with a director-signed spec sheet (which sets
  // ``approved_version_number``) are sellable. Mirrors the gate the
  // backend enforces in ``add_proposal_line``; filtering here means
  // the dropdown never offers an option the server would refuse.
  const formulations = useMemo(
    () =>
      (formulationsQuery.data?.pages.flatMap((p) => p.results) ?? []).filter(
        (f) => f.approved_version_number !== null,
      ),
    [formulationsQuery.data],
  );
  const pickedFormulation = formulations.find((f) => f.id === formulationId);
  const approvedVersionNumber =
    pickedFormulation?.approved_version_number ?? null;
  const versions: readonly FormulationVersionDto[] = (
    versionsQuery.data ?? []
  ).filter((v) => v.version_number === approvedVersionNumber);

  // Auto-select the single approved version once it lands — there's
  // only ever one entry in ``versions`` under the new model, so the
  // user shouldn't have to click the version dropdown manually.
  useEffect(() => {
    if (versions.length === 0) {
      if (versionId !== "") setVersionId("");
      return;
    }
    if (!versions.some((v) => v.id === versionId)) {
      setVersionId(versions[0]!.id);
    }
  }, [versions, versionId]);

  const canSubmit = Boolean(formulationId && versionId);

  return (
    <div className="mt-4 rounded-xl bg-ink-50 p-4 ring-1 ring-inset ring-ink-200">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label={tProposals("lines.add_formulation")}>
          <select
            value={formulationId}
            onChange={(e) => setFormulationId(e.target.value)}
            disabled={formulationsQuery.isLoading || formulations.length === 0}
            className="w-full cursor-pointer rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:cursor-not-allowed disabled:bg-ink-100"
          >
            <option value="">—</option>
            {formulations.map((f) => (
              <option key={f.id} value={f.id}>
                {f.code ? `${f.code} · ${f.name}` : f.name}
              </option>
            ))}
          </select>
          <span className="mt-1 text-[11px] text-ink-500">
            {formulationsQuery.isLoading
              ? tProposals("lines.add_formulation_loading")
              : formulations.length === 0
                ? tProposals("lines.add_formulation_empty_approved")
                : tProposals("lines.add_formulation_hint_approved_only")}
          </span>
        </Field>
        <Field label={tProposals("lines.add_version")}>
          <select
            value={versionId}
            onChange={(e) => setVersionId(e.target.value)}
            disabled={
              !formulationId ||
              versionsQuery.isLoading ||
              versions.length === 0
            }
            className="w-full cursor-pointer rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:cursor-not-allowed disabled:bg-ink-100"
          >
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.version_number}
                {v.label ? ` — ${v.label}` : ""}
              </option>
            ))}
          </select>
          <span className="mt-1 text-[11px] text-ink-500">
            {formulationId && versionsQuery.isLoading
              ? tProposals("lines.add_version_loading")
              : tProposals("lines.add_version_hint_approved_only")}
          </span>
        </Field>
        <Field label={tProposals("lines.add_quantity")}>
          <input
            type="number"
            min={1}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          />
        </Field>
        <Field label={tProposals("lines.add_cost")}>
          <input
            type="number"
            step="0.0001"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          />
        </Field>
        <Field label={tProposals("lines.add_margin")}>
          <input
            type="number"
            step="0.1"
            value={margin}
            onChange={(e) => setMargin(e.target.value)}
            className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          />
        </Field>
      </div>
      {(() => {
        const c = Number.parseFloat(cost);
        const m = Number.parseFloat(margin);
        const priceReady =
          Number.isFinite(c) && c > 0 && Number.isFinite(m) && m >= 0 && m < 100;
        const derivedPrice = priceReady ? c / (1 - m / 100) : null;
        return (
          <p className="mt-3 text-xs text-ink-500">
            {derivedPrice === null
              ? tProposals("lines.add_price_hint")
              : tProposals("lines.add_price_derived", {
                  price: derivedPrice.toFixed(2),
                })}
          </p>
        );
      })()}
      <div className="mt-4 flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          isDisabled={busy}
          className="h-9 rounded-lg px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
        >
          {tProposals("lines.cancel")}
        </Button>
        <Button
          type="button"
          isDisabled={!canSubmit || busy}
          onClick={async () => {
            const c = Number.parseFloat(cost);
            const m = Number.parseFloat(margin);
            const price =
              Number.isFinite(c) && c > 0 && Number.isFinite(m) && m >= 0 && m < 100
                ? (c / (1 - m / 100)).toFixed(4)
                : null;
            await onSubmit({
              formulation_version_id: versionId,
              quantity: Math.max(1, Number.parseInt(quantity, 10) || 1),
              unit_cost: cost || null,
              unit_price: price,
            });
          }}
          className="h-9 rounded-lg bg-orange-500 px-3 text-sm font-medium text-ink-0 hover:bg-orange-600"
        >
          <Plus className="mr-1.5 h-4 w-4" />
          {tProposals("lines.add")}
        </Button>
      </div>
    </div>
  );
}


/** Fields safe to fill on a locked (``approved``) proposal via the
 *  narrow ``complete-required-fields`` endpoint — mirror of the
 *  backend's ``_COMPLETABLE_REQUIRED_FIELDS`` whitelist. ``lines``
 *  and ``sales_person`` aren't fillable here because they aren't
 *  free-text inputs; post the future-proof tighten of the
 *  ``in_review → approved`` gate, those can no longer be missing on
 *  an approved proposal anyway. */
const COMPLETABLE_REQUIRED_FIELDS: ReadonlySet<string> = new Set([
  "customer_name",
  "customer_email",
  "reference",
  "invoice_address",
]);


/** Modal surfaced when the backend returns ``missing_required_fields``.
 *
 *  Two modes:
 *
 *  * Mutable proposal (``draft`` / ``in_review``): lists the fields
 *    and offers an "Edit details" button that opens the full edit
 *    panel — the proposal isn't locked so any field is reachable.
 *  * Locked proposal (``approved``): renders inline inputs for the
 *    whitelisted text fields and POSTs to the
 *    ``complete-required-fields`` endpoint, which audits and writes
 *    only the values that were actually missing. The director's
 *    signature stays attached — the values being written are the
 *    blanks the rendered PDF already had, not edits to content the
 *    director did approve. */
function MissingFieldsModal({
  orgId,
  proposalId,
  proposal,
  fields,
  onEdit,
  onDismiss,
  onCompleted,
}: {
  orgId: string;
  proposalId: string;
  proposal: ProposalDto;
  fields: string[];
  onEdit: () => void;
  onDismiss: () => void;
  onCompleted: () => void;
}) {
  const tProposals = useTranslations("proposals");
  const tErrors = useTranslations("errors");
  const completeMutation = useCompleteProposalRequiredFields(
    orgId,
    proposalId,
  );

  const isApproved = proposal.status === "approved";
  const fillable = fields.filter((key) =>
    COMPLETABLE_REQUIRED_FIELDS.has(key),
  );
  const nonFillable = fields.filter(
    (key) => !COMPLETABLE_REQUIRED_FIELDS.has(key),
  );
  const inlineMode = isApproved && fillable.length > 0;

  // Per-field draft values. Seeded empty (the fields are by
  // definition blank — that's why they're on the missing list) and
  // bound to controlled inputs.
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(fillable.map((key) => [key, ""])),
  );
  const [error, setError] = useState<string | null>(null);

  const allFilled = fillable.every((key) => (draft[key] ?? "").trim());

  const handleSave = async () => {
    if (!allFilled || completeMutation.isPending) return;
    setError(null);
    const patch: Record<string, string> = {};
    for (const key of fillable) {
      const value = (draft[key] ?? "").trim();
      if (value) patch[key] = value;
    }
    try {
      await completeMutation.mutateAsync(patch);
      onCompleted();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(extractApiErrorMessage(err, tErrors));
      } else {
        setError(tProposals("missing.complete.error_generic"));
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-1000/50 px-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-2xl bg-ink-0 p-6 shadow-xl ring-1 ring-ink-200">
        <h3 className="text-base font-semibold text-ink-1000">
          {inlineMode
            ? tProposals("missing.complete.title")
            : tProposals("missing.title")}
        </h3>
        <p className="mt-1 text-sm text-ink-500">
          {inlineMode
            ? tProposals("missing.complete.body")
            : tProposals("missing.body")}
        </p>

        {inlineMode ? (
          <div className="mt-4 flex flex-col gap-3">
            {fillable.map((key) => {
              const label = tProposals(
                `missing.fields.${key}` as "missing.fields.customer_name",
              );
              const isAddress = key === "invoice_address";
              return (
                <label key={key} className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-ink-500">
                    {label}
                  </span>
                  {isAddress ? (
                    <textarea
                      value={draft[key] ?? ""}
                      onChange={(e) =>
                        setDraft((prev) => ({
                          ...prev,
                          [key]: e.target.value,
                        }))
                      }
                      rows={3}
                      className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                    />
                  ) : (
                    <input
                      type={key === "customer_email" ? "email" : "text"}
                      value={draft[key] ?? ""}
                      onChange={(e) =>
                        setDraft((prev) => ({
                          ...prev,
                          [key]: e.target.value,
                        }))
                      }
                      className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                    />
                  )}
                </label>
              );
            })}
            {nonFillable.length > 0 ? (
              // Shouldn't happen after the in_review → approved gate
              // catches the full set, but kept as a clear fall-through
              // so we don't silently swallow a real problem.
              <div className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning ring-1 ring-inset ring-warning/20">
                <p className="font-medium">
                  {tProposals("missing.complete.non_fillable_title")}
                </p>
                <ul className="mt-1 list-disc pl-4">
                  {nonFillable.map((key) => (
                    <li key={key}>
                      {tProposals(
                        `missing.fields.${key}` as "missing.fields.customer_name",
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {error ? (
              <p
                role="alert"
                className="rounded-lg bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger ring-1 ring-inset ring-danger/20"
              >
                {error}
              </p>
            ) : null}
          </div>
        ) : (
          <ul className="mt-4 flex flex-col gap-1.5">
            {fields.map((key) => (
              <li
                key={key}
                className="flex items-center gap-2 rounded-lg bg-warning/10 px-3 py-1.5 text-sm text-warning ring-1 ring-inset ring-warning/20"
              >
                <span className="text-xs uppercase tracking-wide">•</span>
                {tProposals(
                  `missing.fields.${key}` as "missing.fields.customer_name",
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onDismiss}
            isDisabled={completeMutation.isPending}
            className="h-10 rounded-lg px-4 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {tProposals("missing.dismiss")}
          </Button>
          {inlineMode ? (
            <Button
              type="button"
              onClick={handleSave}
              isDisabled={!allFilled || completeMutation.isPending}
              className="h-10 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {completeMutation.isPending
                ? tProposals("missing.complete.saving")
                : tProposals("missing.complete.save")}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={onEdit}
              className="h-10 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
            >
              <Pencil className="mr-1.5 h-4 w-4" />
              {tProposals("missing.edit")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}


/**
 * Inline previews of every specification sheet bundled with the
 * proposal, rendered under the proposal preview so staff can eyeball
 * the full packet before sending it to the client. The kiosk already
 * renders the same documents for the client signer — showing them
 * here means "what staff sees" matches "what the client gets"
 * byte-for-byte, eliminating the "I didn't realise that doc was
 * bundled" class of mistake.
 *
 * De-duplicates attached sheets drawn from two sources (per-line refs
 * + the legacy proposal-level OneToOne) so a spec referenced twice
 * only renders once. Returns ``null`` when nothing is attached so the
 * section collapses away on a standalone proposal.
 */
/**
 * Bundled spec previews rendered inline under the proposal PDF.
 * De-duplicates attached sheets drawn from two sources (per-line refs
 * + the legacy proposal-level OneToOne) so a spec referenced twice
 * only renders once. Returns ``null`` when nothing is attached so the
 * section collapses away on a standalone proposal.
 */
function AttachedSpecPreviews({
  orgId,
  proposal,
}: {
  orgId: string;
  proposal: ProposalDto;
}) {
  // Sales can't hold ``formulations.view``, so render via the
  // proposal-scoped spec passthrough below — see
  // ``AttachedSpecPreviewCard``.
  const tProposals = useTranslations("proposals");
  const attached = useMemo(() => {
    const seen = new Set<string>();
    const refs: {
      readonly sheetId: string;
      readonly title: string;
      readonly subtitle: string;
    }[] = [];
    for (const line of proposal.lines) {
      const sheetId = line.specification_sheet_id;
      if (!sheetId || seen.has(sheetId)) continue;
      seen.add(sheetId);
      refs.push({
        sheetId,
        title:
          line.formulation_name ||
          line.description ||
          line.product_code ||
          "",
        subtitle: line.formulation_version_number
          ? `v${line.formulation_version_number}`
          : "",
      });
    }
    const legacy = proposal.specification_sheet_id;
    if (legacy && !seen.has(legacy)) {
      refs.push({
        sheetId: legacy,
        title: proposal.formulation_name || "",
        subtitle: proposal.formulation_version_number
          ? `v${proposal.formulation_version_number}`
          : "",
      });
    }
    return refs;
  }, [proposal]);

  if (attached.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <header className="flex flex-col gap-0.5">
        <h2 className="text-sm font-semibold text-ink-1000">
          {tProposals("detail.attached_specs.title")}
        </h2>
        <p className="text-xs text-ink-500">
          {tProposals("detail.attached_specs.subtitle")}
        </p>
      </header>
      {attached.map((ref) => (
        <AttachedSpecPreviewCard
          key={ref.sheetId}
          orgId={orgId}
          proposalId={proposal.id}
          sheetId={ref.sheetId}
          title={ref.title}
          subtitle={ref.subtitle}
        />
      ))}
    </section>
  );
}


/**
 * Single bundled-spec preview. Renders the spec inline as React
 * from JSON (``useRenderedSpecification`` → ``SpecSheetContent``)
 * rather than iframing a WeasyPrint PDF render. Same approach the
 * customer kiosk uses for its bundled specs — cheaper on the
 * server (no PDF render on every proposal-page load), more
 * reliable (no iframe failure modes), and lets the staff scroll
 * through the spec inside a fixed-height window instead of
 * stretching the whole page.
 */
function AttachedSpecPreviewCard({
  orgId,
  proposalId,
  sheetId,
  title,
  subtitle,
}: {
  orgId: string;
  proposalId: string;
  sheetId: string;
  title: string;
  subtitle: string;
}) {
  const tProposals = useTranslations("proposals");
  // Use the proposal-scoped passthrough so sales (who hold
  // ``proposals.view`` but not ``formulations.view``) can read the
  // spec attached to a proposal they can already see.
  const renderedQuery = useProposalAttachedSpec(orgId, proposalId, sheetId);

  return (
    <article className="rounded-2xl bg-ink-0 p-5 shadow-sm ring-1 ring-ink-200">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Sparkles className="h-4 w-4 text-orange-600" />
          <h3 className="text-sm font-semibold text-ink-1000">
            {title || tProposals("public.doc.spec_title_untitled")}
          </h3>
          {subtitle ? (
            <span className="text-xs text-ink-500">{subtitle}</span>
          ) : null}
        </div>
        <a
          href={specificationsEndpoints.pdf(orgId, sheetId, { download: true })}
          download
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-50"
        >
          <Download className="h-3.5 w-3.5" />
          {tProposals("detail.attached_specs.download_pdf")}
        </a>
      </header>
      {/* Same mobile treatment as the kiosk's ``InlineSpecPreview``
          — no horizontal padding on this wrapper so the inner
          ``SpecSheetContent`` (which already has its own ``px-6
          md:px-12``) gets full width. ``overflow-auto`` (both axes)
          so an over-wide actives / nutrition table scrolls inside
          the box instead of stretching the page. */}
      <div className="mt-3 h-[70vh] overflow-auto rounded-xl bg-ink-50 py-6 ring-1 ring-inset ring-ink-200 md:h-[780px]">
        {renderedQuery.data ? (
          <SpecSheetContent rendered={renderedQuery.data} />
        ) : renderedQuery.isError ? (
          <div className="flex h-full items-center justify-center text-sm text-ink-500">
            {tProposals("detail.attached_specs.failed")}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-ink-500">
            {tProposals("detail.preview_loading")}
          </div>
        )}
      </div>
    </article>
  );
}


/**
 * One-click copier for the proposal's public kiosk link. We write
 * the absolute URL into the clipboard rather than surface it as a
 * long anchor in the toolbar because (a) the token is opaque so
 * it renders badly, and (b) scientists routinely paste the link
 * into email or Slack — copying is the dominant action.
 *
 * Falls back to a selected-text prompt when ``navigator.clipboard``
 * is unavailable (Safari on older macOS, non-HTTPS dev environments)
 * so the button never leaves the scientist stranded.
 */
function ShareKioskLinkButton({
  token,
  tProposals,
}: {
  token: string;
  tProposals: ReturnType<typeof useTranslations<"proposals">>;
}) {
  const [copied, setCopied] = useState(false);

  const url = useMemo(() => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}/p/proposal/${token}`;
  }, [token]);

  const handleCopy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked — show the URL as a prompt so the
      // scientist can still ⌘-C it out of the dialog.
      window.prompt(tProposals("detail.share_kiosk_copy_prompt"), url);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      onClick={handleCopy}
      className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-50"
    >
      <Link2 className="h-4 w-4" />
      {copied
        ? tProposals("detail.share_kiosk_copied")
        : tProposals("detail.share_kiosk")}
    </Button>
  );
}


// ---------------------------------------------------------------------------
// Always-visible sales-person picker on the proposal toolbar
// ---------------------------------------------------------------------------


/**
 * Prominent clickable pill that shows which user signs this proposal
 * and lets the caller swap them in one click — same shape as the
 * formulation header's sales-person menu so the two surfaces feel
 * identical to the scientist.
 *
 * The pill shows the *effective* signatory — the proposal-level
 * override if one is set, otherwise the linked project's sales
 * person, otherwise "unassigned". Selecting a user writes a proposal-
 * level override through ``useUpdateProposal``; "Clear override"
 * nulls the override so the proposal falls back to the project again.
 *
 * Why a dedicated component instead of reusing
 * ``SalesPersonMenu`` from the formulations page: the formulations
 * menu writes via a project-specific ``useAssignSalesPerson``
 * endpoint, while proposals override through the generic
 * ``update_proposal`` path. Inlining the parallel here keeps the two
 * widgets reading identically without a coupled shared component.
 */
function ProposalSalesPersonMenu({
  orgId,
  proposal,
  onError,
  tProposals,
  tErrors,
}: {
  orgId: string;
  proposal: ProposalDto;
  onError: (msg: string | null) => void;
  tProposals: ReturnType<typeof useTranslations<"proposals">>;
  tErrors: ReturnType<typeof useTranslations<"errors">>;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  // Only fetch members when the menu actually opens — keeps the
  // background roster query off the proposal detail's critical path.
  const membersQuery = useMemberships(orgId, { enabled: open });
  const update = useUpdateProposal(orgId, proposal.id);

  const members = useMemo(() => {
    const rows = membersQuery.data ?? [];
    const seen = new Set<string>();
    const out: { id: string; name: string; email: string }[] = [];
    for (const row of rows) {
      if (seen.has(row.user.id)) continue;
      seen.add(row.user.id);
      const name =
        (row.user.full_name && row.user.full_name.trim()) || row.user.email;
      out.push({ id: row.user.id, name, email: row.user.email });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [membersQuery.data]);

  const effectiveName = proposal.effective_sales_person_name ?? "";
  const activeId = proposal.sales_person_id ?? proposal.effective_sales_person_id;
  const isOverride = Boolean(proposal.sales_person_id);
  const inheritedFromProject =
    !proposal.sales_person_id && effectiveName
      ? ` · ${tProposals("detail.sales_person.inherited")}`
      : "";

  const pillLabel = effectiveName || tProposals("detail.sales_person.unassigned");
  const pillClasses = effectiveName
    ? "bg-orange-50 text-orange-800 ring-orange-200"
    : "bg-ink-50 text-ink-600 ring-ink-200";

  const assign = async (userId: string | null) => {
    setOpen(false);
    onError(null);
    if ((userId ?? null) === (proposal.sales_person_id ?? null)) return;
    try {
      await update.mutateAsync({ sales_person_id: userId });
    } catch (err) {
      onError(extractApiErrorMessage(err, tErrors));
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={update.isPending}
        aria-haspopup="menu"
        aria-expanded={open}
        title={tProposals("detail.sales_person.label")}
        className={`inline-flex h-10 items-center gap-1.5 rounded-lg px-3 text-xs font-medium ring-1 ring-inset transition-opacity hover:opacity-90 disabled:opacity-60 ${pillClasses}`}
      >
        <UserRound className="h-3.5 w-3.5" />
        <span className="max-w-[14rem] truncate">
          {pillLabel}
          {inheritedFromProject}
        </span>
        <ChevronDown className="h-3 w-3" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-2 flex w-72 flex-col gap-0.5 rounded-xl bg-ink-0 p-1.5 shadow-lg ring-1 ring-ink-200"
        >
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
              {tProposals("detail.sales_person.label")}
            </span>
            {isOverride ? (
              <button
                type="button"
                onClick={() => assign(null)}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-ink-500 hover:bg-ink-50 hover:text-danger"
              >
                <X className="h-3 w-3" />
                {tProposals("detail.sales_person.clear_override")}
              </button>
            ) : null}
          </div>
          {membersQuery.isLoading ? (
            <p className="px-2 py-3 text-xs text-ink-500">
              {tProposals("detail.sales_person.loading")}
            </p>
          ) : members.length === 0 ? (
            <p className="px-2 py-3 text-xs text-ink-500">
              {tProposals("detail.sales_person.empty")}
            </p>
          ) : (
            <div className="max-h-72 overflow-y-auto">
              {members.map((member) => {
                const isActive = member.id === activeId;
                return (
                  <button
                    key={member.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    disabled={update.isPending}
                    onClick={() => assign(member.id)}
                    className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-ink-50 disabled:opacity-60 ${
                      isActive ? "bg-orange-50/60" : ""
                    }`}
                  >
                    <UserRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-400" />
                    <span className="flex min-w-0 flex-col">
                      <span
                        className={`truncate text-sm ${
                          isActive
                            ? "font-semibold text-ink-1000"
                            : "text-ink-800"
                        }`}
                      >
                        {member.name}
                      </span>
                      <span className="truncate text-[11px] text-ink-500">
                        {member.email}
                      </span>
                    </span>
                    {isActive ? (
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-500" />
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}


/**
 * Internal-only sign-off summary. Surfaces who pressed the
 * scientist + director signature buttons on this proposal and when
 * they did so — strictly for staff browsing the proposal in-app.
 *
 * The same data is intentionally NOT rendered into the customer-
 * facing PDF (the kiosk preview / download stream): the "Internal
 * approvals" block used to live at the foot of every generated PDF
 * but partners flagged it as noise — the customer doesn't need to
 * see internal approval chops. Keeping the panel on the web view
 * means commercial reviewers can still glance at it without
 * leaking the signatures into the document the customer sees.
 *
 * Renders nothing when neither slot has been signed off — keeps
 * fresh draft proposals from growing an empty panel.
 */
function InternalApprovalsPanel({
  proposal,
  tProposals,
}: {
  proposal: ProposalDto;
  tProposals: ReturnType<typeof useTranslations<"proposals">>;
}) {
  const format = useFormatter();
  const { prepared_by: preparedBy, director } = proposal;
  if (!preparedBy && !director) return null;

  const slots: ReadonlyArray<{
    readonly key: "prepared_by" | "director";
    readonly label: string;
    readonly entry: { name: string; signed_at: string } | null;
  }> = [
    {
      key: "prepared_by",
      label: tProposals("detail.internal_approvals.prepared_by"),
      entry: preparedBy,
    },
    {
      key: "director",
      label: tProposals("detail.internal_approvals.director"),
      entry: director,
    },
  ];

  return (
    <section className="rounded-2xl bg-ink-0 p-5 shadow-sm ring-1 ring-ink-200">
      <header className="flex items-center justify-between gap-3 border-b border-ink-100 pb-3">
        <h2 className="text-sm font-semibold text-ink-1000">
          {tProposals("detail.internal_approvals.title")}
        </h2>
        <span className="text-[11px] text-ink-500">
          {tProposals("detail.internal_approvals.hint")}
        </span>
      </header>
      <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {slots.map(({ key, label, entry }) => (
          <div
            key={key}
            className="rounded-xl bg-ink-50 px-3 py-2 ring-1 ring-inset ring-ink-200"
          >
            <dt className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
              {label}
            </dt>
            {entry ? (
              <dd className="mt-1 flex flex-col gap-0.5">
                <span className="text-sm font-medium text-ink-1000">
                  {entry.name}
                </span>
                <span className="text-[11px] text-ink-500">
                  {format.dateTime(new Date(entry.signed_at), {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </span>
              </dd>
            ) : (
              <dd className="mt-1 text-xs text-ink-400">
                {tProposals("detail.internal_approvals.pending")}
              </dd>
            )}
          </div>
        ))}
      </dl>
    </section>
  );
}


/**
 * Customer-side activity timeline for the proposal.
 *
 * Answers the simplest question staff have today and can't:
 * *did the customer open the link we sent them, and where in the
 * flow did they stop?* The panel renders even on a draft proposal
 * (it just renders the "Not yet opened" empty state), so it's a
 * single place to glance at customer engagement without inferring
 * it from sign timestamps or chasing a reply email.
 *
 * Backed by :func:`useProposalActivity` which hits the
 * ``/activity/`` endpoint server-side; the staff capability check
 * lives there. The component itself is dumb — render whatever the
 * server returned, in newest-first order, with a kind-keyed icon
 * + label and a relative-time stamp.
 */
function CustomerActivityPanel({
  orgId,
  proposalId,
}: {
  orgId: string;
  proposalId: string;
}) {
  const format = useFormatter();
  const activityQuery = useProposalActivity(orgId, proposalId);

  // Aggregate the flat event list into per-(kind, target) groups so
  // a customer who refreshes the proposal page 12 times produces ONE
  // row, not 12. Groups stay sorted by most-recent activity so the
  // freshest signal floats to the top of the panel regardless of
  // how chatty older interactions were.
  const groups = useMemo(
    () => aggregateActivityEvents(activityQuery.data?.events ?? []),
    [activityQuery.data?.events],
  );

  return (
    <section className="rounded-2xl bg-ink-0 p-5 shadow-sm ring-1 ring-ink-200">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 pb-3">
        <div className="flex flex-col">
          <h2 className="text-sm font-semibold text-ink-1000">
            Customer activity
          </h2>
          <p className="text-[11px] text-ink-500">
            What the customer has done on the portal for this proposal.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => activityQuery.refetch()}
          isDisabled={activityQuery.isFetching}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50 disabled:opacity-60"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${
              activityQuery.isFetching ? "animate-spin" : ""
            }`}
          />
          Refresh
        </Button>
      </header>

      {activityQuery.isLoading ? (
        <p className="mt-3 text-xs text-ink-500">Loading activity…</p>
      ) : activityQuery.error ? (
        <p
          role="alert"
          className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs font-medium text-danger ring-1 ring-inset ring-danger/20"
        >
          Couldn't load activity for this proposal.
        </p>
      ) : groups.length > 0 ? (
        <>
          <ActivitySummaryHeader
            events={activityQuery.data?.events ?? []}
            format={format}
          />
          <ul className="mt-3 flex flex-col gap-2">
            {groups.map((group) => (
              <ActivityGroupRow
                key={group.key}
                group={group}
                format={format}
              />
            ))}
          </ul>
        </>
      ) : (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-ink-50 px-3 py-3 text-xs text-ink-600">
          <Clock className="h-3.5 w-3.5 text-ink-400" aria-hidden />
          <span>
            Not yet opened. The activity log will populate as soon as the
            customer clicks the link.
          </span>
        </div>
      )}
    </section>
  );
}


/** Cosmetic metadata per portal-event kind — keep keys in lockstep
 *  with :class:`apps.client_portal.models.PortalEvent.Kind` server
 *  side. Unknown kinds fall back to the raw string so a backend
 *  that ships a new kind before the FE updates still renders. */
const ACTIVITY_KIND_LABEL: Record<string, string> = {
  link_opened: "Opened activation link",
  activation_code_requested: "Requested verification code",
  activated: "Activated account",
  signed_in: "Signed in",
  signed_out: "Signed out",
  proposal_viewed: "Opened proposal",
  proposal_pdf_downloaded: "Downloaded PDF",
  proposal_signed: "Signed proposal",
  proposal_rejected: "Rejected proposal",
  spec_viewed: "Opened spec",
  spec_signed: "Signed spec",
};

function ActivityKindIcon({ kind }: { kind: string }) {
  const cls = "h-3.5 w-3.5";
  switch (kind) {
    case "link_opened":
      return <MailOpen className={`${cls} text-ink-500`} aria-hidden />;
    case "activation_code_requested":
      return <KeyRound className={`${cls} text-ink-500`} aria-hidden />;
    case "activated":
      return <CheckCircle2 className={`${cls} text-success`} aria-hidden />;
    case "signed_in":
      return <LogIn className={`${cls} text-ink-500`} aria-hidden />;
    case "signed_out":
      return <LogIn className={`${cls} text-ink-400`} aria-hidden />;
    case "proposal_viewed":
    case "spec_viewed":
      return <Eye className={`${cls} text-ink-500`} aria-hidden />;
    case "proposal_pdf_downloaded":
      return <FileDown className={`${cls} text-ink-500`} aria-hidden />;
    case "proposal_signed":
    case "spec_signed":
      return <FileSignature className={`${cls} text-success`} aria-hidden />;
    case "proposal_rejected":
      return <XCircle className={`${cls} text-danger`} aria-hidden />;
    default:
      return <Clock className={`${cls} text-ink-400`} aria-hidden />;
  }
}


/** One row in the aggregated activity list. A "group" is every
 *  event the customer fired for the same ``(kind, target)`` pair —
 *  e.g. every "Opened proposal" rolls into one row regardless of
 *  refresh count, but two different spec sheets stay distinct. */
interface ActivityGroup {
  readonly key: string;
  readonly kind: string;
  readonly target: ProposalActivityEventDto["target"];
  /** All event timestamps inside this group, newest-first. */
  readonly timestamps: readonly string[];
  /** Account email observed on at least one event in the group. */
  readonly accountEmail: string | null;
}

function aggregateActivityEvents(
  events: readonly ProposalActivityEventDto[],
): ActivityGroup[] {
  const byKey = new Map<string, ActivityGroup>();
  for (const event of events) {
    const targetKey = event.target ? `${event.target.kind}:${event.target.id}` : "";
    const key = `${event.kind}::${targetKey}`;
    const existing = byKey.get(key);
    if (existing) {
      // Events arrive newest-first, so the *first* push of any
      // group is also the freshest. Subsequent pushes are older
      // and naturally append after.
      (existing.timestamps as string[]).push(event.created_at);
      continue;
    }
    byKey.set(key, {
      key,
      kind: event.kind,
      target: event.target,
      timestamps: [event.created_at] as string[],
      accountEmail: event.client_account?.email ?? null,
    });
  }
  // Sort groups by their newest timestamp (timestamps[0]) DESC so
  // the most recently active row sits at the top — matches how
  // the rest of the staff inbox views surface "what just happened".
  return Array.from(byKey.values()).sort((a, b) =>
    a.timestamps[0]! < b.timestamps[0]! ? 1 : -1,
  );
}


function describeActivityGroup(group: ActivityGroup): string {
  const base = ACTIVITY_KIND_LABEL[group.kind] ?? group.kind;
  if (group.target?.kind === "spec") {
    const name = group.target.formulation_name || group.target.code || "spec";
    return `${base}: ${name}`;
  }
  return base;
}


function ActivityGroupRow({
  group,
  format,
}: {
  group: ActivityGroup;
  format: ReturnType<typeof useFormatter>;
}) {
  const [expanded, setExpanded] = useState(false);
  const count = group.timestamps.length;
  const newest = new Date(group.timestamps[0]!);
  const oldest = new Date(group.timestamps[group.timestamps.length - 1]!);
  const label = describeActivityGroup(group);
  const isRepeated = count > 1;

  return (
    <li className="rounded-lg bg-ink-50/60 ring-1 ring-inset ring-ink-100">
      <button
        type="button"
        onClick={() => (isRepeated ? setExpanded((v) => !v) : undefined)}
        aria-expanded={isRepeated ? expanded : undefined}
        disabled={!isRepeated}
        className="flex w-full items-start gap-3 px-3 py-2 text-left"
      >
        <span className="mt-0.5 shrink-0">
          <ActivityKindIcon kind={group.kind} />
        </span>
        <div className="flex-1 min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-medium text-ink-1000">
            <span className="truncate">{label}</span>
            {isRepeated ? (
              <span className="inline-flex h-4 items-center rounded bg-ink-200/70 px-1.5 text-[10px] font-semibold tabular-nums text-ink-700">
                ×{count}
              </span>
            ) : null}
          </p>
          {group.accountEmail ? (
            <p className="truncate text-[11px] text-ink-500">
              {group.accountEmail}
            </p>
          ) : null}
        </div>
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-ink-500">
          <time
            dateTime={group.timestamps[0]}
            title={format.dateTime(newest, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          >
            {format.relativeTime(newest, new Date())}
          </time>
          {isRepeated ? (
            <ChevronDown
              className={`h-3.5 w-3.5 text-ink-400 transition-transform ${
                expanded ? "rotate-180" : ""
              }`}
              aria-hidden
            />
          ) : null}
        </span>
      </button>
      {isRepeated && expanded ? (
        <div className="border-t border-ink-100 px-3 pb-2 pt-2">
          <p className="text-[10px] uppercase tracking-wide text-ink-500">
            First seen{" "}
            {format.dateTime(oldest, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </p>
          <ol className="mt-1 flex flex-col gap-0.5">
            {group.timestamps.map((ts, idx) => {
              const when = new Date(ts);
              return (
                <li
                  key={`${ts}-${idx}`}
                  className="flex items-center justify-between text-[11px] text-ink-500"
                >
                  <span className="tabular-nums">#{count - idx}</span>
                  <time dateTime={ts} title={ts}>
                    {format.dateTime(when, {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                  </time>
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}
    </li>
  );
}


function ActivitySummaryHeader({
  events,
  format,
}: {
  events: readonly ProposalActivityEventDto[];
  format: ReturnType<typeof useFormatter>;
}) {
  // Events arrive newest-first from the API. The summary line is
  // load-bearing: it's the single glanceable signal a PM needs to
  // see at the top of the card without expanding anything ("they
  // opened it · they just looked again 5 minutes ago").
  if (events.length === 0) return null;
  const newest = new Date(events[0]!.created_at);
  const oldest = new Date(events[events.length - 1]!.created_at);

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-500">
      <span className="inline-flex items-center gap-1">
        <Clock className="h-3 w-3 text-ink-400" aria-hidden />
        <span>
          Last seen{" "}
          <time
            dateTime={events[0]!.created_at}
            title={format.dateTime(newest, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
            className="font-medium text-ink-700"
          >
            {format.relativeTime(newest, new Date())}
          </time>
        </span>
      </span>
      <span className="text-ink-300">·</span>
      <span>
        First seen{" "}
        <time
          dateTime={events[events.length - 1]!.created_at}
          title={format.dateTime(oldest, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        >
          {format.relativeTime(oldest, new Date())}
        </time>
      </span>
      <span className="text-ink-300">·</span>
      <span className="tabular-nums">
        {events.length} event{events.length === 1 ? "" : "s"}
      </span>
    </div>
  );
}


/**
 * Staff-side e-signature audit trail. Renders one row per signed
 * document (proposal + each attached spec) with the evidence the
 * kiosk captures at sign time: IP, User-Agent, signed-at timestamp,
 * and the SHA-256 of the rendered HTML the signer saw. The backend
 * recomputes the hash live and we colour the row red when it no
 * longer matches — that's the load-bearing piece for a court
 * argument that "this customer agreed to this document".
 *
 * Hidden until the proposal has a customer signature so a blank
 * draft proposal doesn't grow an empty audit section. Permission-
 * gated server-side (``proposals:view_signed``); the kiosk never
 * sees this surface.
 */
function SignatureEvidencePanel({
  orgId,
  proposalId,
  hasCustomerSignature,
  tProposals,
}: {
  orgId: string;
  proposalId: string;
  hasCustomerSignature: boolean;
  tProposals: ReturnType<typeof useTranslations<"proposals">>;
}) {
  const format = useFormatter();
  const auditQuery = useProposalAudit(orgId, proposalId, hasCustomerSignature);

  // No signature yet → no panel. Avoids a "nothing here" placeholder
  // on every draft proposal page.
  if (!hasCustomerSignature) return null;

  return (
    <section className="rounded-2xl bg-ink-0 p-5 shadow-sm ring-1 ring-ink-200">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 pb-3">
        <div className="flex flex-col">
          <h2 className="text-sm font-semibold text-ink-1000">
            {tProposals("detail.audit.title")}
          </h2>
          <p className="text-[11px] text-ink-500">
            {tProposals("detail.audit.subtitle")}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => auditQuery.refetch()}
          isDisabled={auditQuery.isFetching}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50 disabled:opacity-60"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${
              auditQuery.isFetching ? "animate-spin" : ""
            }`}
          />
          {tProposals("detail.audit.verify_cta")}
        </Button>
      </header>

      {auditQuery.isLoading ? (
        <p className="mt-3 text-xs text-ink-500">
          {tProposals("detail.audit.loading")}
        </p>
      ) : auditQuery.error ? (
        <p
          role="alert"
          className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs font-medium text-danger ring-1 ring-inset ring-danger/20"
        >
          {tProposals("detail.audit.error")}
        </p>
      ) : auditQuery.data ? (
        <div className="mt-3 flex flex-col gap-3">
          <AuditRow
            title={tProposals("detail.audit.proposal_title")}
            document={auditQuery.data.proposal}
            format={format}
            tProposals={tProposals}
          />
          {auditQuery.data.specs.map((spec) => (
            <AuditRow
              key={spec.id}
              title={
                spec.formulation_name || spec.code
                  ? tProposals("detail.audit.spec_title", {
                      name: spec.formulation_name || spec.code,
                    })
                  : tProposals("detail.audit.spec_title_untitled")
              }
              document={spec}
              format={format}
              tProposals={tProposals}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}


/**
 * One row in the audit panel. Same shape for the proposal and for
 * each attached spec — ``document`` is typed broadly so the spec
 * row's extra ``id`` / ``code`` fields can come along without a
 * second component.
 */
function AuditRow({
  title,
  document,
  format,
  tProposals,
}: {
  title: string;
  document: ProposalAuditDocumentDto | ProposalAuditSpecDto;
  format: ReturnType<typeof useFormatter>;
  tProposals: ReturnType<typeof useTranslations<"proposals">>;
}) {
  const signed = Boolean(document.signed_at);
  const hashStored = document.stored_hash !== "";
  // Hash status is one of three:
  //  - "match"   — stored + current both present and equal (good)
  //  - "drift"   — stored + current present but unequal (bad — red)
  //  - "missing" — pre-sign or pre-instrumentation row (neutral)
  const hashStatus: "match" | "drift" | "missing" = !hashStored
    ? "missing"
    : document.hash_matches
      ? "match"
      : "drift";

  return (
    <article className="rounded-xl bg-ink-50 px-4 py-3 ring-1 ring-inset ring-ink-200">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-ink-1000">{title}</h3>
        {signed && hashStatus !== "missing" ? (
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${
              hashStatus === "match"
                ? "bg-success/10 text-success ring-success/30"
                : "bg-danger/10 text-danger ring-danger/30"
            }`}
          >
            {hashStatus === "match" ? (
              <ShieldCheck className="h-3 w-3" />
            ) : (
              <ShieldAlert className="h-3 w-3" />
            )}
            {hashStatus === "match"
              ? tProposals("detail.audit.hash_match")
              : tProposals("detail.audit.hash_drift")}
          </span>
        ) : null}
      </header>

      {!signed ? (
        <p className="mt-2 text-[11px] text-ink-500">
          {tProposals("detail.audit.not_signed")}
        </p>
      ) : (
        <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 text-[11px] sm:grid-cols-2">
          <AuditField
            label={tProposals("detail.audit.signer")}
            value={[
              document.signer_name,
              document.signer_email
                ? `<${document.signer_email}>`
                : "",
              document.signer_company,
            ]
              .filter(Boolean)
              .join(" · ")}
          />
          <AuditField
            label={tProposals("detail.audit.signed_at")}
            value={
              document.signed_at
                ? format.dateTime(new Date(document.signed_at), {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })
                : ""
            }
          />
          <AuditField
            label={tProposals("detail.audit.ip")}
            value={document.ip || "—"}
            mono
          />
          <AuditField
            label={tProposals("detail.audit.user_agent")}
            value={document.user_agent || "—"}
            mono
          />
          <AuditField
            label={tProposals("detail.audit.stored_hash")}
            value={document.stored_hash || "—"}
            mono
            wide
          />
          <AuditField
            label={tProposals("detail.audit.current_hash")}
            value={document.current_hash || "—"}
            mono
            wide
          />
        </dl>
      )}
    </article>
  );
}


function AuditField({
  label,
  value,
  mono = false,
  wide = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-0.5 ${wide ? "sm:col-span-2" : ""}`}
    >
      <dt className="text-[9px] font-semibold uppercase tracking-wide text-ink-500">
        {label}
      </dt>
      <dd
        className={`break-all text-ink-1000 ${
          mono ? "font-mono text-[10px]" : "text-[11px]"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}


/**
 * Red banner shown at the top of a rejected proposal. Renders only
 * when the customer declined via the kiosk (``customer_rejected_at``
 * is non-null) — a manual operator-driven status change to
 * ``rejected`` won't populate the timestamp and the banner stays
 * collapsed in that case.
 *
 * The reason can be empty when the customer declined without
 * explaining; we still show the panel with a fallback sentence so
 * the sales team sees the decline event acknowledged on the page.
 */
function RejectionPanel({
  proposal,
  tProposals,
}: {
  proposal: ProposalDto;
  tProposals: ReturnType<typeof useTranslations<"proposals">>;
}) {
  const format = useFormatter();
  const declinedAt = proposal.customer_rejected_at;
  if (!declinedAt) return null;
  const reason = (proposal.customer_rejection_reason || "").trim();
  return (
    <section
      role="alert"
      className="rounded-2xl border border-danger/30 bg-danger/5 p-5 shadow-sm md:p-6"
    >
      <header className="flex items-center gap-2 border-b border-danger/20 pb-3">
        <XCircle className="h-5 w-5 text-danger" />
        <div className="flex flex-col">
          <h2 className="text-sm font-semibold text-danger">
            {tProposals("detail.rejection.title")}
          </h2>
          <p className="text-[11px] text-danger/80">
            {tProposals("detail.rejection.subtitle", {
              when: format.dateTime(new Date(declinedAt), {
                dateStyle: "medium",
                timeStyle: "short",
              }),
            })}
          </p>
        </div>
      </header>
      <div className="mt-3 text-sm text-ink-1000">
        {reason ? (
          <blockquote className="whitespace-pre-wrap border-l-2 border-danger/40 bg-ink-0 px-3 py-2 italic text-ink-700 ring-1 ring-inset ring-danger/10">
            {reason}
          </blockquote>
        ) : (
          <p className="text-ink-500">
            {tProposals("detail.rejection.no_reason")}
          </p>
        )}
      </div>
    </section>
  );
}


/**
 * Quick-links panel on the proposal page. Surfaces the
 * project (formulation) the proposal quotes against plus every
 * unique specification sheet bundled into it, so the sales /
 * scientist who opens a proposal can jump straight to the source
 * documents without poking around the nav. De-dupes spec sheets
 * referenced by multiple lines + the legacy proposal-level
 * OneToOne — same de-dup the kiosk uses.
 *
 * Hidden entirely when there's nothing linkable (no formulation +
 * no specs) so a fresh empty proposal doesn't grow a pointless
 * empty card.
 */
function LinkedResourcesPanel({
  proposal,
  tProposals,
}: {
  proposal: ProposalDto;
  tProposals: ReturnType<typeof useTranslations<"proposals">>;
}) {
  // Collect unique attached spec sheets. ``Set`` keyed on the sheet
  // id; we walk the lines first (canonical path) then fall back to
  // the legacy proposal-level OneToOne for older rows.
  const specs = useMemo(() => {
    const seen = new Set<string>();
    const out: {
      readonly sheetId: string;
      readonly label: string;
      readonly subLabel: string;
    }[] = [];
    for (const line of proposal.lines) {
      const sheetId = line.specification_sheet_id;
      if (!sheetId || seen.has(sheetId)) continue;
      seen.add(sheetId);
      out.push({
        sheetId,
        label:
          line.formulation_name ||
          line.description ||
          line.product_code ||
          tProposals("detail.linked.spec_fallback"),
        subLabel: line.formulation_version_number
          ? `v${line.formulation_version_number}`
          : "",
      });
    }
    const legacy = proposal.specification_sheet_id;
    if (legacy && !seen.has(legacy)) {
      seen.add(legacy);
      out.push({
        sheetId: legacy,
        label:
          proposal.formulation_name ||
          tProposals("detail.linked.spec_fallback"),
        subLabel: proposal.formulation_version_number
          ? `v${proposal.formulation_version_number}`
          : "",
      });
    }
    return out;
  }, [proposal, tProposals]);

  // Project link only renders when the proposal carries a
  // ``formulation_id`` — should always be true under the current
  // schema, but the field is nullable on the DTO for older rows
  // so we guard.
  const hasProject = Boolean(proposal.formulation_id);
  if (!hasProject && specs.length === 0) return null;

  return (
    <section className="rounded-2xl bg-ink-0 p-5 shadow-sm ring-1 ring-ink-200">
      <header className="flex items-center justify-between gap-3 border-b border-ink-100 pb-3">
        <h2 className="text-sm font-semibold text-ink-1000">
          {tProposals("detail.linked.title")}
        </h2>
        <span className="text-[11px] text-ink-500">
          {tProposals("detail.linked.hint")}
        </span>
      </header>
      <div className="mt-3 flex flex-wrap gap-2">
        {hasProject ? (
          <Link
            href={`/formulations/${proposal.formulation_id}`}
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink-50 px-3 py-2 text-xs font-medium text-ink-1000 ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-100"
          >
            <FlaskConical className="h-3.5 w-3.5 text-orange-600" />
            <span className="text-ink-1000">
              {proposal.formulation_name ||
                tProposals("detail.linked.project_fallback")}
            </span>
            {proposal.formulation_version_number ? (
              <span className="text-ink-500">
                v{proposal.formulation_version_number}
              </span>
            ) : null}
            <ExternalLink className="h-3 w-3 text-ink-400" />
          </Link>
        ) : null}

        {specs.map((spec) => (
          <Link
            key={spec.sheetId}
            href={`/specifications/${spec.sheetId}`}
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink-50 px-3 py-2 text-xs font-medium text-ink-1000 ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-100"
          >
            <Sparkles className="h-3.5 w-3.5 text-orange-600" />
            <span className="text-ink-1000">{spec.label}</span>
            {spec.subLabel ? (
              <span className="text-ink-500">{spec.subLabel}</span>
            ) : null}
            <ExternalLink className="h-3 w-3 text-ink-400" />
          </Link>
        ))}
      </div>
    </section>
  );
}


/**
 * "Reject on behalf of client" dialog.
 *
 * Mirrors the kiosk's decline modal so a closer who's heard a
 * verbal no by phone/email can terminate the proposal in place and
 * recreate it later. The reason field is optional — same shape as
 * the customer-facing form — and round-trips to
 * ``customer_rejection_reason`` so the existing :class:`RejectionPanel`
 * picks it up as if the customer had typed it themselves.
 */
function RejectOnBehalfDialog({
  isOpen,
  busy,
  onOpenChange,
  onConfirm,
  tProposals,
}: {
  isOpen: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => Promise<void> | void;
  tProposals: ReturnType<typeof useTranslations<"proposals">>;
}) {
  const [reason, setReason] = useState("");

  // Reset the textarea every time the modal closes so a stray draft
  // from a cancelled attempt doesn't bleed into the next one.
  useEffect(() => {
    if (!isOpen) setReason("");
  }, [isOpen]);

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (busy) return;
        onOpenChange(open);
      }}
    >
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <Modal.Header className="border-b border-ink-200 px-6 py-4">
              <Modal.Heading className="text-base font-semibold text-ink-1000">
                {tProposals("detail.reject_on_behalf.title")}
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-3 px-6 py-5">
              <p className="text-sm text-ink-700">
                {tProposals("detail.reject_on_behalf.body")}
              </p>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-ink-700">
                  {tProposals("detail.reject_on_behalf.reason_label")}
                </span>
                <textarea
                  rows={4}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={tProposals(
                    "detail.reject_on_behalf.reason_placeholder",
                  )}
                  className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                />
              </label>
            </Modal.Body>
            <Modal.Footer className="flex items-center justify-end gap-2 border-t border-ink-200 bg-ink-50 px-6 py-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                isDisabled={busy}
                className="h-10 rounded-lg px-4 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-0"
              >
                {tProposals("detail.reject_on_behalf.cancel")}
              </Button>
              <Button
                type="button"
                onClick={() => void onConfirm(reason.trim())}
                isDisabled={busy}
                className="h-10 rounded-lg bg-danger px-4 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy
                  ? tProposals("detail.reject_on_behalf.confirming")
                  : tProposals("detail.reject_on_behalf.confirm")}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
