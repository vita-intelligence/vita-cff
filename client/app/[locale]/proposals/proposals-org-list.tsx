"use client";

import { ExternalLink, Plus, PoundSterling, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { Button, Modal } from "@heroui/react";

import { Link, useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import {
  PROPOSAL_TEMPLATE_TYPES,
  useCreateProposal,
  useDeleteProposal,
  useProposals,
  type ProposalDto,
  type ProposalStatus,
  type ProposalTemplateType,
} from "@/services/proposals";
import {
  useFormulationVersions,
  useInfiniteFormulations,
  type FormulationVersionDto,
} from "@/services/formulations";
import { type CustomerDto } from "@/services/customers";
import {
  useInfiniteSpecifications,
  type SpecificationSheetDto,
} from "@/services/specifications";

import { CustomerPicker } from "@/components/customers/customer-picker";
import { CustomerFormModal } from "../customers/customers-list";


/**
 * Org-wide proposals list. Same shape as the per-project panel but
 * un-scoped — renders every proposal in the caller's organization
 * so a sales user can find a quote without knowing which project
 * it started on.
 *
 * The create modal asks for a formulation + version to seed the
 * first line; scientists add additional products (potentially from
 * different projects) from the proposal detail page's lines panel.
 */
export function ProposalsOrgList({ orgId }: { orgId: string }) {
  const tProposals = useTranslations("proposals");
  const tErrors = useTranslations("errors");

  const proposalsQuery = useProposals(orgId);
  const deleteMutation = useDeleteProposal(orgId);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const proposals = proposalsQuery.data ?? [];

  const handleDelete = async (proposalId: string) => {
    if (!confirm(tProposals("list.delete_confirm"))) return;
    setDeleteError(null);
    try {
      await deleteMutation.mutateAsync(proposalId);
    } catch (err) {
      setDeleteError(extractErrorMessage(err, tErrors));
    }
  };

  return (
    <section className="mt-6 rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 md:p-8">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-100 pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink-1000 md:text-2xl">
            {tProposals("list.title")}
          </h1>
          <p className="mt-0.5 text-sm text-ink-500">
            {tProposals("list.org_subtitle")}
          </p>
        </div>
        <OrgNewProposalButton orgId={orgId} />
      </header>

      {deleteError ? (
        <p
          role="alert"
          className="mt-4 rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
        >
          {deleteError}
        </p>
      ) : null}

      {proposalsQuery.isLoading ? (
        <p className="mt-6 text-sm text-ink-500">
          {tProposals("list.loading")}
        </p>
      ) : proposals.length === 0 ? (
        <div className="mt-6 rounded-xl bg-ink-50 px-4 py-8 text-center ring-1 ring-inset ring-ink-200">
          <PoundSterling className="mx-auto h-6 w-6 text-ink-400" />
          <p className="mt-2 text-sm text-ink-500">
            {tProposals("list.empty")}
          </p>
        </div>
      ) : (
        <ul className="mt-2 divide-y divide-ink-100">
          {proposals.map((proposal) => (
            <OrgProposalRow
              key={proposal.id}
              proposal={proposal}
              onDelete={handleDelete}
              deletePending={deleteMutation.isPending}
            />
          ))}
        </ul>
      )}
    </section>
  );
}


function OrgProposalRow({
  proposal,
  onDelete,
  deletePending,
}: {
  proposal: ProposalDto;
  onDelete: (id: string) => void;
  deletePending: boolean;
}) {
  const tProposals = useTranslations("proposals");
  const total = proposal.total_excl_vat ?? proposal.subtotal ?? null;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <Link
          href={`/proposals/${proposal.id}`}
          className="text-sm font-medium text-ink-1000 hover:text-orange-700"
        >
          {proposal.code} ·{" "}
          {proposal.customer_company ||
            proposal.customer_name ||
            tProposals("list.no_customer")}
        </Link>
        <span className="text-xs text-ink-500">
          {tProposals(
            `template_type.${proposal.template_type}` as "template_type.custom",
          )}
          {" · "}
          {proposal.lines.length}{" "}
          {tProposals("list.products_count", {
            count: proposal.lines.length,
          })}
          {total !== null ? ` · ${total} ${proposal.currency}` : ""}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <StatusChip status={proposal.status} />
        <Link
          href={`/proposals/${proposal.id}`}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {tProposals("list.view")}
        </Link>
        <button
          type="button"
          aria-label={tProposals("list.delete")}
          onClick={() => onDelete(proposal.id)}
          disabled={deletePending}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-500 transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </li>
  );
}


function StatusChip({ status }: { status: ProposalStatus }) {
  const tProposals = useTranslations("proposals");
  const variants: Record<ProposalStatus, string> = {
    draft: "bg-ink-100 text-ink-700 ring-ink-200",
    in_review: "bg-warning/10 text-warning ring-warning/20",
    approved: "bg-orange-500/10 text-orange-700 ring-orange-500/30",
    sent: "bg-orange-500/10 text-orange-700 ring-orange-500/30",
    accepted: "bg-success/10 text-success ring-success/30",
    rejected: "bg-danger/10 text-danger ring-danger/30",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset ${variants[status]}`}
    >
      {tProposals(`status.${status}` as "status.draft")}
    </span>
  );
}


/** Org-scoped create — picks any formulation in the org rather
 *  than starting inside one project. Creates a draft proposal with
 *  a single line; the scientist adds more lines from the detail
 *  page (the `Products on this proposal` panel supports any
 *  formulation via the same `AddLineForm`). */
function OrgNewProposalButton({ orgId }: { orgId: string }) {
  const tProposals = useTranslations("proposals");
  const tErrors = useTranslations("errors");
  const router = useRouter();

  const [isOpen, setIsOpen] = useState(false);
  const [template, setTemplate] = useState<ProposalTemplateType>("custom");
  const [formulationId, setFormulationId] = useState<string>("");
  const formulationsQuery = useInfiniteFormulations(orgId, {
    ordering: "name",
    pageSize: 50,
  });
  const versionsQuery = useFormulationVersions(orgId, formulationId);
  const [versionId, setVersionId] = useState<string>("");
  const [customer, setCustomer] = useState<CustomerDto | null>(null);
  const [customerCreating, setCustomerCreating] = useState(false);
  const [quantity, setQuantity] = useState<string>("1");
  const [unitCost, setUnitCost] = useState<string>("");
  const [margin, setMargin] = useState<string>("30");
  //: Optional spec-sheet attachment. Empty = no bundled spec; any
  //: value = SpecificationSheet UUID. The backend validates tenancy
  //: and the OneToOne uniqueness (one proposal per sheet) and
  //: rejects with ``specification_sheet_not_in_org`` when crossed.
  const [specSheetId, setSpecSheetId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const createMutation = useCreateProposal(orgId);
  const specSheetsQuery = useInfiniteSpecifications(orgId, { pageSize: 100 });

  const formulations =
    formulationsQuery.data?.pages.flatMap((p) => p.results) ?? [];
  const versions: readonly FormulationVersionDto[] =
    versionsQuery.data ?? [];
  // Flatten the infinite pages into a single list. 100/page is enough
  // that most orgs will never paginate here; the picker is a simple
  // <select> so we don't need infinite-scroll UX inside it.
  const specSheets: readonly SpecificationSheetDto[] =
    specSheetsQuery.data?.pages.flatMap((p) => p.results) ?? [];

  // Gross margin: price = cost / (1 - margin/100). See service
  // ``suggest_unit_price`` for the full edge-case rationale.
  const derivedUnitPrice = (() => {
    const c = Number.parseFloat(unitCost);
    const m = Number.parseFloat(margin);
    if (!Number.isFinite(c) || c <= 0) return null;
    if (!Number.isFinite(m) || m < 0 || m >= 100) return null;
    return c / (1 - m / 100);
  })();

  const close = () => {
    setIsOpen(false);
    setFormulationId("");
    setVersionId("");
    setCustomer(null);
    setQuantity("1");
    setUnitCost("");
    setMargin("30");
    setTemplate("custom");
    setSpecSheetId("");
    setError(null);
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    if (!versionId) {
      setError(tProposals("create.invalid_input"));
      return;
    }
    try {
      const created = await createMutation.mutateAsync({
        formulation_version_id: versionId,
        template_type: template,
        // Link the address-book record when one was picked. The
        // backend seeds the proposal's customer_* fields from this
        // customer, so we don't need to forward the individual
        // name / email / company values here — they fall out of the
        // FK lookup server-side.
        customer_id: customer?.id ?? null,
        specification_sheet_id: specSheetId || null,
        customer_name: customer?.name ?? "",
        customer_email: customer?.email ?? "",
        customer_company: customer?.company ?? "",
        quantity: Math.max(1, Number.parseInt(quantity, 10) || 1),
        unit_price:
          derivedUnitPrice !== null
            ? derivedUnitPrice.toFixed(4)
            : null,
        material_cost_per_pack: unitCost ? unitCost : null,
        margin_percent: margin ? margin : null,
      });
      close();
      router.push(`/proposals/${created.id}`);
    } catch (err) {
      setError(extractErrorMessage(err, tErrors));
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => (open ? setIsOpen(true) : close())}
    >
      <Modal.Trigger>
        <Button
          type="button"
          variant="primary"
          size="sm"
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-orange-500 px-3 text-sm font-medium text-ink-0 hover:bg-orange-600"
        >
          <Plus className="h-4 w-4" />
          {tProposals("create.trigger")}
        </Button>
      </Modal.Trigger>
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <form onSubmit={handleSubmit} style={{ display: "contents" }}>
              <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
                <Modal.Heading className="text-base font-semibold text-ink-1000">
                  {tProposals("create.title")}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-4 px-6 py-6">
                <p className="text-sm text-ink-500">
                  {tProposals("create.org_subtitle")}
                </p>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-ink-700">
                    {tProposals("create.formulation")}
                  </span>
                  <select
                    value={formulationId}
                    onChange={(e) => {
                      setFormulationId(e.target.value);
                      setVersionId("");
                    }}
                    className="w-full cursor-pointer rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                  >
                    <option value="">—</option>
                    {formulations.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.code ? `${f.code} · ${f.name}` : f.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-ink-700">
                    {tProposals("create.version")}
                  </span>
                  <select
                    value={versionId}
                    onChange={(e) => setVersionId(e.target.value)}
                    disabled={!formulationId || versions.length === 0}
                    className="w-full cursor-pointer rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:cursor-not-allowed disabled:bg-ink-100"
                  >
                    <option value="">—</option>
                    {versions.map((v) => (
                      <option key={v.id} value={v.id}>
                        v{v.version_number}
                        {v.label ? ` — ${v.label}` : ""}
                      </option>
                    ))}
                  </select>
                </label>

                <fieldset className="flex flex-col gap-1.5">
                  <legend className="text-xs font-medium text-ink-700">
                    {tProposals("create.template_type")}
                  </legend>
                  <div className="flex gap-2">
                    {PROPOSAL_TEMPLATE_TYPES.map((key) => (
                      <label
                        key={key}
                        className={`flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-inset transition-colors ${
                          template === key
                            ? "bg-orange-500 text-ink-0 ring-orange-500"
                            : "bg-ink-0 text-ink-700 ring-ink-200 hover:bg-ink-50"
                        }`}
                      >
                        <input
                          type="radio"
                          name="template_type"
                          value={key}
                          checked={template === key}
                          onChange={() => setTemplate(key)}
                          className="sr-only"
                        />
                        {tProposals(
                          `template_type.${key}` as "template_type.custom",
                        )}
                      </label>
                    ))}
                  </div>
                </fieldset>

                {/* Optional bundled specification sheet. Attaching a
                    sheet enables the kiosk's "Accept and sign both
                    documents" flow — the proposal and the spec move
                    through signatures together. Default "none" means
                    the proposal stands alone; scientists attach a
                    sheet later from the proposal detail page too. */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-ink-700">
                    {tProposals("create.specification_sheet")}
                  </span>
                  <select
                    value={specSheetId}
                    onChange={(e) => setSpecSheetId(e.target.value)}
                    className="w-full cursor-pointer rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                  >
                    <option value="">
                      {tProposals("create.specification_sheet_none")}
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
                </label>

                <CustomerPicker
                  orgId={orgId}
                  value={customer}
                  onChange={setCustomer}
                  onCreateNew={() => setCustomerCreating(true)}
                />

                <div className="grid grid-cols-3 gap-3">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-ink-700">
                      {tProposals("create.quantity")}
                    </span>
                    <input
                      type="number"
                      min={1}
                      value={quantity}
                      onChange={(e) => setQuantity(e.target.value)}
                      className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-ink-700">
                      {tProposals("create.unit_cost")}
                    </span>
                    <input
                      type="number"
                      step="0.0001"
                      value={unitCost}
                      onChange={(e) => setUnitCost(e.target.value)}
                      className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-ink-700">
                      {tProposals("create.margin_percent")}
                    </span>
                    <input
                      type="number"
                      step="0.1"
                      value={margin}
                      onChange={(e) => setMargin(e.target.value)}
                      className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                    />
                  </label>
                </div>

                <div
                  className={`rounded-xl px-3 py-2 text-sm font-medium ring-1 ring-inset ${
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

                {error ? (
                  <p
                    role="alert"
                    className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
                  >
                    {error}
                  </p>
                ) : null}
              </Modal.Body>
              <Modal.Footer className="flex items-center justify-end gap-3 border-t border-ink-200 px-6 py-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={close}
                  isDisabled={createMutation.isPending}
                  className="h-10 rounded-lg px-4 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                >
                  {tProposals("create.cancel")}
                </Button>
                <Button
                  type="submit"
                  isDisabled={createMutation.isPending}
                  className="h-10 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
                >
                  {tProposals("create.submit")}
                </Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      {/* Mount inside the outer Modal so the create-customer dialog
          stacks above the proposal dialog instead of dismissing it.
          On create we snap the new customer into the picker so the
          scientist doesn't have to re-find it. */}
      <CustomerFormModal
        orgId={orgId}
        mode="create"
        isOpen={customerCreating}
        onClose={() => setCustomerCreating(false)}
        initial={null}
        onCreated={(c) => setCustomer(c)}
      />
    </Modal>
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
