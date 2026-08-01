"use client";

/**
 * "New RTG product" affordance on the RTG Catalog hub page.
 *
 * Single-click — no modal. Creates a ``Formulation`` with
 * ``project_type='ready_to_go'`` and lets the backend auto-assign
 * an ``RTG#####`` code + placeholder name. The user then lands on
 * the project overview page where the customer-facing name,
 * marketing image, price, MOQ and packaging live.
 *
 * We used to open a modal here asking for an internal name + code,
 * but RTG products have only one name (the customer-facing display
 * name edited on the overview) and the code is a catalog reference
 * the system should generate, not a scientist reference typed by
 * hand. That modal was a dead weight — creation is now zero-input.
 */

import { Loader2, Plus } from "lucide-react";
import { useState } from "react";

import { useRouter } from "@/i18n/navigation";
import { normalizeApiError } from "@/lib/api";
import { useCreateFormulation } from "@/services/formulations";


export function NewRTGButton({ orgId, locale }: { orgId: string; locale: string }) {
  const router = useRouter();
  const createFormulation = useCreateFormulation(orgId);
  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  // Silences the unused-locale warning; kept for API symmetry with
  // other locale-aware affordances even though `useRouter` handles
  // the prefix for us.
  void locale;

  const onClick = async () => {
    if (submitting) return;
    setBanner(null);
    setSubmitting(true);
    try {
      const formulation = await createFormulation.mutateAsync({
        // Blank name + code — backend auto-assigns ``RTG#####`` and
        // uses that as the placeholder name until the user edits the
        // customer-facing name on the overview page.
        name: "",
        code: "",
        project_type: "ready_to_go",
      });
      router.push({ pathname: `/formulations/${formulation.id}` });
    } catch (error) {
      const api = normalizeApiError(error);
      setBanner(
        (api.payload?.detail as string | undefined) ||
          api.message ||
          "Failed to create the RTG product.",
      );
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={submitting}
        className="inline-flex items-center gap-2 rounded-full bg-orange-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-orange-700 disabled:opacity-60"
      >
        {submitting ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <Plus className="h-4 w-4" aria-hidden />
        )}
        {submitting ? "Creating…" : "New RTG product"}
      </button>
      {banner ? (
        <p className="text-xs text-rose-700">{banner}</p>
      ) : null}
    </div>
  );
}
