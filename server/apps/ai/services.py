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

import json
import logging
import time
from dataclasses import asdict, dataclass
from decimal import Decimal
from typing import Any

logger = logging.getLogger(__name__)

from apps.ai.matching import (
    HIGH_CONFIDENCE_THRESHOLD,
    MIN_RELEVANCE_THRESHOLD,
    CandidateItem,
    IngredientAlternative,
    IngredientMatch,
    match_ingredients,
    shortlist_candidates,
)
from apps.ai.models import AIProviderChoices, AIUsage, AIUsagePurpose
from apps.formulations.services import compute_line
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


_FORMULATION_DRAFT_PROMPT_TEMPLATE = """\
You are a senior nutraceutical R&D scientist building product
formulations from customer briefs.

## Rules (follow exactly, no exceptions)

1. Respond with valid JSON ONLY. No prose, no markdown, no commentary,
   no code fences. Your output is parsed by a machine.
2. You may use ONLY the raw materials listed in the catalogue below.
   Never invent, guess, or paraphrase raw material names.
3. EVERY ingredient object MUST include an ``item_id`` field. The
   value MUST be copied VERBATIM from a ``[...]`` entry in the
   catalogue — including all hyphens and characters. An ingredient
   WITHOUT an ``item_id`` is INVALID and will be rejected.
4. If the brief mentions an ingredient that is not in the catalogue,
   either substitute the closest catalogue item (and say so in
   ``notes``) or omit that ingredient entirely. Never emit a made-up
   name.
5. Fill every other top-level field. Use empty strings or empty
   arrays only when the brief truly provides no information.

## Dosage rules (the formulation must physically fit)

The product is packed into a capsule or tablet. Total raw powder
weight has a hard cap:

- Capsule Double-00: max 730 mg
- Capsule 00:        max 680 mg
- Capsule 0:         max 450 mg
- Capsule 1:         max 400 mg
- Capsule 3:         max 180 mg
- Tablet typical:    800-1500 mg depending on size

For every active: ``raw_powder_mg = label_claim_mg / purity``. The sum
of raw_powder_mg across ALL ingredients must stay under the max fill
weight, leaving ~30% headroom for excipients (MCC, magnesium stearate,
silica). In practice: keep the sum of raw_powder_mg under 500 mg for
capsules and under 1000 mg for tablets.

## What ``label_claim_mg`` means

``label_claim_mg`` is the PURE ACTIVE weight printed on the product
label — NOT the raw powder weight. A raw material sold as
"500,000 IU/g" has very low purity (tiny amount of real active in a
carrier) so tiny ``label_claim_mg`` values (0.01-0.1 mg) blow up into
reasonable raw powder weights. Never set a double-digit claim on a
raw material whose purity is below ~0.05.

Safe label-claim ranges by ingredient class:

- Vitamin A, D, E, K:         0.005 - 0.1 mg  (micrograms)
- Vitamin B12, B9 (folate):   0.001 - 0.4 mg  (micrograms)
- Vitamin B1, B2, B3, B5, B6: 1 - 100 mg
- Vitamin C:                  50 - 1000 mg
- Minerals (iron, zinc, etc): 5 - 500 mg
- Botanical extracts:         50 - 500 mg
- Amino acids:                500 - 3000 mg
- Fibre / protein / creatine: 500 - 5000 mg (powders/sachets only)

When unsure, err low. The scientist can always raise a claim later;
if you overshoot the capsule max the whole formulation is wasted.

## Raw material catalogue (the ONLY ingredients you may pick)

Format: ``[item_id] | Name | code=... | purity=... | extract_ratio=...``
The ``item_id`` is the UUID between the square brackets. Copy it
verbatim. ``purity`` is the fraction of pure active per gram of raw
powder (0.89 = 89% pure).

{catalogue_menu}

## Ingredient example (exact shape — copy it every time)

An ingredient object always has these four fields. ``item_id`` is
ALWAYS present:

{{
  "item_id": "{example_item_id}",
  "name": "{example_item_name}",
  "label_claim_mg": 200,
  "notes": "example rationale"
}}

(Note: the line above is only a shape example — your real pick must
match the brief, not this placeholder.)

## Full JSON schema (all top-level keys required)

{{
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
  "ingredients": [                   // active ingredients only — no excipients
    {{
      "item_id": string,             // REQUIRED — copy verbatim from the catalogue above
      "name": string,                // the raw material name (copy from the catalogue)
      "label_claim_mg": number,      // per-serving label claim in mg
      "notes": string                // short rationale, can be empty
    }}
  ]
}}

## Final reminder

Every ingredient MUST have an ``item_id`` from the catalogue. Not
one without. Check your output before finishing.
"""


def _build_formulation_draft_prompt(
    candidates: list[CandidateItem],
) -> str:
    """Bake the per-request catalogue menu into the prompt template.

    Runs once per request. Small models (~3B) often drop required
    fields when the schema is abstract, so the template anchors the
    expected ingredient shape with a *concrete* example lifted from
    the first catalogue entry. Empirically this makes llama3.2:3b
    emit ``item_id`` far more reliably.

    Kept as a separate function so the prompt stays deterministic
    per catalogue state — same inputs, same prompt string — which is
    easier to reason about when debugging why the model picked what.
    """

    if not candidates:
        # Rare: org has no raw materials yet. The model gets a clear
        # instruction that it cannot attach ingredients — the service
        # will still accept a header-only draft so the scientist can
        # at least start the workspace.
        return _FORMULATION_DRAFT_PROMPT_TEMPLATE.format(
            catalogue_menu=(
                "(The organisation's raw_materials catalogue is empty. "
                "Return ingredients=[] in the response.)"
            ),
            example_item_id="",
            example_item_name="",
        )
    catalogue_menu = "\n".join(
        candidate.prompt_line() for candidate in candidates
    )
    # Concrete example anchors the shape for small models. We pick
    # the first candidate to keep the prompt deterministic — any
    # catalogue entry works equally well as a template.
    example = candidates[0]
    return _FORMULATION_DRAFT_PROMPT_TEMPLATE.format(
        catalogue_menu=catalogue_menu,
        example_item_id=example.item_id,
        example_item_name=example.name.replace('"', ""),
    )


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
    # AI4 — build the catalogue menu the LLM picks from BEFORE the
    # provider call so the request carries the constrained prompt.
    # The shortlister is local (Postgres + token math), so the
    # latency cost is negligible relative to the LLM round-trip.
    candidates = shortlist_candidates(
        organization=organization, brief=brief
    )
    candidates_by_id: dict[str, CandidateItem] = {
        candidate.item_id: candidate for candidate in candidates
    }
    system_prompt = _build_formulation_draft_prompt(candidates)

    start = time.monotonic()
    try:
        result: AIProviderResult = provider.generate_json(
            system_prompt=system_prompt,
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
        # Ship a snapshot of the bad payload to the server log so we
        # can see exactly which field the model botched. Truncated
        # aggressively because some models emit very long responses
        # when confused. Log level is warning — this is recoverable
        # on the client (generic error) but actionable for ops.
        logger.warning(
            "AI response failed schema validation: %s (model=%s); raw data (truncated): %s",
            exc,
            result.model,
            json.dumps(result.data, default=str)[:2000]
            if result.data is not None
            else "<empty>",
        )
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

    # AI4 — trust the catalogue ``item_id`` the constrained prompt
    # asked the LLM to copy verbatim; fall back to AI3 fuzzy matching
    # on the name only when the model hallucinates an id that isn't
    # on the menu. Both paths share the same ``IngredientMatch``
    # shape so the frontend renders uniformly.
    draft = _enrich_with_matches(
        draft=draft,
        organization=organization,
        candidates_by_id=candidates_by_id,
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
    candidates_by_id: dict[str, CandidateItem],
) -> FormulationDraft:
    """Attach a catalogue match to each ingredient on the draft.

    AI4 asks the LLM to emit an ``item_id`` copied verbatim from the
    catalogue menu. Each ingredient is resolved in one of three ways:

    1. **Valid id path** — the id is present in ``candidates_by_id``.
       We take it at face value with ``confidence=1.0`` and compute
       ``mg_per_serving`` from the real catalogue item's purity.
    2. **Fuzzy fallback path** — the model hallucinated an id (empty,
       mis-typed, or simply invented) but the name it provided fuzzy-
       matches a catalogue item above the relevance floor. We surface
       the match so the scientist can accept or swap.
    3. **Silently dropped** — the name doesn't meaningfully match
       anything (vague briefs coax small models into inventing
       "AI-Powder" / "FutureMineralX"). Below the floor we skip the
       ingredient entirely rather than paint the UI with nonsense.
    """

    ingredients = list(draft.ingredients)
    if not ingredients:
        return draft

    # Separate ingredients by resolution path. Fuzzy matches batch
    # together so the matcher pays one catalogue scan for all of
    # them.
    fallback_indices: list[int] = []
    fallback_inputs: list[tuple[str, float]] = []
    for idx, ingredient in enumerate(ingredients):
        if ingredient.matched_item_id not in candidates_by_id:
            fallback_indices.append(idx)
            fallback_inputs.append(
                (ingredient.name, ingredient.label_claim_mg)
            )

    fallback_matches: list[IngredientMatch] = (
        match_ingredients(
            organization=organization,
            names_with_claims=fallback_inputs,
            serving_size=draft.serving_size or 1,
        )
        if fallback_inputs
        else []
    )
    fallback_by_index = dict(zip(fallback_indices, fallback_matches))

    enriched: list[IngredientSuggestion] = []
    for idx, ingredient in enumerate(ingredients):
        candidate = candidates_by_id.get(ingredient.matched_item_id or "")
        if candidate is not None:
            mg = compute_line(
                item=candidate.item,
                label_claim_mg=Decimal(str(ingredient.label_claim_mg))
                if ingredient.label_claim_mg > 0
                else Decimal("0"),
                serving_size=draft.serving_size or 1,
            )
            enriched.append(
                IngredientSuggestion(
                    name=candidate.name,
                    label_claim_mg=ingredient.label_claim_mg,
                    notes=ingredient.notes,
                    matched_item_id=candidate.item_id,
                    matched_item_name=candidate.name,
                    matched_item_internal_code=candidate.internal_code,
                    confidence=1.0,
                    mg_per_serving=str(mg) if mg is not None else None,
                    alternatives=(),
                    auto_attach=True,
                )
            )
            continue

        # Fallback: the model returned a name we couldn't resolve
        # directly. Use whatever AI3 fuzzy match we ran above, and
        # drop the ingredient entirely when it falls below the
        # relevance floor (the AI usually invents something with no
        # real analogue in this case).
        match = fallback_by_index.get(idx)
        if match is None or match.confidence < MIN_RELEVANCE_THRESHOLD:
            continue
        enriched.append(
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
        )

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
        # AI4 asks the model to copy ``item_id`` verbatim from the
        # catalogue menu. Capture it here as a best-effort hint; the
        # enrichment step validates it against the shortlist and
        # falls back to name-based matching when the id is missing
        # or not on the menu.
        raw_item_id = row.get("item_id")
        item_id = (
            str(raw_item_id).strip()
            if isinstance(raw_item_id, str) and raw_item_id.strip()
            else None
        )
        if not name and not item_id:
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
                matched_item_id=item_id,
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
