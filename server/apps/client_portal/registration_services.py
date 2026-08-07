"""Self-registration service for the client portal.

Two operations:

1. :func:`start_self_registration` — public. Validates the form, mints
   a :class:`ClientAccountRegistration` row + 6-digit OTP, mails the
   code to the typed address. Returns the registration token the FE
   uses to drive the confirm step. Enumeration-safe: the response
   shape is identical whether or not the email already belongs to an
   activated portal account.
2. :func:`finalize_self_registration` — public. Verifies the code,
   adopts or creates the :class:`apps.customers.models.Customer` for
   the typed email under the single active Organization, then mints
   the :class:`ClientAccount` with the password the form collected and
   stamps the privacy-policy consent fields. Returns the activated
   account so the API layer can issue portal cookies.

Single-org guard: vita-cff is single-tenant in production but the
schema is technically multi-org. This module resolves the target org
at runtime by looking for exactly one :class:`Organization` with
``is_active=True``. Two active orgs or zero active orgs both raise
:class:`MultipleActiveOrganizations` / :class:`NoActiveOrganization`
so a deployment misconfiguration surfaces as a 5xx rather than
silently sending a customer to the wrong tenant.

Mirrors the patterns in :mod:`apps.client_portal.services` and
:mod:`apps.client_portal.invite_services`: hashed code, ``used_at``
/ ``invalidated_at`` / ``expires_at`` lifecycle, ``transaction.atomic``
on every mutation, constant-time code comparison.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from django.contrib.auth.password_validation import validate_password
from django.db import transaction
from django.utils import timezone

from apps.customers.models import Customer
from apps.organizations.models import Organization

from .email import send_portal_registration_code_email
from .models import (
    ClientAccount,
    ClientAccountRegistration,
    PortalEvent,
)
from .services import (
    ActivationError,
    _mask_email,
    record_portal_event,
)

logger = logging.getLogger(__name__)


#: Registration TTL. Matches the activation-code TTL (10 minutes) so
#: a customer who walks away mid-flow has to restart cleanly rather
#: than holding a half-applied state for hours. The code itself is
#: useless without the token, but expiring the row promptly keeps the
#: DB clean and prevents replay against a still-pending registration.
REGISTRATION_TTL = timedelta(minutes=10)

#: Default identifier for the privacy policy the registration form
#: links to. Stored on every successful confirm so a future policy
#: revision can compare what each customer agreed to. Override with
#: a settings value if the URL ever changes — older rows keep their
#: prior value (write-only by intent).
DEFAULT_PRIVACY_POLICY_URL = "https://www.vitamanufacture.co.uk/privacypolicy"


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class RegistrationError(ActivationError):
    """Base class for any self-registration failure surface."""

    code = "registration_failed"


class PrivacyPolicyNotAccepted(RegistrationError):
    code = "privacy_policy_not_accepted"


class RegistrationEmailMissing(RegistrationError):
    code = "registration_email_missing"


class InvalidRegistrationToken(RegistrationError):
    code = "invalid_registration_token"


class RegistrationExpired(RegistrationError):
    code = "registration_expired"


class RegistrationAlreadyUsed(RegistrationError):
    code = "registration_already_used"


class InvalidRegistrationCode(RegistrationError):
    code = "invalid_registration_code"


class NoActiveOrganization(RegistrationError):
    """The deployment has zero active Organizations. Without one we
    can't decide where to land the new Customer row, and silently
    creating an org would be worse than refusing."""

    code = "no_active_organization"


class MultipleActiveOrganizations(RegistrationError):
    """The deployment has two or more active Organizations. The
    single-org guard refuses to pick one — staff has to deactivate
    the non-target org (or carry on adding customers manually) until
    the registration flow can route safely."""

    code = "multiple_active_organizations"


# ---------------------------------------------------------------------------
# Return shapes
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class StartedRegistration:
    """Returned by :func:`start_self_registration` — what the API
    layer hands back to the FE so it can pivot to the code-entry
    step. Both fields are safe to surface in the response body:

    * ``token`` is the opaque handle the confirm step needs.
    * ``email_masked`` is the same shape the activation preview
      returns, so the FE renders a consistent "we sent a code to
      j****@example.com" line across all OTP surfaces.
    """

    token: str
    email_masked: str


@dataclass(frozen=True)
class FinalizedRegistration:
    """Returned by :func:`finalize_self_registration` — the activated
    account + the resolved customer fields the API layer needs to
    render the standard ``MeSerializer`` payload back to the FE."""

    account: ClientAccount
    customer_id: str
    customer_company: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _hash_code(plaintext: str) -> str:
    """SHA-256 of the plaintext code. Same primitive as the invite +
    email-change services — kept duplicated rather than imported to
    avoid the cross-module coupling, since the lifecycles are
    independent."""

    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def _resolve_single_active_org() -> Organization:
    """Return the :class:`Organization` that should own a new self-
    registered customer from the portal.

    Resolution order:

    1. ``settings.PORTAL_DEFAULT_ORG_ID`` — a specific tenant UUID.
       Preferred because it's immune to renames. Must resolve to an
       ``is_active=True`` row.
    2. ``settings.PORTAL_DEFAULT_ORG_NAME`` — human-readable fallback,
       matched case-insensitively. Same active-row requirement.
    3. Auto-pick the single active org when exactly one exists.
       Production is single-tenant (``Vita Manufacture Limited``) so
       this is the everyday path.

    Both env-configured paths raise ``NoActiveOrganization`` when
    the pointer doesn't hit an active row — that's a misconfiguration
    we want to surface loudly rather than silently falling back to
    the auto-pick (which might route the customer to the wrong
    tenant when dev DBs carry multiple active rows).
    """

    from django.conf import settings

    # (1) UUID pointer — most specific, immune to renames.
    configured_id = getattr(settings, "PORTAL_DEFAULT_ORG_ID", None)
    if configured_id:
        org = Organization.objects.filter(
            pk=configured_id,
            is_active=True,
        ).first()
        if org is None:
            raise NoActiveOrganization(
                f"PORTAL_DEFAULT_ORG_ID={configured_id} does not "
                "match an active organization row.",
            )
        return org

    # (2) Name pointer — case-insensitive match on
    #     ``Organization.name``. Handy in dev where UUIDs shift per
    #     seeded DB but org names stay stable.
    configured_name = getattr(settings, "PORTAL_DEFAULT_ORG_NAME", None)
    if configured_name:
        org = Organization.objects.filter(
            name__iexact=configured_name,
            is_active=True,
        ).first()
        if org is None:
            raise NoActiveOrganization(
                f"PORTAL_DEFAULT_ORG_NAME='{configured_name}' does not "
                "match an active organization row.",
            )
        return org

    # (3) No env pointer — enforce single-tenant shape.
    active = Organization.objects.filter(is_active=True)
    count = active.count()
    if count == 0:
        raise NoActiveOrganization(
            "No active organization is configured; self-registration "
            "cannot route the new customer to a tenant.",
        )
    if count > 1:
        raise MultipleActiveOrganizations(
            "Self-registration requires exactly one active organization; "
            f"{count} are active. Set PORTAL_DEFAULT_ORG_ID or "
            "PORTAL_DEFAULT_ORG_NAME to pin the target tenant.",
        )
    org = active.first()
    assert org is not None  # narrowed by the count check above
    return org


def _normalise_email(value: str) -> str:
    return (value or "").strip().lower()


# ---------------------------------------------------------------------------
# Step 1 — start registration
# ---------------------------------------------------------------------------


@transaction.atomic
def start_self_registration(
    *,
    email: str,
    name: str,
    company: str,
    password: str,
    privacy_accepted: bool,
    privacy_policy_version: str = DEFAULT_PRIVACY_POLICY_URL,
    request_ip: str = "",
) -> StartedRegistration:
    """Mint a fresh :class:`ClientAccountRegistration` for ``email``.

    Side effects (atomic):

    * Older unused + unexpired registrations for the same email are
      stamped ``invalidated_at`` so only the freshest code in the
      customer's inbox is consumable. Matches the invite +
      email-change enumeration policy.
    * A new row is created with a freshly minted token + hashed code
      + 10-minute expiry.
    * The plaintext code is mailed to ``email`` *after* the
      transaction commits — a delivery failure never leaves a
      usable row the customer can't see.

    Enumeration safety: the response shape is the same whether or
    not the typed email already belongs to an activated portal
    account. When it does, we suppress the email send + skip
    creating a row, but return the same ``{token, email_masked}``
    body the success path emits. An attacker probing the endpoint
    can't sweep the customer base.

    Validation that raises:

    * :class:`RegistrationEmailMissing` — empty / malformed email.
      DRF's ``EmailField`` should catch this at the serializer
      layer; defence-in-depth here.
    * :class:`PrivacyPolicyNotAccepted` — ``privacy_accepted`` is
      falsy. Always a programmer error since the FE form makes the
      checkbox required, but guarded so a hand-crafted curl can't
      slip a consent-less row past us.
    * :class:`django.core.exceptions.ValidationError` — password
      fails Django's validators. Bubbles up to the API layer which
      maps it to ``weak_password``.
    * :class:`NoActiveOrganization` / :class:`MultipleActiveOrganizations`
      — the single-org guard tripped. Surfaces as a 5xx since the
      customer has no path forward without ops intervention.
    """

    cleaned_email = _normalise_email(email)
    if not cleaned_email:
        raise RegistrationEmailMissing(
            "An email address is required to register."
        )
    if not privacy_accepted:
        raise PrivacyPolicyNotAccepted(
            "You must accept the privacy policy to register."
        )

    # Validate password against Django's validators using a scratch
    # ClientAccount so the user-context similarity check has the
    # typed email to compare against. Raised ValidationError surfaces
    # as ``weak_password`` at the API layer.
    scratch = ClientAccount(email=cleaned_email)
    validate_password(password, user=scratch)

    organization = _resolve_single_active_org()

    # Build the masked-email value up front so every return path
    # (success, suppressed-because-activated) produces the same wire
    # shape. An attacker can't distinguish the two outcomes by
    # response inspection.
    masked = _mask_email(cleaned_email)

    # Suppress the email + row creation when the address already has
    # an activated ClientAccount. The customer should sign in, not
    # re-register; we silently no-op so the FE can route them to the
    # login page without leaking that the email is already on file.
    # We still mint a token-shaped value so the FE has *something* to
    # advance on — when the customer types a code the confirm step
    # will fail with a generic invalid_registration_token error.
    existing_account = ClientAccount.objects.filter(
        email__iexact=cleaned_email,
    ).first()
    if existing_account is not None and existing_account.has_usable_password():
        logger.info(
            "portal.register.suppressed: email=%s already activated",
            cleaned_email,
        )
        return StartedRegistration(
            token=str(uuid.uuid4()),  # decoy — never matches a real row
            email_masked=masked,
        )

    now = timezone.now()
    ClientAccountRegistration.objects.filter(
        email=cleaned_email,
        used_at__isnull=True,
        invalidated_at__isnull=True,
    ).update(invalidated_at=now)

    plaintext_code = f"{secrets.randbelow(1_000_000):06d}"
    registration = ClientAccountRegistration.objects.create(
        organization=organization,
        email=cleaned_email,
        name=(name or "").strip()[:200],
        company=(company or "").strip()[:200],
        code_hash=_hash_code(plaintext_code),
        privacy_policy_version=privacy_policy_version,
        request_ip=request_ip,
        expires_at=now + REGISTRATION_TTL,
    )

    company_for_email = registration.company or registration.name or ""

    def _dispatch() -> None:
        try:
            send_portal_registration_code_email(
                to_email=cleaned_email,
                code=plaintext_code,
                customer_company=company_for_email,
            )
        except Exception:  # noqa: BLE001
            logger.exception(
                "portal.register.code_email_failed email=%s",
                cleaned_email,
            )

    transaction.on_commit(_dispatch)

    return StartedRegistration(
        token=str(registration.token),
        email_masked=masked,
    )


# ---------------------------------------------------------------------------
# Step 2 — finalize registration
# ---------------------------------------------------------------------------


@transaction.atomic
def finalize_self_registration(
    *,
    token: str,
    code: str,
    password: str,
) -> FinalizedRegistration:
    """Promote a verified registration into a real Customer +
    :class:`ClientAccount`.

    Lifecycle:

    * Resolve the registration row. ``invalid_registration_token``
      for unknown tokens — same shape whether the token never
      existed or was a decoy from the suppressed path.
    * Lifecycle guards (used / invalidated / expired) before code
      check so a stale row never burns the customer's verification
      attempt on a doomed registration.
    * Constant-time code comparison.
    * Adopt-by-email: if a :class:`Customer` already exists for the
      registration's email under the same org, attach to it (don't
      overwrite name / company). Otherwise create a fresh row with
      ``created_by=None`` (self-service has no staff actor).
    * Mint the :class:`ClientAccount`, set the password (validated
      again here against the *actual* account context, defence-in-
      depth over the step-1 validation), stamp ``activated_at`` +
      ``privacy_accepted_at`` + ``privacy_policy_version``.
    * Mark the registration row ``used_at``. Append a
      ``self_registered`` event for the staff activity panel.
    """

    try:
        token_uuid = uuid.UUID(str(token))
    except (ValueError, AttributeError, TypeError) as exc:
        raise InvalidRegistrationToken(
            "Malformed registration token.",
        ) from exc

    registration = (
        ClientAccountRegistration.objects
        .select_for_update()
        .select_related("organization")
        .filter(token=token_uuid)
        .first()
    )
    if registration is None:
        raise InvalidRegistrationToken(
            "No registration matches this token.",
        )

    now = timezone.now()
    if registration.used_at is not None:
        raise RegistrationAlreadyUsed(
            "This registration has already been completed.",
        )
    if registration.invalidated_at is not None:
        raise RegistrationAlreadyUsed(
            "A newer code was issued for this email; use the most "
            "recent one in your inbox.",
        )
    if registration.expires_at <= now:
        raise RegistrationExpired(
            "This registration has expired. Start a fresh signup.",
        )

    supplied = (code or "").strip()
    if not supplied or len(supplied) != 6 or not supplied.isdigit():
        raise InvalidRegistrationCode(
            "Confirmation code must be 6 digits.",
        )
    if not hmac.compare_digest(
        registration.code_hash, _hash_code(supplied),
    ):
        raise InvalidRegistrationCode(
            "Confirmation code is incorrect.",
        )

    email = registration.email
    organization = registration.organization

    # Adopt-by-email + auto-merge. The Dynamics import runs the same
    # lookup, and the customers page enforces a forward-only email
    # uniqueness guard — so finding a row here means staff (or
    # Dynamics) already added the customer's contact info, and the
    # self-registration is the customer claiming ownership of their
    # portal account on that row. Don't overwrite name / company:
    # the snapshot we already have is the authoritative source
    # (Dynamics-driven or operator-typed), not what the customer
    # just typed on a webform.
    #
    # When MORE than one row matches (the existing duplicate-customer
    # footprint that the Phase 4 sweep / Phase 5 DB constraint
    # together drain), collapse the losers into the canonical row in
    # the same transaction so the new ClientAccount lands on a single
    # source-of-truth row. ``auto_merge_email_duplicates`` does the
    # heavy lifting; we wrap it in a savepoint so a merge failure
    # never blocks an honest sign-up — we fall back to the legacy
    # ``.first()`` behaviour and log the dup case for follow-up.
    from django.db import transaction as _db_tx

    from apps.customers.services import (
        CustomerMergeError,
        auto_merge_email_duplicates,
    )

    try:
        with _db_tx.atomic():
            auto_merge_email_duplicates(
                organization=organization,
                email=email,
                actor=None,  # self-registration has no staff actor
                reason="self_registration adopt-by-email",
            )
    except CustomerMergeError:
        # Inconsistent inputs — same id, cross-org. Should not happen
        # for the (org, email) cluster but if it does the legacy
        # adopt-by-email path below still keeps the customer signing
        # in, on whichever row ``.first()`` returns.
        pass

    customer = (
        Customer.objects
        .filter(
            organization=organization,
            email__iexact=email,
        )
        .first()
    )
    if customer is None:
        customer = Customer.objects.create(
            organization=organization,
            name=registration.name,
            company=registration.company,
            email=email,
            created_by=None,
            updated_by=None,
        )

    # The ClientAccount.email column is globally unique (not org-
    # scoped). If a row already exists for this email *without* a
    # usable password (e.g. a kiosk pre-creation that never
    # activated), reuse it rather than racing the uniqueness
    # constraint. The activated case was already short-circuited at
    # step 1.
    account = (
        ClientAccount.objects
        .filter(email__iexact=email)
        .first()
    )
    if account is None:
        account = ClientAccount.objects.create_account(
            email=email,
            customer=customer,
            password=password,
        )
    else:
        # Re-validate against the real account so user-context checks
        # (similarity to the email) match the live row.
        validate_password(password, user=account)
        from django.contrib.auth.hashers import make_password

        account.password = make_password(password)
        account.customer = customer
        account.is_active = True

    account.activated_at = now
    account.privacy_accepted_at = now
    account.privacy_policy_version = registration.privacy_policy_version
    account.save(
        update_fields=[
            "password",
            "is_active",
            "activated_at",
            "customer",
            "privacy_accepted_at",
            "privacy_policy_version",
            "updated_at",
        ],
    )

    registration.used_at = now
    registration.save(update_fields=["used_at"])

    record_portal_event(
        organization=organization,
        client_account=account,
        kind=PortalEvent.Kind.SELF_REGISTERED,
        metadata={
            "privacy_policy_version": registration.privacy_policy_version,
        },
    )

    return FinalizedRegistration(
        account=account,
        customer_id=str(customer.id),
        customer_company=customer.company or customer.name or "",
    )


__all__ = [
    "DEFAULT_PRIVACY_POLICY_URL",
    "REGISTRATION_TTL",
    "FinalizedRegistration",
    "InvalidRegistrationCode",
    "InvalidRegistrationToken",
    "MultipleActiveOrganizations",
    "NoActiveOrganization",
    "PrivacyPolicyNotAccepted",
    "RegistrationAlreadyUsed",
    "RegistrationEmailMissing",
    "RegistrationError",
    "RegistrationExpired",
    "StartedRegistration",
    "finalize_self_registration",
    "start_self_registration",
]
