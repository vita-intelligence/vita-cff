"""DRF permission class for the specifications API.

Specifications live inside the project workspace — every spec sheet is
attached to a formulation — so they authorise against the
``formulations`` module rather than carrying their own module. Views
declare the capability they need (view / edit / approve / delete).
"""

from __future__ import annotations

from apps.formulations.api.permissions import HasFormulationsPermission


class HasSpecificationsPermission(HasFormulationsPermission):
    """Alias so specifications views keep expressive naming.

    All logic lives on :class:`HasFormulationsPermission` — spec sheets
    are another surface of the project workspace, not an independent
    permission scope.
    """

    pass
