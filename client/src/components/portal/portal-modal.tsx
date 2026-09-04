"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Shared portal modal shell — brutalist design language, mobile-safe.
 *
 * Solves the four things every hand-rolled dialog in this repo
 * kept getting wrong:
 *   1. Overlay lets the underlying page scroll (body-lock via
 *      ``document.body.style.overflow`` on mount).
 *   2. Modal grows past the viewport height on long content.
 *      Cap here is ``max-h-[calc(100dvh-1rem)]`` (safe on notches),
 *      with the header + footer pinned and only the body scrolling.
 *   3. Action bar scrolls off the bottom on tall content. Footer
 *      is sticky inside the flex column so the primary CTA is
 *      always tap-able.
 *   4. Escape key + backdrop click don't close consistently.
 *      Both handled here.
 *
 * Compose the three slots:
 *
 *     <PortalModal onClose={close} ariaLabel="Request dispatch">
 *       <PortalModal.Header>...</PortalModal.Header>
 *       <PortalModal.Body>...</PortalModal.Body>
 *       <PortalModal.Footer>...</PortalModal.Footer>
 *     </PortalModal>
 */
export function PortalModal({
  onClose,
  ariaLabel,
  children,
  /** When true, backdrop click + Escape are ignored. Use during
   *  a pending submit to prevent the operator dismissing the
   *  modal mid-request. */
  locked = false,
  /** Tailwind width override — defaults to ``max-w-md``. */
  widthClassName = "max-w-md",
}: {
  onClose: () => void;
  ariaLabel: string;
  children: React.ReactNode;
  locked?: boolean;
  widthClassName?: string;
}) {
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => {
    if (!locked) onClose();
  }, [locked, onClose]);

  // Body scroll lock. Restores whatever overflow the page had
  // before the modal mounted so opening + closing a modal
  // doesn't strip a page's own overflow style.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Escape key.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      onClick={(e) => {
        // Backdrop click only — clicks inside the modal
        // content bubble via stopPropagation on the card.
        if (e.target === overlayRef.current) close();
      }}
      // ``100dvh`` + safe-area padding so the overlay respects
      // the iOS notch on landscape phones + the bottom home bar.
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-2 sm:items-center sm:p-4"
      style={{
        paddingTop: "max(0.5rem, env(safe-area-inset-top))",
        paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`flex w-full ${widthClassName} max-h-[calc(100dvh-1rem)] flex-col overflow-hidden border-2 border-black bg-white shadow-[8px_8px_0_0_black] sm:max-h-[calc(100dvh-2rem)]`}
      >
        {children}
      </div>
    </div>
  );
}

function Header({ children }: { children: React.ReactNode }) {
  return <div className="shrink-0 border-b-2 border-black bg-white p-5">{children}</div>;
}

function Body({ children }: { children: React.ReactNode }) {
  // ``overflow-y-auto`` on the scroll region + ``min-h-0`` on the
  // flex child so the container actually contracts when its child
  // overflows (default ``min-height: auto`` prevents that).
  return (
    <div className="flex-1 overflow-y-auto p-5 min-h-0">{children}</div>
  );
}

function Footer({ children }: { children: React.ReactNode }) {
  return (
    <div className="shrink-0 border-t-2 border-black bg-white p-4">
      {children}
    </div>
  );
}

PortalModal.Header = Header;
PortalModal.Body = Body;
PortalModal.Footer = Footer;
