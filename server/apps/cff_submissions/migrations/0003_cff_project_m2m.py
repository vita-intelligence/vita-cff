"""Migrate :class:`CFFSubmission` from a single-project FK to an M2M
through :class:`CFFProjectAssignment`.

Order of operations matters here: the through-table and its FK
columns must exist *before* we copy the legacy ``project`` /
``assigned_by`` / ``assigned_at`` data into it, and the legacy
columns must only drop *after* the copy succeeds. The Django
auto-generator emits ``RemoveField`` first, so this file rewrites
the operations list to interleave a ``RunPython`` data copy in the
right slot. ``atomic = True`` (Django's default for non-trivial
migrations) means a partial run rolls back as a unit — operators
never end up with the through table created and the source data
already gone.
"""

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


def copy_legacy_assignments(apps, schema_editor):
    """Backfill the new through-table from the legacy single-FK shape.

    Walks every :class:`CFFSubmission` row whose ``project_id`` was
    set under the old schema and materialises one matching
    :class:`CFFProjectAssignment`. Uses ``bulk_create`` so the
    historical ``assigned_at`` survives the copy — a regular
    ``.create()`` would have ``auto_now_add=True`` rewrite the
    timestamp to "right now", losing the original audit trail. We
    fall back to ``imported_at`` when the legacy row never had
    ``assigned_at`` populated (older CFFs from before the audit
    field landed).
    """

    CFFSubmission = apps.get_model("cff_submissions", "CFFSubmission")
    CFFProjectAssignment = apps.get_model(
        "cff_submissions", "CFFProjectAssignment"
    )

    legacy = CFFSubmission.objects.filter(project_id__isnull=False).values(
        "id",
        "project_id",
        "assigned_by_id",
        "assigned_at",
        "imported_at",
    )
    rows = [
        CFFProjectAssignment(
            submission_id=row["id"],
            project_id=row["project_id"],
            assigned_by_id=row["assigned_by_id"],
            assigned_at=row["assigned_at"] or row["imported_at"],
        )
        for row in legacy
    ]
    if rows:
        # ``bulk_create`` skips auto_now_add so the original
        # timestamps are preserved. ``ignore_conflicts`` is
        # belt-and-braces against the (theoretically impossible
        # under the old schema) case where a (submission, project)
        # pair already exists — the unique constraint added later
        # in this migration would catch it anyway.
        CFFProjectAssignment.objects.bulk_create(
            rows, ignore_conflicts=True, batch_size=500,
        )


def restore_legacy_assignments(apps, schema_editor):
    """Reverse of :func:`copy_legacy_assignments`.

    Lets ``migrate cff_submissions 0002`` undo the move by copying
    the most-recent assignment for each CFF back onto the legacy
    FK columns. Multi-project CFFs lose the extra links on rollback
    — that's the inevitable cost of reversing a 1:N → 1:1
    consolidation. We pick the most recent link by ``assigned_at``
    so a recently-attached secondary project wins over an older
    primary one (matches what a human operator would expect after a
    rollback).
    """

    CFFSubmission = apps.get_model("cff_submissions", "CFFSubmission")
    CFFProjectAssignment = apps.get_model(
        "cff_submissions", "CFFProjectAssignment"
    )

    latest_per_cff: dict[str, dict] = {}
    for row in (
        CFFProjectAssignment.objects.order_by("-assigned_at").values(
            "submission_id", "project_id", "assigned_by_id", "assigned_at",
        )
    ):
        latest_per_cff.setdefault(row["submission_id"], row)

    for submission_id, row in latest_per_cff.items():
        CFFSubmission.objects.filter(pk=submission_id).update(
            project_id=row["project_id"],
            assigned_by_id=row["assigned_by_id"],
            assigned_at=row["assigned_at"],
        )


class Migration(migrations.Migration):

    dependencies = [
        ("cff_submissions", "0002_cffsubmission_submitter_email"),
        ("formulations", "0031_formulation_formulations_org_sales_idx"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        # 1. Stand up the new through-table and its FK columns.
        migrations.CreateModel(
            name="CFFProjectAssignment",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                (
                    "assigned_at",
                    models.DateTimeField(
                        auto_now_add=True,
                        help_text=(
                            "Stamped on insert. Use the most recent row "
                            "to answer 'when was this CFF last touched'."
                        ),
                    ),
                ),
            ],
            options={
                "verbose_name": "CFF project assignment",
                "verbose_name_plural": "CFF project assignments",
                "ordering": ("-assigned_at",),
            },
        ),
        migrations.AddField(
            model_name="cffprojectassignment",
            name="assigned_by",
            field=models.ForeignKey(
                blank=True,
                help_text=(
                    "User who created this link. ``NULL`` for system-driven "
                    "links (importer back-fill, future webhook paths)."
                ),
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="+",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name="cffprojectassignment",
            name="project",
            field=models.ForeignKey(
                help_text="Project the CFF is being attached to.",
                on_delete=django.db.models.deletion.CASCADE,
                related_name="cff_assignments",
                to="formulations.formulation",
            ),
        ),
        migrations.AddField(
            model_name="cffprojectassignment",
            name="submission",
            field=models.ForeignKey(
                help_text="CFF being attached.",
                on_delete=django.db.models.deletion.CASCADE,
                related_name="assignments",
                to="cff_submissions.cffsubmission",
            ),
        ),
        # 2. Tell the ORM about the M2M on CFFSubmission (purely a
        #    state op — no DB column is added since the through-table
        #    already exists from step 1).
        migrations.AddField(
            model_name="cffsubmission",
            name="projects",
            field=models.ManyToManyField(
                blank=True,
                related_name="cff_submissions",
                through="cff_submissions.CFFProjectAssignment",
                through_fields=("submission", "project"),
                to="formulations.formulation",
            ),
        ),
        # 3. Backfill existing single-project assignments into the
        #    new shape BEFORE the legacy columns are dropped.
        migrations.RunPython(
            copy_legacy_assignments,
            reverse_code=restore_legacy_assignments,
            elidable=False,
        ),
        # 4. Drop the now-redundant legacy columns and their index.
        migrations.RemoveIndex(
            model_name="cffsubmission",
            name="cff_submiss_organiz_d44e84_idx",
        ),
        migrations.RemoveField(
            model_name="cffsubmission",
            name="assigned_at",
        ),
        migrations.RemoveField(
            model_name="cffsubmission",
            name="assigned_by",
        ),
        migrations.RemoveField(
            model_name="cffsubmission",
            name="project",
        ),
        # 5. Add the new through-table indexes + uniqueness guard.
        #    Uniqueness lands LAST so any (theoretical) duplicate
        #    pairs in the legacy data would surface at copy time
        #    via ``ignore_conflicts`` rather than blowing up the
        #    whole migration.
        migrations.AddIndex(
            model_name="cffprojectassignment",
            index=models.Index(
                fields=["project", "-assigned_at"],
                name="cff_submiss_project_2d06be_idx",
            ),
        ),
        migrations.AddConstraint(
            model_name="cffprojectassignment",
            constraint=models.UniqueConstraint(
                fields=("submission", "project"),
                name="cff_assignment_unique_per_pair",
            ),
        ),
    ]
