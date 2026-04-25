"use client";

import {
  ExternalLink,
  Plus,
  PoundSterling,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState, type FormEvent } from "react";

import { Button, Modal } from "@heroui/react";

import { Link, useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import {
  useFormulationVersions,
  type FormulationVersionDto,
  type ProjectType,
} from "@/services/formulations";
import {
  PROPOSAL_TEMPLATE_TYPES,
  fetchCostPreview,
  useCreateProposal,
  useDeleteProposal,
  useProposals,
  type ProposalDto,
  type ProposalStatus,
  type ProposalTemplateType,
} from "@/services/proposals";
import { type CustomerDto } from "@/services/customers";
import { CustomerPicker } from "@/components/customers/customer-picker";
import { CustomerFormModal } from "../../../customers/customers-list";


/**
 * Project-scoped proposals list. Each row links to the proposal's
 * detail page where the commercial offer HTML is embedded for
 * scientist + director review. "+ New proposal" opens a modal that
 * asks for margin %, auto-suggests a unit price from the raw material
 * cost roll-up, and wires the proposal to a picked version.
 */
export function ProposalsList({
  orgId,
  formulationId,
  projectType,
  canWrite,
}: {
  orgId: string;
  formulationId: string;
  projectType: ProjectType;
  canWrite: boolean;
}) {
  const tProposals = useTranslations("proposals");
  const tErrors = useTranslations("errors");

  const proposalsQuery = useProposals(orgId, formulationId);
  const versionsQuery = useFormulationVersions(orgId, formulationId);
  const deleteMutation = useDeleteProposal(orgId);

  const proposals = proposalsQuery.data ?? [];
  const versions: readonly FormulationVersionDto[] =
    versionsQuery.data ?? [];

  const [deleteError, setDeleteError] = useState<string | null>(null);

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
    <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 md:p-8">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-100 pb-4">
        <div className="flex flex-col">
          <h2 className="text-base font-semibold text-ink-1000">
            {tProposals("list.title")}
          </h2>
          <p className="mt-0.5 text-sm text-ink-500">
            {tProposals("list.subtitle")}
          </p>
        </div>
        {canWrite ? (
          <NewProposalButton
            orgId={orgId}
            formulationId={formulationId}
            versions={versions}
            projectType={projectType}
          />
        ) : null}
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
            <ProposalRow
              key={proposal.id}
              proposal={proposal}
              canDelete={canWrite}
              onDelete={handleDelete}
              deletePending={deleteMutation.isPending}
            />
          ))}
        </ul>
      )}
    </section>
  );
}


function ProposalRow({
  proposal,
  canDelete,
  onDelete,
  deletePending,
}: {
  proposal: ProposalDto;
  canDelete: boolean;
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
          {proposal.code} · {proposal.customer_company || proposal.customer_name || tProposals("list.no_customer")}
        </Link>
        <span className="text-xs text-ink-500">
          v{proposal.formulation_version_number}{" "}
          · {tProposals(`template_type.${proposal.template_type}` as "template_type.custom")}
          {total !== null
            ? ` · ${total} ${proposal.currency}`
            : ""}
          {proposal.specification_sheet_id
            ? ` · ${tProposals("list.bundled_spec")}`
            : ""}
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
        {canDelete ? (
          <button
            type="button"
            aria-label={tProposals("list.delete")}
            onClick={() => onDelete(proposal.id)}
            disabled={deletePending}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-500 transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        ) : null}
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


function NewProposalButton({
  orgId,
  formulationId,
  versions,
  projectType,
}: {
  orgId: string;
  formulationId: string;
  versions: readonly FormulationVersionDto[];
  projectType: ProjectType;
}) {
  const tProposals = useTranslations("proposals");
  const tErrors = useTranslations("errors");
  const router = useRouter();

  const [isOpen, setIsOpen] = useState(false);
  const [versionId, setVersionId] = useState<string>("");
  const [template, setTemplate] = useState<ProposalTemplateType>(
    projectType as ProposalTemplateType,
  );
  const [customer, setCustomer] = useState<CustomerDto | null>(null);
  const [customerCreating, setCustomerCreating] = useState(false);
  const [quantity, setQuantity] = useState<string>("1");
  // The pricing model the user wants: unit cost (what it costs us)
  // + target margin → the unit price the customer pays is the
  // derived product. No separate price input — avoids the earlier
  // confusion over "three numbers, which one wins".
  const [unitCost, setUnitCost] = useState<string>("");
  const [margin, setMargin] = useState<string>("30");
  const [error, setError] = useState<string | null>(null);

  const createMutation = useCreateProposal(orgId);

  // Derived unit price = cost ÷ (1 − margin/100). Gross-margin
  // semantics: a 30% margin on £5 cost produces £7.14 (30% of each
  // sale is profit). Markup-on-cost would give £6.50 for the same
  // inputs — we picked gross margin because that's how finance
  // reports the relationship. Edge cases return ``null`` so the UI
  // prompts "enter cost and margin" instead of showing a
  // misleading zero or Infinity.
  const derivedUnitPrice = (() => {
    const cost = Number.parseFloat(unitCost);
    const pct = Number.parseFloat(margin);
    if (!Number.isFinite(cost) || cost <= 0) return null;
    if (!Number.isFinite(pct) || pct < 0 || pct >= 100) return null;
    return cost / (1 - pct / 100);
  })();

  useEffect(() => {
    if (versions.length === 0) return;
    if (!versions.some((v) => v.id === versionId)) {
      setVersionId(versions[0]!.id);
    }
  }, [versions, versionId]);

  // Seed the unit cost from the raw-material roll-up the first time
  // the scientist picks a version. Never overwrites a value they
  // already typed — the suggestion is a starting point, not the
  // authoritative number.
  useEffect(() => {
    if (!versionId) return;
    let cancelled = false;
    (async () => {
      try {
        const preview = await fetchCostPreview(orgId, versionId);
        if (cancelled) return;
        setUnitCost((current) =>
          current === "" ? preview.material_cost_per_pack : current,
        );
      } catch {
        /* cost preview is best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, versionId]);

  const reset = () => {
    setCustomer(null);
    setQuantity("1");
    setUnitCost("");
    setMargin("30");
    setTemplate(projectType as ProposalTemplateType);
    setError(null);
  };

  const close = () => {
    setIsOpen(false);
    reset();
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
        // Customer is bound via FK — the backend seeds the proposal's
        // customer_* fields (name / email / company / addresses) from
        // the picked Customer record, so we don't forward them here.
        customer_id: customer?.id ?? null,
        customer_name: customer?.name ?? "",
        customer_email: customer?.email ?? "",
        customer_company: customer?.company ?? "",
        quantity: Math.max(1, Number.parseInt(quantity, 10) || 1),
        // Unit price is derived from cost + margin on the client so
        // the backend never has to figure out which of three fields
        // "wins". Send the derived number straight through.
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

  if (versions.length === 0) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-500 ring-1 ring-inset ring-ink-200"
        isDisabled
      >
        <Plus className="h-4 w-4" />
        {tProposals("create.trigger")}
      </Button>
    );
  }

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
                  {tProposals("create.subtitle")}
                </p>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-ink-700">
                    {tProposals("create.version")}
                  </span>
                  <select
                    value={versionId}
                    onChange={(e) => setVersionId(e.target.value)}
                    className="w-full cursor-pointer rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                  >
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
                        {tProposals(`template_type.${key}` as "template_type.custom")}
                      </label>
                    ))}
                  </div>
                </fieldset>

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
                      step={1}
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
                      placeholder="0.00"
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
                      placeholder="30"
                      className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                    />
                  </label>
                </div>

                {/* Derived unit price — read-only. "Cost × (1 +
                    margin/100)" is the quote the customer sees. */}
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
                  size="md"
                  className="h-10 rounded-lg px-4 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                  onClick={close}
                  isDisabled={createMutation.isPending}
                >
                  {tProposals("create.cancel")}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  className="h-10 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
                  isDisabled={createMutation.isPending}
                >
                  {tProposals("create.submit")}
                </Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      {/*
        Inline "create customer" escape hatch. Nested inside the
        proposal modal's Modal component so opening it here doesn't
        collapse the outer dialog — the HeroUI Modal stacks dialogs
        on top of each other instead of unmounting the parent.
      */}
      <CustomerFormModal
        orgId={orgId}
        mode="create"
        isOpen={customerCreating}
        initial={null}
        onClose={() => setCustomerCreating(false)}
        onCreated={(c) => {
          // Seed the picker with the freshly-created customer so the
          // scientist doesn't have to find them in the search list.
          setCustomer(c);
          setCustomerCreating(false);
        }}
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
