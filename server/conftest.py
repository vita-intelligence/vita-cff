"""Project-wide pytest fixtures.

Fixtures defined here are automatically available to every test file under
the ``apps/`` testpath. Keep this file small and focused on cross-cutting
concerns; app-specific fixtures belong in each app's ``tests/conftest.py``.
"""

from __future__ import annotations

import pytest
from django.db.models.signals import post_save
from django.urls import reverse
from rest_framework.test import APIClient

from apps.organizations.models import Organization


def _force_activate_organization(
    sender, instance: Organization, created: bool, **kwargs
) -> None:
    """Post-save signal: flip new orgs to ``is_active=True`` for tests.

    The pre-billing access gate defaults new orgs to ``is_active=False``,
    which is realistic for production but hostile to the suite: every
    existing test assumes the workspace is usable the instant it is
    created. Rather than sprinkling ``is_active=True`` across dozens of
    tests and factories, we hook ``post_save`` once here and flip the
    field during creation. Tests that exercise the gate explicitly
    deactivate the org after construction.
    """

    if not created or instance.is_active:
        return
    Organization.objects.filter(pk=instance.pk).update(is_active=True)
    instance.is_active = True


@pytest.fixture(autouse=True)
def _activate_created_organizations():
    post_save.connect(_force_activate_organization, sender=Organization)
    try:
        yield
    finally:
        post_save.disconnect(_force_activate_organization, sender=Organization)


@pytest.fixture
def api_client() -> APIClient:
    """A stateless DRF test client."""

    return APIClient()


@pytest.fixture
def register_url() -> str:
    """Reversed URL for the registration endpoint.

    Using ``reverse`` keeps tests decoupled from the literal path so future
    URL refactors do not cascade into the test suite.
    """

    return reverse("accounts:register")
