"""Unit tests for :func:`apps.attributes.services.validate_values`."""

from __future__ import annotations

import datetime as _dt

import pytest

from apps.attributes.models import DataType
from apps.attributes.services import validate_values
from apps.attributes.tests.factories import AttributeDefinitionFactory
from apps.catalogues.tests.factories import raw_materials_catalogue
from apps.organizations.tests.factories import OrganizationFactory

pytestmark = pytest.mark.django_db


def _catalogue():
    """Return a fresh raw_materials catalogue on a fresh org."""

    return raw_materials_catalogue(OrganizationFactory())


def _validate(catalogue, incoming):
    return validate_values(catalogue=catalogue, incoming=incoming)


class TestText:
    def test_trims_and_stores_string(self) -> None:
        catalogue = _catalogue()
        AttributeDefinitionFactory(
            catalogue=catalogue, key="origin", data_type=DataType.TEXT
        )
        coerced, errors = _validate(catalogue, {"origin": "  EU  "})
        assert errors == {}
        assert coerced == {"origin": "EU"}

    def test_missing_non_required_is_ok(self) -> None:
        catalogue = _catalogue()
        AttributeDefinitionFactory(catalogue=catalogue, data_type=DataType.TEXT)
        coerced, errors = _validate(catalogue, {})
        assert errors == {}
        assert coerced == {}

    def test_required_missing_errors(self) -> None:
        catalogue = _catalogue()
        AttributeDefinitionFactory(
            catalogue=catalogue,
            key="origin",
            data_type=DataType.TEXT,
            required=True,
        )
        _, errors = _validate(catalogue, {})
        assert errors == {"origin": ["required"]}

    def test_required_blank_errors(self) -> None:
        catalogue = _catalogue()
        AttributeDefinitionFactory(
            catalogue=catalogue,
            key="origin",
            data_type=DataType.TEXT,
            required=True,
        )
        _, errors = _validate(catalogue, {"origin": "   "})
        assert errors == {"origin": ["required"]}

    def test_wrong_type_errors(self) -> None:
        catalogue = _catalogue()
        AttributeDefinitionFactory(
            catalogue=catalogue, key="origin", data_type=DataType.TEXT
        )
        _, errors = _validate(catalogue, {"origin": 42})
        assert errors == {"origin": ["invalid"]}


class TestNumber:
    def test_accepts_numeric_and_string(self) -> None:
        catalogue = _catalogue()
        AttributeDefinitionFactory(
            catalogue=catalogue, key="potency", data_type=DataType.NUMBER
        )
        c1, _ = _validate(catalogue, {"potency": 12.5})
        c2, _ = _validate(catalogue, {"potency": "12.5"})
        assert c1 == {"potency": 12.5}
        assert c2 == {"potency": 12.5}

    def test_rejects_non_numeric_string(self) -> None:
        catalogue = _catalogue()
        AttributeDefinitionFactory(
            catalogue=catalogue, key="potency", data_type=DataType.NUMBER
        )
        _, errors = _validate(catalogue, {"potency": "hello"})
        assert errors == {"potency": ["invalid"]}

    def test_rejects_boolean_disguise(self) -> None:
        catalogue = _catalogue()
        AttributeDefinitionFactory(
            catalogue=catalogue, key="potency", data_type=DataType.NUMBER
        )
        _, errors = _validate(catalogue, {"potency": True})
        assert errors == {"potency": ["invalid"]}


class TestBoolean:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            (True, True),
            (False, False),
            ("true", True),
            ("false", False),
            ("1", True),
            ("0", False),
        ],
    )
    def test_accepts_common_forms(self, raw, expected) -> None:
        catalogue = _catalogue()
        AttributeDefinitionFactory(
            catalogue=catalogue, key="vegan", data_type=DataType.BOOLEAN
        )
        coerced, errors = _validate(catalogue, {"vegan": raw})
        assert errors == {}
        assert coerced == {"vegan": expected}

    def test_rejects_garbage(self) -> None:
        catalogue = _catalogue()
        AttributeDefinitionFactory(
            catalogue=catalogue, key="vegan", data_type=DataType.BOOLEAN
        )
        _, errors = _validate(catalogue, {"vegan": "maybe"})
        assert errors == {"vegan": ["invalid"]}


class TestDate:
    def test_accepts_iso_string(self) -> None:
        catalogue = _catalogue()
        AttributeDefinitionFactory(
            catalogue=catalogue, key="expires", data_type=DataType.DATE
        )
        coerced, errors = _validate(catalogue, {"expires": "2026-04-14"})
        assert errors == {}
        assert coerced == {"expires": "2026-04-14"}

    def test_accepts_python_date(self) -> None:
        catalogue = _catalogue()
        AttributeDefinitionFactory(
            catalogue=catalogue, key="expires", data_type=DataType.DATE
        )
        coerced, _ = _validate(
            catalogue, {"expires": _dt.date(2026, 4, 14)}
        )
        assert coerced == {"expires": "2026-04-14"}

    def test_rejects_garbage(self) -> None:
        catalogue = _catalogue()
        AttributeDefinitionFactory(
            catalogue=catalogue, key="expires", data_type=DataType.DATE
        )
        _, errors = _validate(catalogue, {"expires": "not-a-date"})
        assert errors == {"expires": ["invalid"]}


class TestSingleSelect:
    def test_accepts_allowed_value(self) -> None:
        catalogue = _catalogue()
        AttributeDefinitionFactory(
            catalogue=catalogue,
            key="tier",
            data_type=DataType.SINGLE_SELECT,
            options=[
                {"value": "a", "label": "A"},
                {"value": "b", "label": "B"},
            ],
        )
        coerced, _ = _validate(catalogue, {"tier": "a"})
        assert coerced == {"tier": "a"}

    def test_rejects_unknown_value(self) -> None:
        catalogue = _catalogue()
        AttributeDefinitionFactory(
            catalogue=catalogue,
            key="tier",
            data_type=DataType.SINGLE_SELECT,
            options=[{"value": "a", "label": "A"}],
        )
        _, errors = _validate(catalogue, {"tier": "z"})
        assert errors == {"tier": ["invalid"]}


class TestMultiSelect:
    def test_accepts_subset(self) -> None:
        catalogue = _catalogue()
        AttributeDefinitionFactory(
            catalogue=catalogue,
            key="allergens",
            data_type=DataType.MULTI_SELECT,
            options=[
                {"value": "gluten", "label": "Gluten"},
                {"value": "dairy", "label": "Dairy"},
                {"value": "soy", "label": "Soy"},
            ],
        )
        coerced, errors = _validate(
            catalogue, {"allergens": ["gluten", "soy"]}
        )
        assert errors == {}
        assert coerced == {"allergens": ["gluten", "soy"]}

    def test_rejects_unknown_entry(self) -> None:
        catalogue = _catalogue()
        AttributeDefinitionFactory(
            catalogue=catalogue,
            key="allergens",
            data_type=DataType.MULTI_SELECT,
            options=[{"value": "gluten", "label": "Gluten"}],
        )
        _, errors = _validate(
            catalogue, {"allergens": ["gluten", "mystery"]}
        )
        assert errors == {"allergens": ["invalid"]}

    def test_rejects_non_array(self) -> None:
        catalogue = _catalogue()
        AttributeDefinitionFactory(
            catalogue=catalogue,
            key="allergens",
            data_type=DataType.MULTI_SELECT,
            options=[{"value": "gluten", "label": "Gluten"}],
        )
        _, errors = _validate(catalogue, {"allergens": "gluten"})
        assert errors == {"allergens": ["invalid"]}


class TestArchivedAndUnknownKeys:
    def test_archived_definitions_are_ignored_even_if_required(self) -> None:
        catalogue = _catalogue()
        AttributeDefinitionFactory(
            catalogue=catalogue,
            key="legacy",
            data_type=DataType.TEXT,
            required=True,
            is_archived=True,
        )
        coerced, errors = _validate(catalogue, {})
        assert errors == {}
        assert coerced == {}

    def test_unknown_keys_are_dropped_silently(self) -> None:
        catalogue = _catalogue()
        AttributeDefinitionFactory(
            catalogue=catalogue, key="origin", data_type=DataType.TEXT
        )
        coerced, errors = _validate(
            catalogue, {"origin": "EU", "mystery_field": "value"}
        )
        assert errors == {}
        assert coerced == {"origin": "EU"}

    def test_definitions_are_catalogue_scoped(self) -> None:
        """A definition on raw_materials must not affect packaging writes."""

        from apps.catalogues.tests.factories import packaging_catalogue

        org = OrganizationFactory()
        AttributeDefinitionFactory(
            catalogue=raw_materials_catalogue(org),
            key="origin",
            data_type=DataType.TEXT,
            required=True,
        )
        # Packaging has no ``origin`` definition so the same empty
        # payload passes validation there.
        coerced, errors = _validate(packaging_catalogue(org), {})
        assert errors == {}
        assert coerced == {}
