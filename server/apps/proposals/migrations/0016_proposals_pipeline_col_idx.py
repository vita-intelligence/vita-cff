"""Composite index for the CRM pipeline board.

Each kanban column query is
``WHERE org=X AND status=Y AND sales_person=Z ORDER BY -updated_at``
limited to the first 25 rows. Without a matching composite, Postgres
either falls back to the wider ``(org, status, -updated_at)`` index
and filters by sales_person in-memory (acceptable on small orgs,
slow on a 10k-proposal tenant) or the ``(org, sales_person)`` index
and re-sorts the result. The new index covers the predicate in one
b-tree range scan.

Index is non-unique and additive — the existing
``proposals_org_stat_upd_idx`` + ``proposals_org_sales_idx`` keep
serving their queries.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("proposals", "0015_proposal_activation_code"),
    ]

    operations = [
        migrations.AddIndex(
            model_name="proposal",
            index=models.Index(
                fields=[
                    "organization",
                    "status",
                    "sales_person",
                    "-updated_at",
                ],
                name="proposals_pipeline_col_idx",
            ),
        ),
    ]
