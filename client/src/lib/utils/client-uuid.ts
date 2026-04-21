/**
 * Browser-safe UUID generator.
 *
 * ``crypto.randomUUID`` is only exposed on **secure contexts** — HTTPS
 * pages or ``localhost``. A teammate browsing the dev server via its
 * LAN IP (``http://192.168.1.x:3000``) is a plain-HTTP origin and the
 * method is ``undefined`` there, breaking every form that generates a
 * client-side row key. This helper picks the best available
 * generator and falls back to a v4-shaped UUID assembled from
 * ``crypto.getRandomValues`` (available everywhere) or
 * ``Math.random`` as a last resort.
 *
 * The output only needs to be unique within the current tab — these
 * ids are client-side row keys that never round-trip to the backend.
 * So a slight bias from ``Math.random`` is acceptable; collision risk
 * is vanishingly small at the handful of rows a scientist enters.
 */


export function clientUuid(): string {
  if (typeof crypto !== "undefined") {
    // Modern secure-context path. Returns a RFC-4122 v4 UUID string.
    if (typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    // Secure-context-optional fallback. ``getRandomValues`` has been
    // shipped on every browser for a decade and is accessible even on
    // plain HTTP, unlike ``randomUUID``.
    if (typeof crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      // Clamp to the v4 layout: set version 4 + RFC variant bits.
      bytes[6] = (bytes[6]! & 0x0f) | 0x40;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
      return _bytesToUuidString(bytes);
    }
  }
  // Last-resort shim for extremely restricted runtimes. Not
  // cryptographically strong but unique enough for per-tab row keys.
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += "-";
      continue;
    }
    if (i === 14) {
      out += "4";
      continue;
    }
    if (i === 19) {
      out += hex[(Math.random() * 4) | 8];
      continue;
    }
    out += hex[(Math.random() * 16) | 0];
  }
  return out;
}


function _bytesToUuidString(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (let i = 0; i < 16; i += 1) {
    hex.push(bytes[i]!.toString(16).padStart(2, "0"));
  }
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}
