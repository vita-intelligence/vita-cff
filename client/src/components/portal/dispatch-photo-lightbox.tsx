"use client";

import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

/*
 * DispatchPhotoLightbox — fullscreen modal for truck-arrival
 * evidence photos on the NPD customer portal (custom-formulation
 * cycle-slot flow). Sibling to the web-site portal lightbox
 * (src/components/portal/dispatch-photo-lightbox.tsx) — same UX,
 * different codebase / design system (neo-brutalist here vs the
 * softer web-site chrome).
 *
 * Interactions:
 *   - Escape / backdrop click → close
 *   - Arrow left/right → prev/next photo (when >1 photo)
 *   - Circular prev/next buttons on desktop; below-strip on mobile
 *   - Body scroll locked while open
 */

export interface DispatchLightboxPhoto {
  readonly uuid: string;
  readonly filename: string;
  /** Full URL the lightbox renders — usually an ownership-scoped
   *  portal proxy path. */
  readonly href: string;
}

interface Props {
  readonly photos: readonly DispatchLightboxPhoto[];
  readonly openIndex: number;
  readonly onClose: () => void;
  readonly onIndexChange: (i: number) => void;
}

export function DispatchPhotoLightbox({
  photos,
  openIndex,
  onClose,
  onIndexChange,
}: Props) {
  const total = photos.length;
  const current = photos[openIndex];

  const prev = useCallback(() => {
    if (total <= 1) return;
    onIndexChange((openIndex - 1 + total) % total);
  }, [openIndex, total, onIndexChange]);

  const next = useCallback(() => {
    if (total <= 1) return;
    onIndexChange((openIndex + 1) % total);
  }, [openIndex, total, onIndexChange]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [prev, next, onClose]);

  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = original;
    };
  }, []);

  const closeBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeBtnRef.current?.focus();
  }, []);

  if (!current) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={current.filename}
      className="fixed inset-0 z-[90] flex flex-col bg-black/95 backdrop-blur-xl"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Top bar — filename + counter + close */}
      <div
        className="flex items-center justify-between gap-4 px-5 py-4 text-white sm:px-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-white/50">
            {String(openIndex + 1).padStart(2, "0")} /{" "}
            {String(total).padStart(2, "0")}
          </p>
          <p className="mt-1 truncate text-sm text-white/80">
            {current.filename}
          </p>
        </div>
        <button
          ref={closeBtnRef}
          type="button"
          onClick={onClose}
          aria-label="Close photo viewer"
          className="inline-flex h-11 w-11 items-center justify-center border-2 border-white bg-black text-white transition-transform hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-[3px_3px_0_0_white] focus:outline-none"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div
        className="relative flex flex-1 select-none items-center justify-center overflow-hidden px-4 pb-4"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {total > 1 ? (
          <button
            type="button"
            onClick={prev}
            aria-label="Previous photo"
            className="absolute left-4 z-10 hidden h-12 w-12 items-center justify-center border-2 border-white bg-black text-white transition-transform hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-[3px_3px_0_0_white] focus:outline-none md:inline-flex"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
        ) : null}

        {/* eslint-disable-next-line @next/next/no-img-element -- proxy-served bytes */}
        <img
          key={current.uuid}
          src={current.href}
          alt={current.filename}
          className="max-h-full max-w-full object-contain"
          draggable={false}
          onClick={(e) => e.stopPropagation()}
        />

        {total > 1 ? (
          <button
            type="button"
            onClick={next}
            aria-label="Next photo"
            className="absolute right-4 z-10 hidden h-12 w-12 items-center justify-center border-2 border-white bg-black text-white transition-transform hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-[3px_3px_0_0_white] focus:outline-none md:inline-flex"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        ) : null}
      </div>

      {total > 1 ? (
        <div
          className="flex items-center justify-center gap-3 border-t border-white/20 px-4 py-3 md:hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={prev}
            aria-label="Previous photo"
            className="inline-flex h-11 w-11 items-center justify-center border-2 border-white bg-black text-white"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={next}
            aria-label="Next photo"
            className="inline-flex h-11 w-11 items-center justify-center border-2 border-white bg-black text-white"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
