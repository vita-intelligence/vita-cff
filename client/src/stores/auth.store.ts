/**
 * Client-side auth state.
 *
 * Server state (who is the logged-in user, their roles, their org) lives
 * in TanStack Query. This store only holds *ephemeral client state* that
 * does not belong in the query cache — e.g. "is the login modal open",
 * "remember my email across reloads".
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface AuthUiState {
  rememberedEmail: string | null;
  setRememberedEmail: (email: string | null) => void;
  clearRememberedEmail: () => void;
}

export const useAuthUiStore = create<AuthUiState>()(
  persist(
    (set) => ({
      rememberedEmail: null,
      setRememberedEmail: (email) => set({ rememberedEmail: email }),
      clearRememberedEmail: () => set({ rememberedEmail: null }),
    }),
    {
      name: "vita.auth.ui",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ rememberedEmail: state.rememberedEmail }),
    },
  ),
);
