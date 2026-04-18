"""Unit tests for the catalogue matcher.

Exercises :func:`apps.ai.matching.match_ingredients` with a seeded
raw-materials catalogue so the end-to-end scoring (token-set ∪
sequence ratio, stopword filtering, purity-adjusted mg math) is
covered deterministically without touching the AI provider layer.
"""

from __future__ import annotations

import pytest
from decimal import Decimal

from apps.ai.matching import (
    HIGH_CONFIDENCE_THRESHOLD,
    SHORTLIST_LIMIT,
    match_ingredients,
    shortlist_candidates,
)
from apps.catalogues.models import Catalogue, Item, RAW_MATERIALS_SLUG
from apps.catalogues.tests.factories import (
    ItemFactory,
    raw_materials_catalogue,
)
from apps.organizations.tests.factories import OrganizationFactory

pytestmark = pytest.mark.django_db


def _seed(
    organization, *specs: dict
) -> list[Item]:
    """Create items in the org's raw_materials catalogue from specs."""

    catalogue = raw_materials_catalogue(organization)
    return [
        ItemFactory(catalogue=catalogue, **spec) for spec in specs
    ]


class TestMatchIngredients:
    def test_no_ingredients_returns_empty(self) -> None:
        org = OrganizationFactory()
        assert match_ingredients(
            organization=org, names_with_claims=[]
        ) == []

    def test_empty_catalogue_returns_empty_matches(self) -> None:
        org = OrganizationFactory()
        results = match_ingredients(
            organization=org,
            names_with_claims=[("Caffeine", 200.0)],
        )
        assert len(results) == 1
        assert results[0].matched_item_id is None
        assert results[0].confidence == 0.0
        assert results[0].alternatives == ()

    def test_missing_raw_materials_catalogue_does_not_raise(self) -> None:
        """A pathological org without the seeded catalogue still
        returns empty matches rather than 500ing the request."""

        org = OrganizationFactory()
        Catalogue.objects.filter(
            organization=org, slug=RAW_MATERIALS_SLUG
        ).delete()

        results = match_ingredients(
            organization=org,
            names_with_claims=[("Caffeine", 200.0)],
        )
        assert results == [
            results[0]  # empty match
        ]
        assert results[0].matched_item_id is None

    def test_exact_name_lands_high_confidence(self) -> None:
        org = OrganizationFactory()
        [item] = _seed(
            org,
            {
                "name": "Caffeine Anhydrous Powder",
                "attributes": {"purity": "0.89"},
            },
        )
        results = match_ingredients(
            organization=org,
            names_with_claims=[("Caffeine Anhydrous Powder", 200.0)],
        )
        assert results[0].matched_item_id == str(item.id)
        assert results[0].confidence >= 0.95
        # 200 mg label claim at 89% purity → ~224.72 mg raw powder
        # Matches the workbook's ``Valley Low Fat Burner`` cascade.
        assert results[0].mg_per_serving is not None
        assert Decimal(results[0].mg_per_serving) > Decimal("224.0")
        assert Decimal(results[0].mg_per_serving) < Decimal("225.0")

    def test_stopword_noise_still_matches(self) -> None:
        """AI often emits short generic names ("Caffeine") while the
        catalogue stores verbose variants ("Caffeine Anhydrous Powder
        USP"). Both should land on the same item."""

        org = OrganizationFactory()
        [item] = _seed(
            org,
            {
                "name": "Caffeine Anhydrous Powder USP",
                "attributes": {"purity": "0.99"},
            },
        )
        results = match_ingredients(
            organization=org,
            names_with_claims=[("Caffeine", 100.0)],
        )
        assert results[0].matched_item_id == str(item.id)
        assert results[0].confidence >= HIGH_CONFIDENCE_THRESHOLD

    def test_low_confidence_skips_mg_calculation(self) -> None:
        """Below the auto-attach threshold the UI is about to show a
        chooser, so we do not pre-compute a purity-adjusted mg that
        would have to be recalculated as soon as the user picks a
        different item."""

        org = OrganizationFactory()
        _seed(
            org,
            {
                "name": "Spirulina Powder",
                "attributes": {"purity": "1.0"},
            },
        )
        results = match_ingredients(
            organization=org,
            names_with_claims=[("Ashwagandha Extract", 300.0)],
        )
        # Top pick still returns *something* so the UI can show a
        # chooser — the confidence number is what tells the frontend
        # not to auto-attach.
        assert results[0].matched_item_id is not None
        assert results[0].confidence < HIGH_CONFIDENCE_THRESHOLD
        assert results[0].mg_per_serving is None

    def test_alternatives_are_ranked_and_capped(self) -> None:
        org = OrganizationFactory()
        _seed(
            org,
            {"name": "Green Tea Extract 50% Polyphenols"},
            {"name": "Green Tea Leaf Powder"},
            {"name": "Green Tea Extract 95% EGCG"},
            {"name": "Matcha Green Tea Powder"},
            {"name": "Completely Unrelated Raw Material"},
        )
        results = match_ingredients(
            organization=org,
            names_with_claims=[("Green Tea Extract", 500.0)],
        )
        alternatives = results[0].alternatives
        # Up to 3 alternatives; ordered by confidence descending.
        assert len(alternatives) <= 3
        scores = [alt.confidence for alt in alternatives]
        assert scores == sorted(scores, reverse=True)

    def test_zero_claim_skips_mg_even_when_confident(self) -> None:
        """A label claim of zero (AI filled an ingredient with a
        placeholder claim) should match catalogue-wise but not emit
        a phantom mg_per_serving."""

        org = OrganizationFactory()
        _seed(
            org,
            {
                "name": "Caffeine Anhydrous",
                "attributes": {"purity": "0.99"},
            },
        )
        results = match_ingredients(
            organization=org,
            names_with_claims=[("Caffeine", 0.0)],
        )
        assert results[0].matched_item_id is not None
        assert results[0].mg_per_serving is None

    def test_archived_items_excluded_from_matching(self) -> None:
        """Archived raw materials are off-limits — the UI marks them
        hidden, and the AI should not resurrect them by matching."""

        org = OrganizationFactory()
        _seed(
            org,
            {
                "name": "Caffeine Anhydrous",
                "attributes": {"purity": "0.99"},
                "is_archived": True,
            },
        )
        results = match_ingredients(
            organization=org,
            names_with_claims=[("Caffeine Anhydrous", 100.0)],
        )
        assert results[0].matched_item_id is None

    def test_missing_raw_materials_catalogue_from_shortlister(self) -> None:
        org = OrganizationFactory()
        Catalogue.objects.filter(
            organization=org, slug=RAW_MATERIALS_SLUG
        ).delete()
        assert shortlist_candidates(
            organization=org, brief="anything"
        ) == []

    def test_shortlist_prefers_keyword_matches(self) -> None:
        org = OrganizationFactory()
        _seed(
            org,
            {"name": "Caffeine Anhydrous Powder"},
            {"name": "Green Tea Extract"},
            {"name": "Completely Unrelated Material"},
        )
        candidates = shortlist_candidates(
            organization=org, brief="caffeine capsule"
        )
        # The brief shares the token "caffeine" with one item; that
        # item must appear first in the shortlist regardless of its
        # alphabetical position.
        assert candidates[0].name == "Caffeine Anhydrous Powder"

    def test_shortlist_pads_with_unmatched_items(self) -> None:
        """A brief with no token matches still gets a menu built from
        the catalogue's alphabetical order so the LLM has something
        to pick from."""

        org = OrganizationFactory()
        _seed(
            org,
            {"name": "Alpha Ingredient"},
            {"name": "Beta Ingredient"},
            {"name": "Gamma Ingredient"},
        )
        candidates = shortlist_candidates(
            organization=org, brief="zzz nothing here"
        )
        names = [c.name for c in candidates]
        assert "Alpha Ingredient" in names
        assert "Beta Ingredient" in names
        assert "Gamma Ingredient" in names

    def test_shortlist_respects_limit(self) -> None:
        org = OrganizationFactory()
        _seed(
            org,
            *[{"name": f"Ingredient {n:03d}"} for n in range(SHORTLIST_LIMIT + 20)],
        )
        candidates = shortlist_candidates(
            organization=org, brief="anything", limit=25
        )
        assert len(candidates) == 25

    def test_shortlist_skips_archived_items(self) -> None:
        org = OrganizationFactory()
        _seed(
            org,
            {"name": "Caffeine Anhydrous", "is_archived": True},
            {"name": "Green Tea Extract"},
        )
        candidates = shortlist_candidates(
            organization=org, brief="anything"
        )
        names = [c.name for c in candidates]
        assert "Caffeine Anhydrous" not in names
        assert "Green Tea Extract" in names

    def test_shortlist_exposes_purity_and_ratio_in_prompt_line(self) -> None:
        org = OrganizationFactory()
        _seed(
            org,
            {
                "name": "Caffeine Anhydrous",
                "attributes": {"purity": "0.99", "extract_ratio": "1"},
            },
        )
        candidates = shortlist_candidates(
            organization=org, brief="caffeine"
        )
        line = candidates[0].prompt_line()
        assert "purity=0.99" in line
        assert "extract_ratio=1" in line
        assert candidates[0].item_id in line

    def test_serving_size_scales_mg_per_serving(self) -> None:
        """Label claim is total per serving; when the scientist marks
        serving_size=2 each capsule carries half the claim, so raw
        powder per capsule halves too."""

        org = OrganizationFactory()
        _seed(
            org,
            {
                "name": "Caffeine Anhydrous",
                "attributes": {"purity": "0.99"},
            },
        )
        singletons = match_ingredients(
            organization=org,
            names_with_claims=[("Caffeine Anhydrous", 100.0)],
            serving_size=1,
        )
        pairs = match_ingredients(
            organization=org,
            names_with_claims=[("Caffeine Anhydrous", 100.0)],
            serving_size=2,
        )
        assert singletons[0].mg_per_serving is not None
        assert pairs[0].mg_per_serving is not None
        # Halving the per-unit claim halves the purity-adjusted mg too.
        single_mg = Decimal(singletons[0].mg_per_serving)
        pair_mg = Decimal(pairs[0].mg_per_serving)
        assert pair_mg * Decimal("2") == pytest.approx(single_mg, abs=Decimal("0.001"))
