"use client";

/**
 * Avatar upload widget.
 *
 * Drives the full capture flow:
 *   1. User clicks "Upload photo" (file picker opens).
 *   2. We draw the picked file onto a hidden canvas, centre-crop to
 *      a square, and scale down to ``MAX_DIMENSION`` px.
 *   3. The canvas is serialised to a JPEG data URL (quality 0.85)
 *      which typically lands at 15–40 KB — comfortably under the
 *      backend's 500 KB cap without pixelating the photo.
 *   4. POST to ``/auth/me/avatar/``; on success the parent's
 *      ``onUploaded`` callback fires with the new data URL so the
 *      UI re-paints without a round-trip back to ``/me``.
 *
 * The widget deliberately does NOT crop interactively — scientists
 * should be able to swap their profile photo in one click, not
 * fight a crop rectangle. Centre-crop covers the common headshot
 * case; any face that needs tighter framing can be re-uploaded
 * from an already-cropped source.
 */

import { Button } from "@heroui/react";
import { Camera, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import { apiClient } from "@/lib/api";
import { UserAvatar } from "./user-avatar";


const MAX_DIMENSION = 256;
const JPEG_QUALITY = 0.85;


async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });
}


async function imageFromDataUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("avatar_image_decode_failed"));
    img.src = url;
  });
}


function cropAndCompress(img: HTMLImageElement): string {
  const side = Math.min(img.width, img.height);
  const sx = Math.floor((img.width - side) / 2);
  const sy = Math.floor((img.height - side) / 2);
  const target = Math.min(side, MAX_DIMENSION);
  const canvas = document.createElement("canvas");
  canvas.width = target;
  canvas.height = target;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("avatar_canvas_unavailable");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, target, target);
  ctx.drawImage(img, sx, sy, side, side, 0, 0, target, target);
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}


interface Props {
  readonly name: string;
  readonly email: string;
  readonly currentImage: string;
  readonly onUploaded: (image: string) => void;
  readonly onCleared: () => void;
}


export function AvatarUploader({
  name,
  email,
  currentImage,
  onUploaded,
  onCleared,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (file: File) => {
    setError(null);
    setBusy(true);
    try {
      const dataUrl = await fileToDataUrl(file);
      const img = await imageFromDataUrl(dataUrl);
      const compressed = cropAndCompress(img);
      const { data } = await apiClient.post<{ avatar_image: string }>(
        "/auth/me/avatar/",
        { avatar_image: compressed },
      );
      onUploaded(data.avatar_image || compressed);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "avatar_upload_failed",
      );
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleClear = async () => {
    setError(null);
    setBusy(true);
    try {
      await apiClient.delete("/auth/me/avatar/");
      onCleared();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "avatar_clear_failed",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-4">
      <UserAvatar
        name={name}
        email={email}
        imageUrl={currentImage || null}
        size={72}
      />
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink-0 px-3 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
            onClick={() => fileInputRef.current?.click()}
            isDisabled={busy}
          >
            <Camera className="h-4 w-4" />
            {currentImage ? "Change photo" : "Upload photo"}
          </Button>
          {currentImage ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="inline-flex items-center gap-1.5 rounded-lg bg-ink-0 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20 hover:bg-danger/5"
              onClick={handleClear}
              isDisabled={busy}
            >
              <Trash2 className="h-4 w-4" />
              Remove
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-ink-500">
          JPEG or PNG. Centre-cropped and compressed to a 256×256
          thumbnail before upload.
        </p>
        {error ? (
          <p className="text-xs font-medium text-danger">{error}</p>
        ) : null}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
      </div>
    </div>
  );
}
