"use client";

import { useRef, useState } from "react";

import {
  Card,
  ErrorBanner,
  H2,
  P,
  PortalButton,
} from "@/components/portal/brutalist";
import { updateAvatar } from "@/services/portal/api";
import { portalErrorMessage } from "@/services/portal/errors";


/**
 * Avatar upload card.
 *
 * The customer picks a local image; we draw it onto a hidden canvas
 * to crop it square + scale it down to ``MAX_DIMENSION`` pixels,
 * then send the base64 data URL to the backend. Same shape as the
 * staff avatar column so the comments rendering can treat both
 * fields as one opaque blob.
 *
 * Keeping the encode work on the client keeps Django out of the
 * multipart parsing business and lets us cap the upload size cheaply
 * — the canvas redraw step is the implicit quota.
 */

const MAX_DIMENSION = 256;
// JPEG quality. PNGs with transparent backgrounds become JPEGs
// here (lossy), but the chat bubble is a small circle and the
// quality loss is invisible at the rendered size.
const JPEG_QUALITY = 0.85;


export function AvatarSection({
  initialAvatar,
  initialInitials,
}: {
  initialAvatar: string;
  initialInitials: string;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [avatar, setAvatar] = useState(initialAvatar);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const cropped = await cropToSquareDataUrl(file, MAX_DIMENSION);
      const stored = await updateAvatar(cropped);
      setAvatar(stored);
    } catch (err: unknown) {
      setError(portalErrorMessage(err));
    } finally {
      setBusy(false);
      // Reset so the same file can be re-picked after a failure.
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function onClear() {
    setBusy(true);
    setError(null);
    try {
      const stored = await updateAvatar("");
      setAvatar(stored);
    } catch (err: unknown) {
      setError(portalErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card as="section">
      <H2>Avatar</H2>
      <P>
        Shown next to your messages in the chat. PNG or JPEG, up to a
        few MB — we crop to a square and resize it.
      </P>
      <ErrorBanner>{error}</ErrorBanner>
      <div className="flex items-center gap-4">
        <AvatarBubble src={avatar} initials={initialInitials} size={88} />
        <div className="flex flex-col gap-2">
          <PortalButton
            type="button"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            {busy ? "Uploading…" : "Choose image"}
          </PortalButton>
          {avatar ? (
            <PortalButton
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={onClear}
            >
              Remove
            </PortalButton>
          ) : null}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={onFile}
          className="hidden"
        />
      </div>
    </Card>
  );
}


export function AvatarBubble({
  src,
  initials,
  size = 32,
  className = "",
}: {
  src: string;
  initials: string;
  size?: number;
  className?: string;
}) {
  if (src) {
    return (
      <img
        src={src}
        alt="Avatar"
        style={{ width: size, height: size }}
        className={`border-2 border-black object-cover ${className}`}
      />
    );
  }
  return (
    <span
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      className={`flex items-center justify-center border-2 border-black bg-black font-black uppercase text-white ${className}`}
    >
      {initials || "?"}
    </span>
  );
}


function cropToSquareDataUrl(file: File, target: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read the image."));
    reader.onload = () => {
      const dataUrl = reader.result;
      if (typeof dataUrl !== "string") {
        reject(new Error("Couldn't read the image."));
        return;
      }
      const img = new Image();
      img.onload = () => {
        // Center-crop to square at the natural size, then draw onto
        // a smaller canvas so the encoded blob stays small.
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        const sx = (img.naturalWidth - side) / 2;
        const sy = (img.naturalHeight - side) / 2;
        const canvas = document.createElement("canvas");
        canvas.width = target;
        canvas.height = target;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Browser can't process this image."));
          return;
        }
        ctx.drawImage(img, sx, sy, side, side, 0, 0, target, target);
        resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
      };
      img.onerror = () => reject(new Error("That file isn't a valid image."));
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}
