"""DRF exceptions for the organizations app.

These subclass :class:`rest_framework.exceptions.PermissionDenied` so
the existing codified exception handler already produces a sensible
``detail`` payload. The extra :attr:`api_code` attribute is lifted to
a top-level ``code`` field by
:func:`config.exception_handler.codified_exception_handler` so the
frontend's standard ``ApiError.code`` path can branch on it without
having to sniff the ``detail`` string.
"""

from __future__ import annotations

from rest_framework import status
from rest_framework.exceptions import PermissionDenied


class OrganizationInactive(PermissionDenied):
    """Raised when a member tries to use an organization that is not
    yet activated.

    Pre-billing placeholder: platform admins flip :attr:`Organization.is_active`
    from the Django admin (or a management command) once a workspace
    is cleared to use the app. Superusers always bypass the check so
    operators can still inspect a dead workspace through the UI.
    """

    status_code = status.HTTP_403_FORBIDDEN
    default_detail = "organization_inactive"
    default_code = "organization_inactive"
    api_code = "organization_inactive"
