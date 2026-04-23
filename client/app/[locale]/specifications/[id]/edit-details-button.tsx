"use client";

import { Button, Modal } from "@heroui/react";
import { FileText } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState, type FormEvent } from "react";

import { useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import {
  useUpdateSpecification,
  type SpecificationSheetDto,
  type UpdateSpecificationRequestDto,
} from "@/services/specifications";


const INPUT_CLASS =
  "w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400";
const LABEL_CLASS = "text-xs font-medium text-ink-700";
const HINT_CLASS = "text-xs text-ink-500";


/**
 * Modal trigger that edits the free-text metadata rows on a spec
 * sheet — client info, shelf life, storage, food contact status,
 * unit quantity, weight uniformity, total-weight override, cover
 * notes. These map onto the same ``PATCH /specifications/<id>/``
 * endpoint the (now-slimmer) creation modal uses; the sheet renders
 * them on its customer-facing layout and PDF.
 */
export function EditDetailsButton({
  orgId,
  sheet,
}: {
  orgId: string;
  sheet: SpecificationSheetDto;
}) {
  const tSpecs = useTranslations("specifications");
  const tErrors = useTranslations("errors");
  const router = useRouter();

  const [isOpen, setIsOpen] = useState(false);
  const [form, setForm] = useState<UpdateSpecificationRequestDto>({});
  const [error, setError] = useState<string | null>(null);

  const mutation = useUpdateSpecification(orgId, sheet.id);

  // Hydrate the form from the latest server truth whenever the modal
  // opens. Using the modal-open flag (rather than mounting fresh) so
  // the inputs retain focus across re-renders the parent triggers.
  useEffect(() => {
    if (!isOpen) return;
    // ``total_weight_label`` and ``unit_quantity`` used to live on
    // this form but the builder is authoritative for both (computed
    // total weight + servings-per-pack). Editing them here only
    // created a way to drift from the snapshot, so we dropped them.
    // Existing stored values on old sheets stay in the DB untouched.
    setForm({
      code: sheet.code,
      client_name: sheet.client_name,
      client_email: sheet.client_email,
      client_company: sheet.client_company,
      cover_notes: sheet.cover_notes,
      margin_percent: sheet.margin_percent,
      final_price: sheet.final_price,
      food_contact_status: sheet.food_contact_status,
      shelf_life: sheet.shelf_life,
      storage_conditions: sheet.storage_conditions,
      weight_uniformity: sheet.weight_uniformity,
    });
    setError(null);
  }, [
    isOpen,
    sheet.code,
    sheet.client_name,
    sheet.client_email,
    sheet.client_company,
    sheet.cover_notes,
    sheet.margin_percent,
    sheet.final_price,
    sheet.food_contact_status,
    sheet.shelf_life,
    sheet.storage_conditions,
    sheet.weight_uniformity,
  ]);

  const set = <K extends keyof UpdateSpecificationRequestDto>(
    key: K,
    value: UpdateSpecificationRequestDto[K],
  ) => setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    try {
      await mutation.mutateAsync(form);
      setIsOpen(false);
      router.refresh();
    } catch (err) {
      setError(extractErrorMessage(err, tErrors));
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        if (!open) setError(null);
      }}
    >
      <Modal.Trigger>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-lg bg-ink-0 px-3 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
        >
          <span className="inline-flex items-center gap-1.5">
            <FileText className="h-4 w-4" />
            {tSpecs("detail.edit_details")}
          </span>
        </Button>
      </Modal.Trigger>
      <Modal.Backdrop>
        <Modal.Container size="lg">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <form onSubmit={handleSubmit} style={{ display: "contents" }}>
              <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
                <Modal.Heading className="text-base font-semibold text-ink-1000">
                  {tSpecs("edit_details.title")}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto px-6 py-6">
                <p className="text-sm text-ink-500">
                  {tSpecs("edit_details.subtitle")}
                </p>

                {/* Client context — identity the customer will see on
                    their copy of the sheet. The create modal uses the
                    address-book picker; here we surface the raw fields
                    so a scientist can override a single value (e.g. a
                    different contact for this specific sheet) without
                    mutating the address-book record. */}
                <fieldset className="grid grid-cols-1 gap-4 rounded-xl border border-ink-100 p-4 sm:grid-cols-2">
                  <legend className="px-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                    {tSpecs("edit_details.group.client")}
                  </legend>
                  <TextField
                    label={tSpecs("create.code")}
                    value={form.code ?? ""}
                    onChange={(v) => set("code", v)}
                    hint={tSpecs("edit_details.code_hint")}
                  />
                  <TextField
                    label={tSpecs("create.client_company")}
                    value={form.client_company ?? ""}
                    onChange={(v) => set("client_company", v)}
                    hint={tSpecs("edit_details.client_company_hint")}
                  />
                  <TextField
                    label={tSpecs("create.client_name")}
                    value={form.client_name ?? ""}
                    onChange={(v) => set("client_name", v)}
                    hint={tSpecs("edit_details.client_name_hint")}
                  />
                  <TextField
                    label={tSpecs("create.client_email")}
                    value={form.client_email ?? ""}
                    onChange={(v) => set("client_email", v)}
                    type="email"
                    hint={tSpecs("edit_details.client_email_hint")}
                  />
                </fieldset>

                {/* Commercial numbers the customer sees on the sheet.
                    Optional on a draft; required once the sheet is
                    ``sent`` to a client and a price has been agreed.
                    Scientists quote in the sheet's currency (stored
                    on the org, not per-sheet) so we show the bare
                    number without an attached symbol here. */}
                <fieldset className="grid grid-cols-1 gap-4 rounded-xl border border-ink-100 p-4 sm:grid-cols-2">
                  <legend className="px-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                    {tSpecs("edit_details.group.commercial")}
                  </legend>
                  <TextField
                    label={tSpecs("edit_details.margin_percent")}
                    value={
                      form.margin_percent === null ||
                      form.margin_percent === undefined
                        ? ""
                        : String(form.margin_percent)
                    }
                    onChange={(v) =>
                      set("margin_percent", v === "" ? null : v)
                    }
                    placeholder="30"
                    hint={tSpecs("edit_details.margin_percent_hint")}
                    inputMode="decimal"
                  />
                  <TextField
                    label={tSpecs("edit_details.final_price")}
                    value={
                      form.final_price === null ||
                      form.final_price === undefined
                        ? ""
                        : String(form.final_price)
                    }
                    onChange={(v) =>
                      set("final_price", v === "" ? null : v)
                    }
                    placeholder="0.00"
                    hint={tSpecs("edit_details.final_price_hint")}
                    inputMode="decimal"
                  />
                </fieldset>

                {/* Client-negotiated product properties — shelf life,
                    storage and food contact depend on the *quote*, not
                    the recipe, so they live on the spec (not the
                    formulation builder). Total weight + servings per
                    pack are authoritative in the builder and flow
                    through the snapshot; they're intentionally not
                    duplicated here anymore.

                    Weight uniformity stays because QC tolerance is
                    negotiated per-client — a supermarket brand may
                    demand ±5% where a boutique label accepts ±10%. */}
                <fieldset className="grid grid-cols-1 gap-4 rounded-xl border border-ink-100 p-4 sm:grid-cols-2">
                  <legend className="px-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                    {tSpecs("edit_details.group.product_spec")}
                  </legend>
                  <TextField
                    label={tSpecs("edit_details.shelf_life")}
                    value={form.shelf_life ?? ""}
                    onChange={(v) => set("shelf_life", v)}
                    placeholder="24 months"
                    hint={tSpecs("edit_details.shelf_life_hint")}
                  />
                  <TextField
                    label={tSpecs("edit_details.storage_conditions")}
                    value={form.storage_conditions ?? ""}
                    onChange={(v) => set("storage_conditions", v)}
                    placeholder="Store in a cool dry place"
                    hint={tSpecs("edit_details.storage_conditions_hint")}
                  />
                  <TextField
                    label={tSpecs("edit_details.food_contact_status")}
                    value={form.food_contact_status ?? ""}
                    onChange={(v) => set("food_contact_status", v)}
                    hint={tSpecs("edit_details.food_contact_status_hint")}
                  />
                  <TextField
                    label={tSpecs("edit_details.weight_uniformity")}
                    value={form.weight_uniformity ?? ""}
                    onChange={(v) => set("weight_uniformity", v)}
                    placeholder="10%"
                    hint={tSpecs("edit_details.weight_uniformity_hint")}
                  />
                </fieldset>

                {/* Long-form cover copy — kept separate from the
                    grid above so it can span full width without
                    stretching every text input. */}
                <label className="flex flex-col gap-1.5">
                  <span className={LABEL_CLASS}>
                    {tSpecs("create.cover_notes")}
                  </span>
                  <textarea
                    rows={3}
                    value={form.cover_notes ?? ""}
                    onChange={(e) => set("cover_notes", e.target.value)}
                    className={INPUT_CLASS}
                  />
                  <p className={HINT_CLASS}>
                    {tSpecs("edit_details.cover_notes_hint")}
                  </p>
                </label>

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
                  className="rounded-lg px-4 py-2 font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                  onClick={() => setIsOpen(false)}
                  isDisabled={mutation.isPending}
                >
                  {tSpecs("create.cancel")}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  className="rounded-lg bg-orange-500 px-4 py-2 font-medium text-ink-0 hover:bg-orange-600"
                  isDisabled={mutation.isPending}
                >
                  {tSpecs("edit_details.save")}
                </Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}


function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  hint,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  hint?: string;
  //: Forwarded to the underlying ``<input>``'s ``inputMode`` attr
  //: so numeric commercial fields (margin, price) pop a decimal
  //: keyboard on mobile without breaking the free-text semantics
  //: (we still accept empty strings and trailing decimals during
  //: typing, so ``type="number"`` isn't the right tool here).
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className={LABEL_CLASS}>{label}</span>
      <input
        type={type}
        inputMode={inputMode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={INPUT_CLASS}
      />
      {hint ? <p className={HINT_CLASS}>{hint}</p> : null}
    </label>
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
