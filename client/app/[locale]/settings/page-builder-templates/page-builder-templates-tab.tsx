"use client";

import { Button } from "@heroui/react";
import { Loader2, Pencil, Plus, Star, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { PageBuilderEditor } from "@/components/page-builder/page-builder-editor";
import {
  useCreatePageBuilderTemplate,
  useDeletePageBuilderTemplate,
  usePageBuilderTemplate,
  usePageBuilderTemplates,
  useUpdatePageBuilderTemplate,
  type PageBuilderTemplateDto,
  type PageBuilderTemplateContent,
} from "@/services/formulations";


/**
 * Settings tab for the RTG page-builder template library.
 *
 * List view shows every template with an edit / delete / mark-default
 * affordance. Opening a template swaps the tab body to a full-height
 * ``PageBuilderEditor`` bound to the template's ``content`` field
 * (rather than a formulation's ``rtg_page_content``). Save writes back
 * through the update endpoint; a back link returns to the list.
 *
 * "Default" is the row that seeds the RTG editor's "Apply template"
 * picker with a chip — service-layer atomicity means marking one
 * clears any prior default.
 */
export function PageBuilderTemplatesTab({ orgId }: { orgId: string }) {
  // Which template is being edited, if any. ``"new"`` = create flow;
  // any UUID = editing that row; ``null`` = list view.
  //
  // Editor renders as a full-viewport overlay on top of the list —
  // the Puck editor needs the whole screen to be usable and a
  // cramped in-tab canvas felt like editing through a keyhole.
  const [editing, setEditing] = useState<"new" | string | null>(null);

  return (
    <>
      <TemplateList orgId={orgId} onOpen={setEditing} />
      {editing ? (
        <TemplateEditorOverlay
          orgId={orgId}
          templateId={editing === "new" ? null : editing}
          onExit={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}


function TemplateList({
  orgId,
  onOpen,
}: {
  orgId: string;
  onOpen: (target: "new" | string) => void;
}) {
  const query = usePageBuilderTemplates(orgId);
  const deleteMutation = useDeletePageBuilderTemplate(orgId);
  const updateMutation = useUpdatePageBuilderTemplate(orgId);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const rows = useMemo(() => query.data?.items ?? [], [query.data]);

  const setDefault = async (row: PageBuilderTemplateDto) => {
    setRowError((prev) => ({ ...prev, [row.id]: "" }));
    try {
      await updateMutation.mutateAsync({
        templateId: row.id,
        patch: { is_default: true },
      });
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [row.id]:
          err instanceof Error ? err.message : "Couldn't set as default.",
      }));
    }
  };

  const deleteRow = async (row: PageBuilderTemplateDto) => {
    setRowError((prev) => ({ ...prev, [row.id]: "" }));
    try {
      await deleteMutation.mutateAsync(row.id);
      setPendingDeleteId(null);
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [row.id]: err instanceof Error ? err.message : "Delete failed.",
      }));
    }
  };

  return (
    <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-2xl">
          <h2 className="text-lg font-semibold tracking-tight text-ink-1000">
            Page templates
          </h2>
          <p className="mt-1 text-sm text-ink-600">
            Reusable Puck page shapes that the RTG product-page editor
            can seed from. Scientists apply templates from the editor
            toolbar — reshape rights sit with this settings surface.
            Mark one as the default so it appears with a
            &ldquo;recommended&rdquo; chip in the picker.
          </p>
        </div>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onPress={() => onOpen("new")}
          className="gap-1.5"
        >
          <Plus className="h-4 w-4" />
          New template
        </Button>
      </header>

      {query.isLoading ? (
        <p className="mt-6 text-sm text-ink-500">Loading…</p>
      ) : query.isError ? (
        <p className="mt-6 rounded-lg bg-red-50 p-3 text-sm text-red-700 ring-1 ring-inset ring-red-200">
          Couldn&apos;t load templates. Refresh the page or try again.
        </p>
      ) : rows.length === 0 ? (
        <div className="mt-6 rounded-lg bg-ink-50 p-4 text-sm text-ink-600 ring-1 ring-inset ring-ink-200">
          No templates yet. Add one with the button above.
        </div>
      ) : (
        <ul className="mt-6 flex flex-col gap-3">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-col gap-2 rounded-xl bg-ink-0 p-4 ring-1 ring-ink-200"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-ink-1000">
                      {row.name}
                    </span>
                    {row.is_default ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-orange-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-orange-700 ring-1 ring-inset ring-orange-200">
                        <Star className="h-3 w-3 fill-current" />
                        default
                      </span>
                    ) : null}
                  </div>
                  {row.description ? (
                    <p className="mt-1 text-xs text-ink-600">
                      {row.description}
                    </p>
                  ) : null}
                  <p className="mt-1 text-[11px] text-ink-500">
                    Updated {new Date(row.updated_at).toLocaleString()}
                  </p>
                  {rowError[row.id] ? (
                    <p className="mt-2 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700 ring-1 ring-inset ring-red-200">
                      {rowError[row.id]}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {!row.is_default ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onPress={() => setDefault(row)}
                      isDisabled={updateMutation.isPending}
                      className="gap-1.5"
                    >
                      <Star className="h-3.5 w-3.5" />
                      Set default
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onPress={() => onOpen(row.id)}
                    className="gap-1.5"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Edit
                  </Button>
                  {pendingDeleteId === row.id ? (
                    <>
                      <button
                        type="button"
                        onClick={() => deleteRow(row)}
                        disabled={deleteMutation.isPending}
                        className="rounded-lg bg-red-500 px-2 py-1 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50"
                      >
                        {deleteMutation.isPending ? "Deleting…" : "Confirm"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDeleteId(null)}
                        className="text-[11px] text-ink-500 hover:text-ink-700"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setPendingDeleteId(row.id)}
                      className="rounded p-1.5 text-ink-500 hover:bg-red-50 hover:text-red-600"
                      aria-label="Delete template"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}


/**
 * Full-viewport overlay editor for a single template. Renders on
 * top of everything else — the Puck canvas needs the whole screen
 * to be workable, and an embedded editor was cramped.
 *
 * Slim metadata strip at the top (name / description / default
 * toggle / save-details / close). Full-height Puck canvas below.
 * Escape or the close button dismisses.
 *
 * On save: metadata (name/description/is_default) writes first as a
 * PATCH so the Puck editor's own "Publish" only carries ``content``.
 */
function TemplateEditorOverlay({
  orgId,
  templateId,
  onExit,
}: {
  orgId: string;
  templateId: string | null;
  onExit: () => void;
}) {
  const query = usePageBuilderTemplate(orgId, templateId);
  const createMutation = useCreatePageBuilderTemplate(orgId);
  const updateMutation = useUpdatePageBuilderTemplate(orgId);

  // Lock the page scroll while the overlay is up so the settings
  // list underneath doesn't scroll behind. Restore on unmount.
  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = original;
    };
  }, []);

  // Escape closes the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExit();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onExit]);

  // Metadata form state — hydrated from the fetched row (or empty
  // defaults for a new template).
  const loaded = query.data;
  const [name, setName] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [isDefault, setIsDefault] = useState<boolean | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [metaSavedId, setMetaSavedId] = useState<string | null>(null);

  // First hydration: seed the form once from the server row. Guarded
  // by the null-init above so subsequent typing isn't stomped.
  if (loaded && name === null) {
    setName(loaded.name);
    setDescription(loaded.description);
    setIsDefault(loaded.is_default);
  }
  const effectiveName = name ?? "";
  const effectiveDescription = description ?? "";
  const effectiveIsDefault = isDefault ?? false;
  const effectiveId = metaSavedId ?? templateId;

  const initialContent: PageBuilderTemplateContent | null = loaded
    ? loaded.content
    : templateId
      ? null
      : {};

  /**
   * ONE save path — Puck's built-in "Publish" button triggers this
   * with the Puck JSON. We layer the metadata (name / description /
   * is_default) into the same request so authors never have to think
   * about which of two buttons to press. Missing name → visible error
   * and Puck's own "saved" toast is short-circuited.
   */
  const savePuck = async (data: unknown) => {
    setMetaError(null);
    const trimmed = effectiveName.trim();
    if (!trimmed) {
      setMetaError("Name is required.");
      throw new Error("Name is required.");
    }
    const puck = (data as PageBuilderTemplateContent) ?? {};
    try {
      if (!effectiveId) {
        // First save — create with everything at once.
        const created = await createMutation.mutateAsync({
          name: trimmed,
          description: effectiveDescription.trim(),
          is_default: effectiveIsDefault,
          content: puck,
        });
        setMetaSavedId(created.id);
        return;
      }
      // Subsequent save — patch meta + content atomically.
      await updateMutation.mutateAsync({
        templateId: effectiveId,
        patch: {
          name: trimmed,
          description: effectiveDescription.trim(),
          is_default: effectiveIsDefault,
          content: puck,
        },
      });
    } catch (err) {
      setMetaError(err instanceof Error ? err.message : "Save failed.");
      throw err;
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Page template editor"
      className="fixed inset-0 z-[70] flex flex-col bg-ink-0"
    >
      {/* Single-row header — name + description inline + default
          toggle + close. Kept SLIM so Puck's own header/sidebars
          fit the remaining viewport without overflowing.
          Puck's own "Publish" button is the ONE save affordance —
          it saves metadata + Puck content in a single request. */}
      <header className="flex flex-wrap items-center gap-3 border-b border-ink-200 bg-ink-50 px-4 py-2">
        <p className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-500">
          {templateId ? "Edit" : "New"}
        </p>
        <input
          value={effectiveName}
          onChange={(e) => setName(e.target.value)}
          className="min-w-[10rem] flex-1 rounded-lg bg-ink-0 px-3 py-1.5 text-sm font-semibold ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          placeholder="Template name"
          maxLength={200}
        />
        <input
          value={effectiveDescription}
          onChange={(e) => setDescription(e.target.value)}
          className="min-w-[10rem] flex-[2] rounded-lg bg-ink-0 px-3 py-1.5 text-sm ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          placeholder="Description (optional)"
        />
        <label className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-ink-700">
          <input
            type="checkbox"
            checked={effectiveIsDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
          />
          Default
        </label>
        <button
          type="button"
          onClick={onExit}
          aria-label="Close editor"
          className="rounded-lg p-2 text-ink-500 hover:bg-ink-100 hover:text-ink-1000"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      {metaError ? (
        <p className="border-b border-red-200 bg-red-50 px-4 py-2 text-[12px] text-red-700">
          {metaError}
        </p>
      ) : null}

      {/* Puck canvas — flex-1 with ``min-h-0`` so the child (Puck's
          own grid layout) can constrain its rows/panels within our
          box instead of expanding past the viewport. */}
      {templateId && query.isLoading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-ink-500">
          Loading template…
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden">
          <PageBuilderEditor
            initialData={initialContent}
            onSave={savePuck}
            title={effectiveName || "New page template"}
          />
        </div>
      )}
    </div>
  );
}
