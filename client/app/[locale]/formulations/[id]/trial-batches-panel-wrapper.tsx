"use client";

import { useFormulationVersions } from "@/services/formulations";

import { TrialBatchesPanel } from "./trial-batches-panel";


/**
 * Client-side wrapper that fetches the formulation's saved versions
 * and hands them to :class:`TrialBatchesPanel`. Lives in its own
 * file so the server-rendered formulation detail page can drop it
 * in without pulling the client runtime into the page module.
 */
export function TrialBatchesPanelWrapper({
  orgId,
  formulationId,
  formulationName,
  canWrite,
  canDelete,
}: {
  orgId: string;
  formulationId: string;
  formulationName: string;
  canWrite: boolean;
  canDelete: boolean;
}) {
  const versionsQuery = useFormulationVersions(orgId, formulationId);
  const versions = versionsQuery.data ?? [];
  return (
    <TrialBatchesPanel
      orgId={orgId}
      formulationId={formulationId}
      formulationName={formulationName}
      versions={versions}
      canWrite={canWrite}
      canDelete={canDelete}
    />
  );
}
