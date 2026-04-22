"use client";

/**
 * Interactive avatar crop modal.
 *
 * The scientist picks a source image, this modal shows it inside a
 * circular viewport with pan + zoom gestures (mouse / touch) powered
 * by ``react-easy-crop``. When they hit **Apply** we render the
 * selected region to an off-screen canvas, downscale to 256×256, and
 * return a JPEG data URL to the caller.
 *
 * Guardrails the modal enforces before the crop UI even appears:
 *
 * * Rejects non-image MIME types outright.
 * * Rejects raw files larger than ``MAX_SOURCE_BYTES`` (6 MB) —
 *   above that the in-memory decode starts to stutter on older
 *   machines and the end result will never be better than our
 *   256-pixel output anyway.
 * * Rejects source images smaller than ``MIN_DIMENSION`` on either
 *   axis — cropping a 40×40 favicon into a 256×256 avatar gives you
 *   a blurry thumbnail nobody wants to see in chat.
 *
 * The parent component receives the final data URL + a pre-upload
 * byte count so it can surface "your avatar is 28 KB" feedback.
 */

import { Button, Modal } from "@heroui/react";
import { Upload, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import Cropper, { type Area } from "react-easy-crop";


const OUTPUT_SIZE = 256;
const JPEG_QUALITY = 0.85;
const MAX_SOURCE_BYTES = 6 * 1024 * 1024; // 6 MB picked-file cap
const MIN_DIMENSION = 96; // reject anything smaller on either axis
const SUPPORTED_TYPES = ["image/png", "image/jpeg", "image/webp"];


export interface CroppedAvatar {
  readonly dataUrl: string;
  readonly byteLength: number;
}


interface Props {
  readonly file: File | null;
  readonly onClose: () => void;
  readonly onCropped: (result: CroppedAvatar) => void;
}


async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });
}


async function decodeImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("avatar_decode_failed"));
    img.src = url;
  });
}


/** Pull the cropped region off the source image into a square 256×256
 *  JPEG. ``area`` is in source-pixel units (react-easy-crop converts
 *  the on-screen gesture geometry for us). */
function renderCrop(img: HTMLImageElement, area: Area): string {
  const canvas = document.createElement("canvas");
  canvas.width = OUTPUT_SIZE;
  canvas.height = OUTPUT_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("avatar_canvas_unavailable");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
  ctx.drawImage(
    img,
    area.x,
    area.y,
    area.width,
    area.height,
    0,
    0,
    OUTPUT_SIZE,
    OUTPUT_SIZE,
  );
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}


export function AvatarCropModal({ file, onClose, onCropped }: Props) {
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [sourceImg, setSourceImg] = useState<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedArea, setCroppedArea] = useState<Area | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Decode the file when the modal opens. Validation runs up-front
  // so the user sees a specific rejection reason before the crop UI
  // ever paints.
  useEffect(() => {
    let cancelled = false;
    setSourceUrl(null);
    setSourceImg(null);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setCroppedArea(null);
    setError(null);

    if (!file) return;

    if (!SUPPORTED_TYPES.includes(file.type)) {
      setError("Unsupported file type. Please pick a PNG, JPEG, or WebP.");
      return;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      setError(
        `File is too large (${Math.round(
          file.size / 1024 / 1024,
        )} MB). Pick an image under 6 MB.`,
      );
      return;
    }

    (async () => {
      try {
        const url = await fileToDataUrl(file);
        const img = await decodeImage(url);
        if (cancelled) return;
        if (img.width < MIN_DIMENSION || img.height < MIN_DIMENSION) {
          setError(
            `Image is too small (${img.width}×${img.height}). Pick one at least ${MIN_DIMENSION}×${MIN_DIMENSION} pixels.`,
          );
          return;
        }
        setSourceUrl(url);
        setSourceImg(img);
      } catch {
        if (!cancelled) setError("Could not read this image. Try another file.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file]);

  const handleCropComplete = useCallback(
    (_area: Area, pixels: Area) => setCroppedArea(pixels),
    [],
  );

  const handleApply = async () => {
    if (!sourceImg || !croppedArea) return;
    setBusy(true);
    try {
      const dataUrl = renderCrop(sourceImg, croppedArea);
      // Approximate byte length: base64 expands by 4/3 and includes
      // the ``data:...;base64,`` prefix. We report the payload size
      // so the caller can confirm we're under the backend's 500 KB
      // cap before we even POST.
      onCropped({ dataUrl, byteLength: Math.ceil(dataUrl.length * 0.75) });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "avatar_crop_failed",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen={file !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
              <Modal.Heading className="text-base font-semibold text-ink-1000">
                Crop your profile photo
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4 px-6 py-6">
              {error ? (
                <p
                  role="alert"
                  className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
                >
                  {error}
                </p>
              ) : null}

              {sourceUrl && !error ? (
                <>
                  <div className="relative h-72 w-full overflow-hidden rounded-xl bg-ink-900">
                    <Cropper
                      image={sourceUrl}
                      crop={crop}
                      zoom={zoom}
                      aspect={1}
                      cropShape="round"
                      showGrid={false}
                      onCropChange={setCrop}
                      onZoomChange={setZoom}
                      onCropComplete={handleCropComplete}
                    />
                  </div>
                  <label className="flex items-center gap-3 text-xs text-ink-500">
                    <ZoomOut className="h-4 w-4" />
                    <input
                      type="range"
                      min={1}
                      max={4}
                      step={0.05}
                      value={zoom}
                      onChange={(e) =>
                        setZoom(Number.parseFloat(e.target.value))
                      }
                      className="flex-1 accent-orange-500"
                    />
                    <ZoomIn className="h-4 w-4" />
                  </label>
                  <p className="text-xs text-ink-500">
                    Drag to position. Zoom to frame your face. Final
                    output is a 256×256 JPEG.
                  </p>
                </>
              ) : !error ? (
                <p className="text-sm text-ink-500">Loading preview…</p>
              ) : null}
            </Modal.Body>
            <Modal.Footer className="flex items-center justify-end gap-3 border-t border-ink-200 px-6 py-4">
              <Button
                type="button"
                variant="outline"
                size="md"
                className="rounded-lg px-4 py-2 font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                onClick={onClose}
                isDisabled={busy}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                size="md"
                className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-4 py-2 font-medium text-ink-0 hover:bg-orange-600 disabled:opacity-40"
                onClick={handleApply}
                isDisabled={busy || !croppedArea || !sourceImg || error !== null}
              >
                <Upload className="h-4 w-4" />
                Apply crop
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
