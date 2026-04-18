/**
 * Transport types for the AI domain.
 *
 * Mirrors the backend serializers in ``apps/ai/api/serializers.py``.
 * Field names match ``Formulation`` so a draft payload slots directly
 * into :class:`CreateFormulationRequestDto` — no per-field mapping
 * needed when the user confirms and clicks Create.
 */


/** Registered provider slugs. As new adapters ship they're added
 *  both here and on the backend registry (`apps/ai/models.py`). */
export type AIProviderSlug = "ollama" | "openai" | "anthropic";


export interface FormulationDraftRequestDto {
  readonly brief: string;
  /** Optional — defaults to ``ollama`` server-side. */
  readonly provider?: AIProviderSlug;
  /** Optional model override (e.g. ``"llama3.1:70b"``). Empty
   *  string / omitted = server's configured default. */
  readonly model?: string;
}


/** One ingredient the AI wants in the formulation. Not yet matched
 *  to a real catalogue row — AI3 adds the server-side matching
 *  layer and this interface will grow ``item_id?: string | null``. */
export interface IngredientSuggestionDto {
  readonly name: string;
  readonly label_claim_mg: number;
  readonly notes: string;
}


/** Structured draft returned by ``POST /ai/formulation-draft/``.
 *  Every metadata field lines up with ``CreateFormulationRequestDto``
 *  so forwarding straight to /formulations POST is a one-liner. */
export interface FormulationDraftResponseDto {
  readonly name: string;
  readonly code: string;
  readonly description: string;
  readonly dosage_form: string;
  readonly capsule_size: string;
  readonly tablet_size: string;
  readonly serving_size: number;
  readonly servings_per_pack: number;
  readonly directions_of_use: string;
  readonly suggested_dosage: string;
  readonly appearance: string;
  readonly disintegration_spec: string;
  readonly ingredients: readonly IngredientSuggestionDto[];
}
