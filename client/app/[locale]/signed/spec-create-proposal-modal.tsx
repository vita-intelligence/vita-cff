"use client";

import { useEffect, useState, type FormEvent } from "react";

import { Button, Modal } from "@heroui/react";
import { Paperclip } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { CustomerFormModal } from "../customers/customers-list";
import { CustomerPicker } from "@/components/customers/customer-picker";
import { useRouter } from "@/i18n/navigation";
import { extractApiErrorMessage } from "@/lib/errors/translate";
import { type CustomerDto } from "@/services/customers";
import {
  PROPOSAL_TEMPLATE_TYPES,
  fetchCostPreview,
  proposalsQueryKeys,
  useCreateProposal,
  type ProposalTemplateType,
} from "@/services/proposals";
import { specificationsQueryKeys } from "@/services/specifications";
import { type SpecificationSheetDto } from "@/services/specifications";


/**
 * Modal that creates a proposal pre-seeded against a specific spec
 * sheet — opened from the "Create proposal" CTA on the
 * "Approved — ready to send" cards on the /signed page.
 *
 * Distinct from the org-wide modal in two important ways:
 *
 *   1. The formulation + version + specification_sheet fields are
 *      locked to the spec the user clicked. No pickers — they read
 *      the spec's own metadata and feed it straight through to the
 *      create call. The user only fills in the commercial bits
 *      (customer, quantity, cost, margin).
 *   2. On success it refreshes the spec-list query in addition to
 *      the proposal queries so the "linked proposal" chip on the
 *      /signed page flips from "No proposal yet" → "Proposal
 *      <code>" without a manual refresh.
 *
 * After creation the page navigates to ``/proposals/<id>`` — same
 * post-create flow as the org-wide modal so the user lands on the
 * commercial document straight away.
 */
export function SpecCreateProposalModal({
  orgId,
  sheet,
  isOpen,
  onClose,
}: {
  orgId: string;
  sheet: SpecificationSheetDto;
  isOpen: boolean;
  onClose: () => void;
}) {
  const tProposals = useTranslations("proposals");
  const tErrors = useTranslations("errors");
  const tSigned = useTranslations("signed");
  const router = useRouter();
  const queryClient = useQueryClient();

  const [template, setTemplate] = useState<ProposalTemplateType>("custom");
  const [customer, setCustomer] = useState<CustomerDto | null>(null);
  const [customerCreating, setCustomerCreating] = useState(false);
  const [quantity, setQuantity] = useState<string>("1");
  const [unitCost, setUnitCost] = useState<string>("");
  const [margin, setMargin] = useState<string>("30");
  const [error, setError] = useState<string | null>(null);

  const createMutation = useCreateProposal(orgId);

  // Match the org-modal pricing model: cost ÷ (1 − margin/100) gives
  // the unit price the customer pays. Edge cases return ``null`` so
  // the UI shows "enter cost and margin" rather than a broken number.
  const derivedUnitPrice = (() => {
    const cost = Number.parseFloat(unitCost);
    const pct = Number.parseFloat(margin);
    if (!Number.isFinite(cost) || cost <= 0) return null;
    if (!Number.isFinite(pct) || pct < 0 || pct >= 100) return null;
    return cost / (1 - pct / 100);
  })();

  // Seed the unit cost once on open from the formulation version's
  // material-cost roll-up. Never overwrites a typed value — the
  // suggestion is a starting point, not the authoritative number.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const preview = await fetchCostPreview(
          orgId,
          sheet.formulation_version,
        );
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
  }, [isOpen, orgId, sheet.formulation_version]);

  const reset = () => {
    setTemplate("custom");
    setCustomer(null);
    setQuantity("1");
    setUnitCost("");
    setMargin("30");
    setError(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    try {
      const created = await createMutation.mutateAsync({
        formulation_version_id: sheet.formulation_version,
        specification_sheet_id: sheet.id,
        template_type: template,
        customer_id: customer?.id ?? null,
        customer_name: customer?.name ?? "",
        customer_email: customer?.email ?? "",
        customer_company: customer?.company ?? "",
        quantity: Math.max(1, Number.parseInt(quantity, 10) || 1),
        unit_price:
          derivedUnitPrice !== null ? derivedUnitPrice.toFixed(4) : null,
        material_cost_per_pack: unitCost ? unitCost : null,
        margin_percent: margin ? margin : null,
      });
      // ``useCreateProposal`` already refreshes the proposal trees;
      // we also nuke the spec caches so the "linked proposal" chip
      // on this page flips from missing to linked on the next paint.
      queryClient.invalidateQueries({
        queryKey: specificationsQueryKeys.all,
      });
      queryClient.invalidateQueries({
        queryKey: proposalsQueryKeys.all,
      });
      close();
      router.push(`/proposals/${created.id}`);
    } catch (err) {
      setError(extractApiErrorMessage(err, tErrors));
    }
  };

  // Compact label that surfaces the locked context — formulation
  // name + version + spec code — so the user can confirm at a glance
  // which spec they're quoting against without having to navigate
  // away. Falls back gracefully if any of the fields are blank.
  const lockedSummary = [
    sheet.code || sheet.formulation_name,
    tSigned("card.version", {
      version: sheet.formulation_version_number,
    }),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => (!open ? close() : undefined)}
    >
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
                  {tSigned("create_proposal.subtitle")}
                </p>

                <div className="flex items-start gap-2 rounded-xl bg-ink-50 px-3 py-2 text-xs text-ink-700 ring-1 ring-inset ring-ink-200">
                  <Paperclip className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-500" />
                  <div className="flex min-w-0 flex-col">
                    <span className="font-semibold tracking-tight">
                      {sheet.formulation_name}
                    </span>
                    <span className="text-ink-500">{lockedSummary}</span>
                  </div>
                </div>

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

      <CustomerFormModal
        orgId={orgId}
        mode="create"
        isOpen={customerCreating}
        initial={null}
        onClose={() => setCustomerCreating(false)}
        onCreated={(c) => {
          setCustomer(c);
          setCustomerCreating(false);
        }}
      />
    </Modal>
  );
}
