"""Portal read-side surface for the label-design template library.

One endpoint: returns every category for the customer's org with
its templates nested. The customer downloads files directly from
``LabelDesignTemplate.file.url`` so the storage backend (Azure
Blob in prod) serves the bytes — Django never relays them.
"""

from __future__ import annotations

from rest_framework.request import Request
from rest_framework.response import Response

from apps.client_portal.api.views import PortalAPIView
from apps.label_design.api.template_serializers import (
    LabelDesignTemplateCategorySerializer,
    LabelDesignTemplateSerializer,
)
from apps.label_design.models import (
    LabelDesignTemplate,
    LabelDesignTemplateCategory,
)


class PortalLabelDesignTemplateLibraryView(PortalAPIView):
    """``GET /api/portal/label-design-templates/``.

    Returns the customer's org's template library shaped as:

    ``[
        {category: {...}, templates: [...]},
        ...
    ]``

    Categories with zero templates are dropped so the FE renders
    only what's actually downloadable — a category staff hasn't
    populated yet would otherwise show as an empty card. Sort
    order is preserved (category sort_order then template
    sort_order then name).
    """

    def get(self, request: Request) -> Response:
        # The portal user resolves to a ClientAccount which is
        # pinned to a customer pinned to an organization. The
        # template library is org-scoped — see
        # :class:`apps.label_design.models.LabelDesignTemplate`.
        customer = request.user.customer
        organization_id = customer.organization_id

        categories = list(
            LabelDesignTemplateCategory.objects.filter(
                organization_id=organization_id
            ).order_by("sort_order", "name")
        )
        templates_by_cat: dict = {}
        for t in (
            LabelDesignTemplate.objects.filter(
                organization_id=organization_id
            )
            .select_related("category")
            .order_by("sort_order", "name")
        ):
            templates_by_cat.setdefault(t.category_id, []).append(t)

        items: list[dict] = []
        for cat in categories:
            ts = templates_by_cat.get(cat.id, [])
            if not ts:
                continue
            items.append(
                {
                    "category": LabelDesignTemplateCategorySerializer(cat).data,
                    "templates": LabelDesignTemplateSerializer(ts, many=True).data,
                }
            )
        return Response({"items": items})
