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
import { CheckCircle2, Upload } from "lucide-react";

import { apiClient, normalizeApiError } from "@/lib/api";
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
  const [published, setPublished] = useState(formulation.is_rtg_published);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const submit = useCallback(
    async (nextPublished: boolean) => {
      setBanner(null);
      setFieldErrors({});
      setSaving(true);
      try {
        const form = new FormData();
        form.append("is_rtg_published", nextPublished ? "true" : "false");
        form.append("rtg_display_name", displayName);
        form.append("rtg_short_description", description);
        form.append("rtg_base_price", basePrice);
        form.append("rtg_moq", moq);
        form.append("rtg_currency_code", currency);
        if (heroFile) {
          form.append("rtg_hero_image", heroFile);
        }
        // Do NOT hand-set ``Content-Type: multipart/form-data`` —
        // axios will populate it including the ``boundary=…`` token
        // when it sees a ``FormData`` body. Setting the header
        // manually strips the boundary and DRF's multipart parser
        // can't split the parts, which surfaces as a bewildering
        // ``415 unsupported_media_type``. Trust the runtime.
        await apiClient.patch(
          `/api/organizations/${orgId}/formulations/${formulation.id}/rtg-publish/`,
          form,
        );
        setPublished(nextPublished);
        setBanner(
          nextPublished
            ? "Published to the customer catalog."
            : "Unpublished — the SKU is no longer visible in the customer catalog.",
        );
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
    },
    [
      basePrice,
      currency,
      description,
      displayName,
      formulation.id,
      heroFile,
      moq,
      orgId,
    ],
  );

  const disabled = !canEdit || saving;

  return (
    <section className="rounded-2xl border border-ink-200 bg-ink-0 p-6 shadow-sm">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            Ready-to-Go catalog
          </p>
          <h2 className="text-lg font-semibold text-ink-1000">
            Publish this recipe to the customer catalog
          </h2>
        </div>
        {published ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Live in catalog
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-ink-100 px-3 py-1 text-xs font-semibold text-ink-700">
            Draft
          </span>
        )}
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
        {published ? (
          <button
            type="button"
            onClick={() => submit(false)}
            disabled={disabled}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-300 px-3 py-2 text-sm font-semibold text-ink-800 hover:bg-ink-50 disabled:opacity-40"
          >
            Take offline
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => submit(true)}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 rounded-lg bg-ink-1000 px-4 py-2 text-sm font-semibold text-ink-0 hover:bg-ink-900 disabled:opacity-40"
        >
          <Upload className="h-4 w-4" />
          {published ? "Save changes" : "Publish to catalog"}
        </button>
      </div>
    </section>
  );
}
