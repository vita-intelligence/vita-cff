"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Button, Modal } from "@heroui/react";
import { Paperclip } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { CustomerFormModal } from "../customers/customers-list";
import { CustomerPicker } from "@/components/customers/customer-picker";
import { useOrganization } from "@/services/organizations";
import { useRouter } from "@/i18n/navigation";
import { extractApiErrorMessage } from "@/lib/errors/translate";
import { type CustomerDto } from "@/services/customers";
import {
  PROPOSAL_TEMPLATE_TYPES,
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
 * Same pricing UX as the org-wide new-proposal modal:
 *
 *   1. Quantity is the only field the operator types by default.
 *   2. Cost / margin / customer-pays come straight from the spec
 *      (the director already signed off on those numbers during
 *      approval) and render read-only inside an amber summary card.
 *   3. An "Adjust pricing" toggle exposes cost + margin inputs for
 *      the rare deal that needs a custom rate. Clicking "Use spec
 *      pricing" reverts to the spec's signed values.
 *
 * The formulation + version + specification_sheet are locked to
 * the sheet the user clicked — no pickers. On success the spec
 * caches invalidate so the "linked proposal" chip flips
 * immediately on the /signed page.
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
  // Dynamics-managed orgs hide the inline "Create new customer"
  // affordance; reads from the cached org list, no extra fetch.
  const organization = useOrganization(orgId);
  const dynamicsManaged = Boolean(
    organization?.dynamics_customers_managed,
  );

  const [template, setTemplate] = useState<ProposalTemplateType>("custom");
  const [customer, setCustomer] = useState<CustomerDto | null>(null);
  const [customerCreating, setCustomerCreating] = useState(false);
  const [quantity, setQuantity] = useState<string>("1");
  const [unitCost, setUnitCost] = useState<string>("");
  const [margin, setMargin] = useState<string>("30");
  // ``pricingOverride`` mirrors the org-wide new-proposal modal:
  // hidden by default, exposed via the "Adjust pricing" link.
  // When false, cost/margin/price are NOT sent — the backend
  // pulls them from the attached spec instead.
  const [pricingOverride, setPricingOverride] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createMutation = useCreateProposal(orgId);

  // Pre-seed the override inputs from the spec's signed pricing
  // when the modal opens, so the override panel (when revealed)
  // starts from the spec's values instead of an empty form.
  // Quantity intentionally stays at "1" — order size is a per-
  // proposal decision, not a spec-level constant.
  useEffect(() => {
    if (!isOpen) return;
    setUnitCost(sheet.unit_cost ? String(sheet.unit_cost) : "");
    // Margin autopopulate: prefer the explicit ``margin_percent``
    // the scientist typed; fall back to deriving it from
    // cost + final price when the spec was priced via
    // ``final_price`` directly (a common path — sales sometimes
    // skips the margin field and types the customer price). Without
    // the fallback the form silently stays at its hardcoded "30"
    // default on those specs, which reads to the operator as
    // "autopopulate is broken".
    if (sheet.margin_percent) {
      setMargin(String(sheet.margin_percent));
    } else if (sheet.unit_cost && sheet.final_price) {
      const cost = Number(sheet.unit_cost);
      const price = Number(sheet.final_price);
      if (
        Number.isFinite(cost) &&
        Number.isFinite(price) &&
        price > 0 &&
        cost > 0 &&
        cost < price
      ) {
        setMargin(((1 - cost / price) * 100).toFixed(2));
      }
    }
    setPricingOverride(false);
  }, [
    isOpen,
    sheet.unit_cost,
    sheet.margin_percent,
    sheet.final_price,
  ]);

  // Live derivation matches the spec approval modal's math:
  // ``cost / (1 − margin/100)``. Used inside the override panel
  // to show what the customer will be charged in real time.
  const derivedUnitPrice = useMemo(() => {
    const cost = Number.parseFloat(unitCost);
    const pct = Number.parseFloat(margin);
    if (!Number.isFinite(cost) || cost <= 0) return null;
    if (!Number.isFinite(pct) || pct < 0 || pct >= 100) return null;
    return cost / (1 - pct / 100);
  }, [unitCost, margin]);

  // What the read-only summary shows when override is off — prefer
  // the spec's stored ``final_price`` (the value the director
  // signed), fall back to deriving from cost+margin for legacy
  // specs that only have those two columns populated.
  const specHasPricing = Boolean(sheet.unit_cost || sheet.final_price);
  const specPrice = sheet.final_price
    ? Number(sheet.final_price).toFixed(2)
    : sheet.unit_cost && sheet.margin_percent
      ? (
          Number(sheet.unit_cost) /
          (1 - Number(sheet.margin_percent) / 100)
        ).toFixed(2)
      : null;
  const specCurrency = (sheet.currency || "GBP").toUpperCase();

  const reset = () => {
    setTemplate("custom");
    setCustomer(null);
    setQuantity("1");
    setUnitCost("");
    setMargin("30");
    setPricingOverride(false);
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
      // When the override panel isn't open we forward NO pricing
      // fields — the backend's create_proposal pulls cost / margin
      // / price / currency from the attached spec via the
      // spec-autofill path. Override flips to the typed values.
      const basePayload = {
        formulation_version_id: sheet.formulation_version,
        specification_sheet_id: sheet.id,
        template_type: template,
        customer_id: customer?.id ?? null,
        customer_name: customer?.name ?? "",
        customer_email: customer?.email ?? "",
        customer_company: customer?.company ?? "",
        quantity: Math.max(1, Number.parseInt(quantity, 10) || 1),
      };
      const created = await createMutation.mutateAsync(
        pricingOverride
          ? {
              ...basePayload,
              unit_price:
                derivedUnitPrice !== null
                  ? derivedUnitPrice.toFixed(4)
                  : null,
              material_cost_per_pack: unitCost ? unitCost : null,
              margin_percent: margin ? margin : null,
            }
          : basePayload,
      );
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
                  dynamicsManaged={dynamicsManaged}
                />

                {/* Quantity is the only typed input by default; cost /
                 *  margin sit behind an Adjust pricing toggle. Same
                 *  shape as the org-wide new-proposal modal so the
                 *  two surfaces feel identical. */}
                <label className="flex w-32 flex-col gap-1.5">
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

                {specHasPricing && !pricingOverride ? (
                  <div className="flex flex-col gap-2 rounded-xl bg-amber-50 px-3 py-3 ring-1 ring-inset ring-amber-200">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-900">
                        {tProposals("create.spec_pricing_label")}
                      </span>
                      <button
                        type="button"
                        onClick={() => setPricingOverride(true)}
                        className="text-[11px] font-medium text-amber-900 underline-offset-2 hover:underline"
                      >
                        {tProposals("create.adjust_pricing")}
                      </button>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-xs text-amber-900">
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[10px] uppercase tracking-wide text-amber-800">
                          {tProposals("create.unit_cost")}
                        </span>
                        <span className="font-semibold text-amber-950">
                          {sheet.unit_cost
                            ? `${specCurrency} ${Number(sheet.unit_cost).toFixed(2)}`
                            : "—"}
                        </span>
                      </div>
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[10px] uppercase tracking-wide text-amber-800">
                          {tProposals("create.margin_percent")}
                        </span>
                        <span className="font-semibold text-amber-950">
                          {sheet.margin_percent
                            ? `${Number(sheet.margin_percent).toFixed(1)} %`
                            : "—"}
                        </span>
                      </div>
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[10px] uppercase tracking-wide text-amber-800">
                          {tProposals("create.customer_pays")}
                        </span>
                        <span className="font-semibold text-amber-950">
                          {specPrice ? `${specCurrency} ${specPrice}` : "—"}
                        </span>
                      </div>
                    </div>
                  </div>
                ) : null}

                {pricingOverride || !specHasPricing ? (
                  <div className="flex flex-col gap-2 rounded-xl bg-ink-50 px-3 py-3 ring-1 ring-inset ring-ink-200">
                    {specHasPricing ? (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-700">
                          {tProposals("create.custom_pricing_label")}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            // Re-seed from spec and collapse back.
                            setUnitCost(
                              sheet.unit_cost ? String(sheet.unit_cost) : "",
                            );
                            setMargin(
                              sheet.margin_percent
                                ? String(sheet.margin_percent)
                                : "30",
                            );
                            setPricingOverride(false);
                          }}
                          className="text-[11px] font-medium text-ink-700 underline-offset-2 hover:underline"
                        >
                          {tProposals("create.use_spec_pricing")}
                        </button>
                      </div>
                    ) : null}
                    <div className="grid grid-cols-2 gap-3">
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
                      className={`rounded-lg px-3 py-2 text-sm font-medium ring-1 ring-inset ${
                        derivedUnitPrice === null
                          ? "bg-ink-0 text-ink-500 ring-ink-200"
                          : "bg-success/10 text-success ring-success/30"
                      }`}
                    >
                      {derivedUnitPrice === null
                        ? tProposals("create.price_placeholder")
                        : tProposals("create.price_derived", {
                            price: derivedUnitPrice.toFixed(2),
                          })}
                    </div>
                  </div>
                ) : null}

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
