"use client";

/**
 * Staff RTG catalog panel.
 *
 * Mounted at the top of the project overview page when
 * ``formulation.project_type === 'ready_to_go'``. Everything below
 * gates through :func:`publishToRTGCatalog` / :func:`unpublishFromRTGCatalog`
 * (backed by ``PATCH /api/organizations/<org>/formulations/<id>/rtg-publish/``),
 * so the marketing block is only writable through the single
 * dedicated endpoint — never through the main formulation PATCH.
 *
 * The panel is deliberately isolated from ``formulation-builder.tsx``
 * (which is already ~5.6k lines) so builder churn doesn't touch this
 * publishing surface, and vice versa.
 */

import { useCallback, useState } from "react";
import { CheckCircle2, Save } from "lucide-react";

import { apiClient, normalizeApiError } from "@/lib/api";
import { RichTextEditor } from "@/components/forms/rich-text-editor";
import type { FormulationDto } from "@/services/formulations/types";


// Curated shortlist covering the currencies the RTG catalog is
// expected to price in. The wider CurrencyPicker lives inside the
// staff proposal builder; a lean shortlist here keeps the panel
// self-contained without dragging that dependency in.
const CURRENCY_OPTIONS = ["GBP", "EUR", "USD"] as const;


interface Props {
  readonly orgId: string;
  readonly formulation: FormulationDto;
  readonly canEdit: boolean;
}


export function RTGCatalogPanel({ orgId, formulation, canEdit }: Props) {
  // Only meaningful on Ready-to-Go rows. The parent already gates
  // on ``project_type`` but we belt-and-brace so a stray render on
  // a Custom project can't accidentally publish anything.
  if (formulation.project_type !== "ready_to_go") return null;

  return (
    <RTGCatalogPanelInner
      orgId={orgId}
      formulation={formulation}
      canEdit={canEdit}
    />
  );
}


function RTGCatalogPanelInner({
  orgId,
  formulation,
  canEdit,
}: Props) {
  const [displayName, setDisplayName] = useState(
    formulation.rtg_display_name || "",
  );
  const [description, setDescription] = useState(
    formulation.rtg_short_description || "",
  );
  const [longDescription, setLongDescription] = useState(
    formulation.rtg_long_description || "",
  );
  const [basePrice, setBasePrice] = useState(
    formulation.rtg_base_price || "",
  );
  const [currency, setCurrency] = useState(
    formulation.rtg_currency_code || "GBP",
  );
  const [moq, setMoq] = useState(
    formulation.rtg_moq !== null && formulation.rtg_moq !== undefined
      ? String(formulation.rtg_moq)
      : "",
  );
  const [heroFile, setHeroFile] = useState<File | null>(null);
  const [heroPreview] = useState<string | null>(
    formulation.rtg_hero_image ?? null,
  );
  // Read-only reflection of the current publish state. The toggle
  // lives on the project header now — this pill is purely
  // informational, so we don't need a local setter.
  const published = formulation.is_rtg_published;
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const submit = useCallback(async () => {
    setBanner(null);
    setFieldErrors({});
    setSaving(true);
    try {
      const form = new FormData();
      // Note: we deliberately do NOT send ``is_rtg_published`` here.
      // Omitting the key tells the server to save the marketing
      // block as a draft — no publish flip, no FINAL-spec gate.
      // The Publish / Take offline toggle lives on the project
      // header actions and hits the same endpoint with the flag.
      form.append("rtg_display_name", displayName);
      form.append("rtg_short_description", description);
      form.append("rtg_long_description", longDescription);
      form.append("rtg_base_price", basePrice);
      form.append("rtg_moq", moq);
      form.append("rtg_currency_code", currency);
      if (heroFile) {
        form.append("rtg_hero_image", heroFile);
      }
      // Do NOT hand-set ``Content-Type: multipart/form-data`` —
      // axios will populate it including the ``boundary=…`` token
      // when it sees a ``FormData`` body.
      await apiClient.patch(
        `/api/organizations/${orgId}/formulations/${formulation.id}/rtg-publish/`,
        form,
      );
      setBanner("Saved. Catalog listing updated with your latest copy.");
    } catch (error) {
      const api = normalizeApiError(error);
      const fields = (api.payload?.fields ?? null) as
        | Record<string, string>
        | null;
      if (fields && typeof fields === "object") {
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(fields)) {
          if (typeof v === "string") next[k] = v;
        }
        setFieldErrors(next);
      }
      setBanner(
        (api.payload?.detail as string | undefined) ||
          api.message ||
          "Failed to save the RTG marketing block.",
      );
    } finally {
      setSaving(false);
    }
  }, [
    basePrice,
    currency,
    description,
    displayName,
    formulation.id,
    heroFile,
    longDescription,
    moq,
    orgId,
  ]);

  const disabled = !canEdit || saving;

  return (
    <section className="rounded-2xl border border-ink-200 bg-ink-0 p-6 shadow-sm">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            Ready-to-Go catalog
          </p>
          <h2 className="text-lg font-semibold text-ink-1000">
            Customer-facing listing
          </h2>
          <p className="mt-1 text-xs text-ink-500">
            Fill in what customers see on the catalog. Saves as a
            draft anytime — Publish lives up in the project header
            and unlocks once the FINAL spec is approved.
          </p>
        </div>
        {published ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Live in catalog
          </span>
        ) : null}
      </header>

      {banner ? (
        <div className="mb-4 rounded-lg border border-ink-300 bg-ink-50 px-3 py-2 text-sm text-ink-800">
          {banner}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-700">
            Display name
          </label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.currentTarget.value)}
            disabled={disabled}
            maxLength={200}
            placeholder={formulation.name}
            className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-ink-500">
            Customer-facing name shown on the catalog. Leave blank to
            fall back to the internal name{" "}
            <span className="font-mono">{formulation.name}</span>.
          </p>
          {fieldErrors.rtg_display_name ? (
            <p className="mt-1 text-xs text-rose-700">
              {fieldErrors.rtg_display_name}
            </p>
          ) : null}
        </div>

        <div className="md:col-span-2">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-700">
            Short description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            rows={3}
            disabled={disabled}
            className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
          />
          {fieldErrors.rtg_short_description ? (
            <p className="mt-1 text-xs text-rose-700">
              {fieldErrors.rtg_short_description}
            </p>
          ) : null}
        </div>

        <div className="md:col-span-2">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-700">
            Full description
          </label>
          <p className="mb-2 text-xs text-ink-500">
            The customer-facing product page body. Rich formatting is
            preserved end-to-end — what you see here is what shoppers
            see on the catalog.
          </p>
          <RichTextEditor
            value={longDescription}
            onChange={setLongDescription}
            disabled={disabled}
            placeholder="Describe the product in detail — ingredients story, benefits, usage tips, FAQs…"
            minHeight="18rem"
          />
          {fieldErrors.rtg_long_description ? (
            <p className="mt-1 text-xs text-rose-700">
              {fieldErrors.rtg_long_description}
            </p>
          ) : null}
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-700">
            Base price (per unit)
          </label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={basePrice}
            onChange={(e) => setBasePrice(e.currentTarget.value)}
            disabled={disabled}
            className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
          />
          {fieldErrors.rtg_base_price ? (
            <p className="mt-1 text-xs text-rose-700">
              {fieldErrors.rtg_base_price}
            </p>
          ) : null}
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-700">
            Currency
          </label>
          <select
            value={currency}
            onChange={(e) => setCurrency(e.currentTarget.value)}
            disabled={disabled}
            className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
          >
            {CURRENCY_OPTIONS.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-700">
            Minimum order quantity
          </label>
          <input
            type="number"
            step="1"
            min="1"
            value={moq}
            onChange={(e) => setMoq(e.currentTarget.value)}
            disabled={disabled}
            className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
          />
          {fieldErrors.rtg_moq ? (
            <p className="mt-1 text-xs text-rose-700">{fieldErrors.rtg_moq}</p>
          ) : null}
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-700">
            Hero image
          </label>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => setHeroFile(e.currentTarget.files?.[0] ?? null)}
            disabled={disabled}
            className="w-full rounded-lg border border-dashed border-ink-300 bg-white px-3 py-2 text-sm"
          />
          {heroPreview ? (
            <p className="mt-1 text-xs text-ink-500">
              Existing image kept unless a new file is picked.
            </p>
          ) : null}
        </div>

      </div>

      <p className="mt-4 rounded-lg border border-dashed border-ink-300 bg-ink-50 px-3 py-2 text-xs text-ink-700">
        Packaging is now defined per-SKU in the <strong>Packaging
        combos</strong> card above (bottle + lid + label bundles the
        customer picks between at checkout). The old free-text
        packaging options field has been retired.
      </p>

      <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 rounded-lg bg-ink-1000 px-4 py-2 text-sm font-semibold text-ink-0 hover:bg-ink-900 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Save className="h-4 w-4" />
          Save changes
        </button>
      </div>
    </section>
  );
}
