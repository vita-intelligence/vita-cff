"use client";

import {
  useFormulation,
  useFormulationVersions,
} from "@/services/formulations";

import { TrialBatchesPanel } from "./trial-batches-panel";


/**
 * Client-side wrapper that fetches the formulation's saved versions
 * plus its current approved-version pointer and hands them to
 * :class:`TrialBatchesPanel`. Lives in its own file so the
 * server-rendered formulation detail page can drop it in without
 * pulling the client runtime into the page module.
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
  const formulationQuery = useFormulation(orgId, formulationId);
  const versions = versionsQuery.data ?? [];
  const approvedVersionNumber =
    formulationQuery.data?.approved_version_number ?? null;
  return (
    <TrialBatchesPanel
      orgId={orgId}
      formulationId={formulationId}
      formulationName={formulationName}
      versions={versions}
      approvedVersionNumber={approvedVersionNumber}
      canWrite={canWrite}
      canDelete={canDelete}
    />
  );
}
