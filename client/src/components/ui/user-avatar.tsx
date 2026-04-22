"use client";

/**
 * Reusable avatar surface.
 *
 * Renders either the user's uploaded photo (when ``imageUrl`` is
 * present) or a coloured initials pill derived from the name.
 * Deliberately dumb — every place that wants to show a face feeds
 * in a ``{ name, email, imageUrl }`` triple and this component
 * decides between image and initials.
 *
 * Treats ``imageUrl`` as an opaque string. The backend currently
 * stores base64 data URLs on ``User.avatar_image``; a future
 * migration to blob storage replaces it with a CDN URL and this
 * component continues to work unchanged.
 */

import { useMemo } from "react";


const PALETTE = [
  { bg: "#fee4d5", fg: "#a0370b" },
  { bg: "#ffe5a1", fg: "#7a4f00" },
  { bg: "#d8f3dc", fg: "#1b5e20" },
  { bg: "#d0e3ff", fg: "#153a7e" },
  { bg: "#e5d8fa", fg: "#4b1d80" },
  { bg: "#fcd8e3", fg: "#841c54" },
  { bg: "#d7f1f5", fg: "#0e5561" },
];


function hashCode(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}


function pickColour(key: string): { bg: string; fg: string } {
  const index = hashCode(key || "avatar") % PALETTE.length;
  return PALETTE[index]!;
}


function initialsFor(name: string | null | undefined, email: string): string {
  const source = (name || "").trim();
  if (source) {
    const parts = source.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0]!.charAt(0)}${parts[parts.length - 1]!.charAt(0)}`.toUpperCase();
    }
    if (parts[0]) return parts[0].slice(0, 2).toUpperCase();
  }
  const at = email.indexOf("@");
  const local = at === -1 ? email : email.slice(0, at);
  return (local.slice(0, 2) || "??").toUpperCase();
}


interface Props {
  readonly name?: string | null;
  readonly email?: string | null;
  readonly imageUrl?: string | null;
  /** Rendered pixel size (both width + height). Defaults to 32px —
   *  the size the presence roster + mention list use. */
  readonly size?: number;
  /** Thicker ring for the currently-active viewer. */
  readonly ring?: boolean;
  readonly className?: string;
}


export function UserAvatar({
  name,
  email,
  imageUrl,
  size = 32,
  ring = false,
  className,
}: Props) {
  const displayName = (name || "").trim() || email || "";
  const initials = useMemo(
    () => initialsFor(name, email ?? ""),
    [name, email],
  );
  const { bg, fg } = useMemo(
    () => pickColour(email || name || ""),
    [email, name],
  );

  const ringClass = ring
    ? "ring-2 ring-orange-400 ring-offset-2 ring-offset-ink-0"
    : "ring-1 ring-inset ring-ink-200";

  const base = `inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full ${ringClass} ${className ?? ""}`;

  if (imageUrl) {
    return (
      <span
        className={base}
        style={{ width: size, height: size }}
        title={displayName || undefined}
      >
        <img
          src={imageUrl}
          alt={displayName ? `${displayName} avatar` : "User avatar"}
          width={size}
          height={size}
          className="h-full w-full object-cover"
        />
      </span>
    );
  }

  return (
    <span
      className={base}
      style={{
        width: size,
        height: size,
        backgroundColor: bg,
        color: fg,
        fontSize: Math.round(size * 0.4),
      }}
      title={displayName || undefined}
      aria-label={displayName || "User avatar"}
    >
      <span className="font-semibold leading-none">{initials}</span>
    </span>
  );
}
