"""Unit test for the ``0015_backfill_rtg_catalog_module`` migration
helper.

The migration walks every membership, mirrors ``formulations.edit``
onto ``rtg_catalog.view + manage + publish``, and leaves everything
else alone. Testing the helper function directly is simpler + faster
than driving the full ``migrate --plan`` pipeline; the migration
class body is a one-liner so the correctness surface is the helper.
"""

from __future__ import annotations

import pytest

from apps.organizations.rtg_catalog_permissions import (
    backfill_membership_permissions,
)


@pytest.mark.parametrize(
    "before, expected",
    [
        # Legacy formulations.edit → RTG mirrored on.
        (
            {"formulations": ["view", "edit"]},
            {
                "formulations": ["view", "edit"],
                "rtg_catalog": ["manage", "publish", "view"],
            },
        ),
        # No formulations.edit → no touch.
        (
            {"formulations": ["view"]},
            {"formulations": ["view"]},
        ),
        # Pre-existing partial rtg_catalog → merged, no downgrade.
        (
            {
                "formulations": ["view", "edit"],
                "rtg_catalog": ["view"],
            },
            {
                "formulations": ["view", "edit"],
                "rtg_catalog": ["manage", "publish", "view"],
            },
        ),
        # Bare permissions dict.
        ({}, {}),
        # Non-list formulations grant (someone hand-set it) → left alone.
        (
            {"formulations": "edit"},
            {"formulations": "edit"},
        ),
    ],
)
def test_backfill_membership_permissions(before, expected):
    result = backfill_membership_permissions(before)
    assert result == expected
