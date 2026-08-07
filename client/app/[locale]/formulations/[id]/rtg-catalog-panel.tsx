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

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, LayoutTemplate, Save } from "lucide-react";
import { Link, useRouter } from "@/i18n/navigation";

import { apiClient, normalizeApiError } from "@/lib/api";
import { formulationsQueryKeys } from "@/services/formulations";
import type { FormulationDto } from "@/services/formulations/types";
import { CatalogPhotoGallery } from "./catalog-photo-gallery";


// Base-price + currency used to be picked from a shortlist here.
// Both are now derived from the associated spec sheet's approval
// (see backend ``transition_sheet_status``), so the panel no longer
// hosts the picker or the input.


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
  const queryClient = useQueryClient();
  const router = useRouter();
  const [displayName, setDisplayName] = useState(
    formulation.rtg_display_name || "",
  );
  const [description, setDescription] = useState(
    formulation.rtg_short_description || "",
  );
  // Base price + currency are derived from the latest approved spec
  // sheet's ``final_price`` + ``currency`` — the panel reads them
  // straight off the formulation and no longer offers an editable
  // input. The BE endpoint drops any incoming write on these fields
  // too, so a rogue payload can't drift the signed value.
  const basePrice = formulation.rtg_base_price || "";
  const currency = formulation.rtg_currency_code || "GBP";
  const [moq, setMoq] = useState(
    formulation.rtg_moq !== null && formulation.rtg_moq !== undefined
      ? String(formulation.rtg_moq)
      : "",
  );
  // Paid-sample pair — both nullable/empty means the SKU doesn't
  // offer samples and the storefront shows "Sample not available".
  // We keep the price as a string in local state so an author can
  // clear it back to "" and hit save to retract the offer without a
  // separate toggle.
  const [samplePrice, setSamplePrice] = useState(
    formulation.rtg_sample_price !== null &&
      formulation.rtg_sample_price !== undefined
      ? String(formulation.rtg_sample_price)
      : "",
  );
  const [sampleDescription, setSampleDescription] = useState(
    formulation.rtg_sample_description || "",
  );
  // Legacy single-hero uploader has been replaced by the full
  // ``CatalogPhotoGallery`` (see below). We keep the underlying
  // ``rtg_hero_image`` value around only for backwards-compat display
  // on rows that pre-date the gallery — new uploads no longer touch
  // this field.
  // Read-only reflection of the current publish state. The toggle
  // lives on the project header now — this pill is purely
  // informational, so we don't need a local setter.
  const published = formulation.is_rtg_published;
  const [saving, setSaving] = useState(false);
  // Split saved-vs-error banners so the ephemeral success confirmation
  // can auto-dismiss without wiping a genuine error the author still
  // needs to read.
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Snapshot of the last-persisted values so we can compute a dirty
  // flag. Comparing against ``formulation`` directly doesn't work —
  // the parent re-renders with a fresh formulation prop after our
  // save, which would flag every input as "clean" the moment they
  // typed. We snapshot on mount + after each successful save, so
  // dirty === "current text differs from what the server has".
  const [snapshot, setSnapshot] = useState({
    displayName: formulation.rtg_display_name || "",
    description: formulation.rtg_short_description || "",
    moq:
      formulation.rtg_moq !== null && formulation.rtg_moq !== undefined
        ? String(formulation.rtg_moq)
        : "",
    samplePrice:
      formulation.rtg_sample_price !== null &&
      formulation.rtg_sample_price !== undefined
        ? String(formulation.rtg_sample_price)
        : "",
    sampleDescription: formulation.rtg_sample_description || "",
  });
  const isDirty = useMemo(
    () =>
      displayName !== snapshot.displayName ||
      description !== snapshot.description ||
      moq !== snapshot.moq ||
      samplePrice !== snapshot.samplePrice ||
      sampleDescription !== snapshot.sampleDescription,
    [
      displayName,
      description,
      moq,
      samplePrice,
      sampleDescription,
      snapshot,
    ],
  );

  // Auto-dismiss the "Saved" confirmation after a short beat so the
  // panel doesn't grow a stale green chip that lingers forever. Errors
  // stay until the user hits save again.
  useEffect(() => {
    if (savedAt === null) return;
    const id = window.setTimeout(() => setSavedAt(null), 3000);
    return () => window.clearTimeout(id);
  }, [savedAt]);

  const submit = useCallback(async () => {
    setSaveError(null);
    setSavedAt(null);
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
      // ``rtg_base_price`` + ``rtg_currency_code`` are locked in
      // through spec-sheet approval — the server drops them from
      // this endpoint's payload, so we don't send them at all.
      form.append("rtg_moq", moq);
      // Sample pair: send even when empty so the server can clear
      // them (setting ``rtg_sample_price`` to blank retracts the
      // offer). The server ``save_rtg_marketing`` service accepts a
      // blank / null price as "no sample" and blanks the description
      // in lockstep.
      form.append("rtg_sample_price", samplePrice);
      form.append("rtg_sample_description", sampleDescription);
      // Do NOT hand-set ``Content-Type: multipart/form-data`` —
      // axios will populate it including the ``boundary=…`` token
      // when it sees a ``FormData`` body.
      await apiClient.patch(
        `/api/organizations/${orgId}/formulations/${formulation.id}/rtg-publish/`,
        form,
      );
      // Kick the query cache so the project header title + the /rtg-
      // catalog card pick up the new display name / description /
      // price without a page refresh. ``detail`` powers the header
      // + this panel's own inputs; ``overview`` powers the sales /
      // scientist meta and the catalog card. RTG catalog list rows
      // hang off ``list`` so we invalidate that too.
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.detail(orgId, formulation.id),
      });
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.overview(orgId, formulation.id),
      });
      queryClient.invalidateQueries({
        queryKey: [...formulationsQueryKeys.all, orgId, "list"],
      });
      // The project shell + overview cards are server-rendered from
      // ``loadProjectForTab`` — React Query invalidation alone won't
      // touch their props. ``router.refresh()`` re-runs the server
      // component, so the header title / page heading pick up the
      // new ``rtg_display_name`` without a hard reload.
      router.refresh();
      // Rebase the dirty-tracking snapshot so the fields the author
      // just saved read as "clean" until they touch them again.
      setSnapshot({
        displayName,
        description,
        moq,
        samplePrice,
        sampleDescription,
      });
      setSavedAt(Date.now());
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
      setSaveError(
        (api.payload?.detail as string | undefined) ||
          api.message ||
          "Failed to save the RTG marketing block.",
      );
    } finally {
      setSaving(false);
    }
  }, [
    description,
    displayName,
    formulation.id,
    moq,
    orgId,
    queryClient,
    router,
    samplePrice,
    sampleDescription,
  ]);

  const disabled = !canEdit || saving;
  // Save button is inert when nothing has changed — clicking a "Save"
  // that would no-op was the "save button acts weirdly" complaint.
  const canSave = !disabled && isDirty;

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

      {saveError ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{saveError}</span>
        </div>
      ) : null}
      {savedAt !== null ? (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>Saved. Catalog listing updated.</span>
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

        {/* Store-page authoring lives on the dedicated page builder
            route. Rich text formatting (bold / headings / lists /
            tables / colors) happens inside each Rich text block in
            the builder — no separate rich-text field needed here. */}
        <div className="md:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border-2 border-dashed border-ink-300 bg-ink-50 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-ink-1000">
                Store page content
              </p>
              <p className="mt-0.5 text-xs text-ink-500">
                Design the customer-facing product page — sections,
                columns, rich text, images, video, tables.
              </p>
            </div>
            <Link
              href={`/formulations/${formulation.id}/rtg-page`}
              className="inline-flex items-center gap-1.5 rounded-lg border-2 border-ink-1000 bg-ink-1000 px-3 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800"
            >
              <LayoutTemplate className="h-3.5 w-3.5" />
              Open page builder
            </Link>
          </div>
        </div>

        <div className="md:col-span-2">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-700">
            Base price (per unit)
          </label>
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-ink-300 bg-ink-50 px-3 py-2">
            {/* The rtg_base_price field can carry a legacy value from
                before we made it derived. Only show it as legitimately
                locked when the project has actually approved a spec
                sheet — otherwise treat as "not set yet" and ignore
                the stale value. */}
            {basePrice && formulation.has_approved_spec ? (
              <>
                <span className="text-lg font-semibold text-ink-1000">
                  {currency} {basePrice}
                </span>
                <span className="text-xs text-ink-600">
                  Locked from the latest approved spec sheet. Change
                  cost or margin on the spec + re-approve to update.
                </span>
              </>
            ) : (
              <>
                <span className="text-lg font-semibold text-ink-500">—</span>
                <span className="text-xs text-ink-600">
                  Not set yet. Approve a spec sheet (cost + margin →
                  final price) to lock the customer-facing base price
                  here.
                </span>
              </>
            )}
          </div>
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

        {/* Paid-sample pair — kept side-by-side with the price /
            MOQ row so authors see the whole "what the customer
            pays for" picture at once. Leave the price blank to
            retract the sample offer (the storefront then shows
            "Sample not available"). */}
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-700">
            Sample price (per unit)
          </label>
          <div className="flex items-center gap-2">
            <span className="rounded-lg border border-ink-300 bg-ink-50 px-3 py-2 text-sm font-semibold text-ink-700">
              {currency}
            </span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={samplePrice}
              onChange={(e) => setSamplePrice(e.currentTarget.value)}
              disabled={disabled}
              placeholder="Leave blank if no sample"
              className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
            />
          </div>
          {fieldErrors.rtg_sample_price ? (
            <p className="mt-1 text-xs text-rose-700">
              {fieldErrors.rtg_sample_price}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-ink-600">
            Blank = storefront hides the "Request sample" button and
            shows "Sample not available".
          </p>
        </div>

        <div className="md:col-span-2">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-700">
            Sample description
          </label>
          <textarea
            rows={2}
            value={sampleDescription}
            onChange={(e) => setSampleDescription(e.currentTarget.value)}
            disabled={disabled}
            placeholder="e.g. 30-count trial bottle, ships within 5 working days."
            className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
          />
          {fieldErrors.rtg_sample_description ? (
            <p className="mt-1 text-xs text-rose-700">
              {fieldErrors.rtg_sample_description}
            </p>
          ) : null}
        </div>

      </div>

      <div className="mt-4">
        <CatalogPhotoGallery
          orgId={orgId}
          formulationId={formulation.id}
          canEdit={canEdit}
        />
      </div>

      <p className="mt-4 rounded-lg border border-dashed border-ink-300 bg-ink-50 px-3 py-2 text-xs text-ink-700">
        Packaging is now defined per-SKU in the <strong>Packaging
        combos</strong> card above (bottle + lid + label bundles the
        customer picks between at checkout). The old free-text
        packaging options field has been retired.
      </p>

      <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
        {isDirty && !saving ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-600" />
            Unsaved changes
          </span>
        ) : null}
        {saving ? (
          <span className="text-xs text-ink-500">Saving…</span>
        ) : null}
        <button
          type="button"
          onClick={submit}
          disabled={!canSave}
          title={
            !canEdit
              ? "Read-only"
              : !isDirty
                ? "No changes to save"
                : "Save changes"
          }
          className="inline-flex items-center gap-1.5 rounded-lg bg-ink-1000 px-4 py-2 text-sm font-semibold text-ink-0 hover:bg-ink-900 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Save className="h-4 w-4" />
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </section>
  );
}
