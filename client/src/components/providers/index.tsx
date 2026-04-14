"use client";

import type { ReactNode } from "react";

import { HeroProvider } from "./hero-provider";
import { QueryProvider } from "./query-provider";

/**
 * Single top-level Client-Component boundary.
 *
 * Order matters: the query provider wraps everything else so hooks inside
 * HeroUI-rendered children can still reach it. Add new providers by nesting
 * them inside this composition — do not create new boundaries elsewhere.
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryProvider>
      <HeroProvider>{children}</HeroProvider>
    </QueryProvider>
  );
}
