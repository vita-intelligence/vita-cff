"""Composite index on ``(organization, project_type, is_rtg_published, -updated_at)``
so the RTG catalog list + counts stop paying an index scan on every open.

Previously the RTG catalog list query ran as:

    WHERE organization_id = ? AND project_type = 'ready_to_go'
    [AND is_rtg_published = ?]
    ORDER BY updated_at DESC

The planner used the single-column ``(organization, -updated_at)`` index for
the sort order and filtered ``project_type`` / ``is_rtg_published`` in the
heap read. On a tenant where 99% of formulations are Custom, that reads ~100x
more heap pages than necessary before returning the first RTG page. Same
problem on the counts endpoint — two ``COUNT(*)`` calls each had to walk the
org's whole updated_at chain.

This composite serves:

- ``list_formulations(project_type='ready_to_go', is_rtg_published=?)`` — the
  RTG catalog list, ordered by ``-updated_at``. Full index scan, no heap
  filter, no sort.
- ``RtgCatalogCountsView`` — both COUNT(*) calls use the ``(organization,
  project_type)`` prefix.
- Existing ``list_formulations(project_type='custom')`` on ``/formulations/``
  also benefits: same prefix, sorted by ``-updated_at``.

Cost: one composite index per row (~50 bytes). Existing single-column indexes
on ``project_type`` / ``is_rtg_published`` are kept — they still serve
cross-org queries (audit, admin dumps).
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("formulations", "0074_page_builder_template"),
    ]

    operations = [
        migrations.AddIndex(
            model_name="formulation",
            index=models.Index(
                fields=("organization", "project_type", "is_rtg_published", "-updated_at"),
                name="formulations_rtg_catalog_idx",
            ),
        ),
    ]
