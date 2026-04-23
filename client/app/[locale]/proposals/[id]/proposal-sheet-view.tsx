"use client";

import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Download,
  Link2,
  Pencil,
  Plus,
  Save,
  Send,
  Trash2,
  Undo2,
  UserRound,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@heroui/react";

import { SignatureDialog } from "@/components/ui/signature-dialog";
import { Link } from "@/i18n/navigation";
import { apiClient, ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import {
  proposalsEndpoints,
  useAddProposalLine,
  useDeleteProposalLine,
  usePatchProposalLine,
  useProposal,
  useTransitionProposalStatus,
  useUpdateProposal,
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
import { useMemberships } from "@/services/members";
import {
  useInfiniteSpecifications,
  type SpecificationSheetDto,
} from "@/services/specifications";


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
  const [editOpen, setEditOpen] = useState(false);
  //: Missing-fields modal state — set by a 400 response on a status
  //: transition when the backend surfaces ``missing_required_fields``.
  //: Non-null value = modal is open and holding the list to display.
  const [missingFields, setMissingFields] = useState<string[] | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [signatureDialogOpen, setSignatureDialogOpen] = useState<
    false | "in_review" | "approved"
  >(false);
  // Proposal body HTML is rendered server-side (Django template) so
  // every surface — authenticated detail, kiosk, PDF — reads the
  // same document. The iframe src cannot point at the API origin
  // directly (cookies are not sent cross-site in an iframe) so we
  // fetch through apiClient and write the response into an iframe's
  // srcdoc. Re-fetches whenever the proposal changes (status,
  // signatures, customer info) so the preview stays current.
  // Fetch the proposal bytes (PDF when Word/LibreOffice converted
  // it, raw HTML otherwise) and surface them to the iframe through
  // a ``blob:`` URL. That keeps cookies scoped (the API request
  // goes through apiClient) while letting the iframe render binary
  // PDF output the browser can't embed from a direct path.
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

  if (proposalQuery.isLoading || !proposalQuery.data) {
    return (
      <div className="mt-6 text-sm text-ink-500">
        {tProposals("detail.loading")}
      </div>
    );
  }

  const proposal = proposalQuery.data;

  const handleTransition = async (
    nextStatus: ProposalStatus,
    signatureImage?: string,
  ) => {
    setError(null);
    setMissingFields(null);
    try {
      await transitionMutation.mutateAsync({
        status: nextStatus,
        signature_image: signatureImage ?? "",
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
      setError(extractErrorMessage(err, tErrors));
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
            <Button
              type="button"
              onClick={() => setSignatureDialogOpen("approved")}
              className="h-10 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
            >
              <CheckCircle2 className="mr-1.5 h-4 w-4" />
              {tProposals("detail.actions.approve")}
            </Button>
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
      case "approved":
        return (
          <Button
            type="button"
            onClick={() => handleTransition("sent")}
            className="h-10 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
          >
            <Send className="mr-1.5 h-4 w-4" />
            {tProposals("detail.actions.mark_sent")}
          </Button>
        );
      default:
        return null;
    }
  })();

  return (
    <div className="mt-6 flex flex-col gap-5">
      <Link
        href={`/formulations/${proposal.formulation_id}/proposals`}
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
        <ProposalSalesPersonMenu
          orgId={orgId}
          proposal={proposal}
          onError={setError}
          tProposals={tProposals}
          tErrors={tErrors}
        />
        {proposal.public_token ? (
          <ShareKioskLinkButton
            token={proposal.public_token}
            tProposals={tProposals}
          />
        ) : null}
        <Button
          type="button"
          variant="outline"
          onClick={() => setEditOpen(true)}
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-50"
        >
          <Pencil className="h-4 w-4" />
          {tProposals("detail.edit")}
        </Button>
        <Button
          type="button"
          onClick={async () => {
            // Fetch the PDF through apiClient (cookies attached)
            // instead of a cross-origin <a href download>, which
            // silently fails when the browser refuses to send the
            // auth cookie to the API origin.
            try {
              const response = await apiClient.get<Blob>(
                proposalsEndpoints.pdf(orgId, proposalId),
                { responseType: "blob" },
              );
              const blob = response.data;
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `${proposal.code || "proposal"}.pdf`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              URL.revokeObjectURL(url);
            } catch {
              setError("download_failed");
            }
          }}
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-orange-500 px-3 text-sm font-medium text-ink-0 transition-colors hover:bg-orange-600"
        >
          <Download className="h-4 w-4" />
          {tProposals("detail.download_pdf")}
        </Button>
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

      <ProposalLinesPanel
        orgId={orgId}
        proposalId={proposalId}
        lines={proposal.lines}
      />

      {missingFields ? (
        <MissingFieldsModal
          fields={missingFields}
          onEdit={() => {
            setMissingFields(null);
            setEditOpen(true);
          }}
          onDismiss={() => setMissingFields(null)}
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

  const [form, setForm] = useState(() => ({
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
    quantity: String(proposal.quantity),
    unit_cost: proposal.material_cost_per_pack ?? "",
    // Store the margin in the form state (not the unit_price). When
    // the proposal arrived with a non-zero margin we use that;
    // otherwise we back-compute the implied margin from the stored
    // cost + price pair so an existing proposal's current price
    // round-trips through the new UI without reading as "0%".
    margin:
      proposal.margin_percent ??
      _deriveMargin(
        proposal.material_cost_per_pack,
        proposal.unit_price,
      ),
    freight_amount: proposal.freight_amount ?? "",
    currency: proposal.currency,
    valid_until: proposal.valid_until ?? "",
    cover_notes: proposal.cover_notes,
  }));

  //: Live-computed unit price from cost + margin. Gross-margin
  //: semantics: ``price = cost / (1 − margin/100)``. Read-only in
  //: the UI — the backend still stores unit_price for template
  //: rendering, but the scientist only types cost + margin.
  const derivedUnitPrice = useMemo(() => {
    const cost = Number.parseFloat(form.unit_cost);
    const pct = Number.parseFloat(form.margin);
    if (!Number.isFinite(cost) || cost <= 0) return null;
    if (!Number.isFinite(pct) || pct < 0 || pct >= 100) return null;
    return cost / (1 - pct / 100);
  }, [form.unit_cost, form.margin]);

  const bind =
    (key: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const handleSave = async () => {
    await onSubmit({
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
      quantity: Math.max(1, Number.parseInt(form.quantity, 10) || 1),
      unit_price:
        derivedUnitPrice !== null
          ? derivedUnitPrice.toFixed(4)
          : null,
      material_cost_per_pack: form.unit_cost || null,
      margin_percent: form.margin || null,
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
            onChange={(e) =>
              setForm((prev) => ({
                ...prev,
                specification_sheet_id: e.target.value,
              }))
            }
            className="w-full cursor-pointer rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          >
            <option value="">
              {tProposals("edit.specification_sheet_none")}
            </option>
            {specSheets.map((sheet) => {
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
            })}
          </select>
        </Field>
        <Field label={tProposals("edit.quantity")}>
          <input
            type="number"
            min={1}
            value={form.quantity}
            onChange={bind("quantity")}
            className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          />
        </Field>
        <Field label={tProposals("edit.currency")}>
          <input
            value={form.currency}
            onChange={bind("currency")}
            maxLength={3}
            className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm uppercase text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          />
        </Field>
        <Field label={tProposals("edit.unit_cost")}>
          <input
            type="number"
            step="0.0001"
            value={form.unit_cost}
            onChange={bind("unit_cost")}
            className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          />
        </Field>
        <Field label={tProposals("edit.margin")}>
          <input
            type="number"
            step="0.1"
            value={form.margin}
            onChange={bind("margin")}
            placeholder="30"
            className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
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

      <div
        className={`mt-4 rounded-xl px-3 py-2 text-sm font-medium ring-1 ring-inset ${
          derivedUnitPrice === null
            ? "bg-ink-50 text-ink-500 ring-ink-200"
            : "bg-success/10 text-success ring-success/30"
        }`}
      >
        {derivedUnitPrice === null
          ? tProposals("create.price_placeholder")
          : tProposals("create.price_derived", {
              price: derivedUnitPrice.toFixed(2),
            })}
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
}: {
  orgId: string;
  proposalId: string;
  lines: readonly ProposalLineDto[];
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
        <Button
          type="button"
          variant="outline"
          onClick={() => setAddOpen((v) => !v)}
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
        >
          <Plus className="h-4 w-4" />
          {tProposals("lines.add")}
        </Button>
      </header>

      {addOpen ? (
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
                    />
                  </td>
                  <td className="px-2 py-2">
                    <LineInput
                      defaultValue={line.description}
                      onCommit={(v) =>
                        handleField(line, "description", v)
                      }
                    />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <LineInput
                      defaultValue={String(line.quantity)}
                      type="number"
                      min={1}
                      onCommit={(v) => handleField(line, "quantity", v)}
                      align="right"
                    />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <LineInput
                      defaultValue={line.unit_cost ?? ""}
                      type="number"
                      step="0.0001"
                      onCommit={(v) => handleField(line, "unit_cost", v)}
                      align="right"
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
                    />
                  </td>
                  <td className="px-2 py-2 text-right">
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
}: {
  line: ProposalLineDto;
  specs: readonly SpecificationSheetDto[];
  onChange: (sheetId: string | null) => void;
  tProposals: ReturnType<typeof useTranslations<"proposals">>;
}) {
  // Scope to sheets pinned to the same formulation as this line's
  // snapshot. When the line has no formulation (ad-hoc line) we
  // fall through to the full list so there's always something to
  // pick. ``useMemo`` avoids recomputing on every keystroke in a
  // sibling cell.
  const relevant = useMemo(() => {
    if (!line.formulation_id) return specs;
    const scoped = specs.filter(
      (s) => s.formulation_id === line.formulation_id,
    );
    return scoped.length > 0 ? scoped : specs;
  }, [line.formulation_id, specs]);

  return (
    <select
      value={line.specification_sheet_id ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className="w-full min-w-[180px] cursor-pointer rounded-md bg-ink-0 px-2 py-1 text-xs text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
    >
      <option value="">{tProposals("lines.no_spec")}</option>
      {relevant.map((sheet) => {
        const label = [sheet.code, `v${sheet.formulation_version_number}`]
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
}: {
  defaultValue: string;
  onCommit: (value: string) => void;
  type?: "text" | "number";
  step?: string;
  min?: number;
  align?: "left" | "right";
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
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        if (value !== defaultValue) onCommit(value);
      }}
      className={`w-full rounded-md bg-ink-0 px-2 py-1 text-sm ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 ${
        align === "right" ? "text-right tabular-nums" : ""
      }`}
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

  const formulations = useMemo(
    () => formulationsQuery.data?.pages.flatMap((p) => p.results) ?? [],
    [formulationsQuery.data],
  );
  const versions: readonly FormulationVersionDto[] =
    versionsQuery.data ?? [];

  useEffect(() => {
    if (versions.length > 0 && !versions.some((v) => v.id === versionId)) {
      setVersionId(versions[0]!.id);
    } else if (versions.length === 0 && versionId !== "") {
      setVersionId("");
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
            className="w-full cursor-pointer rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          >
            <option value="">—</option>
            {formulations.map((f) => (
              <option key={f.id} value={f.id}>
                {f.code ? `${f.code} · ${f.name}` : f.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={tProposals("lines.add_version")}>
          <select
            value={versionId}
            onChange={(e) => setVersionId(e.target.value)}
            disabled={!formulationId || versions.length === 0}
            className="w-full cursor-pointer rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:cursor-not-allowed disabled:bg-ink-100"
          >
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.version_number}
                {v.label ? ` — ${v.label}` : ""}
              </option>
            ))}
          </select>
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


/** Pops when a status transition returns ``missing_required_fields``
 *  from the backend. Lists the fields in plain English and offers a
 *  one-click "Edit" button that dismisses the modal and opens the
 *  edit panel with the proposal's current values. */
function MissingFieldsModal({
  fields,
  onEdit,
  onDismiss,
}: {
  fields: string[];
  onEdit: () => void;
  onDismiss: () => void;
}) {
  const tProposals = useTranslations("proposals");
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-1000/50 px-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-2xl bg-ink-0 p-6 shadow-xl ring-1 ring-ink-200">
        <h3 className="text-base font-semibold text-ink-1000">
          {tProposals("missing.title")}
        </h3>
        <p className="mt-1 text-sm text-ink-500">
          {tProposals("missing.body")}
        </p>
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
        <div className="mt-6 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onDismiss}
            className="h-10 rounded-lg px-4 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
          >
            {tProposals("missing.dismiss")}
          </Button>
          <Button
            type="button"
            onClick={onEdit}
            className="h-10 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
          >
            <Pencil className="mr-1.5 h-4 w-4" />
            {tProposals("missing.edit")}
          </Button>
        </div>
      </div>
    </div>
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
      onError(extractErrorMessage(err, tErrors));
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
