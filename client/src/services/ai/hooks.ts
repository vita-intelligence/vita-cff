/**
 * TanStack Query hooks for the AI domain.
 */

import { useMutation, type UseMutationResult } from "@tanstack/react-query";

import type { ApiError } from "@/lib/api";

import { generateFormulationDraft } from "./api";
import type {
  FormulationDraftRequestDto,
  FormulationDraftResponseDto,
} from "./types";


export function useGenerateFormulationDraft(
  orgId: string,
): UseMutationResult<
  FormulationDraftResponseDto,
  ApiError,
  FormulationDraftRequestDto
> {
  return useMutation<
    FormulationDraftResponseDto,
    ApiError,
    FormulationDraftRequestDto
  >({
    mutationFn: (payload) => generateFormulationDraft(orgId, payload),
  });
}
