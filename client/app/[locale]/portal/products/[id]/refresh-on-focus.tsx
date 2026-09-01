"use client";

/**
 * Fires ``router.refresh()`` whenever the tab becomes visible again
 * OR the window gains focus. That triggers Next.js to re-execute the
 * enclosing server component so a peer signing a spec / proposal /
 * label on the web-site portal (or a different tab of NPD) is picked
 * up without a manual reload.
 *
 * Renders nothing.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";


export function RefreshOnFocus() {
  const router = useRouter();
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") {
        router.refresh();
      }
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [router]);
  return null;
}
