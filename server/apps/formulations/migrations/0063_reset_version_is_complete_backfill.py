"""Reset the pragmatic backfill from 0062.

The 0062 migration whitelisted every existing named version as
``is_complete=True`` on the (wrong) assumption that the FE gate
would have prevented an incomplete save. In practice several
historical rows fail the current readiness rules (missing setup
fields added post-facto, orphan lines from an older wizard flow,
stage-type constraints that landed after the version was cut),
so the picker was showing versions that were never actually
checklist-clean.

Reset every row to ``is_complete=False``. Only saves cut against
the new ``save_version`` code path — which computes the gate live
at save time — will be trusted. Operators re-populate the picker
by clicking Save version once from a clean checklist.
"""

from django.db import migrations


def reset_is_complete(apps, schema_editor):
    FormulationVersion = apps.get_model("formulations", "FormulationVersion")
    FormulationVersion.objects.update(is_complete=False)


def reverse_noop(apps, schema_editor):
    """No inverse — 0062 already backfilled; we don't want to restore
    that pragmatic assumption."""


class Migration(migrations.Migration):

    dependencies = [
        ("formulations", "0062_formulationversion_is_complete"),
    ]

    operations = [
        migrations.RunPython(reset_is_complete, reverse_noop),
    ]
