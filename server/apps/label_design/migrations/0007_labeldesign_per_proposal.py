"""Split :class:`LabelDesign` from one-per-formulation to one-per-
(formulation, proposal).

Rationale: RTG catalog products get ordered N times per customer.
Each order is an independent business object with its own artwork
lifecycle — one customer can be reviewing the "back view" upload for
their second order while their first order is already
``label_approved`` and shipping. Sharing one LabelDesign across
those orders collapsed their state onto a single row so both portal
tabs showed the same artwork + status.

Data migration: existing rows get their ``proposal`` filled in from
the accepted / signed proposal that owns the spec sheet that
originally triggered their bootstrap. Rows whose spec sheet has no
proposal link (rare legacy) stay ``NULL`` — the (formulation, NULL)
slot still enforces the pre-fix invariant for that formulation.
"""

from __future__ import annotations

from django.db import migrations, models


def _backfill_proposal(apps, schema_editor):
    LabelDesign = apps.get_model("label_design", "LabelDesign")
    ProposalLine = apps.get_model("proposals", "ProposalLine")

    for ld in LabelDesign.objects.all().select_related("specification_sheet"):
        if ld.proposal_id is not None:
            continue
        sheet = ld.specification_sheet
        if sheet is None:
            continue
        # Prefer the proposal that ships THIS spec sheet. Fall back
        # to any accepted / sent+signed proposal on the formulation
        # so pre-link legacy rows still get attached.
        line = (
            ProposalLine.objects.filter(specification_sheet=sheet)
            .select_related("proposal")
            .order_by("-proposal__updated_at")
            .first()
        )
        if line is None and sheet.formulation_version_id is not None:
            line = (
                ProposalLine.objects.filter(
                    formulation_version_id=sheet.formulation_version_id,
                )
                .select_related("proposal")
                .order_by("-proposal__updated_at")
                .first()
            )
        if line is not None:
            ld.proposal_id = line.proposal_id
            ld.save(update_fields=["proposal"])


def _reverse_noop(apps, schema_editor):
    # Reverse migration wipes the FK — cheap + reversible if we ever
    # need to downgrade the schema.
    LabelDesign = apps.get_model("label_design", "LabelDesign")
    LabelDesign.objects.update(proposal=None)


class Migration(migrations.Migration):

    dependencies = [
        ("label_design", "0006_alter_labeldesign_status_and_more"),
        ("proposals", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="labeldesign",
            name="proposal",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=models.deletion.SET_NULL,
                related_name="label_designs",
                to="proposals.proposal",
            ),
        ),
        migrations.RunPython(_backfill_proposal, _reverse_noop),
        migrations.RemoveConstraint(
            model_name="labeldesign",
            name="label_design_unique_per_formulation",
        ),
        migrations.AddConstraint(
            model_name="labeldesign",
            constraint=models.UniqueConstraint(
                fields=("formulation", "proposal"),
                name="label_design_unique_per_formulation_proposal",
            ),
        ),
        migrations.AddIndex(
            model_name="labeldesign",
            index=models.Index(
                fields=("proposal",),
                name="label_desig_proposa_ee8f4b_idx",
            ),
        ),
    ]
