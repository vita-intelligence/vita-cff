"use client";

/**
 * Multi-photo gallery for the RTG catalog storefront.
 *
 * Scope: ``purpose='catalog'`` — completely separate from the
 * ``purpose='internal'`` gallery on the Setup tab. The internal pool
 * is for scientists (label references, spec shots); this pool is
 * what the customer sees on the store card and product page.
 *
 * Controls per tile:
 *   - Star: promote to primary (the storefront hero + catalog card).
 *   - Replace: swap the file bytes on this row (keeps captions +
 *     primary status).
 *   - Delete: remove the row entirely.
 *   - Drag: reorder secondary photos on the storefront gallery.
 *
 * Reorder persists in one atomic ``POST /photos/reorder/`` — every
 * card in the new sequence gets a fresh ``sort_order`` in a single
 * transaction so the storefront never flashes a half-reordered pool.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import {
  GripVertical,
  ImagePlus,
  Loader2,
  RefreshCw,
  Star,
  StarOff,
  Trash2,
} from "lucide-react";

import { normalizeApiError } from "@/lib/api";
import {
  useDeleteFormulationPhoto,
  useFormulationPhotos,
  useReorderFormulationPhotos,
  useReplaceFormulationPhoto,
  useUpdateFormulationPhoto,
  useUploadFormulationPhoto,
  type FormulationPhotoDto,
} from "@/services/formulations";


interface Props {
  readonly orgId: string;
  readonly formulationId: string;
  readonly canEdit: boolean;
}


export function CatalogPhotoGallery({
  orgId,
  formulationId,
  canEdit,
}: Props) {
  const listQuery = useFormulationPhotos(orgId, formulationId, "catalog");
  const upload = useUploadFormulationPhoto(orgId, formulationId);
  const update = useUpdateFormulationPhoto(orgId, formulationId);
  const replace = useReplaceFormulationPhoto(orgId, formulationId);
  const reorder = useReorderFormulationPhotos(orgId, formulationId);
  const remove = useDeleteFormulationPhoto(orgId, formulationId);

  const rawPhotos = listQuery.data?.items ?? [];
  // Local order lets drag-preview update instantly instead of waiting
  // for the reorder mutation to resolve. Server truth still wins on
  // reload (``listQuery.data`` swaps back in on next invalidation).
  const [dragOrder, setDragOrder] = useState<readonly string[] | null>(null);
  const photos = useMemo(() => {
    if (!dragOrder) return rawPhotos;
    const byId = new Map(rawPhotos.map((p) => [p.id, p]));
    const ordered: FormulationPhotoDto[] = [];
    for (const id of dragOrder) {
      const p = byId.get(id);
      if (p) ordered.push(p);
    }
    // Any server row not represented in the drag order (shouldn't
    // happen, but defensively) gets appended at the end.
    for (const p of rawPhotos) {
      if (!dragOrder.includes(p.id)) ordered.push(p);
    }
    return ordered;
  }, [rawPhotos, dragOrder]);

  const [error, setError] = useState<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const [replacingId, setReplacingId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const handleAdd = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setError(null);
      try {
        // Upload sequentially so ``is_primary`` auto-promotion stays
        // deterministic — parallel uploads could race for the "first
        // photo becomes primary" slot.
        for (const file of Array.from(files)) {
          await upload.mutateAsync({ file, purpose: "catalog" });
        }
      } catch (e) {
        const err = normalizeApiError(e);
        setError(
          (err.payload?.detail as string | undefined) ||
            err.message ||
            "Failed to upload one or more photos.",
        );
      } finally {
        // Reset the input so re-picking the same file re-fires
        // ``change``.
        if (uploadInputRef.current) uploadInputRef.current.value = "";
      }
    },
    [upload],
  );

  const handleSetPrimary = useCallback(
    async (photoId: string) => {
      setError(null);
      try {
        await update.mutateAsync({
          photoId,
          patch: { is_primary: true },
        });
      } catch (e) {
        const err = normalizeApiError(e);
        setError(err.message || "Failed to update the primary photo.");
      }
    },
    [update],
  );

  const handleDelete = useCallback(
    async (photoId: string) => {
      if (
        !window.confirm(
          "Delete this photo? This can't be undone — the storefront card will drop it immediately.",
        )
      ) {
        return;
      }
      setError(null);
      try {
        await remove.mutateAsync(photoId);
      } catch (e) {
        const err = normalizeApiError(e);
        setError(err.message || "Failed to delete the photo.");
      }
    },
    [remove],
  );

  const handleReplaceClick = useCallback((photoId: string) => {
    setReplacingId(photoId);
    replaceInputRef.current?.click();
  }, []);

  const handleReplaceFile = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0 || !replacingId) return;
      const file = files[0];
      if (!file) return;
      setError(null);
      try {
        await replace.mutateAsync({ photoId: replacingId, file });
      } catch (e) {
        const err = normalizeApiError(e);
        setError(err.message || "Failed to replace the photo.");
      } finally {
        setReplacingId(null);
        if (replaceInputRef.current) replaceInputRef.current.value = "";
      }
    },
    [replacingId, replace],
  );

  //  Drag-and-drop reorder (native HTML5 — no dep). We only reorder
  //  visually while dragging; the reorder mutation persists once the
  //  user drops.
  const handleDragStart = useCallback(
    (photoId: string) => (e: React.DragEvent) => {
      setDragId(photoId);
      // ``effectAllowed`` = "move" gives the ghost image the right
      // cursor. ``setData`` is only there because Firefox refuses to
      // start the drag without a payload.
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", photoId);
    },
    [],
  );

  const handleDragOver = useCallback(
    (overId: string) => (e: React.DragEvent) => {
      if (!dragId || overId === dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const current = dragOrder ?? photos.map((p) => p.id);
      const from = current.indexOf(dragId);
      const to = current.indexOf(overId);
      if (from < 0 || to < 0 || from === to) return;
      const next = [...current];
      next.splice(from, 1);
      next.splice(to, 0, dragId);
      setDragOrder(next);
    },
    [dragId, dragOrder, photos],
  );

  const handleDrop = useCallback(async () => {
    if (!dragId) return;
    const order = dragOrder ?? photos.map((p) => p.id);
    setDragId(null);
    // Only fire the server if the order actually differs from what
    // the query reported — noop drags shouldn't spend a round-trip.
    const serverOrder = rawPhotos.map((p) => p.id);
    const changed =
      order.length !== serverOrder.length ||
      order.some((id, i) => id !== serverOrder[i]);
    if (!changed) {
      setDragOrder(null);
      return;
    }
    try {
      await reorder.mutateAsync({ purpose: "catalog", order });
    } catch (e) {
      const err = normalizeApiError(e);
      setError(err.message || "Failed to save the new photo order.");
    } finally {
      setDragOrder(null);
    }
  }, [dragId, dragOrder, photos, rawPhotos, reorder]);

  const busy =
    upload.isPending || update.isPending || remove.isPending || replace.isPending;

  return (
    <div className="rounded-lg border border-ink-200 bg-ink-0 p-4">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            Storefront gallery
          </p>
          <p className="text-xs text-ink-500">
            Add as many product shots as you like. Star one as the hero
            — that's the image on the catalog card and above the
            storefront page. Drag to reorder the rest.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin text-ink-500" />
          ) : null}
          <button
            type="button"
            onClick={() => uploadInputRef.current?.click()}
            disabled={!canEdit || upload.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-300 bg-white px-3 py-1.5 text-xs font-semibold text-ink-1000 hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ImagePlus className="h-3.5 w-3.5" />
            Add photos
          </button>
          <input
            ref={uploadInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => handleAdd(e.currentTarget.files)}
          />
          <input
            ref={replaceInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => handleReplaceFile(e.currentTarget.files)}
          />
        </div>
      </header>

      {error ? (
        <div className="mb-3 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800">
          {error}
        </div>
      ) : null}

      {photos.length === 0 ? (
        <div className="rounded-lg border-2 border-dashed border-ink-300 bg-ink-50 px-4 py-8 text-center text-sm text-ink-500">
          No photos yet. Add at least one — the first upload
          auto-promotes to the storefront hero.
        </div>
      ) : (
        <ul
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
          onDrop={handleDrop}
          onDragOver={(e) => {
            // Allow drops on the empty spaces between tiles too.
            if (dragId) e.preventDefault();
          }}
        >
          {photos.map((photo) => (
            <PhotoTile
              key={photo.id}
              photo={photo}
              canEdit={canEdit}
              busy={busy}
              onSetPrimary={handleSetPrimary}
              onReplace={handleReplaceClick}
              onDelete={handleDelete}
              onDragStart={handleDragStart(photo.id)}
              onDragOver={handleDragOver(photo.id)}
              isDragging={photo.id === dragId}
            />
          ))}
        </ul>
      )}
    </div>
  );
}


interface TileProps {
  readonly photo: FormulationPhotoDto;
  readonly canEdit: boolean;
  readonly busy: boolean;
  readonly onSetPrimary: (photoId: string) => void;
  readonly onReplace: (photoId: string) => void;
  readonly onDelete: (photoId: string) => void;
  readonly onDragStart: (e: React.DragEvent) => void;
  readonly onDragOver: (e: React.DragEvent) => void;
  readonly isDragging: boolean;
}


function PhotoTile({
  photo,
  canEdit,
  busy,
  onSetPrimary,
  onReplace,
  onDelete,
  onDragStart,
  onDragOver,
  isDragging,
}: TileProps) {
  return (
    <li
      className={`group relative aspect-square overflow-hidden rounded-lg border ${
        photo.is_primary
          ? "border-amber-400 ring-2 ring-amber-200"
          : "border-ink-200"
      } bg-ink-50 ${isDragging ? "opacity-40" : ""}`}
      draggable={canEdit}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
    >
      {photo.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photo.url}
          alt={photo.caption || "Product photo"}
          className="h-full w-full object-cover"
          draggable={false}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-xs text-ink-400">
          No preview
        </div>
      )}

      {photo.is_primary ? (
        <span className="pointer-events-none absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white shadow">
          <Star className="h-3 w-3 fill-white" />
          Hero
        </span>
      ) : null}

      {canEdit ? (
        <div
          className={`absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-gradient-to-t from-black/70 via-black/40 to-transparent p-2 transition-opacity ${
            isDragging ? "opacity-0" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <span
            className="cursor-grab rounded-md bg-white/90 p-1 text-ink-800 shadow"
            title="Drag to reorder"
          >
            <GripVertical className="h-3.5 w-3.5" />
          </span>
          <div className="flex items-center gap-1">
            <IconButton
              title={photo.is_primary ? "Already the hero" : "Set as hero"}
              onClick={() => onSetPrimary(photo.id)}
              disabled={busy || photo.is_primary}
            >
              {photo.is_primary ? (
                <StarOff className="h-3.5 w-3.5" />
              ) : (
                <Star className="h-3.5 w-3.5" />
              )}
            </IconButton>
            <IconButton
              title="Replace photo file"
              onClick={() => onReplace(photo.id)}
              disabled={busy}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton
              title="Delete photo"
              onClick={() => onDelete(photo.id)}
              disabled={busy}
              destructive
            >
              <Trash2 className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        </div>
      ) : null}
    </li>
  );
}


interface IconButtonProps {
  readonly title: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  readonly children: React.ReactNode;
}


function IconButton({
  title,
  onClick,
  disabled,
  destructive,
  children,
}: IconButtonProps) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md shadow transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        destructive
          ? "bg-white/90 text-rose-700 hover:bg-rose-100"
          : "bg-white/90 text-ink-1000 hover:bg-white"
      }`}
    >
      {children}
    </button>
  );
}
