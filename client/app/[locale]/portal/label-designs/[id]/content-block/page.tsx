"use client";

import { use, useEffect, useState } from "react";
import {
  Check,
  Copy,
  Download,
  FileImage,
  FileText,
  Loader2,
} from "lucide-react";

import {
  Card,
  Eyebrow,
  PageHeader,
  PortalShell,
} from "@/components/portal/brutalist";
import { env } from "@/config/env";
import { Link } from "@/i18n/navigation";
import {
  usePortalContentBlockJson,
  usePortalContentBlockText,
  usePortalLabelDesign,
} from "@/services/label-design";


const SECTION_TITLES: Record<string, string> = {
  product: "Product",
  serving: "Serving",
  directions: "Directions",
  ingredients: "Ingredients",
  allergen: "Allergens",
  storage: "Storage",
  business: "Business & origin",
};


export default function ContentBlockPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  // We always load the LabelDesign first so we can decide whether to
  // even attempt the content-block fetch — the backend rejects the
  // call when payment is pending OR the design path isn't
  // ``DESIGN_BY_CUSTOMER``, so issuing it in those states would just
  // flash an ugly error.
  const ld = usePortalLabelDesign(id);
  const eligible =
    ld.data?.status !== "payment_pending" &&
    ld.data?.design_path === "design_by_customer";
  const json = usePortalContentBlockJson(id, { enabled: eligible });
  const text = usePortalContentBlockText(id, { enabled: eligible });
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async (key: string, value: string) => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        setCopied(key);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = value;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
        setCopied(key);
      }
    } catch {
      setCopied(null);
    }
  };

  const apiBase = env.NEXT_PUBLIC_API_URL;
  const pdfHref = `${apiBase}/api/portal/label-designs/${id}/content-block/pdf/`;
  const pngHref = `${apiBase}/api/portal/label-designs/${id}/content-block/png/`;

  // Two reasons the customer might land here when they shouldn't:
  // (1) payment still pending, (2) they picked DESIGN_BY_US. In both
  // cases the backend rejects the call — show an explanatory card
  // instead of leaking the rejection as a generic error.
  if (ld.data && !eligible) {
    const projectHref = ld.data.formulation
      ? `/portal/products/${ld.data.formulation}`
      : "/portal/products";
    return (
      <PortalShell active="products">
        <PageHeader
          eyebrow="CONTENT BLOCK"
          title="Not available yet"
          back={{ href: projectHref, label: "Back to project" }}
        />
        <Card>
          <p className="text-sm text-neutral-700">
            {ld.data.status === "payment_pending"
              ? "Payment for this project is still pending. The content block unlocks once our finance team confirms your payment."
              : ld.data.design_path === "design_by_us"
                ? "You chose to have our team design the label, so you don't need the content block — we'll prepare the artwork and share it for your approval. If you'd like to switch to designing it yourself, get in touch and we'll reopen the choice."
                : "Pick a design path first — the content block is only useful when you design the label yourself."}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              href={`/portal/label-designs/${id}`}
              className="inline-flex items-center gap-2 border-2 border-black bg-black px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-white hover:bg-neutral-800"
            >
              Back to label
            </Link>
          </div>
        </Card>
      </PortalShell>
    );
  }

  return (
    <PortalShell active="products">
      <PageHeader
        eyebrow="CONTENT BLOCK"
        title="Required label content"
        subtitle="Every legally-required element derived from your spec sheet. Drop it into your favourite design tool in whichever format fits."
      />

      <Card>
        <Eyebrow>DOWNLOAD</Eyebrow>
        <div className="mt-3 flex flex-wrap gap-2">
          <a
            href={pdfHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 border-2 border-black bg-black px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-white hover:bg-neutral-800"
          >
            <Download className="h-4 w-4" />
            <FileText className="h-4 w-4" />
            PDF (vector)
          </a>
          <a
            href={pngHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 border-2 border-black bg-white px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-black hover:bg-neutral-100"
          >
            <Download className="h-4 w-4" />
            <FileImage className="h-4 w-4" />
            PNG (image)
          </a>
          {text.data?.full ? (
            <button
              type="button"
              onClick={() => copy("__all__", text.data.full)}
              className="inline-flex items-center gap-2 border-2 border-black bg-white px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-black hover:bg-neutral-100"
            >
              {copied === "__all__" ? (
                <Check className="h-4 w-4 text-emerald-600" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
              Copy all text
            </button>
          ) : null}
        </div>
        <p className="mt-3 text-xs text-neutral-500">
          Tip: PDF stays sharp at any size — best for pasting into Canva,
          Illustrator, or Figma. PNG is universal for image-only tools.
        </p>
      </Card>

      <div className="mt-4 grid gap-4">
        {json.isLoading ? (
          <Card>
            <p className="inline-flex items-center gap-2 text-sm text-neutral-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Computing the content block…
            </p>
          </Card>
        ) : json.error ? (
          <Card>
            <p className="text-sm text-red-700">
              Couldn’t derive the content block. Your spec sheet might not be
              attached yet.
            </p>
          </Card>
        ) : json.data ? (
          <Card>
            <Eyebrow>PREVIEW</Eyebrow>
            <div className="mt-3 space-y-3">
              <h3 className="text-xl font-bold">{json.data.product_name}</h3>
              <p className="text-sm text-neutral-600">
                {json.data.product_code}
                {json.data.net_quantity ? ` · ${json.data.net_quantity}` : ""}
              </p>
              {json.data.serving_size || json.data.servings_per_pack ? (
                <p className="text-sm">
                  Serving size: {json.data.serving_size || "—"}
                  <br />
                  Servings per pack: {json.data.servings_per_pack || "—"}
                </p>
              ) : null}
              {json.data.directions_of_use ? (
                <p className="text-sm">
                  <strong>Directions: </strong>
                  {json.data.directions_of_use}
                </p>
              ) : null}
              {json.data.ingredients_list.length > 0 ? (
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.15em]">
                    Ingredients
                  </p>
                  <ul className="mt-1 text-sm">
                    {json.data.ingredients_list.map((ing) => (
                      <li
                        key={`${ing.name}-${ing.qty_label}`}
                        className="border-b border-neutral-200 py-0.5 last:border-0"
                      >
                        {ing.name}
                        {ing.qty_label ? ` — ${ing.qty_label}` : ""}
                        {ing.allergen_flag ? (
                          <span className="ml-2 inline-block bg-amber-200 px-1 text-[10px] font-bold uppercase">
                            allergen
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {json.data.allergen_statement ? (
                <p className="text-sm font-bold">{json.data.allergen_statement}</p>
              ) : null}
              {json.data.storage_conditions ? (
                <p className="text-sm">
                  <strong>Storage: </strong>
                  {json.data.storage_conditions}
                </p>
              ) : null}
              {json.data.business_address ? (
                <p className="whitespace-pre-line text-sm text-neutral-600">
                  {json.data.business_address}
                </p>
              ) : null}
            </div>
          </Card>
        ) : null}

        {text.data?.sections ? (
          <Card>
            <Eyebrow>COPY BY SECTION</Eyebrow>
            <div className="mt-3 space-y-3">
              {Object.entries(text.data.sections).map(([key, value]) => (
                <div key={key} className="border-b border-neutral-200 pb-3 last:border-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-bold uppercase tracking-[0.15em] text-neutral-700">
                      {SECTION_TITLES[key] ?? key}
                    </p>
                    <button
                      type="button"
                      onClick={() => copy(key, value)}
                      className="inline-flex items-center gap-1 text-xs font-bold uppercase tracking-[0.15em] text-neutral-600 hover:text-black"
                    >
                      {copied === key ? (
                        <>
                          <Check className="h-3 w-3 text-emerald-600" /> Copied
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3" /> Copy
                        </>
                      )}
                    </button>
                  </div>
                  <pre className="mt-1 whitespace-pre-wrap font-mono text-xs text-neutral-700">
                    {value}
                  </pre>
                </div>
              ))}
            </div>
          </Card>
        ) : null}
      </div>
    </PortalShell>
  );
}
