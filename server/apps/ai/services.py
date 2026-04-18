"""Service layer for the AI app.

Exposes one function per user-facing "purpose" (e.g.
:func:`generate_formulation_draft`). Each one:

1. Calls the configured provider.
2. Schema-checks the response (no missing fields, no wrong types).
3. Records exactly one :class:`AIUsage` row — success or failure —
   so the owner-facing dashboard and future billing have complete
   data.

Nothing here decides HTTP status codes — service errors raise typed
exceptions and the view layer maps them.
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass
from typing import Any

from apps.ai.matching import (
    HIGH_CONFIDENCE_THRESHOLD,
    IngredientAlternative,
    IngredientMatch,
    match_ingredients,
)
from apps.ai.models import AIProviderChoices, AIUsage, AIUsagePurpose
from apps.ai.providers import (
    AIProvider,
    AIProviderError,
    AIProviderResult,
    get_provider,
)
from apps.organizations.models import Organization


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class AIServiceError(Exception):
    """Base class for service-layer errors mapped to API codes."""

    code: str = "ai_service_error"


class AIResponseInvalid(AIServiceError):
    """Provider returned JSON that doesn't match the expected schema."""

    code = "ai_response_invalid"


# ---------------------------------------------------------------------------
# Formulation draft
# ---------------------------------------------------------------------------


#: Subset of ``Formulation.DOSAGE_FORM`` values we ask the AI to emit.
#: Kept in a constant so the prompt and the schema validator stay in
#: sync with what the formulations app accepts on POST.
_ALLOWED_DOSAGE_FORMS: tuple[str, ...] = (
    "capsule",
    "tablet",
    "powder",
    "gummy",
    "liquid",
    "other_solid",
)


@dataclass(frozen=True)
class IngredientSuggestion:
    """A single proposed ingredient the AI wants in the formulation.

    AI3 augments the raw AI output with a catalogue match so the
    frontend can render a real :class:`apps.catalogues.models.Item`
    reference (name, internal code, alternatives) rather than an
    unattached string. ``matched_item_id`` stays ``None`` when the
    org has no raw-materials catalogue or no candidate scored above
    zero — the UI then shows the raw AI name as an unattached chip.
    """

    name: str
    label_claim_mg: float
    notes: str
    matched_item_id: str | None = None
    matched_item_name: str = ""
    matched_item_internal_code: str = ""
    confidence: float = 0.0
    #: Stringified :class:`decimal.Decimal` so the wire representation
    #: stays lossless (floats drift on JSON roundtrips). Populated
    #: only when confidence meets the auto-attach threshold.
    mg_per_serving: str | None = None
    alternatives: tuple[IngredientAlternative, ...] = ()
    #: ``True`` when confidence ≥ ``HIGH_CONFIDENCE_THRESHOLD`` — the
    #: UI auto-ticks these for inclusion in the formulation, leaving
    #: low-confidence suggestions behind the explicit chooser.
    auto_attach: bool = False


@dataclass(frozen=True)
class FormulationDraft:
    """Structured output the frontend uses to pre-fill the New project form."""

    name: str
    code: str
    description: str
    dosage_form: str
    capsule_size: str
    tablet_size: str
    serving_size: int
    servings_per_pack: int
    directions_of_use: str
    suggested_dosage: str
    appearance: str
    disintegration_spec: str
    ingredients: list[IngredientSuggestion]


_FORMULATION_DRAFT_SYSTEM_PROMPT = """\
You are a senior nutraceutical R&D scientist. You draft product
formulations from a customer brief. Always respond with valid JSON
matching EXACTLY the schema described below — no prose, no markdown,
no commentary. Fill every field; use empty strings or empty arrays
only when the brief truly provides no information.

Schema (all keys required):

{
  "name": string,                    // commercial product name
  "code": string,                    // short internal code, e.g. "FB-001"
  "description": string,             // 1-2 sentences
  "dosage_form": one of ["capsule","tablet","powder","gummy","liquid","other_solid"],
  "capsule_size": string,            // "" when dosage_form != "capsule"
  "tablet_size": string,             // "" when dosage_form != "tablet"
  "serving_size": integer,           // units per serving (usually 1-2)
  "servings_per_pack": integer,      // total units per pack
  "directions_of_use": string,
  "suggested_dosage": string,
  "appearance": string,              // colour + form, e.g. "white capsule"
  "disintegration_spec": string,     // e.g. "Disintegrate within 60 minutes"
  "ingredients": [                   // active ingredients
    {
      "name": string,                // generic ingredient name
      "label_claim_mg": number,      // per-serving label claim in mg
      "notes": string                // short rationale, can be empty
    }
  ]
}
"""


def generate_formulation_draft(
    *,
    organization: Organization,
    actor: Any,
    brief: str,
    provider_name: str = AIProviderChoices.OLLAMA,
    model: str | None = None,
) -> FormulationDraft:
    """Turn a natural-language brief into a :class:`FormulationDraft`.

    Writes one :class:`AIUsage` row whether the call succeeds or not.
    Raises :class:`AIResponseInvalid` if the provider returns JSON that
    doesn't match the expected shape; bubbles :class:`AIProviderError`
    subclasses for transport / timeout / malformed-JSON failures.
    """

    provider: AIProvider = get_provider(provider_name)
    selected_model_for_error_row = model or ""
    start = time.monotonic()
    try:
        result: AIProviderResult = provider.generate_json(
            system_prompt=_FORMULATION_DRAFT_SYSTEM_PROMPT,
            user_prompt=brief,
            model=model,
        )
    except AIProviderError as exc:
        _record_usage(
            organization=organization,
            actor=actor,
            provider_name=provider_name,
            model=selected_model_for_error_row,
            purpose=AIUsagePurpose.FORMULATION_DRAFT,
            started=start,
            success=False,
            error_code=getattr(exc, "code", "provider_error"),
        )
        raise

    try:
        draft = _parse_formulation_draft(result.data)
    except AIResponseInvalid as exc:
        _record_usage(
            organization=organization,
            actor=actor,
            provider_name=provider_name,
            model=result.model,
            purpose=AIUsagePurpose.FORMULATION_DRAFT,
            started=start,
            success=False,
            error_code=exc.code,
            prompt_tokens=result.prompt_tokens,
            completion_tokens=result.completion_tokens,
        )
        raise

    # AI3 — resolve the generic ingredient names the model emits into
    # real ``Item`` references from the org's raw-materials catalogue
    # and a purity-adjusted mg/serving number. A matching failure does
    # not fail the draft: the UI still surfaces the unattached
    # suggestion and lets the scientist pick manually.
    draft = _enrich_with_matches(
        draft=draft, organization=organization
    )

    _record_usage(
        organization=organization,
        actor=actor,
        provider_name=provider_name,
        model=result.model,
        purpose=AIUsagePurpose.FORMULATION_DRAFT,
        started=start,
        success=True,
        prompt_tokens=result.prompt_tokens,
        completion_tokens=result.completion_tokens,
    )
    return draft


def _enrich_with_matches(
    *,
    draft: FormulationDraft,
    organization: Organization,
) -> FormulationDraft:
    """Attach a catalogue match to each ingredient on the draft.

    Matching runs once against all names so the catalogue query is
    paid a single time per request. Returning a new draft
    (``dataclass.replace`` on each ingredient) keeps the original
    frozen dataclasses immutable, matching the rest of the service
    layer's style.
    """

    ingredients = list(draft.ingredients)
    if not ingredients:
        return draft

    names_with_claims = [
        (ingredient.name, ingredient.label_claim_mg)
        for ingredient in ingredients
    ]
    matches: list[IngredientMatch] = match_ingredients(
        organization=organization,
        names_with_claims=names_with_claims,
        serving_size=draft.serving_size or 1,
    )
    enriched: list[IngredientSuggestion] = [
        IngredientSuggestion(
            name=ingredient.name,
            label_claim_mg=ingredient.label_claim_mg,
            notes=ingredient.notes,
            matched_item_id=match.matched_item_id,
            matched_item_name=match.matched_item_name,
            matched_item_internal_code=match.matched_item_internal_code,
            confidence=match.confidence,
            mg_per_serving=match.mg_per_serving,
            alternatives=match.alternatives,
            auto_attach=(
                match.matched_item_id is not None
                and match.confidence >= HIGH_CONFIDENCE_THRESHOLD
            ),
        )
        for ingredient, match in zip(ingredients, matches)
    ]
    return FormulationDraft(
        name=draft.name,
        code=draft.code,
        description=draft.description,
        dosage_form=draft.dosage_form,
        capsule_size=draft.capsule_size,
        tablet_size=draft.tablet_size,
        serving_size=draft.serving_size,
        servings_per_pack=draft.servings_per_pack,
        directions_of_use=draft.directions_of_use,
        suggested_dosage=draft.suggested_dosage,
        appearance=draft.appearance,
        disintegration_spec=draft.disintegration_spec,
        ingredients=enriched,
    )


def _parse_formulation_draft(data: dict[str, Any]) -> FormulationDraft:
    """Validate + coerce the provider's raw JSON into the typed draft.

    Permissive on optional detail (notes, descriptions), strict on
    fields that must slot straight into the Formulation model. Any
    missing required field raises :class:`AIResponseInvalid`.
    """

    dosage_form = _str(data, "dosage_form", required=True)
    if dosage_form not in _ALLOWED_DOSAGE_FORMS:
        raise AIResponseInvalid(
            f"dosage_form {dosage_form!r} not one of {_ALLOWED_DOSAGE_FORMS}"
        )

    ingredients_raw = data.get("ingredients")
    if not isinstance(ingredients_raw, list):
        raise AIResponseInvalid("ingredients must be an array")
    ingredients: list[IngredientSuggestion] = []
    for row in ingredients_raw:
        if not isinstance(row, dict):
            continue
        name = _str(row, "name", required=False).strip()
        if not name:
            continue
        raw_claim = row.get("label_claim_mg")
        try:
            claim = float(raw_claim) if raw_claim is not None else 0.0
        except (TypeError, ValueError):
            claim = 0.0
        ingredients.append(
            IngredientSuggestion(
                name=name,
                label_claim_mg=max(0.0, claim),
                notes=_str(row, "notes", required=False),
            )
        )

    return FormulationDraft(
        name=_str(data, "name", required=True),
        code=_str(data, "code", required=False),
        description=_str(data, "description", required=False),
        dosage_form=dosage_form,
        capsule_size=_str(data, "capsule_size", required=False),
        tablet_size=_str(data, "tablet_size", required=False),
        serving_size=_int(data, "serving_size", default=1),
        servings_per_pack=_int(data, "servings_per_pack", default=60),
        directions_of_use=_str(data, "directions_of_use", required=False),
        suggested_dosage=_str(data, "suggested_dosage", required=False),
        appearance=_str(data, "appearance", required=False),
        disintegration_spec=_str(data, "disintegration_spec", required=False),
        ingredients=ingredients,
    )


def _str(data: dict[str, Any], key: str, *, required: bool) -> str:
    value = data.get(key)
    if value is None or value == "":
        if required:
            raise AIResponseInvalid(f"missing required field: {key}")
        return ""
    if not isinstance(value, str):
        raise AIResponseInvalid(f"field {key} must be a string")
    return value.strip()


def _int(data: dict[str, Any], key: str, *, default: int) -> int:
    value = data.get(key)
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _record_usage(
    *,
    organization: Organization,
    actor: Any,
    provider_name: str,
    model: str,
    purpose: str,
    started: float,
    success: bool,
    error_code: str = "",
    prompt_tokens: int | None = None,
    completion_tokens: int | None = None,
) -> None:
    """Write one :class:`AIUsage` row.

    ``actor`` can be ``None`` (system-triggered flows later on); the
    FK on the model allows it via ``SET_NULL`` so accounting still
    ties back to the organization.
    """

    latency_ms = int((time.monotonic() - started) * 1000)
    AIUsage.objects.create(
        organization=organization,
        user=actor,
        provider=provider_name,
        model=model,
        purpose=purpose,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        latency_ms=latency_ms,
        success=success,
        error_code=error_code,
    )


def draft_to_dict(draft: FormulationDraft) -> dict[str, Any]:
    """Serialize a :class:`FormulationDraft` for the wire."""

    return asdict(draft)
