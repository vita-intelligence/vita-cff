"""Service layer for the organizations app.

The rule is simple: views do not touch the ORM directly and services do
not do authorization. A view is responsible for "is this user allowed to
call me?"; a service is responsible for "given a caller, do the work
correctly and atomically". Cross-app calls should always go through a
service function from here, never through a model import, so extracting
this app into its own service later stays a boundary refactor rather
than a rewrite.
"""

from __future__ import annotations

from typing import Any

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import QuerySet
from django.utils import timezone

from apps.organizations.models import Invitation, Membership, Organization
from apps.organizations.modules import (
    capabilities_for,
    is_row_scoped,
    is_valid_capability,
    is_valid_module,
)

UserModel = get_user_model()


@transaction.atomic
def create_organization(*, user: Any, name: str) -> Organization:
    """Create a new organization and promote ``user`` to its owner.

    Both the ``Organization`` row and its seeding ``Membership`` must be
    written together — a row on the first table without the second would
    leave an orgless creator, and the reverse is impossible thanks to the
    FK. The atomic block guarantees all-or-nothing semantics.
    """

    organization = Organization.objects.create(name=name, created_by=user)
    Membership.objects.create(
        user=user,
        organization=organization,
        is_owner=True,
        permissions={},
    )
    return organization


def list_user_organizations(user: Any) -> QuerySet[Organization]:
    """Return organizations the given user belongs to, newest first."""

    return (
        Organization.objects.filter(memberships__user=user)
        .order_by("name")
        .distinct()
    )


def get_membership(user: Any, organization: Organization) -> Membership | None:
    """Return the membership linking ``user`` and ``organization`` or ``None``."""

    return Membership.objects.filter(user=user, organization=organization).first()


def has_capability(
    membership: Membership | None,
    module_key: str,
    capability: str,
    *,
    scope: str | None = None,
) -> bool:
    """Check whether ``membership`` has ``capability`` on the given module.

    * ``None`` membership (user is not a member) always returns ``False``.
    * Owners bypass the permissions map entirely and always return ``True``.
    * Unknown modules or capabilities always return ``False`` — a check
      for a typoed capability string cannot silently succeed.
    * For *flat* modules the grant is a list of capability strings
      stored at ``membership.permissions[module_key]``. ``scope`` is
      ignored.
    * For *row-scoped* modules the grant is a ``{scope: [capabilities]}``
      dict. ``scope`` is required — omitting it on a row-scoped check
      always returns ``False``.
    """

    if membership is None:
        return False
    if not is_valid_module(module_key):
        return False
    if not is_valid_capability(module_key, capability):
        return False
    if membership.is_owner:
        return True

    granted = granted_capabilities(membership, module_key, scope=scope)
    return capability in granted


def granted_capabilities(
    membership: Membership | None,
    module_key: str,
    *,
    scope: str | None = None,
) -> frozenset[str]:
    """Return the set of capabilities ``membership`` holds on the module.

    Owner memberships short-circuit to every capability declared on the
    module — their ``permissions`` JSON is intentionally ignored. For
    row-scoped modules, ``scope`` selects which row's capability list
    is returned; omitting ``scope`` on a row-scoped module returns
    the empty set.
    """

    if membership is None or not is_valid_module(module_key):
        return frozenset()
    if membership.is_owner:
        return frozenset(capabilities_for(module_key))

    raw = membership.permissions.get(module_key)

    if is_row_scoped(module_key):
        if scope is None or not isinstance(raw, dict):
            return frozenset()
        inner = raw.get(scope)
        if not isinstance(inner, list):
            return frozenset()
        return _clean_capability_list(module_key, inner)

    if not isinstance(raw, list):
        return frozenset()
    return _clean_capability_list(module_key, raw)


def _clean_capability_list(module_key: str, raw: list) -> frozenset[str]:
    """Filter ``raw`` down to capabilities actually declared on the module.

    Defensive step: even though :func:`has_capability` already refuses
    undeclared capability names, a stray entry in the DB (typo, rolled-
    back migration, etc.) shouldn't leak through as a positive match.
    """

    declared = set(capabilities_for(module_key))
    return frozenset(c for c in raw if isinstance(c, str) and c in declared)


# ---------------------------------------------------------------------------
# Invitations
# ---------------------------------------------------------------------------


class InvitationError(Exception):
    """Base class for invitation service errors.

    Each subclass maps to a machine-readable code the view layer surfaces
    to the client. Services never decide HTTP status — they raise a
    typed error and let the view translate.
    """

    code: str = "invitation_error"


class InvitationEmailAlreadyMember(InvitationError):
    code = "email_already_member"


class InvitationAlreadyExists(InvitationError):
    code = "invitation_already_exists"


class InvitationNotFound(InvitationError):
    code = "invitation_not_found"


class InvitationExpired(InvitationError):
    code = "invitation_expired"


class InvitationAlreadyAccepted(InvitationError):
    code = "invitation_already_accepted"


class InvitationEmailAlreadyRegistered(InvitationError):
    code = "email_already_registered"


def _normalize_email(raw: str) -> str:
    return UserModel.objects.normalize_email(raw).strip()


@transaction.atomic
def create_invitation(
    *,
    organization: Organization,
    invited_by: Any,
    email: str,
    permissions: dict[str, str] | None = None,
) -> Invitation:
    """Create a pending invitation for ``email`` to join ``organization``.

    Raises :class:`InvitationEmailAlreadyMember` if the email already
    belongs to an existing member, and :class:`InvitationAlreadyExists`
    if a pending invitation already exists for this ``(organization,
    email)`` pair.
    """

    normalized = _normalize_email(email)

    existing_member = Membership.objects.filter(
        organization=organization,
        user__email__iexact=normalized,
    ).exists()
    if existing_member:
        raise InvitationEmailAlreadyMember()

    existing_pending = Invitation.objects.filter(
        organization=organization,
        email__iexact=normalized,
        accepted_at__isnull=True,
    ).exists()
    if existing_pending:
        raise InvitationAlreadyExists()

    return Invitation.objects.create(
        organization=organization,
        invited_by=invited_by,
        email=normalized,
        permissions=permissions or {},
    )


def get_invitation_by_token(token: str) -> Invitation | None:
    """Return the invitation row for a token, or ``None`` if not found.

    Does *not* filter on expiry or accepted state — callers get the raw
    row and decide how to treat its state. This keeps "already accepted"
    and "expired" distinguishable at the view layer.
    """

    return (
        Invitation.objects.select_related("organization", "invited_by")
        .filter(token=token)
        .first()
    )


@transaction.atomic
def accept_invitation(
    *,
    token: str,
    first_name: str,
    last_name: str,
    password: str,
) -> tuple[Any, Invitation]:
    """Atomically create the user, membership, and mark the invite accepted.

    The caller is responsible for hashing concerns — this service uses
    the standard :meth:`UserManager.create_user` so Django's password
    validators and hashing run through the normal path.

    Returns ``(user, invitation)`` on success so the view can issue
    auth cookies for the new user immediately, same as the login flow.
    """

    invitation = (
        Invitation.objects.select_for_update()
        .select_related("organization")
        .filter(token=token)
        .first()
    )
    if invitation is None:
        raise InvitationNotFound()
    if invitation.accepted_at is not None:
        raise InvitationAlreadyAccepted()
    if invitation.is_expired:
        raise InvitationExpired()

    email = invitation.email
    if UserModel.objects.filter(email__iexact=email).exists():
        # This slice deliberately treats "one email, one account". A future
        # "login and accept" flow could change this, but for now we reject
        # so we do not silently attach a stranger's new password to an
        # existing account.
        raise InvitationEmailAlreadyRegistered()

    user = UserModel.objects.create_user(
        email=email,
        first_name=first_name,
        last_name=last_name,
        password=password,
    )

    Membership.objects.create(
        user=user,
        organization=invitation.organization,
        is_owner=False,
        permissions=dict(invitation.permissions or {}),
    )

    invitation.accepted_at = timezone.now()
    invitation.save(update_fields=["accepted_at", "updated_at"])

    return user, invitation
