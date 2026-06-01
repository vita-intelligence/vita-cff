"use client";

import { useState } from "react";
import {
  AlertCircle,
  Download,
  FilePlus,
  FolderPlus,
  Layers,
  Loader2,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createLabelDesignTemplateCategory,
  deleteLabelDesignTemplate,
  deleteLabelDesignTemplateCategory,
  fetchLabelDesignTemplateCategories,
  fetchLabelDesignTemplates,
  updateLabelDesignTemplateCategory,
  uploadLabelDesignTemplate,
} from "@/services/label-design";
import type {
  LabelDesignTemplateCategoryDto,
  LabelDesignTemplateDto,
} from "@/services/label-design/types";


/**
 * Staff-side curator UI for the customer-facing label-design
 * template library. One section per category; templates live as
 * downloadable file rows inside their category.
 *
 * Gated by ``labelling.manage`` server-side (see ``page.tsx``).
 */
export function LabellingTemplatesTab({ orgId }: { orgId: string }) {
  const qc = useQueryClient();

  const catsQ = useQuery({
    queryKey: ["label-design-template-categories", orgId],
    queryFn: () => fetchLabelDesignTemplateCategories(orgId),
  });
  const tplsQ = useQuery({
    queryKey: ["label-design-templates", orgId],
    queryFn: () => fetchLabelDesignTemplates(orgId),
  });

  const [showCatForm, setShowCatForm] = useState(false);
  const [showTplForm, setShowTplForm] = useState<string | null>(null);
  const [editingCat, setEditingCat] =
    useState<LabelDesignTemplateCategoryDto | null>(null);

  const cats = catsQ.data ?? [];
  const tpls = tplsQ.data ?? [];

  const templatesByCat = new Map<string, LabelDesignTemplateDto[]>();
  for (const t of tpls) {
    const existing = templatesByCat.get(t.category) ?? [];
    existing.push(t);
    templatesByCat.set(t.category, existing);
  }

  const invalidate = () => {
    qc.invalidateQueries({
      queryKey: ["label-design-template-categories", orgId],
    });
    qc.invalidateQueries({ queryKey: ["label-design-templates", orgId] });
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2 border-b border-ink-200 pb-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-ink-1000">
              Labelling templates
            </h2>
            <p className="mt-1 text-sm text-ink-500">
              Files your customers can download when they&rsquo;re designing
              the label themselves. Organised by category.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setEditingCat(null);
              setShowCatForm(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink-1000 px-3 py-1.5 text-xs font-semibold text-ink-0 hover:bg-ink-900"
          >
            <FolderPlus className="h-3.5 w-3.5" /> New category
          </button>
        </div>
      </header>

      {showCatForm ? (
        <CategoryForm
          orgId={orgId}
          initial={editingCat}
          onClose={() => {
            setShowCatForm(false);
            setEditingCat(null);
          }}
          onSaved={() => {
            invalidate();
            setShowCatForm(false);
            setEditingCat(null);
          }}
        />
      ) : null}

      {catsQ.isLoading || tplsQ.isLoading ? (
        <p className="inline-flex items-center gap-2 text-sm text-ink-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      ) : cats.length === 0 ? (
        <div className="rounded-2xl bg-ink-50 p-6 text-center ring-1 ring-ink-200">
          <Layers className="mx-auto h-6 w-6 text-ink-400" />
          <p className="mt-2 text-sm text-ink-700">
            No categories yet. Create one above to start uploading templates.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {cats.map((cat) => {
            const catTpls = templatesByCat.get(cat.id) ?? [];
            return (
              <CategoryCard
                key={cat.id}
                orgId={orgId}
                category={cat}
                templates={catTpls}
                onUploadClick={() => setShowTplForm(cat.id)}
                onEditClick={() => {
                  setEditingCat(cat);
                  setShowCatForm(true);
                }}
                onDeleted={() => invalidate()}
                onTemplateDeleted={() => invalidate()}
              />
            );
          })}
        </div>
      )}

      {showTplForm ? (
        <TemplateForm
          orgId={orgId}
          categoryId={showTplForm}
          onClose={() => setShowTplForm(null)}
          onSaved={() => {
            invalidate();
            setShowTplForm(null);
          }}
        />
      ) : null}
    </div>
  );
}


function CategoryForm({
  orgId,
  initial,
  onClose,
  onSaved,
}: {
  orgId: string;
  initial: LabelDesignTemplateCategoryDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [sortOrder, setSortOrder] = useState(initial?.sort_order ?? 0);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      if (initial) {
        return updateLabelDesignTemplateCategory(orgId, initial.id, {
          name,
          description,
          sort_order: sortOrder,
        });
      }
      return createLabelDesignTemplateCategory(orgId, {
        name,
        description,
        sort_order: sortOrder,
      });
    },
    onSuccess: () => onSaved(),
    onError: (e) => {
      const detail =
        (e as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Couldn't save the category.";
      setError(detail);
    },
  });

  return (
    <Modal title={initial ? "Edit category" : "New category"} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (!name.trim()) {
            setError("Name is required.");
            return;
          }
          mutation.mutate();
        }}
        className="flex flex-col gap-3 text-sm"
      >
        <Field label="Name" required>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-ink-200 px-2 py-1.5 text-sm"
          />
        </Field>
        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-ink-200 px-2 py-1.5 text-sm"
          />
        </Field>
        <Field label="Sort order" hint="Lower numbers render first.">
          <input
            type="number"
            value={sortOrder}
            onChange={(e) => setSortOrder(Number(e.target.value || 0))}
            min={0}
            className="w-full rounded-md border border-ink-200 px-2 py-1.5 text-sm"
          />
        </Field>
        {error ? (
          <p className="flex items-center gap-1.5 text-xs text-rose-700">
            <AlertCircle className="h-3.5 w-3.5" />
            {error}
          </p>
        ) : null}
        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-ink-0 px-3 py-1.5 text-xs font-semibold text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={mutation.isPending}
            className="rounded-md bg-ink-1000 px-3 py-1.5 text-xs font-semibold text-ink-0 hover:bg-ink-900 disabled:opacity-50"
          >
            {mutation.isPending ? "Saving…" : initial ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}


function CategoryCard({
  orgId,
  category,
  templates,
  onUploadClick,
  onEditClick,
  onDeleted,
  onTemplateDeleted,
}: {
  orgId: string;
  category: LabelDesignTemplateCategoryDto;
  templates: LabelDesignTemplateDto[];
  onUploadClick: () => void;
  onEditClick: () => void;
  onDeleted: () => void;
  onTemplateDeleted: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deleteMut = useMutation({
    mutationFn: () => deleteLabelDesignTemplateCategory(orgId, category.id),
    onSuccess: () => onDeleted(),
    onError: (e) => {
      const detail =
        (e as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Couldn't delete the category.";
      setError(detail);
      setConfirmDelete(false);
    },
  });

  return (
    <article className="rounded-2xl bg-ink-0 ring-1 ring-ink-200">
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-ink-100 px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-1000">{category.name}</p>
          {category.description ? (
            <p className="mt-0.5 text-xs text-ink-500">{category.description}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onUploadClick}
            className="inline-flex items-center gap-1 rounded-md bg-ink-1000 px-2.5 py-1 text-[11px] font-semibold text-ink-0 hover:bg-ink-900"
          >
            <FilePlus className="h-3 w-3" /> Upload
          </button>
          <button
            type="button"
            onClick={onEditClick}
            className="inline-flex items-center gap-1 rounded-md bg-ink-0 px-2.5 py-1 text-[11px] font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
          >
            <Pencil className="h-3 w-3" /> Edit
          </button>
          <button
            type="button"
            onClick={() => setConfirmDelete((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md bg-ink-0 px-2.5 py-1 text-[11px] font-medium text-rose-700 ring-1 ring-inset ring-rose-200 hover:bg-rose-50"
          >
            <Trash2 className="h-3 w-3" /> Delete
          </button>
        </div>
      </header>

      {confirmDelete ? (
        <div className="border-b border-ink-100 bg-rose-50 px-4 py-2 text-xs text-rose-800">
          <p>
            Categories with templates inside can&rsquo;t be deleted — move or
            delete the templates first. Confirm?
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => deleteMut.mutate()}
              disabled={deleteMut.isPending}
              className="rounded-md bg-rose-700 px-2.5 py-1 text-[11px] font-semibold text-ink-0 hover:bg-rose-800"
            >
              {deleteMut.isPending ? "Deleting…" : "Yes, delete"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="rounded-md bg-ink-0 px-2.5 py-1 text-[11px] font-medium text-ink-700 ring-1 ring-inset ring-ink-200"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="border-b border-ink-100 bg-rose-50 px-4 py-2 text-xs text-rose-700">
          {error}
        </p>
      ) : null}

      <div className="p-3">
        {templates.length === 0 ? (
          <p className="px-1 text-xs text-ink-500">
            No templates in this category yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {templates.map((t) => (
              <TemplateRow
                key={t.id}
                orgId={orgId}
                template={t}
                onDeleted={onTemplateDeleted}
              />
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}


function TemplateRow({
  orgId,
  template,
  onDeleted,
}: {
  orgId: string;
  template: LabelDesignTemplateDto;
  onDeleted: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => deleteLabelDesignTemplate(orgId, template.id),
    onSuccess: () => onDeleted(),
    onError: (e) => {
      const detail =
        (e as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Couldn't delete the template.";
      setError(detail);
    },
  });

  const kb = template.file_size_bytes / 1024;
  const sizeLabel = kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`;

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg bg-ink-50 p-2 ring-1 ring-inset ring-ink-100">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-ink-1000">{template.name}</p>
        {template.description ? (
          <p className="text-[11px] text-ink-500">{template.description}</p>
        ) : null}
        <p className="text-[10px] text-ink-500">
          {template.file_original_name || "(file)"} · {sizeLabel}
        </p>
        {error ? <p className="text-[11px] text-rose-700">{error}</p> : null}
      </div>
      <div className="flex items-center gap-1.5">
        {template.file_url ? (
          <a
            href={template.file_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md bg-ink-0 px-2 py-1 text-[11px] font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
          >
            <Download className="h-3 w-3" /> Download
          </a>
        ) : null}
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
          className="inline-flex items-center gap-1 rounded-md bg-ink-0 px-2 py-1 text-[11px] font-medium text-rose-700 ring-1 ring-inset ring-rose-200 hover:bg-rose-50 disabled:opacity-50"
        >
          <Trash2 className="h-3 w-3" /> Delete
        </button>
      </div>
    </li>
  );
}


function TemplateForm({
  orgId,
  categoryId,
  onClose,
  onSaved,
}: {
  orgId: string;
  categoryId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => {
      if (!file) throw new Error("Pick a file to upload.");
      return uploadLabelDesignTemplate(orgId, {
        category_id: categoryId,
        name,
        description,
        file,
      });
    },
    onSuccess: () => onSaved(),
    onError: (e) => {
      const detail =
        (e as { response?: { data?: { detail?: string } | string } })?.response
          ?.data;
      const msg =
        typeof detail === "string"
          ? detail
          : detail?.detail ?? (e as Error).message ?? "Couldn't upload.";
      setError(msg);
    },
  });

  return (
    <Modal title="Upload template" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (!name.trim()) {
            setError("Name is required.");
            return;
          }
          if (!file) {
            setError("Pick a file to upload.");
            return;
          }
          mutation.mutate();
        }}
        className="flex flex-col gap-3 text-sm"
      >
        <Field label="Name" required>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-ink-200 px-2 py-1.5 text-sm"
          />
        </Field>
        <Field label="Description (optional)">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-ink-200 px-2 py-1.5 text-sm"
          />
        </Field>
        <Field label="File" required hint="PDF / PNG / JPG / AI / PSD / ZIP up to 25 MB">
          <input
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="w-full text-xs"
          />
        </Field>
        {error ? (
          <p className="flex items-center gap-1.5 text-xs text-rose-700">
            <AlertCircle className="h-3.5 w-3.5" />
            {error}
          </p>
        ) : null}
        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-ink-0 px-3 py-1.5 text-xs font-semibold text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={mutation.isPending}
            className="rounded-md bg-ink-1000 px-3 py-1.5 text-xs font-semibold text-ink-0 hover:bg-ink-900 disabled:opacity-50"
          >
            {mutation.isPending ? "Uploading…" : "Upload"}
          </button>
        </div>
      </form>
    </Modal>
  );
}


function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-ink-0 shadow-xl ring-1 ring-ink-200">
        <header className="flex items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
          <p className="text-sm font-semibold text-ink-1000">{title}</p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-ink-500 hover:bg-ink-50"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}


function Field({
  label,
  required = false,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-600">
        {label}
        {required ? <span className="ml-0.5 text-rose-600">*</span> : null}
      </span>
      {children}
      {hint ? <span className="text-[10px] text-ink-500">{hint}</span> : null}
    </label>
  );
}
