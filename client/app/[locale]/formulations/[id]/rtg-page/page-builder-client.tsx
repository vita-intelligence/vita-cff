"use client";

import { LayoutTemplate, Loader2, Star, X } from "lucide-react";
import { useCallback, useState } from "react";
import { useRouter } from "@/i18n/navigation";

import { apiClient, normalizeApiError } from "@/lib/api";
import { PageBuilderEditor } from "@/components/page-builder/page-builder-editor";
import {
  useApplyPageBuilderTemplate,
  usePageBuilderTemplates,
} from "@/services/formulations";
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
 *
 * The "Apply template" button in the top strip opens a picker of
 * the org's :class:`PageBuilderTemplate` library. Applying overwrites
 * ``rtg_page_content`` on the server and forces the editor to
 * remount so Puck picks up the fresh JSON without a full route reload.
 */
export function PageBuilderClient({ orgId, formulation, canEdit }: Props) {
  const router = useRouter();
  const [pickerOpen, setPickerOpen] = useState(false);
  // Bump this to force the PageBuilderEditor to re-mount with a
  // fresh ``initialData`` after an apply-template overwrite. Puck
  // seeds state from the first render's data — a fresh key is the
  // simplest way to reset it.
  const [remountKey, setRemountKey] = useState(0);
  // Track the currently-applied content so we can hot-swap after an
  // apply without a router refresh (which would blow away the editor
  // route and any unrelated state on the way back).
  const [liveContent, setLiveContent] = useState<unknown>(
    formulation.rtg_page_content ?? null,
  );

  const handleSave = useCallback(
    async (data: unknown) => {
      const form = new FormData();
      form.append("rtg_page_content", JSON.stringify(data));
      try {
        await apiClient.patch(
          `/api/organizations/${orgId}/formulations/${formulation.id}/rtg-publish/`,
          form,
        );
      } catch (error) {
        const api = normalizeApiError(error);
        throw new Error(
          (api.payload?.detail as string | undefined) ||
            api.message ||
            "Failed to save the page.",
        );
      }
    },
    [formulation.id, orgId],
  );

  const handleAfterSave = useCallback(() => {
    router.push(`/formulations/${formulation.id}`);
    router.refresh();
  }, [formulation.id, router]);

  return (
    <div className="flex h-dvh flex-col">
      {/* Slim top strip above the Puck canvas — holds the Apply
          Template action. Only rendered when the caller can edit so
          read-only viewers don't see a button that would 403. */}
      {canEdit ? (
        <div className="flex items-center justify-end gap-2 border-b border-ink-200 bg-ink-50 px-4 py-2">
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink-0 px-3 py-1.5 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-100"
          >
            <LayoutTemplate className="h-3.5 w-3.5" />
            Apply template
          </button>
        </div>
      ) : null}

      <div className="flex-1 overflow-hidden">
        <PageBuilderEditor
          key={remountKey}
          initialData={liveContent}
          onSave={handleSave}
          onAfterSave={handleAfterSave}
          title={
            formulation.rtg_display_name || formulation.name || "Product page"
          }
          disabled={!canEdit}
        />
      </div>

      {pickerOpen ? (
        <ApplyTemplatePicker
          orgId={orgId}
          formulationId={formulation.id}
          onApplied={(content) => {
            setLiveContent(content);
            setRemountKey((k) => k + 1);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}


/**
 * Modal-style picker over the top of the Puck canvas. Shows every
 * template in the org's library, lets the operator pick one, and
 * warns that applying overwrites current page content. Default
 * templates are chip-badged and float to the top of the list.
 */
function ApplyTemplatePicker({
  orgId,
  formulationId,
  onApplied,
  onClose,
}: {
  orgId: string;
  formulationId: string;
  onApplied: (content: unknown) => void;
  onClose: () => void;
}) {
  const query = usePageBuilderTemplates(orgId);
  const applyMutation = useApplyPageBuilderTemplate(orgId, formulationId);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = query.data?.items ?? [];

  const apply = async (templateId: string) => {
    setError(null);
    setPendingId(templateId);
    try {
      const result = await applyMutation.mutateAsync(templateId);
      onApplied(result.rtg_page_content);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Apply failed.");
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-xl overflow-hidden rounded-2xl bg-ink-0 shadow-2xl ring-1 ring-ink-200">
        <header className="flex items-center justify-between border-b border-ink-100 px-5 py-3">
          <div>
            <h3 className="text-sm font-semibold text-ink-1000">
              Apply a page template
            </h3>
            <p className="mt-0.5 text-[11px] text-ink-500">
              Overwrites the current page content. This does not save —
              hit &ldquo;Save&rdquo; in the editor afterwards to keep it.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-ink-500 hover:bg-ink-100 hover:text-ink-1000"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="max-h-[60vh] overflow-y-auto p-4">
          {query.isLoading ? (
            <p className="text-sm text-ink-500">Loading templates…</p>
          ) : query.isError ? (
            <p className="rounded bg-red-50 p-3 text-sm text-red-700 ring-1 ring-inset ring-red-200">
              Couldn&apos;t load templates.
            </p>
          ) : rows.length === 0 ? (
            <p className="rounded bg-ink-50 p-3 text-sm text-ink-600 ring-1 ring-inset ring-ink-200">
              No templates yet. Ask an admin to create one in Settings →
              Page templates.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {rows.map((row) => (
                <li
                  key={row.id}
                  className="flex items-start justify-between gap-3 rounded-lg bg-ink-0 p-3 ring-1 ring-inset ring-ink-200"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-ink-1000">
                        {row.name}
                      </span>
                      {row.is_default ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-orange-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-orange-700 ring-1 ring-inset ring-orange-200">
                          <Star className="h-3 w-3 fill-current" />
                          recommended
                        </span>
                      ) : null}
                    </div>
                    {row.description ? (
                      <p className="mt-1 text-xs text-ink-600">
                        {row.description}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => apply(row.id)}
                    disabled={pendingId !== null}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-ink-1000 px-3 py-1.5 text-xs font-medium text-ink-0 hover:bg-ink-900 disabled:opacity-50"
                  >
                    {pendingId === row.id ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Applying…
                      </>
                    ) : (
                      "Apply"
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error ? (
            <p className="mt-3 rounded bg-red-50 p-2 text-[12px] text-red-700 ring-1 ring-inset ring-red-200">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
