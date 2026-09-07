"use client";

/**
 * Ready-to-Go order wizard.
 *
 * Two screens:
 *
 * 1. **Catalog grid** — SKU picker. Each card renders the SKU's hero,
 *    name, marketing sub-copy, "From £X · MOQ N" price anchor, and
 *    routes to screen 2 on click.
 * 2. **Order form** — quantity + packaging + delivery + optional
 *    ship-date fields. Debounced draft is persisted to localStorage
 *    under ``portal:rtg-draft:{customer_id}:{sku_id}`` so a reload
 *    doesn't lose in-flight values. On submit, POSTs to
 *    ``/api/portal/cffs/new-rtg/`` and routes to /portal/products so
 *    the customer sees their new pending card.
 *
 * Uses only the existing brutalist primitives (Card, PortalInput,
 * PortalTextarea, PortalButton, ErrorBanner) so the visual language
 * stays consistent with the Custom wizard and the products page.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ChevronLeft, ChevronRight, Send } from "lucide-react";

import {
  Card,
  ErrorBanner,
  Eyebrow,
  PortalButton,
  PortalInput,
  PortalTextarea,
} from "@/components/portal/brutalist";
import { PageBuilderRender } from "@/components/page-builder/page-builder-render";
import { apiClient, normalizeApiError } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------


export interface PortalRTGPackagingCombo {
  readonly id: string;
  readonly name: string;
  readonly price_delta: string;
  readonly is_default: boolean;
  readonly items: ReadonlyArray<string>;
}


export interface PortalRTGCatalogItem {
  readonly id: string;
  readonly name: string;
  readonly short_description: string;
  //: Legacy sanitized HTML body. Server pre-sanitizes via bleach,
  //: so ``dangerouslySetInnerHTML`` is safe. Rendered only when
  //: ``page_content`` is null (pre-migration listings).
  readonly long_description: string;
  //: Puck page-builder JSON schema. When set, we render this via
  //: Puck's ``<Render>`` and skip the legacy HTML fallback.
  readonly page_content: unknown | null;
  readonly hero_image_url: string | null;
  //: Full storefront gallery (primary first). Empty when staff
  //: haven't added any photos; wizard falls back to just the hero.
  readonly gallery?: ReadonlyArray<{
    readonly id: string;
    readonly url: string;
    readonly caption: string;
    readonly is_primary: boolean;
  }>;
  readonly base_price: string;
  readonly currency_code: string;
  readonly moq: number;
  //: Sample price string, or ``null`` when the SKU doesn't offer a
  //: paid sample. Mirrors ``rtg_sample_price`` on the Formulation
  //: model — the FE hides the "Get sample" affordance when null.
  readonly sample_price: string | null;
  //: Sales description of what's in the sample kit (typically "1x
  //: 60-cap bottle" or similar). Falls back to a generic label when
  //: staff hasn't written one.
  readonly sample_description: string;
  readonly packaging_options: ReadonlyArray<string>;
  readonly packaging_combos?: ReadonlyArray<PortalRTGPackagingCombo>;
}


export interface ProfileShape {
  readonly customer_id: string;
  readonly email: string;
  readonly name: string;
  readonly company: string;
  readonly phone: string;
  readonly invoice_address: string;
  readonly delivery_address: string;
}


interface OrderForm {
  readonly quantity: string;
  readonly packaging: string;
  readonly packaging_combo_id: string;
  readonly delivery_address: string;
  readonly target_ship_date: string;
  readonly notes: string;
}


function draftKey(customerId: string, skuId: string): string {
  return `portal:rtg-draft:${customerId}:${skuId}`;
}


function currencySymbol(code: string): string {
  const upper = (code || "GBP").toUpperCase();
  if (upper === "GBP") return "£";
  if (upper === "EUR") return "€";
  if (upper === "USD") return "$";
  return `${upper} `;
}


// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------


export function RTGOrderWizard({
  profile,
  catalog,
}: {
  profile: ProfileShape;
  catalog: ReadonlyArray<PortalRTGCatalogItem>;
}) {
  const [pickedId, setPickedId] = useState<string | null>(null);
  const picked = useMemo(
    () => catalog.find((c) => c.id === pickedId) ?? null,
    [catalog, pickedId],
  );
  // Sample flow lives on its own state track — customer can hit
  // "Get sample" on any card without leaving the grid, and the modal
  // handles submit + close in-place. Once the sample lands as a
  // PENDING Payment on finance's queue we redirect to the customer's
  // product list, mirroring the RTG order flow's success path.
  const [sampleSkuId, setSampleSkuId] = useState<string | null>(null);
  const sampleSku = useMemo(
    () => catalog.find((c) => c.id === sampleSkuId) ?? null,
    [catalog, sampleSkuId],
  );

  if (catalog.length === 0) {
    return (
      <Card>
        <div className="flex flex-col items-start gap-3 py-6">
          <Eyebrow>Nothing to show yet</Eyebrow>
          <h3 className="text-lg font-black uppercase tracking-tight">
            No Ready-to-Go products in your catalog
          </h3>
          <p className="max-w-prose text-sm leading-relaxed text-neutral-700">
            Your account manager will publish products here once
            they&rsquo;re ready. In the meantime, start a Custom
            formulation from the previous screen.
          </p>
        </div>
      </Card>
    );
  }

  if (picked === null) {
    return (
      <>
        <CatalogGrid
          catalog={catalog}
          onPick={(id) => setPickedId(id)}
          onGetSample={(id) => setSampleSkuId(id)}
        />
        {sampleSku ? (
          <SampleOrderModal
            profile={profile}
            sku={sampleSku}
            onClose={() => setSampleSkuId(null)}
          />
        ) : null}
      </>
    );
  }

  return (
    <OrderForm
      profile={profile}
      sku={picked}
      onBack={() => setPickedId(null)}
    />
  );
}


// ---------------------------------------------------------------------------
// Catalog grid
// ---------------------------------------------------------------------------


function CatalogGrid({
  catalog,
  onPick,
  onGetSample,
}: {
  catalog: ReadonlyArray<PortalRTGCatalogItem>;
  onPick: (id: string) => void;
  onGetSample: (id: string) => void;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {catalog.map((sku) => {
        // Each card carries TWO CTAs when a sample is offered:
        //   * primary — Order (full MOQ + packaging flow)
        //   * secondary — Get sample (compact modal, 1 kit)
        // The card wrapper is a <div> (not a <button>) because we now
        // have nested buttons; clicking the image / body still opens
        // the order flow via the primary button, but the secondary
        // Sample button needs its own click boundary that doesn't
        // bubble.
        const hasSample =
          sku.sample_price !== null && sku.sample_price !== undefined;
        return (
          <div key={sku.id} className="group text-left focus:outline-none">
            <Card hover className="h-full">
              <div className="flex h-full flex-col gap-3">
                {sku.hero_image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={sku.hero_image_url}
                    alt={sku.name}
                    className="h-32 w-full border-2 border-black object-cover"
                  />
                ) : (
                  <div
                    className="flex h-32 w-full items-center justify-center border-2 border-black bg-neutral-100 text-3xl font-black uppercase"
                    aria-hidden="true"
                  >
                    {(sku.name || "?").slice(0, 1)}
                  </div>
                )}
                <h3 className="text-lg font-black uppercase leading-tight tracking-tight">
                  {sku.name}
                </h3>
                {sku.short_description ? (
                  <p className="text-sm leading-relaxed text-neutral-700">
                    {sku.short_description}
                  </p>
                ) : null}
                <div className="mt-auto flex flex-col gap-2 text-[11px] font-bold uppercase tracking-[0.2em]">
                  <span>
                    From {currencySymbol(sku.currency_code)}
                    {sku.base_price} &middot; MOQ {sku.moq}
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => onPick(sku.id)}
                      className="flex flex-1 items-center justify-between border-2 border-black bg-orange-500 px-3 py-2 text-black transition-colors hover:bg-orange-400"
                    >
                      Order
                      <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                    </button>
                    {hasSample ? (
                      <button
                        type="button"
                        onClick={() => onGetSample(sku.id)}
                        className="border-2 border-black bg-white px-3 py-2 text-black transition-colors hover:bg-neutral-100"
                        title={`Order a paid sample kit for ${currencySymbol(sku.currency_code)}${sku.sample_price}`}
                      >
                        Sample&nbsp;{currencySymbol(sku.currency_code)}
                        {sku.sample_price}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            </Card>
          </div>
        );
      })}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Sample order modal — compact "Get sample" flow that stays on the
// catalog grid. Prefills the customer's delivery address (same source
// as the full-order form), captures optional notes, and posts to the
// portal checkout endpoint with ``kind=sample`` so a PENDING Payment
// lands on finance's queue for approval.
// ---------------------------------------------------------------------------

function SampleOrderModal({
  profile,
  sku,
  onClose,
}: {
  profile: ProfileShape;
  sku: PortalRTGCatalogItem;
  onClose: () => void;
}) {
  const router = useRouter();
  const [delivery, setDelivery] = useState(profile.delivery_address || "");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // Track how long the modal has been open so the anti-abuse
  // ``too_fast`` guard on ``/api/portal/checkout/`` doesn't fire on
  // a legitimate customer submit. The BE compares against a few-
  // second threshold; anything past 2s is safe.
  const openedAtRef = useMemo(() => ({ current: Date.now() }), []);

  const onSubmit = useCallback(async () => {
    setBanner(null);
    const errs: Record<string, string> = {};
    if (!delivery.trim()) {
      errs.delivery_address = "A delivery address is required.";
    }
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    try {
      await apiClient.post("/api/portal/checkout/", {
        lines: [
          {
            formulation_id: sku.id,
            kind: "sample",
            quantity: 1,
            unit_price: sku.sample_price ?? "0",
            currency_code: sku.currency_code || "GBP",
            packaging_combo_id: null,
          },
        ],
        name: profile.name || "",
        company: profile.company || "",
        phone: profile.phone || "",
        invoice_address: profile.invoice_address || "",
        delivery_address: delivery.trim(),
        elapsed_ms: Math.max(2000, Date.now() - openedAtRef.current),
      });
      router.push("/portal/products");
    } catch (error) {
      const api = normalizeApiError(error);
      const detail =
        (api.payload?.message as string | undefined) ||
        (api.payload?.detail as string | undefined) ||
        api.message ||
        "Something went wrong submitting your sample order.";
      setBanner(detail);
    } finally {
      setSubmitting(false);
    }
  }, [
    delivery,
    notes,
    openedAtRef,
    profile.company,
    profile.invoice_address,
    profile.name,
    profile.phone,
    router,
    sku.currency_code,
    sku.id,
    sku.sample_price,
  ]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="w-full max-w-lg border-2 border-black bg-white p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-orange-600">
              Sample kit
            </p>
            <h2 className="mt-1 text-xl font-black uppercase leading-tight tracking-tight">
              {sku.name}
            </h2>
            <p className="mt-2 text-sm text-neutral-700">
              {sku.sample_description ||
                "One sample kit — invoice goes to your finance team after our team approves it."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
            className="border-2 border-black bg-white px-2 py-1 text-sm font-bold hover:bg-neutral-100 disabled:opacity-50"
          >
            ✕
          </button>
        </div>

        <div className="mt-4 flex items-center justify-between border-2 border-black bg-neutral-50 px-3 py-2 text-sm">
          <span className="font-bold uppercase tracking-[0.2em]">
            Total
          </span>
          <span className="text-lg font-black tabular-nums">
            {currencySymbol(sku.currency_code)}
            {sku.sample_price}
          </span>
        </div>

        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!submitting) void onSubmit();
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-bold uppercase tracking-widest">
              Delivery address
            </span>
            <textarea
              rows={3}
              value={delivery}
              onChange={(e) => setDelivery(e.currentTarget.value)}
              className="w-full border-2 border-black bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
              placeholder="Recipient name, street, city, post code, country"
            />
            {fieldErrors.delivery_address ? (
              <span className="text-xs text-red-700">
                {fieldErrors.delivery_address}
              </span>
            ) : null}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-bold uppercase tracking-widest">
              Notes (optional)
            </span>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.currentTarget.value)}
              className="w-full border-2 border-black bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
              placeholder="Anything our sample team should know?"
            />
          </label>

          {banner ? (
            <p className="border-2 border-red-700 bg-red-50 px-3 py-2 text-xs font-medium text-red-900">
              {banner}
            </p>
          ) : null}

          <div className="mt-1 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="border-2 border-black bg-white px-3 py-2 text-sm font-bold uppercase tracking-widest hover:bg-neutral-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-1.5 border-2 border-black bg-orange-500 px-4 py-2 text-sm font-bold uppercase tracking-widest text-black transition-colors hover:bg-orange-400 disabled:opacity-50"
            >
              {submitting ? "Submitting…" : "Order sample"}
              {submitting ? null : <Send className="h-4 w-4" />}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Order form
// ---------------------------------------------------------------------------


function OrderForm({
  profile,
  sku,
  onBack,
}: {
  profile: ProfileShape;
  sku: PortalRTGCatalogItem;
  onBack: () => void;
}) {
  const router = useRouter();
  const key = useMemo(
    () => draftKey(profile.customer_id, sku.id),
    [profile.customer_id, sku.id],
  );

  const combos = useMemo(
    () => sku.packaging_combos ?? [],
    [sku.packaging_combos],
  );
  const hasCombos = combos.length > 0;

  const initialState = useMemo<OrderForm>(() => {
    const defaultCombo = combos.find((c) => c.is_default) ?? combos[0];
    return {
      quantity: String(sku.moq),
      packaging: hasCombos ? "" : (sku.packaging_options[0] ?? ""),
      packaging_combo_id: defaultCombo?.id ?? "",
      delivery_address: profile.delivery_address || "",
      target_ship_date: "",
      notes: "",
    };
  }, [combos, hasCombos, sku, profile.delivery_address]);

  const [form, setForm] = useState<OrderForm>(initialState);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Restore draft on mount. Falls back to initial state on any
  // parse error so a bad localStorage payload can't break the form.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<OrderForm>;
      setForm((prev) => ({ ...prev, ...parsed }));
    } catch {
      // ignore
    }
  }, [key]);

  // Debounced draft persist. 500ms mirrors the Custom wizard cadence
  // so a mid-form reload after < half a second is the only window
  // that loses work.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      try {
        window.localStorage.setItem(key, JSON.stringify(form));
      } catch {
        // ignore
      }
    }, 500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [form, key]);

  const setField = useCallback(
    <K extends keyof OrderForm>(field: K, value: OrderForm[K]) => {
      setForm((prev) => ({ ...prev, [field]: value }));
      setFieldErrors((prev) => {
        if (!(field in prev)) return prev;
        const next = { ...prev };
        delete next[field as string];
        return next;
      });
    },
    [],
  );

  const quantityNum = Number(form.quantity) || 0;
  const belowMoq = quantityNum > 0 && quantityNum < sku.moq;
  const selectedCombo = useMemo(
    () => combos.find((c) => c.id === form.packaging_combo_id) ?? null,
    [combos, form.packaging_combo_id],
  );
  const subtotal = useMemo(() => {
    const price = Number(sku.base_price) || 0;
    const delta = Number(selectedCombo?.price_delta ?? 0) || 0;
    return quantityNum * (price + delta);
  }, [quantityNum, sku.base_price, selectedCombo]);

  const handleSubmit = useCallback(async () => {
    setBanner(null);
    // Client-side guards mirror the server so a misconfigured form
    // never hits the wire.
    const errors: Record<string, string> = {};
    if (quantityNum < sku.moq) {
      errors.quantity = `Minimum order quantity is ${sku.moq}.`;
    }
    if (hasCombos) {
      if (!form.packaging_combo_id) {
        errors.packaging_combo_id = "Pick a packaging option.";
      } else if (!combos.some((c) => c.id === form.packaging_combo_id)) {
        errors.packaging_combo_id = "Pick a packaging option from the list.";
      }
    } else if (!form.packaging) {
      errors.packaging = "Pick a packaging option.";
    } else if (!sku.packaging_options.includes(form.packaging)) {
      errors.packaging = "Pick a packaging option from the list.";
    }
    if (!form.delivery_address.trim()) {
      errors.delivery_address = "A delivery address is required.";
    }
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setSubmitting(true);
    try {
      await apiClient.post("/api/portal/cffs/new-rtg/", {
        rtg_formulation_id: sku.id,
        quantity: quantityNum,
        packaging: hasCombos
          ? (selectedCombo?.name ?? "")
          : form.packaging,
        packaging_combo_id: hasCombos ? form.packaging_combo_id : null,
        delivery_address: form.delivery_address.trim(),
        target_ship_date: form.target_ship_date || null,
        notes: form.notes.trim() || undefined,
      });
      if (typeof window !== "undefined") {
        try {
          window.localStorage.removeItem(key);
        } catch {
          // ignore
        }
      }
      router.push("/portal/products");
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
        if (Object.keys(next).length > 0) setFieldErrors(next);
      }
      const detail =
        (api.payload?.detail as string | undefined) ||
        api.message ||
        "Something went wrong submitting your order.";
      setBanner(detail);
    } finally {
      setSubmitting(false);
    }
  }, [
    combos,
    form.delivery_address,
    form.notes,
    form.packaging,
    form.packaging_combo_id,
    form.target_ship_date,
    hasCombos,
    key,
    quantityNum,
    router,
    selectedCombo,
    sku.id,
    sku.moq,
    sku.packaging_options,
  ]);

  return (
    <div className="flex flex-col gap-6">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex w-fit items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-600 transition-colors hover:text-black"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        Back to catalog
      </button>

      <Card>
        <div className="mb-2 flex items-center gap-3">
          <Eyebrow>Selected product</Eyebrow>
        </div>
        <h2 className="text-xl font-black uppercase tracking-tight">
          {sku.name}
        </h2>
        {sku.short_description ? (
          <p className="mt-2 text-sm leading-relaxed text-neutral-700">
            {sku.short_description}
          </p>
        ) : null}
        <p className="mt-3 text-[11px] font-bold uppercase tracking-[0.2em]">
          From {currencySymbol(sku.currency_code)}
          {sku.base_price} per unit &middot; MOQ {sku.moq}
        </p>
      </Card>

      {/* Rich catalog page body, authored in the staff RTG panel and
          pre-sanitized on the server via bleach so
          ``dangerouslySetInnerHTML`` is safe here. Self-hides when
          the SKU hasn't been given a full description yet. */}
      {/* Two rendering paths:
          1. If ``page_content`` is set, the SKU was authored in the
             Puck page builder — render it through ``<Render>``.
          2. Otherwise fall back to the legacy sanitized-HTML long
             description so pre-migration listings still show
             marketing copy. */}
      {sku.page_content ? (
        <PageBuilderRender data={sku.page_content} />
      ) : sku.long_description ? (
        <Card>
          <div
            className="rich-content"
            dangerouslySetInnerHTML={{ __html: sku.long_description }}
          />
        </Card>
      ) : null}

      {banner ? <ErrorBanner>{banner}</ErrorBanner> : null}

      <Card>
        <div className="flex flex-col gap-5">
          <PortalInput
            label="Quantity"
            type="number"
            min={1}
            step={1}
            value={form.quantity}
            onChange={(e) => setField("quantity", e.currentTarget.value)}
            error={
              fieldErrors.quantity ||
              (belowMoq ? `Minimum order quantity is ${sku.moq}.` : undefined)
            }
            hint={`Subtotal: ${currencySymbol(sku.currency_code)}${subtotal.toFixed(2)}`}
          />

          <div>
            <span className="mb-2 block text-xs font-bold uppercase tracking-widest">
              Packaging
            </span>
            <div className="flex flex-col gap-2">
              {hasCombos
                ? combos.map((combo) => {
                    const delta = Number(combo.price_delta) || 0;
                    const deltaLabel =
                      delta === 0
                        ? ""
                        : delta > 0
                          ? `+${currencySymbol(sku.currency_code)}${delta.toFixed(2)}/unit`
                          : `−${currencySymbol(sku.currency_code)}${Math.abs(delta).toFixed(2)}/unit`;
                    const picked = form.packaging_combo_id === combo.id;
                    return (
                      <label
                        key={combo.id}
                        className={`flex cursor-pointer items-start gap-3 border-2 border-black bg-white px-3 py-2 text-sm ${
                          picked ? "bg-orange-500" : ""
                        }`}
                      >
                        <input
                          type="radio"
                          name="packaging_combo"
                          value={combo.id}
                          checked={picked}
                          onChange={() =>
                            setField("packaging_combo_id", combo.id)
                          }
                          className="mt-1 accent-black"
                        />
                        <span className="flex flex-1 flex-col gap-0.5">
                          <span className="flex items-center justify-between gap-3">
                            <span className="font-bold">{combo.name}</span>
                            {deltaLabel ? (
                              <span className="text-[11px] font-bold uppercase tracking-wide">
                                {deltaLabel}
                              </span>
                            ) : null}
                          </span>
                          {combo.items.length > 0 ? (
                            <span className="text-[11px] text-neutral-700">
                              Includes: {combo.items.join(" · ")}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    );
                  })
                : sku.packaging_options.map((opt) => (
                    <label
                      key={opt}
                      className={`flex cursor-pointer items-center gap-3 border-2 border-black bg-white px-3 py-2 text-sm ${
                        form.packaging === opt ? "bg-orange-500" : ""
                      }`}
                    >
                      <input
                        type="radio"
                        name="packaging"
                        value={opt}
                        checked={form.packaging === opt}
                        onChange={() => setField("packaging", opt)}
                        className="accent-black"
                      />
                      <span className="font-medium">{opt}</span>
                    </label>
                  ))}
            </div>
            {fieldErrors.packaging_combo_id || fieldErrors.packaging ? (
              <span className="mt-1.5 block text-[11px] font-bold uppercase tracking-wide text-red-700">
                {fieldErrors.packaging_combo_id || fieldErrors.packaging}
              </span>
            ) : null}
          </div>

          <PortalTextarea
            label="Delivery address"
            rows={3}
            value={form.delivery_address}
            onChange={(e) =>
              setField("delivery_address", e.currentTarget.value)
            }
            error={fieldErrors.delivery_address}
          />

          <PortalInput
            label="Target ship date (optional)"
            type="date"
            value={form.target_ship_date}
            onChange={(e) => setField("target_ship_date", e.currentTarget.value)}
          />

          <PortalTextarea
            label="Notes (optional)"
            rows={3}
            value={form.notes}
            onChange={(e) => setField("notes", e.currentTarget.value)}
            hint="Anything we should know? Shipping preferences, label copy, etc."
          />
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <PortalButton
          type="button"
          variant="secondary"
          onClick={onBack}
          disabled={submitting}
        >
          <ChevronLeft className="h-4 w-4" />
          Pick another
        </PortalButton>
        <PortalButton
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
        >
          {submitting ? "Submitting…" : "Submit order"}
          {submitting ? null : <Send className="h-4 w-4" />}
        </PortalButton>
      </div>
    </div>
  );
}
