"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import type { ReactNode } from "react";

import { getQueryClient } from "@/lib/query";

/**
 * TanStack Query provider.
 *
 * A single ``QueryClient`` lives per browser tab — see ``getQueryClient``
 * for the server/client split. Devtools are only mounted while
 * ``NODE_ENV !== 'production'`` so they are tree-shaken from the prod bundle.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const queryClient = getQueryClient();
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {process.env.NODE_ENV !== "production" ? (
        <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-right" />
      ) : null}
    </QueryClientProvider>
  );
}
