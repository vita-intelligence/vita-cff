"""Collapse duplicate LabelDesign rows onto a single row per
formulation, then swap the uniqueness rule.

Historical bug: :mod:`apps.label_design.signals` created a fresh
:class:`LabelDesign` for every customer-signed spec sheet, including
draft-kind specs and every revised final on the same project. Real-
world usage produced 3+ label-design rows per formulation instead of
one, all of which fanned out through payment approval into duplicate
"choose a design path" rows on the customer dashboard.

Correct end state: **one LabelDesign per formulation**. Multi-PRODUCT
proposals still get one LabelDesign per product because each product
IS a separate formulation. Multi-spec-revision projects collapse.

## Migration shape

1. **Remove the old `(formulation, specification_sheet)` unique
   constraint.** Without this the delete step below can't safely
   free up conflicting rows.
2. **Widen `specification_sheet` FK** — SET_NULL on delete + nullable
   spelling stays the same but the on-delete behaviour changes so we
   don't cascade a spec deletion into a label workflow.
3. **Data step**: walk every formulation with > 1 LabelDesign, keep
   the row with the most-advanced status (never lose an in-progress
   workflow), and delete the rest. Winner's ``specification_sheet``
   FK stays put — it points at the spec that originally seeded the
   winner, which is fine as an audit anchor even if a later revision
   is now the current one.
4. **Add the new `(formulation,)` unique constraint** — safe once
   step 3 has collapsed duplicates.

Reversal restores the old constraint but does NOT recreate the
deleted duplicate rows. Downgrading past this migration on a
database that saw the collapse is a one-way trip; the audit trail on
the deleted rows survives in the audit log so the history isn't lost.
"""

from __future__ import annotations

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


# Ordered most-advanced → least. When collapsing duplicates we keep
# the row whose status appears earliest in this list — never losing
# an in-progress workflow to a fresh PAYMENT_PENDING sibling.
STATUS_PRIORITY = [
    "label_approved",
    "customer_approval",
    "director_review",
    "scientist_review",
    "design_in_progress",
    "design_preferences_pending",
    "label_path_pending",
    "on_hold",
    "payment_pending",
]


def _collapse_duplicates(apps, schema_editor):
    LabelDesign = apps.get_model("label_design", "LabelDesign")
    from collections import defaultdict

    grouped: dict = defaultdict(list)
    for row in LabelDesign.objects.all():
        grouped[row.formulation_id].append(row)

    deleted = 0
    for formulation_id, rows in grouped.items():
        if len(rows) < 2:
            continue

        # Rank by (status priority ascending, created_at descending).
        # A tied status ties break to the most recently created row,
        # which is the one whose spec trigger is freshest.
        def rank(r):
            try:
                priority = STATUS_PRIORITY.index(r.status)
            except ValueError:
                priority = len(STATUS_PRIORITY)  # unknown → lowest
            return (priority, -r.created_at.timestamp())

        rows.sort(key=rank)
        winner = rows[0]
        losers = rows[1:]

        for loser in losers:
            # Ripple the loser's child rows onto the winner before
            # delete so we don't cascade-drop transitions, revisions,
            # preferences, or payment links that were tied to a
            # doomed row.
            LabelDesignTransition = apps.get_model(
                "label_design", "LabelDesignTransition"
            )
            LabelDesignRevision = apps.get_model(
                "label_design", "LabelDesignRevision"
            )
            LabelDesignPreferences = apps.get_model(
                "label_design", "LabelDesignPreferences"
            )

            LabelDesignTransition.objects.filter(
                label_design=loser
            ).update(label_design=winner)
            LabelDesignRevision.objects.filter(
                label_design=loser
            ).update(label_design=winner)

            # Preferences is a OneToOne on the LabelDesign; if the
            # loser had one and the winner didn't, move the pointer.
            if loser.preferences_id and not winner.preferences_id:
                winner.preferences_id = loser.preferences_id
                winner.save(update_fields=["preferences"])
                # Detach from loser so its cascade doesn't nuke the
                # row we just linked to the winner.
                LabelDesignPreferences.objects.filter(
                    id=loser.preferences_id
                ).update()  # no-op; the FK was on LabelDesign side

            # Payments reference LabelDesign via a nullable FK — repoint.
            Payment = apps.get_model("payments", "Payment")
            Payment.objects.filter(label_design=loser).update(
                label_design=winner
            )

            loser.delete()
            deleted += 1

    if deleted:
        print(
            f"  [label_design_collapse] deleted {deleted} duplicate "
            "LabelDesign row(s); one per formulation retained."
        )


def _noop_reverse(apps, schema_editor):
    """We cannot re-materialise the deleted duplicate rows. The audit
    log preserves their creation events so no forensic history is
    lost; the workflow simply cannot be un-collapsed by a schema
    downgrade."""

    pass


class Migration(migrations.Migration):

    dependencies = [
        ("client_portal", "0006_self_registration"),
        ("formulations", "0035_formulation_rtg_display_name"),
        (
            "label_design",
            "0004_labeldesigntemplatecategory_labeldesigntemplate_and_more",
        ),
        ("organizations", "0015_backfill_rtg_catalog_module"),
        ("payments", "0001_initial"),
        (
            "specifications",
            "0016_specificationsheet_specs_fv_kind_status_idx",
        ),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        # Drop the old constraint FIRST so the data step can freely
        # collapse rows without tripping a UNIQUE violation.
        migrations.RemoveConstraint(
            model_name="labeldesign",
            name="label_design_unique_per_formulation_spec",
        ),
        migrations.AlterField(
            model_name="labeldesign",
            name="formulation",
            field=models.ForeignKey(
                help_text=(
                    "The project this label belongs to. Exactly one "
                    "LabelDesign per formulation — enforced by the "
                    "unique constraint in Meta. Revised spec sheets "
                    "on the same project reuse the existing row rather "
                    "than spawning a second label workflow (labels are "
                    "per-product, and a spec revision on the same "
                    "product doesn't change the artwork surface)."
                ),
                on_delete=django.db.models.deletion.CASCADE,
                related_name="label_designs",
                to="formulations.formulation",
            ),
        ),
        migrations.AlterField(
            model_name="labeldesign",
            name="specification_sheet",
            field=models.ForeignKey(
                blank=True,
                help_text=(
                    "The customer-signed final spec sheet whose "
                    "acceptance gated entry to this workflow. Kept "
                    "for audit — points at the spec whose signature "
                    "originally triggered the bootstrap. When a later "
                    "revision is signed the pointer stays put; the "
                    "workflow doesn't restart. SET_NULL on delete "
                    "because losing the spec row shouldn't cascade "
                    "into losing the label workflow that followed "
                    "from it."
                ),
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="label_designs",
                to="specifications.specificationsheet",
            ),
        ),
        migrations.RunPython(_collapse_duplicates, _noop_reverse),
        migrations.AddConstraint(
            model_name="labeldesign",
            constraint=models.UniqueConstraint(
                fields=("formulation",),
                name="label_design_unique_per_formulation",
            ),
        ),
    ]
