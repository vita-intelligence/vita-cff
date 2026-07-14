"""Tests for the polymorphic FormulationLine — local vs PSP-sourced.

The ``effective_item_*`` property helpers on FormulationLine drive
every downstream consumer (compute, serializer, spec sheet snapshot,
BOM print) so a source-swapped line renders identically to a local
one. This module pins the contract: given a line with
``item_source='psp'``, every property reads from the snapshot and
never touches the ``item`` FK.
"""

from __future__ import annotations

from decimal import Decimal
from uuid import uuid4

import pytest

from apps.catalogues.tests.factories import (
    ItemFactory,
    raw_materials_catalogue,
)
from apps.formulations.models import FormulationLine
from apps.formulations.tests.factories import (
    FormulationFactory,
    FormulationLineFactory,
)


pytestmark = pytest.mark.django_db


def _psp_line(**overrides) -> FormulationLine:
    formulation = FormulationFactory()
    defaults = {
        "formulation": formulation,
        "item_source": "psp",
        "item": None,
        "psp_item_uuid": uuid4(),
        "psp_item_snapshot": {
            "name": "Ashwagandha KSM-66",
            "external_sku": "ASH-KSM",
            "description": "Root extract",
            "attributes": {
                "use_as": "active",
                "purity": "0.05",
                "overage": "0.1",
                "extract_ratio": None,
                "powder_standard_mg_per_g": "1000",
            },
        },
        "label_claim_mg": Decimal("300.0000"),
        "display_order": 0,
    }
    defaults.update(overrides)
    return FormulationLine.objects.create(**defaults)


class TestPolymorphicIdentity:
    def test_local_line_reads_from_fk(self):
        line = FormulationLineFactory()
        assert line.item_source == "local"
        assert line.effective_item_name == line.item.name
        assert line.effective_item_internal_code == line.item.internal_code
        assert line.effective_item_reference == str(line.item_id)

    def test_psp_line_reads_from_snapshot(self):
        line = _psp_line()
        assert line.item_source == "psp"
        assert line.item is None
        assert line.effective_item_name == "Ashwagandha KSM-66"
        assert line.effective_item_internal_code == "ASH-KSM"
        assert line.effective_item_reference == str(line.psp_item_uuid)

    def test_psp_line_missing_sku_falls_back_to_uuid_prefix(self):
        """PSP items without an external_sku still need a stable
        display id for the spec sheet + BOM. Fall back to the
        first 8 chars of the UUID hex — matches the FE picker's
        convention when it renders these rows on the search
        results dropdown."""

        line = _psp_line(
            psp_item_snapshot={
                "name": "SKUless Item",
                "external_sku": "",
                "attributes": {},
            }
        )
        code = line.effective_item_internal_code
        assert len(code) == 8
        assert code.isalnum()
        assert code == str(line.psp_item_uuid).replace("-", "")[:8]


class TestPolymorphicAttributes:
    def test_local_line_returns_fk_attributes(self):
        formulation = FormulationFactory()
        item = ItemFactory(
            catalogue=raw_materials_catalogue(formulation.organization),
            attributes={
                "use_as": "active",
                "purity": "0.98",
                "overage": "0.0",
            },
        )
        line = FormulationLineFactory(formulation=formulation, item=item)
        attrs = line.effective_item_attributes
        assert attrs["use_as"] == "active"
        assert attrs["purity"] == "0.98"

    def test_psp_line_returns_snapshot_attributes(self):
        line = _psp_line()
        attrs = line.effective_item_attributes
        assert attrs["use_as"] == "active"
        assert attrs["purity"] == "0.05"
        assert attrs["overage"] == "0.1"

    def test_psp_line_with_malformed_snapshot_returns_empty(self):
        """Defensive — a snapshot with a non-dict ``attributes``
        (e.g. an older version, or one that was JSON-serialised
        into the wrong shape) must not crash callers. The
        property returns ``{}`` and compute readers just see
        missing keys."""

        line = _psp_line(
            psp_item_snapshot={"name": "X", "attributes": "not-a-dict"}
        )
        assert line.effective_item_attributes == {}


class TestPsPLineWireShape:
    def test_read_serializer_returns_source_agnostic_shape(self):
        """The FE consumes a single line shape — the two sources
        must serialise to fields with the same keys. Serializer
        picks up ``effective_*`` for every ``item_*`` slot so the
        wire shape stays stable."""

        from apps.formulations.api.serializers import (
            FormulationLineReadSerializer,
        )

        local_line = FormulationLineFactory()
        psp_line = _psp_line()

        local_data = FormulationLineReadSerializer(local_line).data
        psp_data = FormulationLineReadSerializer(psp_line).data

        # Same key set on the wire (both are the same
        # ``FormulationLine`` serializer output).
        assert set(local_data.keys()) == set(psp_data.keys())
        # Source discriminator surfaced correctly.
        assert local_data["item_source"] == "local"
        assert psp_data["item_source"] == "psp"
        # PSP UUID surfaced only on PSP rows.
        assert local_data["psp_item_uuid"] is None
        assert str(psp_data["psp_item_uuid"]) == str(psp_line.psp_item_uuid)
        # Item name populated from either source.
        assert psp_data["item_name"] == "Ashwagandha KSM-66"
