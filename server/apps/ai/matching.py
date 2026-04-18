"""Fuzzy-match AI-proposed ingredient names against the catalogue.

The AI's draft output uses generic ingredient labels (``"Caffeine"``,
``"Green Tea Extract"``) that have no database ID. This module takes
those strings and a per-ingredient label claim, then scores them
against the organisation's ``raw_materials`` catalogue so the
frontend can render a real :class:`apps.catalogues.models.Item`
reference — matched name, internal code, alternatives for the
scientist to override, and a purity-adjusted ``mg_per_serving``
for the matches we're confident about.

Scoring is a hybrid of **token-set Jaccard** (robust to word order
and stopword noise — "Caffeine Anhydrous Powder" vs "Caffeine"
still scores high) and :class:`difflib.SequenceMatcher`
(catches small typos and letter swaps). Stdlib only — no external
dependency — because at the current catalogue scale (O(10^3)) both
primitives run comfortably under 100 ms per ingredient. Upgrade to
``pg_trgm`` or pgvector when catalogues cross ~50k rows.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal
from difflib import SequenceMatcher

from apps.catalogues.models import Catalogue, Item, RAW_MATERIALS_SLUG
from apps.formulations.services import compute_line
from apps.organizations.models import Organization


#: Confidence above which the frontend defaults to auto-attaching the
#: match as a real formulation line. The threshold is deliberately on
#: the conservative side — a false positive silently swaps in the
#: wrong raw material, whereas a false negative just forces the
#: scientist to pick from the alternatives dropdown.
HIGH_CONFIDENCE_THRESHOLD = 0.75


#: Floor below which we treat the match as noise. A vague AI
#: hallucination ("AI-Powder", "FutureMineralX") usually shares one
#: short token with something in the catalogue and rides back at
#: confidence 0.1-0.25. Suppressing those keeps the UI focused on
#: plausible candidates instead of forcing the scientist to decline
#: a parade of nonsense chips.
MIN_RELEVANCE_THRESHOLD = 0.35


#: How many raw-material candidates AI4 shortlisting feeds into the
#: constrained prompt. Large enough that the LLM can actually build a
#: formulation from the menu (a brief like "fat burner" needs the
#: obvious stimulants + synergists in the list even if none of those
#: words appear in the brief). Small enough that the prompt stays well
#: under the 3B model's context budget — 100 × ~60 chars ≈ 6 KB.
SHORTLIST_LIMIT = 100


#: Words that appear across dozens of raw materials and dilute useful
#: similarity signal. Stripped from both sides before scoring so
#: "Caffeine Anhydrous Powder" and "Caffeine" match on the meaningful
#: token ("caffeine") rather than tying on the filler words.
_STOPWORDS: frozenset[str] = frozenset(
    {
        "powder",
        "extract",
        "anhydrous",
        "usp",
        "bp",
        "ep",
        "pure",
        "natural",
        "dried",
        "milled",
        "ground",
        "premium",
        "pharma",
        "grade",
        "food",
        "raw",
    }
)


_TOKEN_RE = re.compile(r"[a-z0-9]+")


@dataclass(frozen=True)
class CandidateItem:
    """Compact summary of a raw material surfaced to the LLM.

    Only the fields the model needs to pick intelligently make the
    prompt — full catalogue rows would bloat context without helping
    the selection. Purity / extract ratio stay on the line so the AI
    can reason about dosage math when it picks actives like extracts
    ("if I want 200 mg EGCG and this is a 50% extract, set claim to
    400 mg").
    """

    item_id: str
    name: str
    internal_code: str
    purity: str
    extract_ratio: str
    item: Item

    def prompt_line(self) -> str:
        """Single-line catalogue entry the prompt shows to the LLM."""

        parts = [f"[{self.item_id}]", self.name]
        if self.internal_code:
            parts.append(f"code={self.internal_code}")
        if self.purity:
            parts.append(f"purity={self.purity}")
        if self.extract_ratio:
            parts.append(f"extract_ratio={self.extract_ratio}")
        return " | ".join(parts)


@dataclass(frozen=True)
class IngredientAlternative:
    """Second-tier match surfaced so the scientist can override the top
    pick from a dropdown. The frontend ranks these below the matched
    item and renders them dim until selected."""

    item_id: str
    item_name: str
    internal_code: str
    confidence: float


@dataclass(frozen=True)
class IngredientMatch:
    """Catalogue-resolved picture of a single AI ingredient suggestion.

    ``matched_item_id`` is ``None`` when the catalogue was empty or
    every candidate scored zero (e.g. the AI proposed a raw material
    the org simply does not stock). ``mg_per_serving`` carries a
    pre-computed purity-adjusted weight only for high-confidence
    matches — below the threshold we leave the number empty because
    the scientist is about to pick a different item anyway.
    """

    matched_item_id: str | None
    matched_item_name: str
    matched_item_internal_code: str
    confidence: float
    mg_per_serving: str | None
    alternatives: tuple[IngredientAlternative, ...]


def match_ingredients(
    *,
    organization: Organization,
    names_with_claims: list[tuple[str, float]],
    serving_size: int = 1,
) -> list[IngredientMatch]:
    """Return one :class:`IngredientMatch` per input pair.

    ``names_with_claims`` is ordered: output ``[i]`` corresponds to
    input ``[i]``. An org with no raw-materials catalogue (genuinely
    possible during F0 bootstrap) or an empty catalogue returns a
    list of empty matches rather than raising — the UI still surfaces
    the AI's unattached suggestions, just without a real item link.

    ``serving_size`` feeds the purity-adjusted math; the draft uses
    the formulation's serving size so the mg/serving value the user
    sees after creation lines up with what the builder would compute
    once the line is persisted.
    """

    if not names_with_claims:
        return []

    catalogue = Catalogue.objects.filter(
        organization=organization, slug=RAW_MATERIALS_SLUG
    ).first()
    if catalogue is None:
        return [_empty_match() for _ in names_with_claims]

    items = list(
        Item.objects.filter(catalogue=catalogue, is_archived=False)
    )
    if not items:
        return [_empty_match() for _ in names_with_claims]

    # Precompute normalised form + token set per candidate once so the
    # per-query loop below stays linear in the candidate count.
    candidates: list[tuple[Item, str, frozenset[str]]] = [
        (item, _normalise(item.name), frozenset(_tokenise(item.name)))
        for item in items
    ]

    results: list[IngredientMatch] = []
    for name, claim_mg in names_with_claims:
        results.append(
            _match_one(
                query=name,
                claim_mg=claim_mg,
                candidates=candidates,
                serving_size=serving_size,
            )
        )
    return results


def shortlist_candidates(
    *,
    organization: Organization,
    brief: str,
    limit: int = SHORTLIST_LIMIT,
) -> list[CandidateItem]:
    """Return the top-scored raw-material candidates for a brief.

    Feeds the AI4 constrained-menu prompt. Scoring ranks items whose
    name tokens overlap the brief's tokens first; once the keyword
    pool is exhausted we fall back to the remaining catalogue in
    ``name`` order so the LLM always sees a menu big enough to build
    from (a brief like *"fat burner"* shares almost no tokens with
    any specific raw material, but the model still needs "Caffeine
    Anhydrous Powder" et al. on the menu to do its job).

    The returned tuple carries the live :class:`Item` alongside the
    display fields so the caller can feed it straight into
    :func:`apps.formulations.services.compute_line` without re-
    querying.
    """

    catalogue = Catalogue.objects.filter(
        organization=organization, slug=RAW_MATERIALS_SLUG
    ).first()
    if catalogue is None:
        return []

    items = list(
        Item.objects.filter(catalogue=catalogue, is_archived=False)
        .order_by("name")
    )
    if not items:
        return []

    brief_tokens = frozenset(_tokenise(brief))

    scored: list[tuple[float, Item]] = []
    for item in items:
        cand_tokens = frozenset(_tokenise(item.name))
        score = _token_set_ratio(brief_tokens, cand_tokens)
        scored.append((score, item))

    # Primary pool: items the brief shares at least one token with,
    # ranked by token-set Jaccard descending.
    keyword_hits = sorted(
        (pair for pair in scored if pair[0] > 0.0),
        key=lambda pair: pair[0],
        reverse=True,
    )

    selected: list[Item] = [item for _, item in keyword_hits[:limit]]

    if len(selected) < limit:
        # Pad with unmatched items in catalogue order so the menu is
        # long enough to build a formulation from. Order-stable so the
        # prompt is reproducible for the same catalogue state.
        selected_ids = {item.id for item in selected}
        for item in items:
            if len(selected) >= limit:
                break
            if item.id in selected_ids:
                continue
            selected.append(item)

    return [
        CandidateItem(
            item_id=str(item.id),
            name=item.name,
            internal_code=item.internal_code,
            purity=str((item.attributes or {}).get("purity") or ""),
            extract_ratio=str(
                (item.attributes or {}).get("extract_ratio") or ""
            ),
            item=item,
        )
        for item in selected
    ]


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _match_one(
    *,
    query: str,
    claim_mg: float,
    candidates: list[tuple[Item, str, frozenset[str]]],
    serving_size: int,
) -> IngredientMatch:
    q_norm = _normalise(query)
    q_tokens = frozenset(_tokenise(query))
    if not q_norm or not candidates:
        return _empty_match()

    # Score every candidate; the top result plus the next few become
    # alternatives the UI offers when confidence is low.
    scored: list[tuple[float, Item]] = [
        (
            _score(
                query_norm=q_norm,
                query_tokens=q_tokens,
                cand_norm=cand_norm,
                cand_tokens=cand_tokens,
            ),
            item,
        )
        for item, cand_norm, cand_tokens in candidates
    ]
    scored.sort(key=lambda pair: pair[0], reverse=True)

    best_confidence, best_item = scored[0]
    if best_confidence <= 0:
        return _empty_match()

    alternatives: list[IngredientAlternative] = []
    for confidence, item in scored[1:4]:
        if confidence <= 0:
            break
        alternatives.append(
            IngredientAlternative(
                item_id=str(item.id),
                item_name=item.name,
                internal_code=item.internal_code,
                confidence=round(confidence, 4),
            )
        )

    mg_per_serving: str | None = None
    if best_confidence >= HIGH_CONFIDENCE_THRESHOLD and claim_mg > 0:
        mg = compute_line(
            item=best_item,
            label_claim_mg=Decimal(str(claim_mg)),
            serving_size=serving_size,
        )
        mg_per_serving = str(mg) if mg is not None else None

    return IngredientMatch(
        matched_item_id=str(best_item.id),
        matched_item_name=best_item.name,
        matched_item_internal_code=best_item.internal_code,
        confidence=round(best_confidence, 4),
        mg_per_serving=mg_per_serving,
        alternatives=tuple(alternatives),
    )


def _empty_match() -> IngredientMatch:
    return IngredientMatch(
        matched_item_id=None,
        matched_item_name="",
        matched_item_internal_code="",
        confidence=0.0,
        mg_per_serving=None,
        alternatives=(),
    )


def _score(
    *,
    query_norm: str,
    query_tokens: frozenset[str],
    cand_norm: str,
    cand_tokens: frozenset[str],
) -> float:
    """Hybrid similarity: max(token-set Jaccard, sequence ratio).

    Token-set handles word-order and filler-word noise; sequence ratio
    catches small typos and prefix/suffix differences. Using ``max``
    keeps either primitive from dragging the other down — an exact
    substring match with extra filler words should score highly even
    when the raw character ratio looks weak.
    """

    token_score = _token_set_ratio(query_tokens, cand_tokens)
    sequence_score = (
        SequenceMatcher(None, query_norm, cand_norm).ratio()
        if query_norm and cand_norm
        else 0.0
    )
    return max(token_score, sequence_score)


def _token_set_ratio(
    query: frozenset[str], candidate: frozenset[str]
) -> float:
    if not query or not candidate:
        return 0.0
    intersection = query & candidate
    if not intersection:
        return 0.0
    union = query | candidate
    return len(intersection) / len(union)


def _normalise(name: str) -> str:
    """Lowercase + strip punctuation + collapse whitespace + drop
    stopwords. Used as the input to :class:`difflib.SequenceMatcher`.

    Falls back to the unfiltered token stream when stopword stripping
    would leave an empty string (e.g. the AI proposed just ``"Powder"``)
    — we would rather match weakly than not at all.
    """

    return " ".join(_tokenise(name))


def _tokenise(name: str) -> list[str]:
    if not name:
        return []
    tokens = _TOKEN_RE.findall(name.lower())
    # Require tokens of at least 3 characters so single- and
    # two-letter noise (``ai``, ``mg``, ``b1``) can't land a false
    # positive off a two-character overlap with catalogue words.
    # Common three-letter actives like ``CoQ`` or ``DHA`` still pass.
    filtered = [t for t in tokens if t not in _STOPWORDS and len(t) > 2]
    return filtered or tokens
