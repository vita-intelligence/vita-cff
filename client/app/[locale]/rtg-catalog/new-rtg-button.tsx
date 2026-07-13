"use client";

/**
 * "New RTG product" affordance on the RTG Catalog hub page.
 *
 * Opens a minimal dialog collecting only the two required fields
 * to create a ``Formulation`` — internal name + code. Everything
 * else takes model defaults (dosage_form=capsule, project_status=
 * concept, etc.), and the crucial ``project_type='ready_to_go'`` is
 * baked in so the new row lands with the marketing panel already
 * visible on its project overview page.
 *
 * On success we route straight to ``/formulations/<id>`` because
 * the panel there is where every other RTG marketing field lives.
 * Splitting the create + publish surface across two clicks is
 * intentional: this keeps the catalog hub stateless and avoids
 * mounting a full formulation editor inside a modal here.
 */

import { Loader2, Plus, X } from "lucide-react";
import { useState } from "react";

import { useRouter } from "@/i18n/navigation";
import { normalizeApiError } from "@/lib/api";
import { useCreateFormulation } from "@/services/formulations";


export function NewRTGButton({ orgId, locale }: { orgId: string; locale: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-full bg-orange-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-orange-700"
      >
        <Plus className="h-4 w-4" aria-hidden />
        New RTG product
      </button>
      {open ? (
        <NewRTGDialog
          orgId={orgId}
          locale={locale}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}


function NewRTGDialog({
  orgId,
  locale,
  onClose,
}: {
  orgId: string;
  locale: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const createFormulation = useCreateFormulation(orgId);

  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBanner(null);
    setFieldErrors({});

    const trimmedName = name.trim();
    const trimmedCode = code.trim();
    const localErrors: Record<string, string> = {};
    if (!trimmedName) localErrors.name = "Name is required.";
    if (!trimmedCode) localErrors.code = "Code is required.";
    if (Object.keys(localErrors).length > 0) {
      setFieldErrors(localErrors);
      return;
    }

    setSubmitting(true);
    try {
      const formulation = await createFormulation.mutateAsync({
        name: trimmedName,
        code: trimmedCode,
        project_type: "ready_to_go",
      });
      // ``i18n/navigation`` router prepends the locale prefix so we
      // pass an unprefixed href — same convention every other push
      // in this app follows.
      router.push({
        pathname: `/formulations/${formulation.id}`,
      });
    } catch (error) {
      const api = normalizeApiError(error);
      const fields = (api.payload?.fields ?? null) as
        | Record<string, string | string[]>
        | null;
      if (fields && typeof fields === "object") {
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(fields)) {
          if (typeof v === "string") next[k] = v;
          else if (Array.isArray(v) && typeof v[0] === "string") next[k] = v[0];
        }
        setFieldErrors(next);
      }
      setBanner(
        (api.payload?.detail as string | undefined) ||
          api.message ||
          "Failed to create the RTG product.",
      );
      setSubmitting(false);
    }
  };

  // Never actually used but silences the unused-locale warning; keeps
  // the API-symmetric with future locale-aware routing.
  void locale;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
              Ready-to-Go
            </p>
            <h2 className="mt-0.5 text-lg font-semibold text-ink-1000">
              New RTG product
            </h2>
            <p className="mt-1 text-xs text-ink-500">
              Creates a Ready-to-Go project. You&apos;ll land on its
              overview page where you can add the marketing image,
              price, MOQ and packaging options, then publish.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-ink-500 hover:bg-ink-100"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {banner ? (
          <div className="mb-4 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {banner}
          </div>
        ) : null}

        <form onSubmit={submit} className="flex flex-col gap-4">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-700">
              Internal name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              maxLength={200}
              autoFocus
              disabled={submitting}
              placeholder="e.g. Vanilla Whey Protein v3.2"
              className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
            />
            <p className="mt-1 text-xs text-ink-500">
              The internal identifier for R&amp;D and specs. You can
              set a separate customer-facing display name on the
              catalog card afterwards.
            </p>
            {fieldErrors.name ? (
              <p className="mt-1 text-xs text-rose-700">{fieldErrors.name}</p>
            ) : null}
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-700">
              Code
            </label>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.currentTarget.value)}
              maxLength={64}
              disabled={submitting}
              placeholder="e.g. RTG-VWP-032"
              className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm font-mono"
            />
            <p className="mt-1 text-xs text-ink-500">
              Unique per organisation. Prints on the BOM, spec sheet
              and proposal.
            </p>
            {fieldErrors.code ? (
              <p className="mt-1 text-xs text-rose-700">{fieldErrors.code}</p>
            ) : null}
          </div>

          <footer className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-orange-700 disabled:opacity-60"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Creating…
                </>
              ) : (
                "Create"
              )}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
