"""DRF permission class for the comments API.

Comments piggy-back on the ``formulations`` module — the three
capabilities we added (``comments_view`` / ``comments_write`` /
``comments_moderate``) live on that module rather than on a dedicated
``comments`` module. Rationale: every comment attaches to a
project-workspace entity; granting "can comment here" without already
having "can see the project" would be nonsensical.
"""

from __future__ import annotations

from apps.formulations.api.permissions import HasFormulationsPermission


class HasCommentsPermission(HasFormulationsPermission):
    """Alias so comment views read naturally.

    All logic lives on :class:`HasFormulationsPermission`. The view
    sets ``required_capability`` to one of ``COMMENTS_VIEW`` /
    ``COMMENTS_WRITE`` / ``COMMENTS_MODERATE`` depending on the
    request method.
    """

    pass
