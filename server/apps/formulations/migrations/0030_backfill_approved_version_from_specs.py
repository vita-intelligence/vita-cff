"""Backfill ``Formulation.approved_version_number`` from historical
director-approved spec sheets.

The customer-pipeline rewrite (commit ebadd9d) made
``set_approved_version`` get called automatically whenever a spec
sheet hits ``status=approved`` (the director signature). That
covers every sheet director-approved from that commit onwards, but
on production there were already plenty of formulations whose
sheets had been director-signed weeks earlier — their
``approved_version_number`` was still ``None`` because the auto-
wiring didn't exist yet, so the proposal-creation picker was
hiding them.

This migration walks every formulation whose pointer is still
``None``, finds the highest version_number with a spec sheet in
``approved`` / ``sent`` / ``accepted`` (all three states imply the
director signed at some point), and pins the pointer to that
version. Idempotent — re-running adds nothing new and never
overwrites a value that's already set.
"""

from __future__ import annotations

from django.db import migrations


#: Spec-sheet statuses that imply the director has already signed
#: the sheet at some point in its lifecycle. ``rejected`` is
#: deliberately omitted — a rejection can land before the director
#: ever signs, so the status alone doesn't prove approval.
_DIRECTOR_SIGNED_STATUSES = ("approved", "sent", "accepted")


def backfill(apps, schema_editor):
    Formulation = apps.get_model("formulations", "Formulation")
    SpecificationSheet = apps.get_model(
        "specifications", "SpecificationSheet"
    )

    backfilled = 0
    skipped_no_signed_sheet = 0
    already_set = 0

    for formulation in Formulation.objects.all():
        if formulation.approved_version_number is not None:
            already_set += 1
            continue

        sheet = (
            SpecificationSheet.objects.filter(
                formulation_version__formulation_id=formulation.id,
                status__in=_DIRECTOR_SIGNED_STATUSES,
            )
            # Highest version wins — matches the auto-wiring rule
            # that "last director-approved version is the quotable
            # one". Tie-break by director_signed_at descending so a
            # later approval on the same version still beats an
            # earlier one if the data is odd.
            .order_by(
                "-formulation_version__version_number",
                "-director_signed_at",
            )
            .first()
        )
        if sheet is None:
            skipped_no_signed_sheet += 1
            continue

        formulation.approved_version_number = (
            sheet.formulation_version.version_number
        )
        formulation.save(update_fields=["approved_version_number"])
        backfilled += 1

    print(
        f"  [backfill_approved_version_from_specs] "
        f"backfilled: {backfilled}, "
        f"already set: {already_set}, "
        f"no director-signed sheet: {skipped_no_signed_sheet}"
    )


def revert(apps, schema_editor):
    """Roll-back is intentionally a no-op.

    The forward pass only fills ``None`` pointers — it never
    overwrites a value that was set manually or by the runtime
    auto-wiring. Reversing would clear pointers operators may
    have come to rely on, so we keep the migration one-way.
    """
    return None


class Migration(migrations.Migration):

    dependencies = [
        ("formulations", "0029_formulation_formulations_org_status_idx"),
        # Reach across to specifications so the SpecificationSheet
        # model is registered on the historical app set when the
        # backfill runs.
        ("specifications", "0012_specificationsheet_specs_formulation_version_idx"),
    ]

    operations = [
        migrations.RunPython(backfill, revert),
    ]
