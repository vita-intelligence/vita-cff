"use client";

/**
 * In-portal Custom Formulation Request wizard.
 *
 * Replaces the historical redirect to the marketing site's Wix
 * form. Seven steps, prefilled from the customer's profile,
 * autosaved to localStorage between steps, and POSTed to
 * ``/api/portal/cffs/new/`` on submit.
 *
 * Design choices worth calling out:
 *
 * * State is a single flat object. Every field is a string (or a
 *   string[] for the checkbox groups); the backend accepts strings
 *   for everything and does its own coercion. This keeps the
 *   draft-restore path trivial: JSON.stringify in / out and we're
 *   done.
 * * Validation is per-step + client-side only. The backend's 422
 *   response is the source of truth on submit — we surface those
 *   field errors on step 7 (or the step that owns the field).
 * * Draft key is scoped by ``customer_id`` so two logins on the
 *   same browser don't stomp each other. If the customer clears
 *   localStorage, we fall back to prefill and they lose in-flight
 *   edits — that's fine, we're not promising server persistence.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Send,
} from "lucide-react";

import {
  Card,
  ErrorBanner,
  Eyebrow,
  H2,
  PageHeader,
  PortalButton,
  PortalInput,
  PortalTextarea,
} from "@/components/portal/brutalist";
import { apiClient, normalizeApiError } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";


// -------------------------------------------------------------------
// Types + constants
// -------------------------------------------------------------------


export interface SalesPerson {
  readonly id: string;
  readonly full_name: string;
  readonly email: string;
}


interface ProfileShape {
  readonly customer_id: string;
  readonly email: string;
  readonly name: string;
  readonly company: string;
  readonly phone: string;
  readonly invoice_address: string;
  readonly delivery_address: string;
}


interface FormState {
  // Step 1
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  company_name: string;
  // Step 2
  product_formats: string[];
  market_segment: string;
  dose: string;
  // Step 3
  nutritional_requirements: string[];
  target_sex: string[];
  target_age: string[];
  other_nutritional_requirements: string;
  // Step 4
  dose_per_unit: string;
  actives_requirements: string;
  // Step 5
  primary_package_type: string;
  quantity_to_be_quoted: string;
  // Step 6
  country_region: string;
  address: string;
  city: string;
  postal_code: string;
  delivery_same_as_proposal: string; // "" | "yes" | "no"
  // Step 7
  account_manager_email: string;
}


const PRODUCT_FORMATS = ["Capsule", "Powder", "Tablet", "Gummy", "Liquid"] as const;
const NUTRITIONAL_REQS = [
  "Vegan",
  "Sugar Free",
  "Halal",
  "Kosher",
  "Organic",
] as const;
const TARGET_SEX = ["Male", "Female", "Both", "Others"] as const;
const TARGET_AGE = ["Under 18", "18-65 Years", "65+ Years"] as const;
/**
 * Primary-package taxonomy for the CFF wizard.
 *
 * Grouped by presentation family so the customer scans by intent
 * (solid-dose bottle, liquid dropper, jar for powders, etc.)
 * rather than searching a flat list.
 *
 * Historical values ("Bottle 30ct", "Bottle 60ct", "Bottle 120ct",
 * "Pouch", "Sachet", "Tube", "Blister") are preserved verbatim as
 * the first entries in their group so any in-flight draft with
 * one of them selected still resolves to a menu row on rehydrate.
 * New entries use the "<Family> · <capacity>" cadence for
 * consistency.
 *
 * ``PACKAGE_TYPES`` (flat) is kept for validation — the wizard
 * accepts either an exact match or the ``Other`` escape hatch.
 */
const PACKAGE_TYPE_GROUPS = [
  {
    label: "Bottles — solid dose",
    items: [
      "Bottle 30ct",
      "Bottle 60ct",
      "Bottle 90ct",
      "Bottle 120ct",
      "Bottle · 180 count",
      "Bottle · 240 count",
    ],
  },
  {
    label: "Bottles — liquid",
    items: [
      "Bottle · 30 ml (dropper)",
      "Bottle · 60 ml (dropper)",
      "Bottle · 100 ml",
      "Bottle · 250 ml",
      "Bottle · 500 ml",
      "Bottle · 1 L",
    ],
  },
  {
    label: "Jars — powder & gummies",
    items: [
      "Jar · 200 g",
      "Jar · 400 g",
      "Jar · 500 g",
      "Jar · 1 kg",
    ],
  },
  {
    label: "Single-dose",
    items: [
      "Sachet",
      "Stick pack",
      "Ampoule",
      "Vial",
    ],
  },
  {
    label: "Pouches",
    items: [
      "Pouch",
      "Pouch · single-serve",
      "Pouch · resealable multi-serve",
    ],
  },
  {
    label: "Blister",
    items: [
      "Blister",
      "Blister · 10 count",
      "Blister · 30 count",
    ],
  },
  {
    label: "Topical",
    items: [
      "Tube",
      "Tube · squeeze",
      "Spray bottle",
      "Roll-on",
      "Airless pump bottle",
    ],
  },
  {
    label: "Other",
    items: ["Other"],
  },
] as const;

const PACKAGE_TYPES = PACKAGE_TYPE_GROUPS.flatMap((g) => g.items);


const TOTAL_STEPS = 7;
const DRAFT_KEY_PREFIX = "portal:cff-draft:";
const DRAFT_DEBOUNCE_MS = 500;


// -------------------------------------------------------------------
// Prefill helpers
// -------------------------------------------------------------------


function splitName(fullName: string): { first: string; last: string } {
  const trimmed = (fullName || "").trim();
  if (!trimmed) return { first: "", last: "" };
  const idx = trimmed.indexOf(" ");
  if (idx === -1) return { first: trimmed, last: "" };
  return {
    first: trimmed.slice(0, idx),
    last: trimmed.slice(idx + 1).trim(),
  };
}


/** Cheap best-effort parse of the free-text invoice_address the
 *  profile stores. If the address looks like a structured multi-line
 *  block ("street\ncity\npostcode\ncountry") we split it out;
 *  otherwise everything lands in ``address`` and the customer edits
 *  the rest by hand. Never guesses — better to leave a field blank
 *  than to seed it with wrong data the customer forgets to fix. */
function parseInvoiceAddress(raw: string): {
  address: string;
  city: string;
  postal_code: string;
  country_region: string;
} {
  const blank = { address: "", city: "", postal_code: "", country_region: "" };
  const cleaned = (raw || "").trim();
  if (!cleaned) return blank;
  const lines = cleaned
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length <= 1) {
    // Comma-separated single line — dump the whole thing into
    // address to avoid mis-splitting on a comma that lives inside
    // a street ("Flat 3, 15 High St") vs one that separates fields.
    return { ...blank, address: cleaned };
  }
  if (lines.length === 2) {
    return { ...blank, address: lines[0]!, city: lines[1]! };
  }
  if (lines.length === 3) {
    return {
      ...blank,
      address: lines[0]!,
      city: lines[1]!,
      postal_code: lines[2]!,
    };
  }
  // 4+ lines: last line is country, second-to-last is postcode,
  // third-to-last is city, everything above collapses into address.
  return {
    address: lines.slice(0, lines.length - 3).join(", "),
    city: lines[lines.length - 3]!,
    postal_code: lines[lines.length - 2]!,
    country_region: lines[lines.length - 1]!,
  };
}


function buildInitialState(profile: ProfileShape, defaultAM: string): FormState {
  const { first, last } = splitName(profile.name);
  const parsed = parseInvoiceAddress(profile.invoice_address);
  return {
    first_name: first,
    last_name: last,
    email: profile.email || "",
    phone: profile.phone || "",
    company_name: profile.company || "",
    product_formats: [],
    market_segment: "",
    dose: "",
    nutritional_requirements: [],
    target_sex: [],
    target_age: [],
    other_nutritional_requirements: "",
    dose_per_unit: "",
    actives_requirements: "",
    primary_package_type: "",
    quantity_to_be_quoted: "",
    country_region: parsed.country_region,
    address: parsed.address,
    city: parsed.city,
    postal_code: parsed.postal_code,
    delivery_same_as_proposal: "",
    account_manager_email: defaultAM,
  };
}


// -------------------------------------------------------------------
// Step validation
// -------------------------------------------------------------------


type FieldErrors = Partial<Record<keyof FormState, string>>;


const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;


function validateStep(step: number, state: FormState): FieldErrors {
  const errors: FieldErrors = {};
  if (step === 1) {
    if (!state.first_name.trim()) errors.first_name = "Required";
    if (!state.last_name.trim()) errors.last_name = "Required";
    if (!state.email.trim()) errors.email = "Required";
    else if (!EMAIL_RE.test(state.email.trim()))
      errors.email = "Enter a valid email";
    if (!state.company_name.trim()) errors.company_name = "Required";
  } else if (step === 2) {
    if (state.product_formats.length === 0)
      errors.product_formats = "Pick at least one";
    if (!state.dose.trim()) errors.dose = "Required";
  } else if (step === 5) {
    if (!state.primary_package_type.trim())
      errors.primary_package_type = "Required";
    if (!state.quantity_to_be_quoted.trim())
      errors.quantity_to_be_quoted = "Required";
    else {
      const n = Number(state.quantity_to_be_quoted);
      if (!Number.isFinite(n) || n <= 0)
        errors.quantity_to_be_quoted = "Enter a positive number";
    }
  } else if (step === 6) {
    if (!state.country_region.trim()) errors.country_region = "Required";
    if (!state.address.trim()) errors.address = "Required";
    if (!state.city.trim()) errors.city = "Required";
    if (!state.postal_code.trim()) errors.postal_code = "Required";
  } else if (step === 7) {
    if (!state.account_manager_email.trim())
      errors.account_manager_email = "Required";
  }
  return errors;
}


/** Which step the given field lives on — used to jump the customer
 *  back to the right screen when a 422 fires on submit. Anything
 *  not mapped defaults to step 7 (the submit screen). */
const FIELD_TO_STEP: Partial<Record<keyof FormState, number>> = {
  first_name: 1,
  last_name: 1,
  email: 1,
  phone: 1,
  company_name: 1,
  product_formats: 2,
  market_segment: 2,
  dose: 2,
  nutritional_requirements: 3,
  target_sex: 3,
  target_age: 3,
  other_nutritional_requirements: 3,
  dose_per_unit: 4,
  actives_requirements: 4,
  primary_package_type: 5,
  quantity_to_be_quoted: 5,
  country_region: 6,
  address: 6,
  city: 6,
  postal_code: 6,
  delivery_same_as_proposal: 6,
  account_manager_email: 7,
};


// -------------------------------------------------------------------
// Component
// -------------------------------------------------------------------


export function NewCFFWizard({
  profile,
  salesPeople,
  defaultAccountManagerEmail,
}: {
  profile: ProfileShape;
  salesPeople: ReadonlyArray<SalesPerson>;
  defaultAccountManagerEmail: string;
}) {
  const router = useRouter();
  const draftKey = `${DRAFT_KEY_PREFIX}${profile.customer_id}`;

  const initialState = useMemo(
    () => buildInitialState(profile, defaultAccountManagerEmail),
    [profile, defaultAccountManagerEmail],
  );

  const [state, setState] = useState<FormState>(initialState);
  const [step, setStep] = useState<number>(1);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);

  // Restore draft on mount. Draft wins over prefill so a refresh
  // mid-form doesn't erase edits the customer already made.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(draftKey);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          state?: Partial<FormState>;
          step?: number;
        };
        if (parsed && parsed.state && typeof parsed.state === "object") {
          setState((prev) => ({ ...prev, ...parsed.state }));
        }
        if (typeof parsed.step === "number" && parsed.step >= 1 && parsed.step <= TOTAL_STEPS) {
          setStep(parsed.step);
        }
      }
    } catch {
      // Corrupt draft — ignore, fall back to prefill.
    }
    setDraftLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced draft save. Fires 500ms after the latest edit.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!draftLoaded) return;
    if (typeof window === "undefined") return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try {
        window.localStorage.setItem(
          draftKey,
          JSON.stringify({ state, step }),
        );
      } catch {
        // Quota exceeded or storage disabled — drop silently.
      }
    }, DRAFT_DEBOUNCE_MS);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [state, step, draftLoaded, draftKey]);

  const setField = useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) => {
      setState((prev) => ({ ...prev, [key]: value }));
      // Clear the field's error as soon as they touch it — the
      // next validation run will re-add if still wrong.
      setErrors((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    [],
  );

  const toggleInList = useCallback(
    (key: keyof FormState, value: string) => {
      setState((prev) => {
        const current = prev[key];
        if (!Array.isArray(current)) return prev;
        const arr = current as string[];
        const next = arr.includes(value)
          ? arr.filter((v) => v !== value)
          : [...arr, value];
        return { ...prev, [key]: next };
      });
      setErrors((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    [],
  );

  function goNext() {
    const stepErrors = validateStep(step, state);
    if (Object.keys(stepErrors).length > 0) {
      setErrors(stepErrors);
      return;
    }
    setErrors({});
    setStep((s) => Math.min(s + 1, TOTAL_STEPS));
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
  }

  function goBack() {
    setErrors({});
    setStep((s) => Math.max(s - 1, 1));
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
  }

  async function submit() {
    // Re-validate every gated step so someone jumping to 7 by
    // clicking Next through empty fields can't slip past.
    const combined: FieldErrors = {};
    for (let s = 1; s <= TOTAL_STEPS; s += 1) {
      Object.assign(combined, validateStep(s, state));
    }
    if (Object.keys(combined).length > 0) {
      setErrors(combined);
      // Jump to the first offending step so the customer sees
      // where the missing field lives.
      const firstBadField = Object.keys(combined)[0] as keyof FormState;
      const targetStep = FIELD_TO_STEP[firstBadField] ?? step;
      setStep(targetStep);
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      const payload = {
        first_name: state.first_name.trim(),
        last_name: state.last_name.trim(),
        email: state.email.trim(),
        phone: state.phone.trim(),
        company_name: state.company_name.trim(),
        product_formats: state.product_formats,
        market_segment: state.market_segment.trim(),
        dose: state.dose.trim(),
        nutritional_requirements: state.nutritional_requirements,
        target_sex: state.target_sex,
        target_age: state.target_age,
        other_nutritional_requirements: state.other_nutritional_requirements.trim(),
        dose_per_unit: state.dose_per_unit.trim(),
        actives_requirements: state.actives_requirements.trim(),
        primary_package_type: state.primary_package_type.trim(),
        quantity_to_be_quoted: state.quantity_to_be_quoted.trim(),
        country_region: state.country_region.trim(),
        address: state.address.trim(),
        city: state.city.trim(),
        postal_code: state.postal_code.trim(),
        delivery_same_as_proposal: state.delivery_same_as_proposal,
        account_manager_email: state.account_manager_email.trim(),
      };
      const { data } = await apiClient.post<{ id: string }>(
        "/api/portal/cffs/new/",
        payload,
      );

      // Success — clear draft so a return trip starts fresh.
      try {
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(draftKey);
        }
      } catch {
        // ignore
      }
      const newId = data?.id;
      router.push(
        newId
          ? `/portal/cffs?just_submitted=${encodeURIComponent(newId)}`
          : "/portal/cffs",
      );
    } catch (err: unknown) {
      const api = normalizeApiError(err);
      // 422 backend shape: ``{ error, detail, fields: { field: msg } }``
      const fields = (api.payload?.fields ?? null) as
        | Record<string, string>
        | null;
      if (fields && typeof fields === "object") {
        const nextErrors: FieldErrors = {};
        for (const [k, v] of Object.entries(fields)) {
          if (typeof v === "string") {
            nextErrors[k as keyof FormState] = v;
          }
        }
        setErrors(nextErrors);
        const firstBadField = Object.keys(nextErrors)[0] as
          | keyof FormState
          | undefined;
        if (firstBadField) {
          const targetStep = FIELD_TO_STEP[firstBadField] ?? 7;
          setStep(targetStep);
        }
      }
      const detail =
        (api.payload?.detail as string | undefined) ||
        api.message ||
        "Submission failed. Please try again.";
      setSubmitError(detail);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow={`Step ${step} of ${TOTAL_STEPS}`}
        title="New custom formulation request"
        subtitle="Tell us what you want to make. We'll review your request and get back with a proposal."
        back={{ href: "/portal/cffs", label: "All requests" }}
      />

      <StepIndicator step={step} total={TOTAL_STEPS} />

      {submitError ? (
        <div className="mb-4">
          <ErrorBanner>{submitError}</ErrorBanner>
        </div>
      ) : null}

      <Card as="section">
        {step === 1 ? (
          <Step1
            state={state}
            errors={errors}
            setField={setField}
          />
        ) : null}
        {step === 2 ? (
          <Step2
            state={state}
            errors={errors}
            setField={setField}
            toggleInList={toggleInList}
          />
        ) : null}
        {step === 3 ? (
          <Step3
            state={state}
            errors={errors}
            setField={setField}
            toggleInList={toggleInList}
          />
        ) : null}
        {step === 4 ? (
          <Step4 state={state} errors={errors} setField={setField} />
        ) : null}
        {step === 5 ? (
          <Step5 state={state} errors={errors} setField={setField} />
        ) : null}
        {step === 6 ? (
          <Step6 state={state} errors={errors} setField={setField} />
        ) : null}
        {step === 7 ? (
          <Step7
            state={state}
            errors={errors}
            setField={setField}
            salesPeople={salesPeople}
          />
        ) : null}

        <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t-2 border-black pt-6">
          <div>
            {step > 1 ? (
              <PortalButton
                variant="secondary"
                onClick={goBack}
                disabled={submitting}
                type="button"
              >
                <ChevronLeft className="h-4 w-4" />
                Back
              </PortalButton>
            ) : (
              <span />
            )}
          </div>
          <div>
            {step < TOTAL_STEPS ? (
              <PortalButton onClick={goNext} type="button">
                Next
                <ChevronRight className="h-4 w-4" />
              </PortalButton>
            ) : (
              <PortalButton
                onClick={submit}
                disabled={submitting}
                type="button"
              >
                <Send className="h-4 w-4" />
                {submitting ? "Submitting…" : "Submit request"}
              </PortalButton>
            )}
          </div>
        </div>
      </Card>
    </>
  );
}


// -------------------------------------------------------------------
// Step indicator
// -------------------------------------------------------------------


function StepIndicator({ step, total }: { step: number; total: number }) {
  return (
    <div className="mb-6 flex items-center gap-2">
      {Array.from({ length: total }, (_, i) => i + 1).map((s) => {
        const isActive = s === step;
        const isDone = s < step;
        return (
          <span
            key={s}
            className={`h-2 flex-1 border-2 border-black ${
              isActive
                ? "bg-orange-500"
                : isDone
                  ? "bg-black"
                  : "bg-white"
            }`}
            aria-label={`Step ${s}${isActive ? " (current)" : ""}`}
          />
        );
      })}
    </div>
  );
}


// -------------------------------------------------------------------
// Reusable primitives
// -------------------------------------------------------------------


function CheckboxGroup({
  label,
  options,
  values,
  onToggle,
  error,
  hint,
}: {
  label: string;
  options: ReadonlyArray<string>;
  values: string[];
  onToggle: (value: string) => void;
  error?: string;
  hint?: string;
}) {
  return (
    <div>
      <span className="mb-2 block text-xs font-bold uppercase tracking-widest">
        {label}
      </span>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const active = values.includes(opt);
          return (
            <button
              type="button"
              key={opt}
              onClick={() => onToggle(opt)}
              className={`border-2 border-black px-3 py-2 text-xs font-bold uppercase tracking-widest shadow-[3px_3px_0_#000] transition-transform hover:-translate-x-[1px] hover:-translate-y-[1px] hover:shadow-[4px_4px_0_#000] ${
                active
                  ? "bg-black text-white"
                  : "bg-white text-black"
              }`}
              aria-pressed={active}
            >
              {opt}
            </button>
          );
        })}
      </div>
      {hint && !error ? (
        <span className="mt-2 block text-[11px] text-neutral-600">{hint}</span>
      ) : null}
      {error ? (
        <span className="mt-2 block text-[11px] font-bold uppercase tracking-wide text-red-700">
          {error}
        </span>
      ) : null}
    </div>
  );
}


type StepProps = {
  state: FormState;
  errors: FieldErrors;
  setField: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
};


type StepPropsWithToggle = StepProps & {
  toggleInList: (key: keyof FormState, value: string) => void;
};


// -------------------------------------------------------------------
// Steps
// -------------------------------------------------------------------


function Step1({ state, errors, setField }: StepProps) {
  return (
    <div className="flex flex-col gap-4">
      <H2>General information</H2>
      <div className="grid gap-4 sm:grid-cols-2">
        <PortalInput
          name="first_name"
          label="First name"
          maxLength={200}
          value={state.first_name}
          onChange={(e) => setField("first_name", e.target.value)}
          error={errors.first_name}
          autoComplete="given-name"
        />
        <PortalInput
          name="last_name"
          label="Last name"
          maxLength={200}
          value={state.last_name}
          onChange={(e) => setField("last_name", e.target.value)}
          error={errors.last_name}
          autoComplete="family-name"
        />
        <PortalInput
          name="email"
          type="email"
          label="Email"
          value={state.email}
          onChange={(e) => setField("email", e.target.value)}
          error={errors.email}
          autoComplete="email"
        />
        <PortalInput
          name="phone"
          label="Phone (optional)"
          value={state.phone}
          onChange={(e) => setField("phone", e.target.value)}
          error={errors.phone}
          autoComplete="tel"
        />
        <div className="sm:col-span-2">
          <PortalInput
            name="company_name"
            label="Company"
            maxLength={200}
            value={state.company_name}
            onChange={(e) => setField("company_name", e.target.value)}
            error={errors.company_name}
            autoComplete="organization"
          />
        </div>
      </div>
    </div>
  );
}


function Step2({
  state,
  errors,
  setField,
  toggleInList,
}: StepPropsWithToggle) {
  return (
    <div className="flex flex-col gap-6">
      <H2>Product format &amp; dose</H2>
      <CheckboxGroup
        label="Product format (pick one or more)"
        options={PRODUCT_FORMATS}
        values={state.product_formats}
        onToggle={(v) => toggleInList("product_formats", v)}
        error={errors.product_formats}
      />
      <PortalInput
        name="market_segment"
        label="Market segment (optional)"
        value={state.market_segment}
        onChange={(e) => setField("market_segment", e.target.value)}
        error={errors.market_segment}
        hint="e.g. sports nutrition, women's health, cognitive support…"
      />
      <PortalInput
        name="dose"
        label="Dose"
        value={state.dose}
        onChange={(e) => setField("dose", e.target.value)}
        error={errors.dose}
        hint="e.g. 2 caps/day, 1 scoop/day, 5ml twice daily"
      />
    </div>
  );
}


function Step3({
  state,
  errors,
  setField,
  toggleInList,
}: StepPropsWithToggle) {
  return (
    <div className="flex flex-col gap-6">
      <H2>Nutritional profile &amp; target audience</H2>
      <CheckboxGroup
        label="Nutritional requirements (optional)"
        options={NUTRITIONAL_REQS}
        values={state.nutritional_requirements}
        onToggle={(v) => toggleInList("nutritional_requirements", v)}
        error={errors.nutritional_requirements}
      />
      <CheckboxGroup
        label="Target sex (optional)"
        options={TARGET_SEX}
        values={state.target_sex}
        onToggle={(v) => toggleInList("target_sex", v)}
        error={errors.target_sex}
      />
      <CheckboxGroup
        label="Target age (optional)"
        options={TARGET_AGE}
        values={state.target_age}
        onToggle={(v) => toggleInList("target_age", v)}
        error={errors.target_age}
      />
      <PortalTextarea
        name="other_nutritional_requirements"
        label="Other nutritional requirements (optional)"
        rows={3}
        value={state.other_nutritional_requirements}
        onChange={(e) =>
          setField("other_nutritional_requirements", e.target.value)
        }
        error={errors.other_nutritional_requirements}
      />
    </div>
  );
}


function Step4({ state, errors, setField }: StepProps) {
  return (
    <div className="flex flex-col gap-4">
      <H2>Formulation</H2>
      <PortalInput
        name="dose_per_unit"
        label="Amount of dose per unit (optional)"
        value={state.dose_per_unit}
        onChange={(e) => setField("dose_per_unit", e.target.value)}
        error={errors.dose_per_unit}
        hint="e.g. 500mg per capsule, 10g per scoop"
      />
      <PortalTextarea
        name="actives_requirements"
        label="Actives &amp; requirements (optional)"
        rows={6}
        value={state.actives_requirements}
        onChange={(e) => setField("actives_requirements", e.target.value)}
        error={errors.actives_requirements}
        hint="Please provide as much detail as you can for your actives."
      />
    </div>
  );
}


/**
 * Custom dropdown for the Primary package type field.
 *
 * Built inline instead of using a native ``<select>`` for three
 * reasons that the native control couldn't cover:
 *
 * 1. **Grouped options** — native ``<optgroup>`` styling is
 *    inconsistent across browsers and can't match the neobrutalist
 *    look the portal wizard runs. A rendered list gives us
 *    predictable typography per row + per-group header.
 * 2. **Selected-row visual cue** — a checkmark on the picked row
 *    reads faster than the browser's default highlight, especially
 *    when the customer scrolls back into the menu after landing
 *    on it via draft restore.
 * 3. **Keyboard parity** — Arrow up/down, Home/End, Enter/Space
 *    to select, Escape to close. Type-ahead search bumps focus
 *    to the first row whose label starts with the typed letter,
 *    same feel as a native ``<select>`` on desktop.
 *
 * The panel is absolutely-positioned below the trigger and uses
 * click-outside detection to close so the wizard's overall focus
 * flow doesn't get disturbed.
 */
function PackageTypePicker({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (next: string) => void;
  error?: string;
}) {
  const [open, setOpen] = useState(false);
  // Which flat-index is currently under the keyboard focus ring.
  // Reset to the selected row on open so the initial arrow-down /
  // arrow-up moves from where the customer left off, not from the
  // top. -1 means "no highlight yet".
  const [activeIdx, setActiveIdx] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const typeaheadRef = useRef<{ buffer: string; timer: number | null }>({
    buffer: "",
    timer: null,
  });

  // Flat list keeps keyboard navigation trivial — the grouping is
  // presentational only. ``PACKAGE_TYPES`` was defined above as
  // ``PACKAGE_TYPE_GROUPS.flatMap(...)`` so the two orderings can't
  // diverge.
  const flat = PACKAGE_TYPES;
  const currentIdx = flat.findIndex((t) => t === value);

  // Reset the highlight when the panel opens so arrow-down / up
  // starts from the currently-selected row (or the first one if
  // nothing is selected yet).
  useEffect(() => {
    if (open) setActiveIdx(currentIdx >= 0 ? currentIdx : 0);
  }, [open, currentIdx]);

  // Close on outside click. Bound only while open to keep the
  // event listener count sane.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        panelRef.current &&
        !panelRef.current.contains(t) &&
        triggerRef.current &&
        !triggerRef.current.contains(t)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const commit = (idx: number) => {
    const picked = flat[idx];
    if (picked === undefined) return;
    onChange(picked);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onTriggerKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onPanelKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(flat.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      setActiveIdx(0);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      setActiveIdx(flat.length - 1);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (activeIdx >= 0) commit(activeIdx);
      return;
    }
    // Type-ahead — accumulate letters within a 500ms window and
    // jump to the first row whose label case-insensitively starts
    // with the buffer. Same feel as a native ``<select>``.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const state = typeaheadRef.current;
      state.buffer += e.key.toLowerCase();
      if (state.timer !== null) window.clearTimeout(state.timer);
      state.timer = window.setTimeout(() => {
        state.buffer = "";
        state.timer = null;
      }, 500);
      const match = flat.findIndex((label) =>
        label.toLowerCase().startsWith(state.buffer),
      );
      if (match >= 0) setActiveIdx(match);
    }
  };

  return (
    <div className="block">
      <span
        id="primary_package_type_label"
        className="mb-2 block text-xs font-bold uppercase tracking-widest"
      >
        Primary package type
      </span>
      <div className="relative">
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-labelledby="primary_package_type_label"
          onClick={() => setOpen((v) => !v)}
          onKeyDown={onTriggerKey}
          className="flex w-full items-center justify-between border-2 border-black bg-white px-4 py-3 text-left font-medium text-base text-black focus:outline-none focus:shadow-[4px_4px_0_#000] focus:-translate-x-[1px] focus:-translate-y-[1px] transition-transform duration-100"
        >
          <span className={value ? "" : "text-black/50"}>
            {value || "Select a package…"}
          </span>
          <ChevronDown
            className={`h-4 w-4 shrink-0 transition-transform ${
              open ? "rotate-180" : ""
            }`}
          />
        </button>

        {open ? (
          <div
            ref={panelRef}
            role="listbox"
            aria-labelledby="primary_package_type_label"
            tabIndex={-1}
            onKeyDown={onPanelKey}
            className="absolute left-0 right-0 top-full z-30 mt-1.5 max-h-72 overflow-auto border-2 border-black bg-white shadow-[6px_6px_0_#000] focus:outline-none"
          >
            {PACKAGE_TYPE_GROUPS.map((group) => (
              <div key={group.label}>
                <p className="sticky top-0 border-b border-black/10 bg-neutral-50 px-4 py-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-black/60">
                  {group.label}
                </p>
                {group.items.map((label) => {
                  const idx = flat.indexOf(label);
                  const active = idx === activeIdx;
                  const selected = label === value;
                  return (
                    <button
                      key={label}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onMouseEnter={() => setActiveIdx(idx)}
                      onClick={() => commit(idx)}
                      className={`flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-sm font-medium ${
                        active
                          ? "bg-yellow-200 text-black"
                          : "bg-white text-black hover:bg-neutral-100"
                      }`}
                    >
                      <span>{label}</span>
                      {selected ? (
                        <Check className="h-4 w-4 shrink-0" aria-hidden />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {error ? (
        <span className="mt-1.5 block text-[11px] font-bold uppercase tracking-wide text-red-700">
          {error}
        </span>
      ) : null}
    </div>
  );
}


function Step5({ state, errors, setField }: StepProps) {
  return (
    <div className="flex flex-col gap-4">
      <H2>Packaging</H2>
      <PackageTypePicker
        value={state.primary_package_type}
        onChange={(next) => setField("primary_package_type", next)}
        error={errors.primary_package_type}
      />
      <PortalInput
        name="quantity_to_be_quoted"
        label="Quantity to be quoted"
        inputMode="numeric"
        value={state.quantity_to_be_quoted}
        onChange={(e) => setField("quantity_to_be_quoted", e.target.value)}
        error={errors.quantity_to_be_quoted}
        hint="Number of units. See our MOQs below."
      />
      <div className="border-2 border-black bg-yellow-100 px-4 py-3 text-sm shadow-[3px_3px_0_#000]">
        <p className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Not sure about MOQs?{" "}
            <a
              href="https://www.vitamanufacture.co.uk/moqs-and-leadtimes"
              target="_blank"
              rel="noopener noreferrer"
              className="font-bold underline"
            >
              See our MOQs and lead times.
            </a>
          </span>
        </p>
      </div>
    </div>
  );
}


function Step6({ state, errors, setField }: StepProps) {
  return (
    <div className="flex flex-col gap-4">
      <H2>Delivery address</H2>
      <PortalInput
        name="country_region"
        label="Country / region"
        value={state.country_region}
        onChange={(e) => setField("country_region", e.target.value)}
        error={errors.country_region}
        autoComplete="country-name"
      />
      <PortalInput
        name="address"
        label="Address"
        value={state.address}
        onChange={(e) => setField("address", e.target.value)}
        error={errors.address}
        autoComplete="street-address"
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <PortalInput
          name="city"
          label="City"
          value={state.city}
          onChange={(e) => setField("city", e.target.value)}
          error={errors.city}
          autoComplete="address-level2"
        />
        <PortalInput
          name="postal_code"
          label="Postal code"
          value={state.postal_code}
          onChange={(e) => setField("postal_code", e.target.value)}
          error={errors.postal_code}
          autoComplete="postal-code"
        />
      </div>
      <label htmlFor="delivery_same_as_proposal" className="block">
        <span className="mb-2 block text-xs font-bold uppercase tracking-widest">
          Delivery same as proposal address? (optional)
        </span>
        <select
          id="delivery_same_as_proposal"
          name="delivery_same_as_proposal"
          value={state.delivery_same_as_proposal}
          onChange={(e) =>
            setField("delivery_same_as_proposal", e.target.value)
          }
          className="w-full border-2 border-black bg-white px-4 py-3 font-medium text-base text-black focus:outline-none focus:shadow-[4px_4px_0_#000] focus:-translate-x-[1px] focus:-translate-y-[1px] transition-transform duration-100"
        >
          <option value="">—</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </label>
    </div>
  );
}


function Step7({
  state,
  errors,
  setField,
  salesPeople,
}: StepProps & { salesPeople: ReadonlyArray<SalesPerson> }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return salesPeople;
    return salesPeople.filter(
      (p) =>
        p.full_name.toLowerCase().includes(q) ||
        p.email.toLowerCase().includes(q),
    );
  }, [query, salesPeople]);

  const selectedPerson = salesPeople.find(
    (p) => p.email === state.account_manager_email,
  );

  return (
    <div className="flex flex-col gap-4">
      <H2>Signoff &amp; submit</H2>
      <p className="text-sm text-neutral-700">
        Almost done. Pick your Vita account manager and hit submit. We'll be
        in touch shortly.
      </p>

      <div>
        <Eyebrow>Account manager</Eyebrow>
        <div className="mt-2 flex flex-col gap-2">
          <input
            type="search"
            placeholder="Search by name or email…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full border-2 border-black bg-white px-4 py-3 font-medium text-base text-black placeholder:text-neutral-400 focus:outline-none focus:shadow-[4px_4px_0_#000] focus:-translate-x-[1px] focus:-translate-y-[1px] transition-transform duration-100"
          />
          <div className="max-h-64 overflow-y-auto border-2 border-black">
            {filtered.length === 0 ? (
              <div className="px-4 py-3 text-sm text-neutral-600">
                No matches.
              </div>
            ) : (
              <ul>
                {filtered.map((p) => {
                  const active = p.email === state.account_manager_email;
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => setField("account_manager_email", p.email)}
                        className={`flex w-full items-center justify-between gap-3 border-b border-black/10 px-4 py-2 text-left last:border-b-0 ${
                          active
                            ? "bg-black text-white"
                            : "bg-white hover:bg-neutral-100"
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold">
                            {p.full_name}
                          </p>
                          <p
                            className={`truncate text-[11px] ${
                              active ? "text-neutral-300" : "text-neutral-600"
                            }`}
                          >
                            {p.email}
                          </p>
                        </div>
                        {active ? (
                          <span className="text-[10px] font-bold uppercase tracking-widest">
                            Selected
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {selectedPerson ? (
            <p className="text-[11px] font-bold uppercase tracking-widest text-neutral-700">
              Assigned to: {selectedPerson.full_name} ({selectedPerson.email})
            </p>
          ) : null}
          {errors.account_manager_email ? (
            <span className="text-[11px] font-bold uppercase tracking-wide text-red-700">
              {errors.account_manager_email}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
