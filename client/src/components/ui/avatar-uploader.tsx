"use client";

/**
 * Avatar upload widget.
 *
 * The flow is two modals deep:
 *
 *   1. File picker opens when the user clicks "Upload / Change photo".
 *   2. Picked file hands off to :component:`AvatarCropModal`, which
 *      validates size + type, shows an interactive round-crop with
 *      pan + zoom, and returns a 256×256 JPEG data URL.
 *   3. The data URL goes to ``POST /api/auth/me/avatar/``; the
 *      response echoes the stored value and we mirror it into
 *      parent state so the page repaints without a round-trip to
 *      ``/me``.
 *
 * Validation errors surface inline — the crop modal rejects bad
 * inputs before the user fights with a cropper that's about to
 * produce a useless result.
 */

import { Button } from "@heroui/react";
import { Camera, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import { apiClient } from "@/lib/api";

import { AvatarCropModal, type CroppedAvatar } from "./avatar-crop-modal";
import { UserAvatar } from "./user-avatar";


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
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCropped = async ({ dataUrl }: CroppedAvatar) => {
    setError(null);
    setBusy(true);
    try {
      const { data } = await apiClient.post<{ avatar_image: string }>(
        "/api/auth/me/avatar/",
        { avatar_image: dataUrl },
      );
      onUploaded(data.avatar_image || dataUrl);
      setPickedFile(null);
    } catch (err) {
      setError(
        err instanceof Error && "message" in err
          ? err.message
          : "Upload failed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    setError(null);
    setBusy(true);
    try {
      await apiClient.delete("/api/auth/me/avatar/");
      onCleared();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not remove photo.",
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
          PNG, JPEG, or WebP · at least 96×96 · max 6 MB. You'll crop
          it into a circle before upload.
        </p>
        {error ? (
          <p className="text-xs font-medium text-danger">{error}</p>
        ) : null}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) setPickedFile(file);
            // Reset so picking the same file a second time still
            // fires ``change`` (the browser otherwise de-dupes).
            if (fileInputRef.current) fileInputRef.current.value = "";
          }}
        />
      </div>

      <AvatarCropModal
        file={pickedFile}
        onClose={() => setPickedFile(null)}
        onCropped={handleCropped}
      />
    </div>
  );
}
