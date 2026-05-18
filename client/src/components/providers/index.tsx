"use client";

import type { ReactNode } from "react";

import { MessengerProvider } from "@/components/messenger";

import { HeroProvider } from "./hero-provider";
import { QueryProvider } from "./query-provider";

/**
 * Single top-level Client-Component boundary.
 *
 * Order matters: the query provider wraps everything else so hooks
 * inside HeroUI-rendered children can still reach it.
 * :component:`MessengerProvider` sits below ``QueryProvider`` because
 * it owns TanStack Query invalidations on inbox WS events; it sits
 * above ``HeroProvider`` so the floating chat stack rendered by the
 * messenger can use HeroUI primitives.
 *
 * Add new providers by nesting them inside this composition — do not
 * create new boundaries elsewhere.
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryProvider>
      <MessengerProvider>
        <HeroProvider>{children}</HeroProvider>
      </MessengerProvider>
    </QueryProvider>
  );
}
