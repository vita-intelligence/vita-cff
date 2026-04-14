"""Project-wide pytest fixtures.

Fixtures defined here are automatically available to every test file under
the ``apps/`` testpath. Keep this file small and focused on cross-cutting
concerns; app-specific fixtures belong in each app's ``tests/conftest.py``.
"""

from __future__ import annotations

import pytest
from django.urls import reverse
from rest_framework.test import APIClient


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
