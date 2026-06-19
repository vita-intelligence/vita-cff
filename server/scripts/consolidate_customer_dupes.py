"""Hand-curated customer-merge runner.

The merge algorithm itself lives in
:func:`apps.customers.services.merge_customers` — single source of
truth shared with the auto-merger inside
:func:`apps.customers.services.import_customer_from_dynamics` and
:func:`apps.client_portal.registration_services.finalize_self_registration`,
and with the ``manage.py merge_customer_duplicates`` sweep command.

This script is the legacy entry-point: paste a hand-built list of
``{canonical, duplicates, note}`` groups (typically from the output
of ``survey_customer_dupes.py``) and run it. Going forward the
recommended path is the management command, which auto-derives
groups by ``(organization, LOWER(email))`` — you only need this
script for one-off curated merges that don't share an email
(e.g. company-only groups, or anchor swaps).

Run with::

    .venv/bin/python manage.py shell < scripts/consolidate_customer_dupes.py

Always run ``survey_customer_dupes.py`` first so the IDs you paste
into ``GROUPS`` reflect the current state of prod.
"""

from __future__ import annotations

from typing import Any

from django.db import transaction

from apps.customers.models import Customer
from apps.customers.services import CustomerMergeError, merge_customers


# ---------------------------------------------------------------------------
# Edit this block per merge run. One entry per group from the survey.
# ---------------------------------------------------------------------------
GROUPS: list[dict[str, Any]] = [
    # ------------------------------------------------------------------
    # High impact: an activated portal login is on one row, but proposals
    # exist on the other(s) — the customer can't see those proposals on
    # their portal today. Merging makes the missing proposals visible.
    # Canonical is always the row that owns the activated ClientAccount,
    # so the customer keeps their existing login + cookies untouched.
    # ------------------------------------------------------------------
    {
        "canonical": "adbc6087-96e8-42d1-b7d4-96756f08de5b",
        "duplicates": ["ad8cfd25-1cb7-4c00-bb5c-f54bb30f2417"],
        "note": "Beckles Fitness Ltd — Tom sees 1/3; reveal PROP-0087 + PROP-0130",
    },
    {
        "canonical": "2e7292c2-c363-4cba-b698-43ab70679605",
        "duplicates": ["3d3d961c-1c40-497c-bc93-e64f836f17e9"],
        "note": "Ahamed Luthfi / Puram Retail Ltd — sees 1/2",
    },
    {
        "canonical": "123d56e6-2470-497e-8263-2d3ea33c722a",
        "duplicates": ["a8b00969-2135-475b-91dd-3f38e59a53a1"],
        "note": "Bradley Deacons / PROEL — sees 1/2",
    },
    {
        "canonical": "723952c7-b733-41f4-a3f3-29ba5f4beaea",
        "duplicates": ["24935f3b-22ad-405e-b5fe-4eeb166245f4"],
        "note": "Reyllen Ltd (Maros) — sees 1/2",
    },
    {
        "canonical": "806d2fb3-2211-49d2-ae48-313166c7c252",
        "duplicates": ["9b9c0e5a-69b4-41bd-9786-5ceb08d63869"],
        "note": "Tony / T5 Retail / Nisa Direct — sees 5/6",
    },
    # ------------------------------------------------------------------
    # Medium impact: customer has an activated portal login on the
    # canonical row, but the duplicate is empty or also has its share
    # of proposals on the activated row. No portal visibility gap today
    # — merging keeps the address book clean and prevents future
    # re-creation of the duplicate from a stale Dataverse import.
    # ------------------------------------------------------------------
    {
        "canonical": "939d61f3-12b6-410e-a414-fd200b0c9575",
        "duplicates": ["7dbe604f-1a8d-4e8c-bebc-bb3787531ffe"],
        "note": "Axon Supplements (Mohammad) — empty twin",
    },
    {
        "canonical": "b1c15ec4-78e9-467b-9068-a9dba5c860a5",
        "duplicates": ["73b0cd24-3e51-41ec-92c6-a7cce35c3f26"],
        "note": "Frances Cope / Grupo Bimbo — empty twin",
    },
    {
        "canonical": "378bc729-737c-45b8-9408-8ad4aed26235",
        "duplicates": ["b0758a7d-48df-4177-910a-7340c76b7d55"],
        "note": "Moonshot Wellness (Julia) — empty twin",
    },
    {
        "canonical": "9e74a6b2-ab0d-4466-b14b-1b9ced39ed3b",
        "duplicates": ["d9c1c3ee-eee5-4df0-9624-be9591a9cbd9"],
        "note": "Susie WHO / Susie Brient — empty twin",
    },
    {
        "canonical": "f97974e9-554a-4e49-946d-ac78c3952403",
        "duplicates": ["f156a6a6-f0c2-4d5d-9d03-5773be0a4578"],
        "note": "PostMyMeds (Imy) — empty twin (no-email)",
    },
    # ------------------------------------------------------------------
    # No portal account yet: pure data hygiene. Canonical is the row
    # that carries an email and/or Dataverse anchor so a future
    # Dynamics re-import still resolves to one local row. The empty
    # ghost gets merged in.
    # ------------------------------------------------------------------
    {
        "canonical": "a2a53261-0065-4445-8d4b-e80e1a3f2728",
        "duplicates": ["af249f3d-869d-458d-9307-d681ab173d6d"],
        "note": "Hatice (no portal yet) — keep row with proposal",
    },
    {
        "canonical": "bd5be564-07a7-4731-bcbf-e927a7628096",
        "duplicates": ["7bfeaaae-d915-4bfd-ab72-571792769488"],
        "note": "LDN Industries / Lewis Nolan — keep row with proposal",
    },
    {
        "canonical": "c6cd2db8-93e5-4fcb-acca-955ebcefd324",
        "duplicates": ["05831df2-fd8a-44cf-9ec9-b039541b8b76"],
        "note": "Finerday / Merley Miegel — keep row with proposal",
    },
    # Niki spans three rows: two share an email, a third shares only
    # the company. Single canonical entry collapses all three at once.
    {
        "canonical": "8a577110-f868-455e-ad4c-dba4b303ea59",
        "duplicates": [
            "045187b2-8318-4ab0-9da6-00b4c1f62bd5",
            "4eec5c2d-f486-4377-a188-5ec92cd7bb45",
        ],
        "note": "Whipped Nutrition / Niki MCginn — 3 rows: email-twin + company-only ghost",
    },
    {
        "canonical": "eb6b2adf-dca5-48aa-b9f1-d11666d362f9",
        "duplicates": ["07fc1636-14b3-43ef-b515-ccecc7457c2a"],
        "note": "Circadian FZ-LLC (Nina) — keep row with proposal",
    },
    {
        "canonical": "8fbbddf4-b56a-408d-8db7-8685b1fe4cea",
        "duplicates": ["fd921c84-8b8e-4d16-9393-fc4a9cc96f9b"],
        "note": "Naturix (William Bowen) — keep row with proposal",
    },
    # Company-only groups: the empty ghost has no email and no
    # Dataverse anchor; the canonical carries everything that
    # matters. These rows were almost always created by the early
    # Dynamics picker that showed both the account and a contact as
    # separate options.
    {
        "canonical": "a2532cce-d273-4d71-8556-624b5c2e91f8",
        "duplicates": ["e493e6ef-9d1e-4411-b76a-d5e4bc4a6130"],
        "note": "7319 LTD — keep email + dynamics + proposal row",
    },
    {
        "canonical": "b9ebdee2-eff7-4434-a016-484ac1e1f844",
        "duplicates": ["376f5267-5ecf-4eee-9733-42b602b8123f"],
        "note": "Aremont Group — keep proposal + dynamics row",
    },
    {
        "canonical": "56c0437b-eb0c-46ec-8d77-0e1b22bbf2c9",
        "duplicates": ["7743b0c6-51b0-41dc-9072-b99cdc5e5433"],
        "note": "Glow (Alaina Taylor) — keep email + proposals row",
    },
    {
        "canonical": "a2b09068-92ac-4a66-aaa4-13480434a379",
        "duplicates": ["a06a0a04-281c-4a98-80f0-ac79a500aa2a"],
        "note": "Naturallymine — keep proposal + dynamics row",
    },
    {
        "canonical": "9e3b4d85-0037-4171-a961-54d64ab7257a",
        "duplicates": ["e9fa2c88-39a7-4c3b-a391-f815bb6c66d4"],
        "note": "Snowden Ltd / Hugo Towne — keep email + proposal row",
    },
    {
        "canonical": "921b1f48-8d20-4e88-bf5a-f9c729c0981b",
        "duplicates": ["7536e150-c7aa-4b17-89bd-e3bcbc30dda0"],
        "note": "VitForm Innovations (Claire) — keep modern account+contact-anchored row",
    },
]


def _merge_group(group: dict[str, Any]) -> dict[str, Any]:
    canonical_id = group["canonical"]
    note = group.get("note") or ""
    duplicate_ids = list(group["duplicates"])

    if canonical_id in duplicate_ids:
        raise ValueError(
            f"canonical {canonical_id} is also listed as a "
            f"duplicate — refusing to run, fix the GROUPS entry."
        )

    canonical = Customer.objects.filter(pk=canonical_id).first()
    if canonical is None:
        raise LookupError(f"canonical customer {canonical_id} not found")

    summary: dict[str, Any] = {
        "canonical": str(canonical.pk),
        "canonical_company": canonical.company or canonical.name or "",
        "duplicates": [],
        "already_gone": [],
        "note": note,
    }

    for dup_id in duplicate_ids:
        duplicate = Customer.objects.filter(
            pk=dup_id, organization_id=canonical.organization_id,
        ).first()
        if duplicate is None:
            summary["already_gone"].append(str(dup_id))
            continue
        with transaction.atomic():
            try:
                merge_summary = merge_customers(
                    canonical=canonical,
                    duplicate=duplicate,
                    actor=canonical.created_by,
                    reason=note,
                )
            except CustomerMergeError as exc:
                summary["duplicates"].append(
                    {"id": str(dup_id), "error": str(exc)}
                )
                continue
        summary["duplicates"].append(merge_summary)

    return summary


def main() -> None:
    if not GROUPS:
        print(
            "GROUPS is empty — edit scripts/consolidate_customer_dupes.py "
            "and paste the canonical/duplicate IDs from the survey output."
        )
        return

    print("=" * 70)
    print(f"CONSOLIDATING {len(GROUPS)} customer group(s)")
    print("=" * 70)
    for idx, group in enumerate(GROUPS, start=1):
        print()
        print(
            f"--- group {idx}/{len(GROUPS)} → canonical "
            f"{group['canonical']} (note: {group.get('note') or '-'})"
        )
        try:
            summary = _merge_group(group)
        except (ValueError, LookupError) as exc:
            print(f"  SKIPPED: {exc}")
            continue
        print(f"  canonical : {summary['canonical_company']!r}")
        if summary["already_gone"]:
            print(
                f"  already gone (no-op): "
                f"{', '.join(summary['already_gone'])}"
            )
        for d in summary["duplicates"]:
            if "error" in d:
                print(f"  REFUSED {d['id']}: {d['error']}")
                continue
            print(
                f"  merged {d['merged_customer_id']}: "
                f"proposals={d['proposals_moved']} "
                f"logins(moved/deactivated)={d['client_logins_moved']}/"
                f"{d['client_logins_deactivated']} "
                f"invites(moved/invalidated)={d['invites_moved']}/"
                f"{d['invites_invalidated']} "
                f"email_archived={d['email_archived_as_alias']} "
                f"aliases_moved={d['existing_aliases_moved']} "
                f"events_following={d['portal_events_now_following']} "
                f"dyn_anchors_copied={','.join(d['dynamics_anchors_copied']) or '-'}"
            )
    print()
    print("=" * 70)
    print("DONE. Re-run scripts/survey_customer_dupes.py to confirm zero")
    print("groups remain (or to spot ones you intentionally left alone).")
    print("=" * 70)


main()
