"use client";

import { useCallback } from "react";
import { useRouter } from "@/i18n/navigation";

import { apiClient, normalizeApiError } from "@/lib/api";
import { PageBuilderEditor } from "@/components/page-builder/page-builder-editor";
import type { FormulationDto } from "@/services/formulations/types";


interface Props {
  readonly orgId: string;
  readonly formulation: FormulationDto;
  readonly canEdit: boolean;
}


/**
 * Staff route that mounts the Puck page builder full-screen for
 * one RTG SKU. Save writes to the same rtg-publish endpoint as
 * the marketing panel — no separate write path so the audit trail
 * stays consistent.
 */
export function PageBuilderClient({ orgId, formulation, canEdit }: Props) {
  const router = useRouter();

  const handleSave = useCallback(
    async (data: unknown) => {
      const form = new FormData();
      // JSON goes through the same PATCH the marketing panel uses.
      // Not sending is_rtg_published keeps this a draft-save so
      // the FINAL-spec gate doesn't fire.
      form.append("rtg_page_content", JSON.stringify(data));
      try {
        await apiClient.patch(
          `/api/organizations/${orgId}/formulations/${formulation.id}/rtg-publish/`,
          form,
        );
        router.refresh();
      } catch (error) {
        const api = normalizeApiError(error);
        throw new Error(
          (api.payload?.detail as string | undefined) ||
            api.message ||
            "Failed to save the page.",
        );
      }
    },
    [formulation.id, orgId, router],
  );

  return (
    <PageBuilderEditor
      initialData={formulation.rtg_page_content ?? null}
      onSave={handleSave}
      title={
        formulation.rtg_display_name || formulation.name || "Product page"
      }
      disabled={!canEdit}
    />
  );
}
