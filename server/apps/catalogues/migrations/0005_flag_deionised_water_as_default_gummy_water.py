"""Flag the ``MA00531`` Deionised Water item across every org as the
default for the ``gummy_water`` band.

Companion to the auto-inject + validation landed in
``apps.formulations.services._ensure_gummy_water_pick``. That save-time
guard raises :class:`GummyWaterDefaultMissing` when a gummy formulation
has no water-named pick AND no catalogue item flagged as the org's
default for ``gummy_water``. This migration seeds the flag on the well-
known dev catalogue code so existing orgs' gummy saves keep working
without a manual admin step.

Idempotent:
* Skips items whose ``internal_code`` isn't ``MA00531`` — this is the
  only well-known water item across dev seeds; every other org will
  configure its own default via the item edit form UI.
* Skips items already flagged for ``gummy_water`` — safe to re-run.
* Preserves any other keys already sitting on ``attributes`` and any
  other bands the item is already flagged for (e.g. ``mcc_carrier``).

Reversible via the ``noop`` reverse — un-flagging is a manual admin
decision, not something a migration downgrade should silently do.
"""

from __future__ import annotations

from django.db import migrations


TARGET_INTERNAL_CODE = "MA00531"
BAND_KEY = "gummy_water"


def _flag_default_water(apps, schema_editor) -> None:
    Item = apps.get_model("catalogues", "Item")
    for item in Item.objects.filter(internal_code=TARGET_INTERNAL_CODE):
        attributes = dict(item.attributes or {})
        existing = attributes.get("default_for_bands")
        if isinstance(existing, list):
            bands = [str(b) for b in existing if isinstance(b, str)]
        else:
            bands = []
        if BAND_KEY in bands:
            continue
        bands.append(BAND_KEY)
        attributes["default_for_bands"] = bands
        item.attributes = attributes
        # ``update_fields`` scoped so the migration doesn't accidentally
        # bump every other tracked field's audit trail.
        item.save(update_fields=["attributes"])


def _noop_reverse(apps, schema_editor) -> None:
    """Reverse is a noop — un-flagging a default item is a manual
    admin decision, not a schema concern."""


class Migration(migrations.Migration):

    dependencies = [
        ("catalogues", "0004_item_regulatory_risk"),
    ]

    operations = [
        migrations.RunPython(_flag_default_water, _noop_reverse),
    ]
