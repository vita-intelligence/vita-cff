"""Custom manager for :class:`ClientAccount`.

Mirrors :class:`apps.accounts.managers.UserManager` so test fixtures
and the activation service can rely on the same normalisation +
hashing contract as the staff side. Clients are deliberately a
separate manager (and table) because the lifecycle is different —
no first/last name required at creation (we lift those off the
:class:`apps.customers.models.Customer` row), no superuser concept,
and creation is always tied to a Customer row.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from django.contrib.auth.hashers import make_password
from django.contrib.auth.models import BaseUserManager

if TYPE_CHECKING:
    from apps.client_portal.models import ClientAccount


class ClientAccountManager(BaseUserManager["ClientAccount"]):
    """Manager for :class:`ClientAccount`.

    All creation paths flow through here so email normalisation +
    password hashing happen exactly once, in one place. The
    activation service is the only realistic caller in production
    (clients can't sign up themselves — they always come in via a
    kiosk email link). Tests + fixtures may also call directly.
    """

    use_in_migrations = True

    def create_account(
        self,
        *,
        email: str,
        customer,
        password: str | None = None,
        **extra_fields: Any,
    ) -> "ClientAccount":
        if not email:
            raise ValueError("An email address is required.")
        if customer is None:
            raise ValueError("A customer is required.")
        email = self.normalize_email(email)
        account = self.model(
            email=email,
            customer=customer,
            **extra_fields,
        )
        # ``set_unusable_password`` when no password yet — the
        # activation page is what assigns one. A ClientAccount with
        # an unusable password is in the "invited, not yet
        # activated" state.
        if password is None:
            account.set_unusable_password()
        else:
            account.password = make_password(password)
        account.save(using=self._db)
        return account
