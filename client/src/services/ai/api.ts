/**
 * Raw Axios calls for the AI domain.
 */

import { apiClient } from "@/lib/api";

import { aiEndpoints } from "./endpoints";
import type {
  FormulationDraftRequestDto,
  FormulationDraftResponseDto,
} from "./types";


// Local-model inference runs serially and the first call pays the
// model-load cost (tens of seconds on a cold Ollama). The global
// apiClient timeout is tuned for CRUD — we override here so legitimate
// AI calls aren't aborted mid-flight. Keep this in lockstep with the
// backend ``AI_PROVIDER_TIMEOUT_SECONDS`` setting so a provider-level
// timeout surfaces as a 504 rather than an axios abort.
const AI_REQUEST_TIMEOUT_MS = 180_000;


export async function generateFormulationDraft(
  orgId: string,
  payload: FormulationDraftRequestDto,
): Promise<FormulationDraftResponseDto> {
  const { data } = await apiClient.post<FormulationDraftResponseDto>(
    aiEndpoints.formulationDraft(orgId),
    payload,
    { timeout: AI_REQUEST_TIMEOUT_MS },
  );
  return data;
}
