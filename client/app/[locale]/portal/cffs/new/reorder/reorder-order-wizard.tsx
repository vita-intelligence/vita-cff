"use client";

/**
 * Reorder wizard — customer re-buys one of their own signed Custom
 * formulations. Two screens:
 *
 * 1. **Picker** — infinite-scroll list of eligible formulations
 *    with debounced ILIKE search. Uses the cursor pagination the
 *    ``/api/portal/reorderable-formulations/`` endpoint returns so
 *    a customer with thousands of past signed products still loads
 *    instantly. Each card shows the display name, dosage form, last
 *    signed date, and last paid price so the customer has enough
 *    context to pick without a second click.
 * 2. **Confirm** — quantity + delivery address + optional target
 *    ship date + notes. Prefills delivery from the profile. On
 *    submit POSTs to ``/api/portal/reorder/new/`` and routes to the
 *    portal home so the new pending card shows up.
 *
 * Draft persisted per source-id to localStorage so a reload mid-
 * confirm doesn't lose the quantity / address the customer typed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ChevronLeft, Loader2, Search, Send } from "lucide-react";

import {
  Card,
  ErrorBanner,
  Eyebrow,
  PortalButton,
  PortalInput,
  PortalTextarea,
} from "@/components/portal/brutalist";
import { apiClient, normalizeApiError } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";


export interface PortalReorderableFormulation {
  readonly id: string;
  readonly display_name: string;
  readonly code: string;
  readonly dosage_form: string;
  readonly servings_per_pack: number;
  readonly last_signed_at: string | null;
  readonly last_unit_price: string | null;
  readonly last_currency: string | null;
  //: Number of finished units the customer bought last time (e.g.
  //: 1000 bottles for a 60-gummy jar). Null if the source has never
  //: been priced. Used to prefill the confirm-step quantity so the
  //: default matches what the customer expects to see, not the
  //: per-pack container count.
  readonly last_quantity: number | null;
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


interface ReorderableListResponse {
  readonly results: ReadonlyArray<PortalReorderableFormulation>;
  readonly next_cursor: string | null;
}


interface OrderForm {
  readonly quantity: string;
  readonly delivery_address: string;
  readonly target_ship_date: string;
  readonly notes: string;
}


function currencySymbol(code: string | null): string {
  const upper = (code || "GBP").toUpperCase();
  if (upper === "GBP") return "£";
  if (upper === "EUR") return "€";
  if (upper === "USD") return "$";
  return `${upper} `;
}


function formatSignedAt(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "";
  }
}


function draftKey(customerId: string, sourceId: string): string {
  return `portal:reorder-draft:${customerId}:${sourceId}`;
}


// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------


export function ReorderOrderWizard({
  profile,
  initialResults,
  initialNextCursor,
}: {
  profile: ProfileShape;
  initialResults: ReadonlyArray<PortalReorderableFormulation>;
  initialNextCursor: string | null;
}) {
  const [picked, setPicked] = useState<PortalReorderableFormulation | null>(
    null,
  );

  if (picked === null) {
    return (
      <ReorderPicker
        initialResults={initialResults}
        initialNextCursor={initialNextCursor}
        onPick={setPicked}
      />
    );
  }

  return (
    <ReorderConfirm
      profile={profile}
      source={picked}
      onBack={() => setPicked(null)}
    />
  );
}


// ---------------------------------------------------------------------------
// Picker
// ---------------------------------------------------------------------------


function ReorderPicker({
  initialResults,
  initialNextCursor,
  onPick,
}: {
  initialResults: ReadonlyArray<PortalReorderableFormulation>;
  initialNextCursor: string | null;
  onPick: (source: PortalReorderableFormulation) => void;
}) {
  const [rows, setRows] = useState<PortalReorderableFormulation[]>(
    () => [...initialResults],
  );
  const [nextCursor, setNextCursor] = useState<string | null>(
    initialNextCursor,
  );
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const searchDebounceRef = useRef<number | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const fetchPage = useCallback(
    async (opts: { search: string; cursor: string | null; replace: boolean }) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        params.set("limit", "20");
        if (opts.search) params.set("search", opts.search);
        if (opts.cursor) params.set("cursor", opts.cursor);
        const res = await apiClient.get<ReorderableListResponse>(
          `/api/portal/reorderable-formulations/?${params.toString()}`,
          { signal: controller.signal },
        );
        const body = res.data;
        setRows((prev) =>
          opts.replace ? [...body.results] : [...prev, ...body.results],
        );
        setNextCursor(body.next_cursor);
      } catch (exc: unknown) {
        if (controller.signal.aborted) return;
        setError(normalizeApiError(exc).message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [],
  );

  // Debounced search — 250ms after typing stops.
  useEffect(() => {
    if (searchDebounceRef.current !== null) {
      window.clearTimeout(searchDebounceRef.current);
    }
    searchDebounceRef.current = window.setTimeout(() => {
      fetchPage({ search, cursor: null, replace: true });
    }, 250);
    return () => {
      if (searchDebounceRef.current !== null) {
        window.clearTimeout(searchDebounceRef.current);
      }
    };
  // Intentionally omit fetchPage from deps — stable via useCallback.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // Infinite scroll — IntersectionObserver on the bottom sentinel.
  useEffect(() => {
    if (!nextCursor) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && !loading) {
          fetchPage({ search, cursor: nextCursor, replace: false });
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextCursor, loading, search]);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <label className="flex items-center gap-3 border-2 border-black bg-white px-3 py-2">
          <Search className="h-4 w-4 shrink-0" aria-hidden />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search your signed formulations…"
            className="w-full bg-transparent text-sm outline-none placeholder:text-neutral-500"
            aria-label="Search reorderable formulations"
          />
        </label>
      </Card>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      <div className="grid gap-3 md:grid-cols-2">
        {rows.map((row) => (
          <ReorderPickerCard key={row.id} row={row} onPick={onPick} />
        ))}
      </div>

      {rows.length === 0 && !loading ? (
        <Card>
          <p className="text-sm text-neutral-700">
            No signed formulations match. Try a different search, or head
            back and pick a different track.
          </p>
        </Card>
      ) : null}

      {nextCursor ? (
        <div ref={sentinelRef} className="flex justify-center py-6">
          {loading ? (
            <Loader2 className="h-5 w-5 animate-spin text-neutral-500" />
          ) : (
            <span className="text-xs uppercase tracking-[0.2em] text-neutral-500">
              Scroll to load more
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}


function ReorderPickerCard({
  row,
  onPick,
}: {
  row: PortalReorderableFormulation;
  onPick: (row: PortalReorderableFormulation) => void;
}) {
  const priceLine =
    row.last_unit_price && row.last_currency
      ? `Last paid ${currencySymbol(row.last_currency)}${row.last_unit_price}`
      : "";
  const signedLine = formatSignedAt(row.last_signed_at);

  return (
    <button
      type="button"
      onClick={() => onPick(row)}
      className="group text-left"
    >
      <Card hover className="h-full">
        <div className="flex h-full flex-col gap-3">
          <Eyebrow>{row.dosage_form || "Custom"}</Eyebrow>
          <h3 className="text-lg font-black uppercase leading-tight tracking-tight">
            {row.display_name}
          </h3>
          {row.code ? (
            <p className="text-xs uppercase tracking-[0.2em] text-neutral-500">
              {row.code}
            </p>
          ) : null}
          <dl className="mt-2 grid grid-cols-2 gap-2 text-xs text-neutral-700">
            {signedLine ? (
              <div>
                <dt className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">
                  Signed
                </dt>
                <dd className="font-semibold">{signedLine}</dd>
              </div>
            ) : null}
            {row.last_quantity ? (
              <div>
                <dt className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">
                  Last order
                </dt>
                <dd className="font-semibold">{row.last_quantity} units</dd>
              </div>
            ) : null}
            {priceLine ? (
              <div className="col-span-2">
                <dt className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">
                  Unit price
                </dt>
                <dd className="font-semibold">{priceLine}</dd>
              </div>
            ) : null}
          </dl>
          <div className="mt-auto flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-700">
            Reorder this
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </div>
        </div>
      </Card>
    </button>
  );
}


// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------


function ReorderConfirm({
  profile,
  source,
  onBack,
}: {
  profile: ProfileShape;
  source: PortalReorderableFormulation;
  onBack: () => void;
}) {
  const router = useRouter();
  const storageKey = useMemo(
    () => draftKey(profile.customer_id, source.id),
    [profile.customer_id, source.id],
  );

  const [form, setForm] = useState<OrderForm>(() => {
    // Prefill with the customer's PREVIOUS order quantity (units of
    // finished product), not the per-pack container count. If the
    // source has never been ordered, fall back to 1 — safer than
    // ``servings_per_pack`` which is a pack-spec, not an order size.
    const prefillQty =
      source.last_quantity && source.last_quantity > 0
        ? source.last_quantity
        : 1;
    const defaults: OrderForm = {
      quantity: String(prefillQty),
      delivery_address: profile.delivery_address || "",
      target_ship_date: "",
      notes: "",
    };
    if (typeof window === "undefined") return defaults;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return defaults;
      const parsed = JSON.parse(raw) as Partial<OrderForm>;
      return { ...defaults, ...parsed };
    } catch {
      return defaults;
    }
  });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Debounced draft persistence.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handle = window.setTimeout(() => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(form));
      } catch {
        // Storage full / disabled — silently skip.
      }
    }, 350);
    return () => window.clearTimeout(handle);
  }, [form, storageKey]);

  const update = useCallback(
    <K extends keyof OrderForm>(key: K, value: OrderForm[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
      setFieldErrors((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    [],
  );

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      const quantity = Number.parseInt(form.quantity, 10);
      await apiClient.post(`/api/portal/reorder/new/`, {
        source_formulation_id: source.id,
        quantity: Number.isFinite(quantity) ? quantity : 0,
        delivery_address: form.delivery_address,
        target_ship_date: form.target_ship_date || null,
        notes: form.notes,
      });
      // Success — nuke the draft, route back to the portal home so
      // the new pending card renders on the activity feed.
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(storageKey);
      }
      router.push("/portal/products");
    } catch (exc: unknown) {
      const api = normalizeApiError(exc);
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
      setError(
        (api.payload?.detail as string | undefined) ||
          api.message ||
          "Something went wrong submitting your reorder.",
      );
    } finally {
      setSubmitting(false);
    }
  }, [form, source.id, storageKey, router]);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="flex flex-col gap-2">
          <Eyebrow>You're reordering</Eyebrow>
          <h2 className="text-xl font-black uppercase leading-tight tracking-tight">
            {source.display_name}
          </h2>
          {source.last_quantity ? (
            <p className="text-sm text-neutral-700">
              Last order:{" "}
              <strong>{source.last_quantity} units</strong>
              {source.last_unit_price && source.last_currency ? (
                <>
                  {" "}at{" "}
                  <strong>
                    {currencySymbol(source.last_currency)}
                    {source.last_unit_price}
                  </strong>{" "}
                  per unit
                </>
              ) : null}
              . Our team will review before sending you the proposal.
            </p>
          ) : source.last_unit_price && source.last_currency ? (
            <p className="text-sm text-neutral-700">
              Last paid unit price:{" "}
              <strong>
                {currencySymbol(source.last_currency)}
                {source.last_unit_price}
              </strong>{" "}
              — our team will review before sending you the proposal.
            </p>
          ) : null}
        </div>
      </Card>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      <Card>
        <div className="flex flex-col gap-4">
          <PortalInput
            label="Quantity"
            type="number"
            min={1}
            step={1}
            value={form.quantity}
            onChange={(e) => update("quantity", e.target.value)}
            error={fieldErrors.quantity}
          />
          <PortalTextarea
            label="Delivery address"
            value={form.delivery_address}
            onChange={(e) => update("delivery_address", e.target.value)}
            rows={3}
            error={fieldErrors.delivery_address}
          />
          <PortalInput
            label="Target ship date (optional)"
            type="date"
            value={form.target_ship_date}
            onChange={(e) => update("target_ship_date", e.target.value)}
          />
          <PortalTextarea
            label="Notes for our team (optional)"
            value={form.notes}
            onChange={(e) => update("notes", e.target.value)}
            rows={3}
          />
        </div>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
        <PortalButton
          type="button"
          variant="secondary"
          onClick={onBack}
          disabled={submitting}
        >
          <ChevronLeft className="h-4 w-4" /> Change product
        </PortalButton>
        <PortalButton
          type="button"
          onClick={submit}
          disabled={submitting}
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Submitting…
            </>
          ) : (
            <>
              <Send className="h-4 w-4" /> Request reorder
            </>
          )}
        </PortalButton>
      </div>
    </div>
  );
}
