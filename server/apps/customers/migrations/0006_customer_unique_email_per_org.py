"""Add a partial unique index on ``(organization_id, LOWER(email))``
to seal the duplicate-customer trap at the database level.

Belt-and-braces sibling to the in-process auto-merger inside
:func:`apps.client_portal.registration_services.finalize_self_registration`
and :func:`apps.customers.services.import_customer_from_dynamics` —
those code paths catch every duplicate they can see, but two
concurrent transactions can both look up "is there a Customer for
this email?", both see "no", and both ``Customer.objects.create``
a fresh row before either commits. The DB constraint refuses the
second commit with ``IntegrityError`` so even the racy path can't
land a duplicate.

The index is partial — ``WHERE email <> ''`` — so the historical
"contact-only" rows (rare freelancer Dataverse imports + Niki-style
ghosts) that have no email are not constrained. A NULL or empty
email is the schema's "no canonical address for this contact yet"
signal and we don't want to refuse it.

Pre-flight: every existing ``(org, LOWER(email))`` cluster must be
collapsed to a single row before this migration applies. Run
``manage.py merge_customer_duplicates --dry-run`` to preview the
plan, then ``manage.py merge_customer_duplicates`` to apply. The
migration fails loud with the DB's ``unique_violation`` if a dup
slips through, so re-running the merge command after the failure
and retrying the migration is a safe recovery.

The migration is a no-op on non-Postgres backends (SQLite test DB)
— the partial-index syntax + ``CONCURRENTLY`` modifier are Postgres
features, and the test environment doesn't exercise the constraint
at the DB level. The model-side guards (auto-merger + email__iexact
adopt) still run on every backend.
"""

from __future__ import annotations

from django.db import connection, migrations


def _create_index_pg(apps, schema_editor) -> None:
    """Create the partial unique index — Postgres only.

    ``CONCURRENTLY`` avoids locking the table during creation so the
    migration can run against a live prod DB without blocking
    writes. ``IF NOT EXISTS`` keeps the migration idempotent for
    re-runs.
    """

    if schema_editor.connection.vendor != "postgresql":
        return
    schema_editor.execute(
        "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "
        "customers_unique_email_per_org_ci "
        "ON customers_customer (organization_id, LOWER(email)) "
        "WHERE email <> '';"
    )


def _drop_index_pg(apps, schema_editor) -> None:
    if schema_editor.connection.vendor != "postgresql":
        return
    schema_editor.execute(
        "DROP INDEX CONCURRENTLY IF EXISTS "
        "customers_unique_email_per_org_ci;"
    )


# ``CREATE UNIQUE INDEX CONCURRENTLY`` cannot run inside a
# transaction block, so the migration opts out of Django's automatic
# transaction wrapping. Without this, Postgres refuses the statement
# with ``cannot run inside a transaction block``.
class Migration(migrations.Migration):

    atomic = False

    dependencies = [
        ("customers", "0005_nullable_customer_actors"),
    ]

    operations = [
        migrations.RunPython(
            _create_index_pg,
            reverse_code=_drop_index_pg,
        ),
    ]
