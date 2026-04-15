"""Tests for the bulk XLSX import service + API."""

from __future__ import annotations

import datetime as _dt
import io
from typing import Any

import openpyxl
import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient


_XLSX_MIME = (
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
)


def _upload(rows: list[list[Any]]) -> SimpleUploadedFile:
    return SimpleUploadedFile(
        "items.xlsx", _workbook_bytes(rows).getvalue(), content_type=_XLSX_MIME
    )

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory
from apps.attributes.models import DataType
from apps.attributes.tests.factories import AttributeDefinitionFactory
from apps.catalogues.models import Item
from apps.catalogues.services import (
    ItemImportError,
    import_items_from_xlsx,
)
from apps.catalogues.tests.factories import raw_materials_catalogue
from apps.organizations.services import create_organization
from apps.organizations.tests.factories import OrganizationFactory

pytestmark = pytest.mark.django_db


def _workbook_bytes(rows: list[list[Any]]) -> io.BytesIO:
    wb = openpyxl.Workbook()
    sheet = wb.active
    for row in rows:
        sheet.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


def _login(client: APIClient, user: Any) -> APIClient:
    client.post(
        reverse("accounts:login"),
        {"email": user.email, "password": DEFAULT_TEST_PASSWORD},
        format="json",
    )
    return client


@pytest.fixture
def owner_client(api_client: APIClient) -> tuple[APIClient, Any, Any]:
    user = UserFactory(email="owner@import.test", password=DEFAULT_TEST_PASSWORD)
    org = create_organization(user=user, name="Owner Co")
    _login(api_client, user)
    return api_client, user, org


# ---------------------------------------------------------------------------
# Service layer
# ---------------------------------------------------------------------------


class TestImportService:
    def test_imports_builtin_columns(self) -> None:
        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        file = _workbook_bytes(
            [
                ["name", "internal_code", "unit", "base_price"],
                ["Vitamin C", "VC-001", "g", "0.5000"],
                ["Zinc", "ZN-002", "mg", "0.2500"],
            ]
        )
        result = import_items_from_xlsx(
            catalogue=catalogue, actor=org.created_by, file=file
        )
        assert result.created == 2
        assert result.errors == []
        assert Item.objects.filter(catalogue=catalogue).count() == 2

    def test_maps_existing_attribute_definitions_by_key(self) -> None:
        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        AttributeDefinitionFactory(
            catalogue=catalogue, key="origin", data_type=DataType.TEXT
        )

        file = _workbook_bytes(
            [["name", "origin"], ["Vitamin C", "EU"]]
        )
        result = import_items_from_xlsx(
            catalogue=catalogue, actor=org.created_by, file=file
        )
        assert result.created == 1
        item = Item.objects.get(catalogue=catalogue)
        assert item.attributes == {"origin": "EU"}

    def test_matches_attribute_by_label_when_key_not_header(self) -> None:
        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        AttributeDefinitionFactory(
            catalogue=catalogue,
            key="country_of_origin",
            label="Country of Origin",
            data_type=DataType.TEXT,
        )

        file = _workbook_bytes(
            [["name", "Country of Origin"], ["Vitamin C", "EU"]]
        )
        result = import_items_from_xlsx(
            catalogue=catalogue, actor=org.created_by, file=file
        )
        assert result.created == 1
        item = Item.objects.get(catalogue=catalogue)
        assert item.attributes == {"country_of_origin": "EU"}

    def test_case_insensitive_and_space_tolerant_headers(self) -> None:
        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        file = _workbook_bytes(
            [
                ["NAME", "Internal Code"],
                ["Vitamin C", "VC-001"],
            ]
        )
        result = import_items_from_xlsx(
            catalogue=catalogue, actor=org.created_by, file=file
        )
        assert result.created == 1
        item = Item.objects.get(catalogue=catalogue)
        assert item.name == "Vitamin C"
        assert item.internal_code == "VC-001"

    def test_unknown_columns_are_recorded_and_ignored(self) -> None:
        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        file = _workbook_bytes(
            [
                ["name", "mystery", "unknown"],
                ["Vitamin C", "ignored", "alsoignored"],
            ]
        )
        result = import_items_from_xlsx(
            catalogue=catalogue, actor=org.created_by, file=file
        )
        assert result.created == 1
        assert set(result.unmapped_columns) == {"mystery", "unknown"}

    def test_missing_name_column_raises(self) -> None:
        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        file = _workbook_bytes(
            [["internal_code", "unit"], ["VC-001", "g"]]
        )
        with pytest.raises(ItemImportError) as exc:
            import_items_from_xlsx(
                catalogue=catalogue, actor=org.created_by, file=file
            )
        assert exc.value.code == "missing_name_column"

    def test_empty_file_raises(self) -> None:
        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        wb = openpyxl.Workbook()
        buf = io.BytesIO()
        wb.save(buf)
        buf.seek(0)
        # Openpyxl always has at least an empty sheet — add a sheet
        # with zero rows so the iterator immediately exhausts.
        with pytest.raises(ItemImportError) as exc:
            import_items_from_xlsx(
                catalogue=catalogue, actor=org.created_by, file=buf
            )
        assert exc.value.code == "file_empty"

    def test_bad_row_does_not_block_other_rows(self) -> None:
        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        AttributeDefinitionFactory(
            catalogue=catalogue,
            key="potency",
            data_type=DataType.NUMBER,
            required=True,
        )

        file = _workbook_bytes(
            [
                ["name", "potency"],
                ["Good 1", "12.5"],
                ["Bad row", "not-a-number"],
                ["Good 2", "7"],
            ]
        )
        result = import_items_from_xlsx(
            catalogue=catalogue, actor=org.created_by, file=file
        )
        assert result.created == 2
        assert len(result.errors) == 1
        assert result.errors[0].row == 3
        assert "potency" in result.errors[0].errors

    def test_blank_name_row_with_other_data_is_reported(self) -> None:
        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        # A row where name is blank but another cell has data must
        # surface an error — it is a user mistake, not a trailing
        # whitespace row to skip.
        file = _workbook_bytes(
            [
                ["name", "internal_code"],
                ["", "ORPHAN-1"],
                ["Good", "OK-1"],
            ]
        )
        result = import_items_from_xlsx(
            catalogue=catalogue, actor=org.created_by, file=file
        )
        assert result.created == 1
        assert len(result.errors) == 1
        assert result.errors[0].errors == {"name": ["required"]}

    def test_duplicate_internal_code_is_reported(self) -> None:
        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        file = _workbook_bytes(
            [
                ["name", "internal_code"],
                ["First", "DUP"],
                ["Second", "DUP"],
            ]
        )
        result = import_items_from_xlsx(
            catalogue=catalogue, actor=org.created_by, file=file
        )
        assert result.created == 1
        assert len(result.errors) == 1
        assert "internal_code" in result.errors[0].errors

    def test_trailing_blank_rows_are_skipped(self) -> None:
        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        file = _workbook_bytes(
            [
                ["name"],
                ["Vitamin C"],
                [None],
                [""],
                ["Zinc"],
            ]
        )
        result = import_items_from_xlsx(
            catalogue=catalogue, actor=org.created_by, file=file
        )
        assert result.created == 2
        assert result.errors == []

    def test_date_column_accepts_python_date(self) -> None:
        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        AttributeDefinitionFactory(
            catalogue=catalogue, key="expires", data_type=DataType.DATE
        )

        file = _workbook_bytes(
            [
                ["name", "expires"],
                ["Vitamin C", _dt.datetime(2026, 4, 14)],
            ]
        )
        result = import_items_from_xlsx(
            catalogue=catalogue, actor=org.created_by, file=file
        )
        assert result.created == 1
        item = Item.objects.get(catalogue=catalogue)
        assert item.attributes == {"expires": "2026-04-14"}

    def test_multi_select_accepts_comma_separated_cell(self) -> None:
        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
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

        file = _workbook_bytes(
            [
                ["name", "allergens"],
                ["Vitamin C", "gluten, soy"],
            ]
        )
        result = import_items_from_xlsx(
            catalogue=catalogue, actor=org.created_by, file=file
        )
        assert result.created == 1
        item = Item.objects.get(catalogue=catalogue)
        assert item.attributes == {"allergens": ["gluten", "soy"]}


# ---------------------------------------------------------------------------
# API layer
# ---------------------------------------------------------------------------


def _import_url(org_id: str, slug: str = "raw_materials") -> str:
    return reverse(
        "catalogues:item-import",
        kwargs={"org_id": org_id, "slug": slug},
    )


class TestImportAPI:
    def test_unauthenticated_cannot_import(
        self, api_client: APIClient
    ) -> None:
        org = OrganizationFactory()
        response = api_client.post(_import_url(str(org.id)))
        assert response.status_code == status.HTTP_401_UNAUTHORIZED

    def test_missing_file_is_rejected(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        response = client.post(_import_url(str(org.id)))
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["file"] == ["required"]

    def test_owner_can_upload_xlsx(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        response = client.post(
            _import_url(str(org.id)),
            {"file": _upload([["name", "internal_code"], ["Vitamin C", "VC-001"]])},
            format="multipart",
        )
        assert response.status_code == status.HTTP_200_OK
        body = response.json()
        assert body["created"] == 1
        assert body["errors"] == []

    def test_reports_errors_and_unmapped_columns(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        AttributeDefinitionFactory(
            catalogue=raw_materials_catalogue(org),
            key="potency",
            data_type=DataType.NUMBER,
        )
        response = client.post(
            _import_url(str(org.id)),
            {
                "file": _upload(
                    [
                        ["name", "potency", "mystery"],
                        ["Good", "12", "ignored"],
                        ["Bad", "nope", "ignored"],
                    ]
                )
            },
            format="multipart",
        )
        assert response.status_code == status.HTTP_200_OK
        body = response.json()
        assert body["created"] == 1
        assert len(body["errors"]) == 1
        assert "mystery" in body["unmapped_columns"]

    def test_missing_name_column_returns_400(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        response = client.post(
            _import_url(str(org.id)),
            {"file": _upload([["internal_code"], ["VC-001"]])},
            format="multipart",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["file"] == ["missing_name_column"]
