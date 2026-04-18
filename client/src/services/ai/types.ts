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


/** Second-tier catalogue match the UI offers in the override
 *  chooser when the top pick is low-confidence. */
export interface IngredientAlternativeDto {
  readonly item_id: string;
  readonly item_name: string;
  readonly internal_code: string;
  readonly confidence: number;
}


/** One ingredient the AI wants in the formulation, enriched with the
 *  server-side catalogue match (AI3). ``matched_item_id`` is ``null``
 *  when the org's raw-materials catalogue is empty or no candidate
 *  scored above zero — the UI then shows the raw AI name as an
 *  unattached chip. ``auto_attach=true`` is the signal that the
 *  match is strong enough to include in the formulation without the
 *  scientist's explicit pick. */
export interface IngredientSuggestionDto {
  readonly name: string;
  readonly label_claim_mg: number;
  readonly notes: string;
  readonly matched_item_id: string | null;
  readonly matched_item_name: string;
  readonly matched_item_internal_code: string;
  readonly confidence: number;
  /** Lossless string (``Decimal`` on the wire) — parse with
   *  ``Number()`` for display, never for arithmetic that flows back. */
  readonly mg_per_serving: string | null;
  readonly alternatives: readonly IngredientAlternativeDto[];
  readonly auto_attach: boolean;
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
