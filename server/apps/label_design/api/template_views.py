"""Views for the staff-curated label-design template library.

Two surfaces:

1. **Category management** — list / create / update / delete the
   top-level groupings customers see on their download page.
2. **Template management** — list / create (multipart upload) /
   update / delete the individual files within a category.

Both are gated by :attr:`LabellingCapability.MANAGE` so only staff
who already manage the labelling workflow can curate the library.
The portal-side READ surface lives in
:mod:`apps.client_portal.api.template_views`.
"""

from __future__ import annotations

import logging
import mimetypes

from rest_framework import status
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.audit.services import record as record_audit
from apps.label_design.api.permissions import HasLabellingPermission
from apps.label_design.api.template_serializers import (
    LabelDesignTemplateCategorySerializer,
    LabelDesignTemplateSerializer,
    LabelDesignTemplateUploadSerializer,
)
from apps.label_design.models import (
    LabelDesignTemplate,
    LabelDesignTemplateCategory,
)
from apps.organizations.modules import LabellingCapability


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Categories
# ---------------------------------------------------------------------------


class LabelDesignTemplateCategoryListView(APIView):
    """``GET / POST /api/organizations/<org>/label-design-template-categories/``.

    GET returns every category for the org ordered by sort_order
    then name. POST creates a new one — staff with
    :attr:`LabellingCapability.MANAGE` only.
    """

    permission_classes = [HasLabellingPermission]
    # GET is fine with VIEW (so a designer can see existing
    # categories) but write paths gate behind MANAGE. The
    # ``HasLabellingPermission`` mixin only checks one capability
    # per view, so we default to MANAGE and document the trade-off:
    # designers without MANAGE simply don't hit this surface.
    required_capability = LabellingCapability.MANAGE

    def get(self, request: Request, **kwargs) -> Response:
        qs = LabelDesignTemplateCategory.objects.filter(
            organization=self.organization
        ).order_by("sort_order", "name")
        return Response(
            {"items": LabelDesignTemplateCategorySerializer(qs, many=True).data}
        )

    def post(self, request: Request, **kwargs) -> Response:
        serializer = LabelDesignTemplateCategorySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        cat = LabelDesignTemplateCategory.objects.create(
            organization=self.organization,
            **serializer.validated_data,
        )
        record_audit(
            organization=self.organization,
            actor=request.user,
            action="label_design_template_category.create",
            target=cat,
            before=None,
            after={"id": str(cat.id), "name": cat.name},
        )
        return Response(
            LabelDesignTemplateCategorySerializer(cat).data,
            status=status.HTTP_201_CREATED,
        )


class LabelDesignTemplateCategoryDetailView(APIView):
    permission_classes = [HasLabellingPermission]
    required_capability = LabellingCapability.MANAGE

    def _get(self, **kwargs) -> LabelDesignTemplateCategory:
        try:
            return LabelDesignTemplateCategory.objects.get(
                organization=self.organization, pk=kwargs["category_id"]
            )
        except LabelDesignTemplateCategory.DoesNotExist:
            raise NotFound()

    def patch(self, request: Request, **kwargs) -> Response:
        cat = self._get(**kwargs)
        serializer = LabelDesignTemplateCategorySerializer(
            cat, data=request.data, partial=True
        )
        serializer.is_valid(raise_exception=True)
        before = {"name": cat.name, "sort_order": cat.sort_order}
        for k, v in serializer.validated_data.items():
            setattr(cat, k, v)
        cat.save()
        record_audit(
            organization=self.organization,
            actor=request.user,
            action="label_design_template_category.update",
            target=cat,
            before=before,
            after={"name": cat.name, "sort_order": cat.sort_order},
        )
        return Response(LabelDesignTemplateCategorySerializer(cat).data)

    def delete(self, request: Request, **kwargs) -> Response:
        cat = self._get(**kwargs)
        if cat.templates.exists():
            raise ValidationError(
                {
                    "detail": (
                        "Move or delete every template in this category "
                        "before deleting the category itself."
                    ),
                    "code": "category_not_empty",
                }
            )
        record_audit(
            organization=self.organization,
            actor=request.user,
            action="label_design_template_category.delete",
            target=cat,
            before={"name": cat.name},
            after=None,
        )
        cat.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------


class LabelDesignTemplateListView(APIView):
    """``GET / POST /api/organizations/<org>/label-design-templates/``.

    POST is a multipart upload — the file lives on the same
    storage backend as artwork (Azure Blob in prod).
    """

    permission_classes = [HasLabellingPermission]
    parser_classes = (MultiPartParser, FormParser)
    required_capability = LabellingCapability.MANAGE

    def get(self, request: Request, **kwargs) -> Response:
        qs = (
            LabelDesignTemplate.objects.filter(organization=self.organization)
            .select_related("category", "created_by")
            .order_by("category__sort_order", "sort_order", "name")
        )
        return Response(
            {"items": LabelDesignTemplateSerializer(qs, many=True).data}
        )

    def post(self, request: Request, **kwargs) -> Response:
        serializer = LabelDesignTemplateUploadSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        payload = serializer.validated_data

        try:
            category = LabelDesignTemplateCategory.objects.get(
                organization=self.organization, pk=payload["category_id"]
            )
        except LabelDesignTemplateCategory.DoesNotExist:
            raise ValidationError(
                {"category_id": "category does not exist in this organization"}
            )

        file_obj = payload["file"]
        original_name = getattr(file_obj, "name", "") or ""
        size_bytes = getattr(file_obj, "size", 0) or 0
        content_type = (
            getattr(file_obj, "content_type", "")
            or mimetypes.guess_type(original_name)[0]
            or ""
        )

        template = LabelDesignTemplate.objects.create(
            organization=self.organization,
            category=category,
            name=payload["name"],
            description=payload.get("description", ""),
            file=file_obj,
            file_original_name=original_name,
            file_size_bytes=size_bytes,
            content_type=content_type,
            sort_order=payload.get("sort_order", 0),
            created_by=request.user,
        )
        record_audit(
            organization=self.organization,
            actor=request.user,
            action="label_design_template.create",
            target=template,
            before=None,
            after={
                "id": str(template.id),
                "name": template.name,
                "category_id": str(category.id),
                "file_size_bytes": size_bytes,
            },
        )
        return Response(
            LabelDesignTemplateSerializer(template).data,
            status=status.HTTP_201_CREATED,
        )


class LabelDesignTemplateDetailView(APIView):
    permission_classes = [HasLabellingPermission]
    parser_classes = (MultiPartParser, FormParser)
    required_capability = LabellingCapability.MANAGE

    def _get(self, **kwargs) -> LabelDesignTemplate:
        try:
            return LabelDesignTemplate.objects.select_related("category").get(
                organization=self.organization, pk=kwargs["template_id"]
            )
        except LabelDesignTemplate.DoesNotExist:
            raise NotFound()

    def patch(self, request: Request, **kwargs) -> Response:
        template = self._get(**kwargs)
        # Allow patching name / description / sort_order / category.
        # File replacement uses the dedicated upload endpoint on the
        # list view (POST + same name); update is meta-only here.
        before = {
            "name": template.name,
            "description": template.description,
            "sort_order": template.sort_order,
            "category_id": str(template.category_id),
        }
        for field in ("name", "description", "sort_order"):
            if field in request.data:
                setattr(template, field, request.data[field])
        if "category_id" in request.data:
            try:
                new_cat = LabelDesignTemplateCategory.objects.get(
                    organization=self.organization,
                    pk=request.data["category_id"],
                )
            except LabelDesignTemplateCategory.DoesNotExist:
                raise ValidationError(
                    {"category_id": "category does not exist in this organization"}
                )
            template.category = new_cat
        template.save()
        record_audit(
            organization=self.organization,
            actor=request.user,
            action="label_design_template.update",
            target=template,
            before=before,
            after={
                "name": template.name,
                "description": template.description,
                "sort_order": template.sort_order,
                "category_id": str(template.category_id),
            },
        )
        return Response(LabelDesignTemplateSerializer(template).data)

    def delete(self, request: Request, **kwargs) -> Response:
        template = self._get(**kwargs)
        record_audit(
            organization=self.organization,
            actor=request.user,
            action="label_design_template.delete",
            target=template,
            before={"name": template.name},
            after=None,
        )
        # Delete the row first; the underlying file is then orphaned
        # in storage. We don't auto-delete the blob because the
        # storage backend's lifecycle policy handles unreferenced
        # files (and an accidental delete recovery is more painful
        # than a stale blob).
        template.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
