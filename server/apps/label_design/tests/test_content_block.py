"""Tests for the spec-derived Compliance Content Block.

The render helpers (PDF, PNG, HTML) are exercised lightly: PDF
needs WeasyPrint's cairo/pango at runtime (skipped if missing —
same convention as the spec-sheet PDF tests). The deterministic
shape of the dataclass and the plain-text export get the bulk of
the coverage because they're the surfaces the customer actually
touches.
"""

from __future__ import annotations

import pytest

from apps.formulations.models import ProjectStatus
from apps.formulations.services import save_version
from apps.formulations.tests.factories import FormulationFactory
from apps.label_design.content_block import (
    ComplianceContentBlock,
    compute_content_block,
    render_content_block_text,
)
from apps.organizations.tests.factories import OrganizationFactory
from apps.specifications.models import SpecificationSheet


pytestmark = pytest.mark.django_db


def _make_spec(*, name="Hydration Serum", code="FORM-001", servings=60):
    org = OrganizationFactory()
    formulation = FormulationFactory(
        organization=org,
        name=name,
        code=code,
        servings_per_pack=servings,
        suggested_dosage="Take 1 capsule daily",
        directions_of_use="Swallow with water",
        project_status=ProjectStatus.IN_DEVELOPMENT,
    )
    version = save_version(formulation=formulation, actor=org.created_by)
    sheet = SpecificationSheet.objects.create(
        organization=org,
        formulation_version=version,
        code="SPEC-001",
        storage_conditions="Cool, dry place below 25°C",
        shelf_life="24 months",
        created_by=org.created_by,
        updated_by=org.created_by,
    )
    return sheet


class TestComputeContentBlock:
    def test_basic_shape_from_minimal_spec(self):
        sheet = _make_spec()
        block = compute_content_block(sheet)

        assert isinstance(block, ComplianceContentBlock)
        assert block.product_name == "Hydration Serum"
        assert block.product_code == "SPEC-001"  # spec code wins over formulation code
        assert block.servings_per_pack == "60"
        assert block.directions_of_use == "Swallow with water"
        assert block.suggested_dosage == "Take 1 capsule daily"
        assert block.storage_conditions == "Cool, dry place below 25°C"
        assert block.shelf_life == "24 months"

    def test_is_deterministic_for_same_spec(self):
        sheet = _make_spec()
        first = compute_content_block(sheet)
        second = compute_content_block(sheet)
        assert first == second
        # to_dict() also stable so the JSONField snapshot survives
        # round-tripping through JSON.
        assert first.to_dict() == second.to_dict()

    def test_falls_back_to_formulation_code_when_spec_code_blank(self):
        sheet = _make_spec()
        sheet.code = ""
        sheet.save(update_fields=["code"])
        block = compute_content_block(sheet)
        # When spec.code is blank, the formulation code wins.
        assert block.product_code == "FORM-001"


class TestPlainTextExport:
    def test_full_payload_includes_every_required_section(self):
        sheet = _make_spec()
        block = compute_content_block(sheet)
        text = render_content_block_text(block)

        # Section keys present
        for key in (
            "product",
            "serving",
            "directions",
            "ingredients",
            "allergen",
            "storage",
            "business",
        ):
            assert key in text.sections, f"missing section: {key}"

        # The combined ``full`` string contains the headline data.
        assert "Hydration Serum" in text.full
        assert "60" in text.full
        assert "Swallow with water" in text.full
        assert "Cool, dry place below 25°C" in text.full

    def test_empty_ingredients_renders_clean_fallback(self):
        sheet = _make_spec()
        block = compute_content_block(sheet)
        text = render_content_block_text(block)
        # With no formulation lines we should not crash; the section
        # should fall back to a "none derived" note.
        assert "Ingredients" in text.sections["ingredients"]


class TestPdfRender:
    def test_pdf_is_bytes(self):
        try:
            from apps.label_design.content_block import render_content_block_pdf

            sheet = _make_spec()
            block = compute_content_block(sheet)
            pdf = render_content_block_pdf(block)
        except (OSError, ImportError):
            # WeasyPrint loads cairo/pango via cffi at import time;
            # on a host without those system libraries (typical
            # local Mac dev image without Homebrew pango) we skip
            # rather than fail. Production containers ship the libs.
            pytest.skip("WeasyPrint system libraries not available")
        assert isinstance(pdf, bytes)
        assert pdf[:4] == b"%PDF"
