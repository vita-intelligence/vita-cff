"use client";

/**
 * Reusable signature-pad surface.
 *
 * Renders a white canvas the user can draw on with mouse / finger /
 * stylus. Emits a base64-encoded PNG data URL whenever the pen is
 * lifted, so parent forms can mirror the latest signature into their
 * state without the user having to press a separate "capture"
 * button.
 *
 * The canvas is wrapped in ``useImperativeHandle`` so parents can
 * programmatically clear the pad (e.g. after a failed submit). We
 * keep the API surface deliberately small — one callback, one ref
 * method — because signature capture is a narrow widget and
 * over-specification invites divergent behaviour across the two
 * places it's used (validation editor + spec-sheet kiosk).
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import SignatureCanvas from "react-signature-canvas";


export interface SignaturePadHandle {
  /** Clear the canvas and the mirrored data URL. */
  clear: () => void;
  /** Returns ``true`` when nothing has been drawn yet. */
  isEmpty: () => boolean;
}


interface Props {
  /** Fires whenever the pen lifts; ``null`` means the pad is empty.
   *  Parents usually mirror this into their form state. */
  readonly onChange: (dataUrl: string | null) => void;
  /** Optional prefilled signature to seed the canvas with — used
   *  when editing a previously-signed validation so the user sees
   *  the stamp they're about to replace. */
  readonly initialDataUrl?: string | null;
  /** ARIA label for screen readers. Defaults to a generic string
   *  but the two call sites override with role-specific copy
   *  ("Scientist signature", "Customer signature"). */
  readonly ariaLabel?: string;
  /** Disable drawing — e.g. when the viewer has read-only access. */
  readonly disabled?: boolean;
}


export const SignaturePad = forwardRef<SignaturePadHandle, Props>(
  function SignaturePad(
    { onChange, initialDataUrl = null, ariaLabel, disabled = false },
    ref,
  ) {
    const padRef = useRef<SignatureCanvas | null>(null);
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    // Canvas pixels must match the parent's CSS pixels or drawings
    // render stretched. We track the measured width so resizes don't
    // leave prior strokes offset.
    //
    // Initial width of ``0`` (not ``400``) is intentional: the
    // HTML ``width`` attribute on ``<canvas>`` is its drawing
    // surface, but it ALSO acts as the element's default CSS
    // width unless overridden. On a 360px phone an initial 400
    // pushed every ancestor wider than the viewport until the
    // ``ResizeObserver`` ran. Starting at 0 + a CSS ``max-width:
    // 100%`` cap (set below) keeps the canvas inside its parent
    // from the first paint.
    const [canvasSize, setCanvasSize] = useState({
      width: 0,
      height: 140,
    });

    // ``useLayoutEffect`` (not ``useEffect``) for the initial
    // measure: it fires AFTER DOM commit but BEFORE paint, so the
    // ``setCanvasSize`` re-render happens before the user ever
    // sees the 0-width canvas. Critical for modal/dialog mounts
    // where ``useEffect`` would let the empty canvas paint once
    // and then resize on the next frame — making the pad look
    // like it didn't render at all on slower devices.
    // ``ResizeObserver`` stays in a plain ``useEffect`` to track
    // later runtime resizes (orientation change, container
    // collapse, etc.). On SSR ``useLayoutEffect`` is aliased
    // to a noop so this is safe even though the component is
    // ``"use client"``.
    useLayoutEffect(() => {
      const el = wrapperRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0) {
        setCanvasSize({ width: Math.round(rect.width), height: 140 });
      }
    }, []);

    useEffect(() => {
      const el = wrapperRef.current;
      if (!el) return;
      const sync = () => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0) {
          setCanvasSize({
            width: Math.round(rect.width),
            height: 140,
          });
        }
      };
      const observer = new ResizeObserver(sync);
      observer.observe(el);
      return () => observer.disconnect();
    }, []);

    // Seed the canvas with the initial data URL after mount. The
    // library exposes ``fromDataURL`` for this; we fire it in a
    // layout effect so the first paint already shows the existing
    // signature rather than flashing blank.
    useEffect(() => {
      if (!initialDataUrl || !padRef.current) return;
      try {
        padRef.current.fromDataURL(initialDataUrl);
      } catch {
        // Bad data URL — ignore; the user can redraw.
      }
    }, [initialDataUrl, canvasSize.width]);

    const emitChange = useCallback(() => {
      const pad = padRef.current;
      if (!pad) return;
      if (pad.isEmpty()) {
        onChange(null);
        return;
      }
      // ``toDataURL`` without a mime argument defaults to PNG, which
      // is what the backend validator expects. Trimming the canvas
      // to the drawn bounds would shrink payloads, but the library's
      // built-in trim is known to drop dots and very short strokes —
      // so we keep the full canvas and let the 200KB size cap
      // upstream do the bounding.
      onChange(pad.toDataURL("image/png"));
    }, [onChange]);

    useImperativeHandle(
      ref,
      () => ({
        clear: () => {
          padRef.current?.clear();
          onChange(null);
        },
        isEmpty: () => padRef.current?.isEmpty() ?? true,
      }),
      [onChange],
    );

    return (
      <div className="flex flex-col gap-2">
        <div
          ref={wrapperRef}
          className={`relative w-full rounded-xl bg-ink-0 ring-1 ring-inset ring-ink-200 ${
            disabled ? "opacity-60" : ""
          }`}
          aria-label={ariaLabel ?? "Signature pad"}
        >
          <SignatureCanvas
            ref={padRef}
            penColor="#111111"
            canvasProps={{
              width: canvasSize.width,
              height: canvasSize.height,
              className: "block rounded-xl",
              // ``max-width: 100%`` + ``display: block`` make the
              // canvas display-size follow its parent even when
              // the HTML ``width`` attribute hasn't synced yet
              // (first render, narrow viewports). Without this
              // the bare attribute width pushed wide parents out
              // beyond the screen on mobile.
              style: {
                touchAction: "none",
                display: "block",
                maxWidth: "100%",
              },
              "aria-label": ariaLabel ?? "Signature pad",
            }}
            onEnd={emitChange}
            clearOnResize={false}
          />
          {disabled ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-xl"
            />
          ) : null}
        </div>
        {/* Caption only — Clear is provided by the wrapping dialog
            (both staff and portal variants render their own button)
            so we drop the inline one here to avoid the double-Clear
            you can see in the kiosk screenshot. */}
        <div className="text-[11px] text-ink-500">
          Draw your signature above.
        </div>
      </div>
    );
  },
);
