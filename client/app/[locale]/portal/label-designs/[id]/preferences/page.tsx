"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  use,
} from "react";
import {
  FileText,
  Image as ImageIcon,
  PenLine,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";

import {
  Card,
  Eyebrow,
  PageHeader,
  PortalShell,
} from "@/components/portal/brutalist";
import { PortalSignatureDialog } from "@/components/portal/portal-signature-dialog";
import { apiClient } from "@/lib/api";
import { ApiError } from "@/lib/api/errors";
import { useRouter } from "@/i18n/navigation";
import {
  usePortalLabelDesign,
  usePortalSubmitPreferences,
} from "@/services/label-design";
import type {
  LabelDesignDto,
  LabelDesignPreferencesDto,
} from "@/services/label-design/types";


type BrandColour = { name: string; hex: string };


interface PortalMe {
  readonly customer_company: string;
  readonly customer_name: string;
  readonly email: string;
}


export default function PreferencesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const submit = usePortalSubmitPreferences(id);

  // Pre-fill: the customer record (company + contact name) comes from
  // ``/api/portal/auth/me/``; the product code + name come from the
  // LabelDesign payload. We seed the form state from these as soon
  // as they load — but only on first load (a ``hydrated`` flag) so
  // the user can still erase / override anything if our data is wrong.
  const ld = usePortalLabelDesign(id);
  const [me, setMe] = useState<PortalMe | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<PortalMe>("/api/portal/auth/me/")
      .then(({ data }) => {
        if (!cancelled) setMe(data);
      })
      .catch(() => {
        // Non-fatal — the form still works, the customer just types
        // their company themselves.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const [companyName, setCompanyName] = useState("");
  const [brandName, setBrandName] = useState("");
  const [productNames, setProductNames] = useState("");
  const [productCodes, setProductCodes] = useState("");
  const [brandColours, setBrandColours] = useState<BrandColour[]>([
    { name: "Primary", hex: "#000000" },
  ]);
  const [inspirationUrls, setInspirationUrls] = useState<string[]>([""]);
  const [elements, setElements] = useState("");
  const [style, setStyle] = useState("");
  const [material, setMaterial] = useState("");
  const [additional, setAdditional] = useState("");
  const [signature, setSignature] = useState("");
  const [signatureOpen, setSignatureOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Per-field validation errors keyed by ``data-field`` markers in
  // the JSX. Empty object = clean form.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Hydrate each source independently — the previous single-effect
  // ``hydrated`` flag flipped to ``true`` the moment ONE source
  // (whichever resolved first) filled its fields, locking out the
  // other source forever. The two effects below each fire when
  // their own data arrives, and the functional ``setState(prev =>
  // prev || …)`` form ensures a value already typed (or already
  // filled by the other source on a prior render) is never
  // overwritten.

  // From ``/api/portal/auth/me/`` — company name only. The customer
  // name + position no longer appear on the form (the auth'd
  // ClientAccount already knows who's signing).
  useEffect(() => {
    if (!me) return;
    setCompanyName((prev) => prev || me.customer_company || "");
  }, [me]);

  // From the portal label-design query — product name + code.
  useEffect(() => {
    if (!ld.data) return;
    setProductNames((prev) => prev || ld.data!.formulation_name || "");
    setProductCodes((prev) => prev || ld.data!.formulation_code || "");
  }, [ld.data]);

  // ---- Validation -----------------------------------------------------
  // Run on submit. Returns a map of field-key → message; empty map
  // = good to go. The form scrolls to the first error and renders a
  // summary so the customer sees what's missing without hunting.
  const HEX_RE = /^#[0-9a-fA-F]{6}$/;
  const URL_RE = /^https?:\/\//i;

  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {};

    if (!brandName.trim()) {
      errs.brand_name = "Brand name is required.";
    }

    const validColours = brandColours.filter(
      (c) => c.name.trim() && HEX_RE.test(c.hex.trim()),
    );
    if (validColours.length === 0) {
      errs.brand_colours =
        "Add at least one brand colour with a name and a valid hex (e.g. #ff7a18).";
    } else {
      // Surface partial entries the user started but didn't finish —
      // a colour with a name but no hex is the most common mistake.
      const partial = brandColours.find(
        (c) =>
          (c.name.trim() || c.hex.trim()) &&
          !(c.name.trim() && HEX_RE.test(c.hex.trim())),
      );
      if (partial) {
        errs.brand_colours =
          "Each colour needs both a name and a valid 6-digit hex (e.g. #ff7a18) — fix or remove the partial row.";
      }
    }

    const urls = inspirationUrls
      .map((u) => u.trim())
      .filter((u) => u.length > 0);
    const badUrl = urls.find((u) => !URL_RE.test(u));
    if (badUrl) {
      errs.inspiration_urls =
        "URLs must start with http:// or https://";
    }
    if (urls.length === 0 && files.length === 0) {
      errs.inspiration =
        "Share at least one inspirational example — a URL, a file, or both.";
    }

    if (!elements.trim()) {
      errs.elements_to_include =
        "Tell us at least one element to include (icons, certifications, imagery).";
    }
    if (!style) {
      errs.design_style = "Pick a design style.";
    }
    if (!material) {
      errs.material_type = "Pick a material type.";
    }
    if (!signature.trim()) {
      errs.signature = "Sign to confirm the brief.";
    }
    return errs;
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const errs = validate();
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      // Bring the first error into view so the user doesn't have to
      // scroll up to find what they missed.
      requestAnimationFrame(() => {
        const firstKey = Object.keys(errs)[0];
        const el = firstKey
          ? document.querySelector(`[data-field="${firstKey}"]`)
          : null;
        (el ?? document.querySelector("[data-error-summary]"))?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      });
      return;
    }
    try {
      await submit.mutateAsync({
        body: {
          company_name: companyName,
          brand_name: brandName,
          product_names: productNames,
          product_codes: productCodes,
          brand_colours: brandColours.filter(
            (c) => c.name.trim() && HEX_RE.test(c.hex.trim()),
          ),
          inspiration_urls: inspirationUrls
            .map((u) => u.trim())
            .filter((u) => u.length > 0),
          elements_to_include: elements,
          design_style: style,
          material_type: material,
          additional_comments: additional,
          // Customer name + position no longer asked here — we
          // already know the authenticated client account; the
          // backend can stamp those from ``request.user`` if it
          // needs them for the declaration audit.
          declaration_signature_image: signature,
        },
        inspirationFiles: files,
      });
      router.replace(`/portal/label-designs/${id}`);
    } catch (e) {
      const { message, fieldErrors: backendErrs } = formatPreferencesError(e);
      // Merge backend field errors with the client-side ones we already
      // surfaced, but let the backend take precedence — its view of the
      // payload is the source of truth.
      setFieldErrors((prev) => ({ ...prev, ...backendErrs }));
      setError(message);
      // Scroll to the first backend field that doesn't already have a
      // marker rendered — otherwise the summary banner.
      requestAnimationFrame(() => {
        const firstKey = Object.keys(backendErrs)[0];
        const el = firstKey
          ? document.querySelector(`[data-field="${firstKey}"]`)
          : null;
        (el ?? document.querySelector("[data-error-summary]"))?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      });
    }
  };

  const projectHref = ld.data?.formulation
    ? `/portal/products/${ld.data.formulation}`
    : "/portal/products";

  // The brief is single-shot: once the customer has submitted the
  // preferences (or the workflow has already moved past the
  // preferences step) we render a read-only summary instead of the
  // editable form. Lets the customer re-read what they sent without
  // accidentally re-submitting — and matches the backend which
  // rejects a second submit anyway (status guard in
  // ``PortalLabelDesignPreferencesView``).
  const submittedPrefs = ld.data?.preferences_detail ?? null;
  const isLocked =
    submittedPrefs !== null ||
    (ld.data !== undefined &&
      ld.data?.status !== "design_preferences_pending" &&
      ld.data?.status !== "payment_pending" &&
      ld.data?.status !== "label_path_pending");

  if (ld.data && isLocked) {
    return (
      <PortalShell active="products">
        <PageHeader
          eyebrow="LABEL BRIEF"
          title="Your design preferences"
          subtitle="Already submitted — here's a copy of what you shared. Need to tweak something? Drop us a message and we'll reopen the brief."
          back={{ href: projectHref, label: "Back to project" }}
        />
        <SubmittedPreferencesView preferences={submittedPrefs} ld={ld.data} />
      </PortalShell>
    );
  }

  return (
    <PortalShell active="products">
      <PageHeader
        eyebrow="LABEL BRIEF"
        title="Design preferences"
        subtitle="Share what matters — we’ll use this to draft the label. Fields marked * are required."
        back={{ href: projectHref, label: "Back to project" }}
      />

      {Object.keys(fieldErrors).length > 0 ? (
        <div
          data-error-summary
          role="alert"
          className="mb-4 border-2 border-red-500 bg-red-50 p-3 text-sm text-red-800"
        >
          <p className="font-bold uppercase tracking-[0.18em]">
            Fix the {Object.keys(fieldErrors).length} item
            {Object.keys(fieldErrors).length > 1 ? "s" : ""} below
          </p>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {Object.entries(fieldErrors).map(([key, msg]) => (
              <li key={key}>{msg}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <form onSubmit={onSubmit} className="space-y-6">
        <Card>
          <Eyebrow>COMPANY INFO</Eyebrow>
          <p className="mt-1 text-[11px] text-neutral-500">
            Company, product and code are pulled from your account and the
            project — if anything looks wrong, drop us a note in the
            additional-comments section below. Brand is yours to choose.
          </p>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            <ReadOnlyField label="Company" value={companyName} />
            <ReadOnlyField label="Product" value={productNames} />
            <ReadOnlyField label="Product code" value={productCodes} />
          </dl>
          <div className="mt-3" data-field="brand_name">
            <Field
              label="Brand name (as it appears on the label)"
              required
              value={brandName}
              onChange={setBrandName}
            />
            <p className="mt-1 text-[11px] text-neutral-500">
              Often the same as your company name — change it if your
              product trades under a different brand.
            </p>
            {fieldErrors.brand_name ? (
              <p className="mt-1 text-[11px] font-medium text-red-700">
                {fieldErrors.brand_name}
              </p>
            ) : null}
          </div>
        </Card>

        <Card>
          <Eyebrow>DESIGN</Eyebrow>

          <div className="mt-3" data-field="brand_colours">
            <p className="text-xs font-bold uppercase tracking-[0.15em] text-neutral-700">
              Brand colours <span className="text-red-600">*</span>
            </p>
            <p className="mt-1 text-[11px] text-neutral-500">
              At least one — use the swatch to pick visually, or paste a hex
              code (e.g. <span className="font-mono">#ff7a18</span>). Each
              row needs both a name and a valid hex.
            </p>
            <div className="mt-2 space-y-2">
              {brandColours.map((c, idx) => (
                <BrandColourRow
                  key={idx}
                  colour={c}
                  onChange={(next) => {
                    const arr = [...brandColours];
                    arr[idx] = next;
                    setBrandColours(arr);
                  }}
                  onRemove={() =>
                    setBrandColours(brandColours.filter((_, i) => i !== idx))
                  }
                />
              ))}
              <button
                type="button"
                onClick={() =>
                  setBrandColours([
                    ...brandColours,
                    { name: "", hex: "#000000" },
                  ])
                }
                className="inline-flex items-center gap-1 border-2 border-black px-3 py-1.5 text-xs font-bold uppercase tracking-[0.15em]"
              >
                <Plus className="h-3 w-3" /> Add colour
              </button>
            </div>
          </div>

          {fieldErrors.brand_colours ? (
            <p className="mt-1 text-[11px] font-medium text-red-700">
              {fieldErrors.brand_colours}
            </p>
          ) : null}

          <div className="mt-4" data-field="inspiration_urls">
            <p className="text-xs font-bold uppercase tracking-[0.15em] text-neutral-700">
              Inspirational examples — URLs
            </p>
            <p className="mt-1 text-[11px] text-neutral-500">
              Required if you don&apos;t attach files below. Start with
              <span className="font-mono"> http://</span> or
              <span className="font-mono"> https://</span>.
            </p>
            <div className="mt-2 space-y-2">
              {inspirationUrls.map((u, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <input
                    type="url"
                    placeholder="https://…"
                    value={u}
                    onChange={(e) => {
                      const next = [...inspirationUrls];
                      next[idx] = e.target.value;
                      setInspirationUrls(next);
                    }}
                    className="flex-1 border-2 border-black px-2 py-1.5 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setInspirationUrls(
                        inspirationUrls.filter((_, i) => i !== idx),
                      )
                    }
                    aria-label="Remove URL"
                    className="border-2 border-black p-1.5 hover:bg-red-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setInspirationUrls([...inspirationUrls, ""])}
                className="inline-flex items-center gap-1 border-2 border-black px-3 py-1.5 text-xs font-bold uppercase tracking-[0.15em]"
              >
                <Plus className="h-3 w-3" /> Add URL
              </button>
            </div>
            {fieldErrors.inspiration_urls ? (
              <p className="mt-1 text-[11px] font-medium text-red-700">
                {fieldErrors.inspiration_urls}
              </p>
            ) : null}
          </div>

          <div className="mt-4" data-field="inspiration">
            <p className="text-xs font-bold uppercase tracking-[0.15em] text-neutral-700">
              Inspirational examples — files{" "}
              <span className="text-red-600">*</span>
            </p>
            <p className="mt-1 text-[11px] text-neutral-500">
              Share at least one example overall — either a URL above or a
              file here (or both).
            </p>
            <div className="mt-2">
              <FileDropzone files={files} onFilesChange={setFiles} />
            </div>
            {fieldErrors.inspiration ? (
              <p className="mt-1 text-[11px] font-medium text-red-700">
                {fieldErrors.inspiration}
              </p>
            ) : null}
          </div>

          <div data-field="elements_to_include">
            <TextArea
              label="Specific elements to include (icons, imagery, certifications)"
              required
              value={elements}
              onChange={setElements}
            />
            {fieldErrors.elements_to_include ? (
              <p className="mt-1 text-[11px] font-medium text-red-700">
                {fieldErrors.elements_to_include}
              </p>
            ) : null}
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div data-field="design_style">
              <SelectField
                label="Design style"
                required
                value={style}
                onChange={setStyle}
                options={[
                  { value: "", label: "Choose…" },
                  { value: "modern", label: "Modern" },
                  { value: "minimalist", label: "Minimalist" },
                  { value: "bold", label: "Bold" },
                  { value: "luxury", label: "Luxury" },
                ]}
              />
              {fieldErrors.design_style ? (
                <p className="mt-1 text-[11px] font-medium text-red-700">
                  {fieldErrors.design_style}
                </p>
              ) : null}
            </div>
            <div data-field="material_type">
              <SelectField
                label="Material type"
                required
                value={material}
                onChange={setMaterial}
                options={[
                  { value: "", label: "Choose…" },
                  { value: "matte", label: "Matte" },
                  { value: "glossy", label: "Glossy" },
                ]}
              />
              {fieldErrors.material_type ? (
                <p className="mt-1 text-[11px] font-medium text-red-700">
                  {fieldErrors.material_type}
                </p>
              ) : null}
            </div>
          </div>
        </Card>

        <Card>
          <Eyebrow>OTHERS</Eyebrow>
          <TextArea
            label="Additional comments (optional)"
            value={additional}
            onChange={setAdditional}
          />
        </Card>

        <Card>
          <Eyebrow>DECLARATION & SIGNATURE</Eyebrow>
          <p className="mt-2 text-sm text-neutral-700">
            By signing below, I confirm that the information provided is
            accurate and understand that revisions beyond the agreed scope
            may incur additional costs. You&apos;re signed in as the customer
            of record — no need to re-type your name.
          </p>
          <div className="mt-4" data-field="signature">
            <p className="text-xs font-bold uppercase tracking-[0.15em] text-neutral-700">
              Signature <span className="text-red-600">*</span>
            </p>
            <p className="mt-1 text-[11px] text-neutral-500">
              Draw with your mouse, finger or stylus — same as signing on
              paper.
            </p>
            <div className="mt-2 border-2 border-black bg-paper p-3">
              {signature ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  alt="Your signature"
                  src={signature}
                  className="block max-h-32 w-auto bg-white"
                />
              ) : (
                <p className="px-2 py-6 text-center text-xs uppercase tracking-[0.18em] text-neutral-500">
                  Not signed yet
                </p>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setSignatureOpen(true)}
                className="inline-flex items-center gap-1 border-2 border-black bg-black px-3 py-1.5 text-xs font-bold uppercase tracking-[0.18em] text-white hover:bg-neutral-800"
              >
                <PenLine className="h-3.5 w-3.5" />
                {signature ? "Re-sign" : "Sign here"}
              </button>
              {signature ? (
                <button
                  type="button"
                  onClick={() => setSignature("")}
                  className="inline-flex items-center gap-1 border-2 border-black bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-[0.18em] text-black hover:bg-neutral-100"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Clear
                </button>
              ) : null}
            </div>
            {fieldErrors.signature ? (
              <p className="mt-1 text-[11px] font-medium text-red-700">
                {fieldErrors.signature}
              </p>
            ) : null}
          </div>
        </Card>

        {error ? (
          <div className="border-2 border-red-500 bg-red-50 p-3 text-sm text-red-800">
            <p className="font-bold uppercase tracking-[0.18em]">
              Couldn&apos;t submit
            </p>
            <p className="mt-1">{error}</p>
          </div>
        ) : null}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={submit.isPending}
            className="border-2 border-black bg-black px-5 py-2 text-sm font-bold uppercase tracking-[0.18em] text-white hover:bg-neutral-800 disabled:opacity-50"
          >
            {submit.isPending ? "Submitting…" : "Submit brief"}
          </button>
        </div>
      </form>

      <PortalSignatureDialog
        isOpen={signatureOpen}
        onOpenChange={(open) => setSignatureOpen(open)}
        title="Sign your brief"
        subtitle="By signing, you confirm the information above is accurate."
        confirmLabel="Save signature"
        onConfirm={async (dataUrl) => {
          setSignature(dataUrl);
          setSignatureOpen(false);
        }}
      />
    </PortalShell>
  );
}


// ---------------------------------------------------------------------------
// Error formatting — map ApiError.fieldErrors into both a human top-line
// message and a per-field map keyed by ``data-field`` so the inline error
// renders next to the relevant input.
// ---------------------------------------------------------------------------


const FIELD_LABEL: Record<string, string> = {
  company_name: "Company",
  brand_name: "Brand name",
  product_names: "Product",
  product_codes: "Product code",
  brand_colours: "Brand colours",
  inspiration_urls: "Inspirational URLs",
  inspiration_files: "Inspirational files",
  elements_to_include: "Specific elements to include",
  design_style: "Design style",
  material_type: "Material type",
  additional_comments: "Additional comments",
  declaration_signature_image: "Signature",
};


// DRF / our app's documented error codes that show up on this form,
// mapped to plain-English copy the customer can act on.
const CODE_MESSAGE: Record<string, string> = {
  blank: "is required.",
  required: "is required.",
  null: "is required.",
  invalid: "is not in the expected format.",
  invalid_choice: "choose one of the listed options.",
  invalid_json: "couldn't be read — please re-add the items.",
  max_length: "is too long.",
  min_length: "is too short.",
  not_a_list: "should be a list — please re-add the items.",
  empty: "needs at least one entry.",
  too_many_files: "you've attached too many files.",
  file_type_not_allowed: "one of the files has an unsupported type.",
  file_too_large: "one of the files is over the per-file size limit.",
  batch_too_large: "the files together exceed the total size limit.",
};


function humanizeCode(field: string, code: string): string {
  const label = FIELD_LABEL[field] ?? field.replace(/_/g, " ");
  const explain = CODE_MESSAGE[code] ?? `is invalid (${code}).`;
  return `${label} ${explain}`;
}


function formatPreferencesError(e: unknown): {
  message: string;
  fieldErrors: Record<string, string>;
} {
  if (e instanceof ApiError) {
    const fieldErrors: Record<string, string> = {};
    for (const [field, codes] of Object.entries(e.fieldErrors)) {
      if (Array.isArray(codes)) {
        // Most common shape: ``{"brand_colours": ["not_a_list"]}``.
        const first = codes[0] ?? "invalid";
        fieldErrors[field] = humanizeCode(field, first);
      } else if (codes && typeof codes === "object") {
        // Nested DRF errors. Flatten into one readable line so the
        // customer sees something useful even if we don't have a
        // dedicated UI for the sub-field.
        const parts: string[] = [];
        for (const [sub, subCodes] of Object.entries(codes)) {
          const c = Array.isArray(subCodes) ? subCodes[0] : String(subCodes);
          parts.push(`${sub}: ${humanizeCode(field, String(c))}`);
        }
        fieldErrors[field] = parts.join(" ");
      }
    }
    const detail =
      typeof e.payload?.detail === "string" && e.payload.detail
        ? e.payload.detail
        : null;
    const summary =
      Object.values(fieldErrors)[0] ??
      detail ??
      e.message ??
      "Could not submit your preferences.";
    return { message: summary, fieldErrors };
  }
  return {
    message: "Could not submit your preferences. Please try again.",
    fieldErrors: {},
  };
}


// ---------------------------------------------------------------------------
// Read-only summary rendered when the brief has already been
// submitted. Kept loose on the type for ``preferences`` because the
// backend may legitimately return ``null`` between the workflow
// moving on and the preferences row being archived.
// ---------------------------------------------------------------------------


function SubmittedPreferencesView({
  preferences,
  ld,
}: {
  preferences: LabelDesignPreferencesDto | null;
  ld: LabelDesignDto;
}) {
  if (!preferences) {
    return (
      <Card>
        <p className="text-sm text-neutral-700">
          Your brief is locked in and we&apos;re working on it. We&apos;ll
          share the first draft for your approval shortly.
        </p>
      </Card>
    );
  }
  const submittedAt = preferences.submitted_at
    ? new Date(preferences.submitted_at).toLocaleString()
    : null;
  return (
    <div className="space-y-4">
      <Card>
        <Eyebrow>SUBMITTED</Eyebrow>
        <p className="mt-1 text-sm text-neutral-700">
          You submitted this brief{submittedAt ? ` on ${submittedAt}` : ""}.
        </p>
        <p className="mt-1 text-xs text-neutral-500">
          Status: {ld.status.replaceAll("_", " ")}.
        </p>
      </Card>

      <Card>
        <Eyebrow>COMPANY INFO</Eyebrow>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <ReadOnlyField label="Company" value={preferences.company_name} />
          <ReadOnlyField label="Brand" value={preferences.brand_name} />
          <ReadOnlyField label="Product" value={preferences.product_names} />
          <ReadOnlyField
            label="Product code"
            value={preferences.product_codes}
          />
        </dl>
      </Card>

      <Card>
        <Eyebrow>BRAND COLOURS</Eyebrow>
        {preferences.brand_colours.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">—</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {preferences.brand_colours.map((c, idx) => (
              <li
                key={`${c.name}-${c.hex}-${idx}`}
                className="flex items-center gap-3"
              >
                <span
                  aria-hidden
                  className="h-6 w-6 border-2 border-black"
                  style={{ backgroundColor: c.hex }}
                />
                <span className="text-sm">
                  {c.name || "—"}
                  <span className="ml-2 font-mono text-xs uppercase text-neutral-500">
                    {c.hex}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <Eyebrow>INSPIRATION</Eyebrow>
        {preferences.inspiration_urls.length > 0 ? (
          <div className="mt-2">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-neutral-500">
              Links
            </p>
            <ul className="mt-1 space-y-1">
              {preferences.inspiration_urls.map((u) => (
                <li key={u} className="text-sm">
                  <a
                    href={u}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2"
                  >
                    {u}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {preferences.inspiration_file_urls.length > 0 ? (
          <div className="mt-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-neutral-500">
              Files
            </p>
            <ul className="mt-1 space-y-1">
              {preferences.inspiration_file_urls.map((f) => (
                <li key={f.id} className="text-sm">
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2"
                  >
                    {f.original_name}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {preferences.inspiration_urls.length === 0 &&
        preferences.inspiration_file_urls.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">—</p>
        ) : null}
      </Card>

      <Card>
        <Eyebrow>DESIGN</Eyebrow>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <ReadOnlyField
            label="Design style"
            value={preferences.design_style || "—"}
          />
          <ReadOnlyField
            label="Material type"
            value={preferences.material_type || "—"}
          />
        </dl>
        <div className="mt-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-neutral-500">
            Specific elements to include
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-neutral-800">
            {preferences.elements_to_include || "—"}
          </p>
        </div>
      </Card>

      {preferences.additional_comments ? (
        <Card>
          <Eyebrow>OTHERS</Eyebrow>
          <p className="mt-2 whitespace-pre-wrap text-sm text-neutral-800">
            {preferences.additional_comments}
          </p>
        </Card>
      ) : null}

      {preferences.declaration_signature_image ? (
        <Card>
          <Eyebrow>SIGNATURE</Eyebrow>
          <div className="mt-2 border-2 border-black bg-paper p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              alt="Your signature"
              src={preferences.declaration_signature_image}
              className="block max-h-32 w-auto bg-white"
            />
          </div>
        </Card>
      ) : null}
    </div>
  );
}


function Field({
  label,
  value,
  onChange,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
}) {
  return (
    <div>
      <label className="text-xs font-bold uppercase tracking-[0.15em] text-neutral-700">
        {label} {required ? <span className="text-red-600">*</span> : null}
      </label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full border-2 border-black px-2 py-1.5 text-sm"
      />
    </div>
  );
}


/**
 * Read-only display of a field that's already known from the
 * customer / project record. Renders as a definition-list pair —
 * label above, value below — with a muted background to signal
 * "this is reference, not input". The value still travels through
 * to the submitted payload via the underlying state, the customer
 * just can't edit it here.
 */
function ReadOnlyField({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div>
      <dt className="text-[10px] font-bold uppercase tracking-[0.18em] text-neutral-500">
        {label}
      </dt>
      <dd className="mt-1 border-2 border-dashed border-neutral-300 bg-neutral-50 px-2 py-1.5 text-sm font-medium text-black">
        {value || <span className="text-neutral-400">—</span>}
      </dd>
    </div>
  );
}


function TextArea({
  label,
  value,
  onChange,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
}) {
  return (
    <div className="mt-3">
      <label className="text-xs font-bold uppercase tracking-[0.15em] text-neutral-700">
        {label} {required ? <span className="text-red-600">*</span> : null}
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="mt-1 w-full border-2 border-black px-2 py-1.5 text-sm"
      />
    </div>
  );
}


function SelectField({
  label,
  value,
  onChange,
  options,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  required?: boolean;
}) {
  return (
    <div>
      <label className="text-xs font-bold uppercase tracking-[0.15em] text-neutral-700">
        {label} {required ? <span className="text-red-600">*</span> : null}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full border-2 border-black bg-white px-2 py-1.5 text-sm"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}


/**
 * One row in the brand-colours editor.
 *
 * Lets the customer either pick a colour visually (native
 * ``<input type="color">``) or paste / type a hex code — the two
 * inputs are wired to the same value so editing either updates the
 * other. The swatch on the left is a click target for the colour
 * picker on Safari (which doesn't render its own swatch chrome).
 */
function BrandColourRow({
  colour,
  onChange,
  onRemove,
}: {
  colour: BrandColour;
  onChange: (next: BrandColour) => void;
  onRemove: () => void;
}) {
  // Validate the hex on every render so the colour-picker only
  // receives a value it can actually accept (it ignores anything
  // that isn't a valid 7-char ``#rrggbb``).
  const safeHex = /^#[0-9a-fA-F]{6}$/.test(colour.hex)
    ? colour.hex
    : "#000000";
  return (
    <div className="flex items-center gap-2">
      <label className="relative inline-block h-9 w-9 shrink-0 cursor-pointer border-2 border-black">
        <span
          aria-hidden
          className="block h-full w-full"
          style={{ backgroundColor: safeHex }}
        />
        <input
          aria-label={`Pick colour for ${colour.name || "this swatch"}`}
          type="color"
          value={safeHex}
          onChange={(e) => onChange({ ...colour, hex: e.target.value })}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>
      <input
        aria-label="Colour name"
        placeholder="Primary"
        value={colour.name}
        onChange={(e) => onChange({ ...colour, name: e.target.value })}
        className="flex-1 border-2 border-black px-2 py-1.5 text-sm"
      />
      <input
        aria-label="Hex code"
        placeholder="#000000"
        value={colour.hex}
        onChange={(e) => onChange({ ...colour, hex: e.target.value })}
        className="w-28 border-2 border-black px-2 py-1.5 font-mono text-sm uppercase"
      />
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove colour"
        className="border-2 border-black p-1.5 hover:bg-red-50"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}


// ---------------------------------------------------------------------------
// FileDropzone — inspiration file picker
// ---------------------------------------------------------------------------


/**
 * Click-to-browse + drag-and-drop file picker for the inspiration
 * section. Validation is FE-only for now (DRF re-validates on
 * submit if the limits are ever exceeded via a direct API call).
 *
 * Constraints:
 *
 * * **Allowed types**: JPEG / PNG / GIF / WebP / HEIC images + PDF.
 *   Anything else is rejected with an inline error and skipped from
 *   the batch — partial adds are fine so the user doesn't lose the
 *   files they DID pick correctly.
 * * **Per-file cap**: 10 MB. Anything larger is rejected with the
 *   file name in the error so the user can see which one tripped.
 * * **Batch caps**: max 10 files total, max 50 MB total. Once any
 *   cap is hit the picker disables the "Add more files" button.
 *
 * Picking from the OS dialog or dropping files both go through the
 * same ``addCandidates`` path so validation + the "skip duplicates"
 * de-dupe are applied consistently.
 */


const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

const ACCEPT_ATTR = "image/jpeg,image/png,image/gif,image/webp,image/heic,application/pdf";

const MAX_FILE_BYTES = 10 * 1024 * 1024; //  10 MB per file
const MAX_TOTAL_BYTES = 50 * 1024 * 1024; //  50 MB across the batch
const MAX_FILES = 10;


function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}


function FileDropzone({
  files,
  onFilesChange,
}: {
  files: File[];
  onFilesChange: (next: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  // Image previews — created on demand via ``URL.createObjectURL``
  // and revoked when the file leaves the list to avoid blob leaks.
  // Keyed by file identity (name + size + lastModified) so two
  // re-renders of the same selection don't churn URLs.
  const previewByKey = useRef<Map<string, string>>(new Map());
  const fileKey = (f: File) => `${f.name}__${f.size}__${f.lastModified}`;
  useEffect(() => {
    const seen = new Set(files.map(fileKey));
    for (const [key, url] of previewByKey.current.entries()) {
      if (!seen.has(key)) {
        URL.revokeObjectURL(url);
        previewByKey.current.delete(key);
      }
    }
  }, [files]);
  const previewFor = (f: File): string | null => {
    if (!f.type.startsWith("image/")) return null;
    const key = fileKey(f);
    const existing = previewByKey.current.get(key);
    if (existing) return existing;
    const url = URL.createObjectURL(f);
    previewByKey.current.set(key, url);
    return url;
  };

  const totalBytes = useMemo(
    () => files.reduce((sum, f) => sum + f.size, 0),
    [files],
  );
  const atFileCap = files.length >= MAX_FILES;
  const atSizeCap = totalBytes >= MAX_TOTAL_BYTES;
  const disabled = atFileCap || atSizeCap;

  const addCandidates = useCallback(
    (incoming: ReadonlyArray<File>) => {
      const errs: string[] = [];
      const existingKeys = new Set(files.map(fileKey));
      const accepted: File[] = [...files];
      let runningTotal = totalBytes;

      for (const f of incoming) {
        if (!ALLOWED_MIME.has(f.type)) {
          errs.push(
            `${f.name} — file type not supported (use JPG, PNG, GIF, WebP, HEIC, or PDF).`,
          );
          continue;
        }
        if (f.size > MAX_FILE_BYTES) {
          errs.push(
            `${f.name} — too large (${formatBytes(f.size)} · max ${formatBytes(MAX_FILE_BYTES)} per file).`,
          );
          continue;
        }
        if (accepted.length >= MAX_FILES) {
          errs.push(
            `Reached the ${MAX_FILES}-file limit — skipped ${f.name}.`,
          );
          continue;
        }
        if (runningTotal + f.size > MAX_TOTAL_BYTES) {
          errs.push(
            `${f.name} — would exceed the ${formatBytes(MAX_TOTAL_BYTES)} batch limit.`,
          );
          continue;
        }
        const key = fileKey(f);
        if (existingKeys.has(key)) {
          // Silent skip — user re-selecting the same file is common
          // and not an error.
          continue;
        }
        existingKeys.add(key);
        accepted.push(f);
        runningTotal += f.size;
      }

      onFilesChange(accepted);
      setErrors(errs);
    },
    [files, onFilesChange, totalBytes],
  );

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    addCandidates(Array.from(e.target.files));
    // Reset the input so picking the same file again still fires an
    // onChange (browsers gate that by default).
    if (inputRef.current) inputRef.current.value = "";
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (!e.dataTransfer.files) return;
    addCandidates(Array.from(e.dataTransfer.files));
  };

  const removeAt = (idx: number) => {
    const next = files.filter((_, i) => i !== idx);
    onFilesChange(next);
  };

  return (
    <div>
      <p className="text-xs font-bold uppercase tracking-[0.15em] text-neutral-700">
        Inspirational examples (files)
      </p>
      <p className="mt-1 text-[11px] text-neutral-500">
        Drop or click to add up to {MAX_FILES} files. JPG, PNG, GIF, WebP,
        HEIC, or PDF. Max {formatBytes(MAX_FILE_BYTES)} per file,{" "}
        {formatBytes(MAX_TOTAL_BYTES)} total.
      </p>

      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          if (!disabled) inputRef.current?.click();
        }}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        aria-disabled={disabled}
        className={`mt-2 flex flex-col items-center justify-center gap-1 border-2 border-dashed p-6 text-center text-sm transition-colors ${
          disabled
            ? "cursor-not-allowed border-neutral-300 bg-neutral-50 text-neutral-400"
            : dragOver
              ? "cursor-copy border-orange-500 bg-orange-50 text-black"
              : "cursor-pointer border-black bg-paper text-black hover:bg-neutral-50"
        }`}
      >
        <Upload className="h-5 w-5" aria-hidden />
        <p className="font-bold">
          {disabled
            ? "Limit reached — remove a file to add more"
            : dragOver
              ? "Drop to add"
              : "Click to browse or drop files here"}
        </p>
        <p className="text-[11px] text-neutral-500">
          {files.length} of {MAX_FILES} files · {formatBytes(totalBytes)} of{" "}
          {formatBytes(MAX_TOTAL_BYTES)}
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT_ATTR}
          onChange={onInputChange}
          className="hidden"
        />
      </div>

      {errors.length > 0 ? (
        <ul
          role="alert"
          className="mt-2 space-y-1 border-2 border-red-300 bg-red-50 p-3 text-[11px] text-red-700"
        >
          {errors.map((msg, i) => (
            <li key={`${msg}-${i}`}>• {msg}</li>
          ))}
        </ul>
      ) : null}

      {files.length > 0 ? (
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {files.map((f, idx) => (
            <li
              key={fileKey(f)}
              className="flex items-center gap-3 border-2 border-black bg-white p-2"
            >
              <FilePreview file={f} previewUrl={previewFor(f)} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-bold">{f.name}</p>
                <p className="text-[10px] uppercase tracking-widest text-neutral-500">
                  {formatBytes(f.size)} · {f.type || "unknown"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => removeAt(idx)}
                aria-label={`Remove ${f.name}`}
                className="shrink-0 border-2 border-black p-1.5 hover:bg-red-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}


function FilePreview({
  file,
  previewUrl,
}: {
  file: File;
  previewUrl: string | null;
}) {
  if (previewUrl) {
    return (
      /* eslint-disable-next-line @next/next/no-img-element */
      <img
        src={previewUrl}
        alt={file.name}
        className="h-12 w-12 shrink-0 border border-black object-cover"
      />
    );
  }
  const Icon = file.type === "application/pdf" ? FileText : ImageIcon;
  return (
    <span className="flex h-12 w-12 shrink-0 items-center justify-center border-2 border-black bg-neutral-100">
      <Icon className="h-5 w-5 text-neutral-700" aria-hidden />
    </span>
  );
}
