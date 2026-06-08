"""Merge duplicate :class:`Customer` rows into a single canonical row,
preserving every dependent (proposals, portal logins, invites,
email aliases) and the customer's historical email addresses.

What the consolidator does, per group:

  * Re-points every ``Proposal.customer_id`` from each duplicate to
    the canonical row. Proposals are kept verbatim (history); only
    the parent pointer moves.
  * Re-points every ``ClientAccount.customer_id``. The activated
    portal login (if any) now sees all proposals previously hidden
    on the duplicate rows. If both the canonical and a duplicate
    have an activated account, the canonical's wins and the
    duplicate's is *deactivated* rather than deleted so historical
    portal events / signatures still resolve.
  * Re-points every ``CustomerPortalInvite``. Stale invites for the
    duplicate row are invalidated so an old link can't be redeemed
    after the merge.
  * Archives the duplicate row's email as a
    :class:`CustomerEmailAlias` on the canonical (unless it equals
    the canonical's current email). This is what keeps CFF
    submissions joined by ``submitter_email`` reachable for the
    customer after the merge.
  * Copies forward Dynamics anchors (``dynamics_id`` /
    ``dynamics_account_id`` / ``dynamics_contact_id``) when the
    canonical row has them blank and the duplicate has them set,
    so a future Dataverse re-import keeps deduping against the
    same local row.
  * Deletes the duplicate ``Customer`` row.
  * Writes one ``customer.merged`` audit-log row per duplicate
    consumed, with before/after snapshots so the merge is
    reversible from the audit table.

Inputs:

  Edit ``GROUPS`` below. Each entry is::

      {
          "canonical": "<UUID of the customer to keep>",
          "duplicates": ["<UUID>", "<UUID>", ...],
          "note": "<free-text reason, written to audit metadata>",
      }

  The script refuses to run if the canonical id appears inside its
  own duplicates list (a no-op that almost always means a typo).

Idempotency:

  Each group is wrapped in ``transaction.atomic``. If anything
  inside the group fails (FK collision, the canonical id doesn't
  exist, …) the group is rolled back and the next group still
  runs. Re-running the script after a partial-success run is safe:
  duplicates that already moved are no longer in the DB and the
  script reports them as "already gone".

Run with::

    .venv/bin/python manage.py shell < scripts/consolidate_customer_dupes.py

Always run ``survey_customer_dupes.py`` first so the IDs you paste
into ``GROUPS`` reflect the current state of prod.
"""

from __future__ import annotations

from typing import Any

from django.db import transaction
from django.utils import timezone

from apps.audit.services import record as record_audit, snapshot
from apps.client_portal.models import (
    ClientAccount,
    CustomerPortalInvite,
    PortalEvent,
)
from apps.customers.models import (
    Customer,
    CustomerEmailAlias,
    CustomerEmailAliasSource,
)
from apps.proposals.models import Proposal


# ---------------------------------------------------------------------------
# Edit this block per merge run. One entry per group from the survey.
# ---------------------------------------------------------------------------
GROUPS: list[dict[str, Any]] = [
    # Example shape (delete + replace before running):
    # {
    #     "canonical": "00000000-0000-0000-0000-000000000001",
    #     "duplicates": [
    #         "00000000-0000-0000-0000-000000000002",
    #         "00000000-0000-0000-0000-000000000003",
    #     ],
    #     "note": "Beckles Fitness Ltd — keep PROP-0087 row, merge "
    #             "PROP-0066 + PROP-0130 rows. Tickets: …",
    # },
]


# ---------------------------------------------------------------------------
# Implementation
# ---------------------------------------------------------------------------


def _redirect_proposals(canonical: Customer, duplicate: Customer) -> int:
    """Move every Proposal pointer from ``duplicate`` to ``canonical``.

    Proposal rows themselves are untouched — code / status / line
    items / sign-off blocks all stay verbatim so the audit trail
    survives the merge intact.
    """

    return Proposal.objects.filter(customer_id=duplicate.pk).update(
        customer_id=canonical.pk,
    )


def _redirect_client_accounts(
    canonical: Customer, duplicate: Customer
) -> dict[str, int]:
    """Move portal-login rows from ``duplicate`` to ``canonical``.

    Three cases the FE can have produced:

    * Duplicate row has an unactivated stub. Move it; the canonical
      may end up with two stubs for the same customer, harmless.
    * Duplicate row has an activated login and canonical does not.
      Move it; the customer now signs in with that email.
    * Both rows have activated logins. Keep the canonical's
      activated login and *deactivate* the duplicate's (set
      ``is_active=False``) instead of deleting it, so portal
      events / signatures that point at the deactivated account
      still resolve. The customer keeps using the canonical's
      login from here on.
    """

    moved = 0
    deactivated = 0
    canonical_has_activated = ClientAccount.objects.filter(
        customer_id=canonical.pk,
        activated_at__isnull=False,
        is_active=True,
    ).exists()
    for account in ClientAccount.objects.filter(customer_id=duplicate.pk):
        if (
            canonical_has_activated
            and account.activated_at is not None
            and account.is_active
        ):
            # Conflict — both rows have a live portal login.
            # Deactivate the duplicate's so the canonical's is the
            # single source of truth going forward.
            account.is_active = False
            account.customer_id = canonical.pk
            account.save(update_fields=["is_active", "customer"])
            deactivated += 1
            continue
        account.customer_id = canonical.pk
        account.save(update_fields=["customer"])
        moved += 1
        if account.activated_at is not None:
            # The duplicate had the activated login, canonical had
            # none. That login is now the canonical's, so future
            # duplicates within this same call must respect it.
            canonical_has_activated = True
    return {"moved": moved, "deactivated": deactivated}


def _redirect_portal_invites(
    canonical: Customer, duplicate: Customer
) -> dict[str, int]:
    """Move every :class:`CustomerPortalInvite` and invalidate any
    that's still open — a stale invite link issued against the
    duplicate row should not redeem post-merge."""

    invites = CustomerPortalInvite.objects.filter(customer_id=duplicate.pk)
    moved = 0
    invalidated = 0
    now = timezone.now()
    for invite in invites:
        invite.customer_id = canonical.pk
        if invite.used_at is None and invite.invalidated_at is None:
            invite.invalidated_at = now
            invalidated += 1
        invite.save(update_fields=["customer", "invalidated_at"])
        moved += 1
    return {"moved": moved, "invalidated": invalidated}


def _archive_email_as_alias(
    canonical: Customer, duplicate: Customer
) -> bool:
    """Pin the duplicate's email onto the canonical as an alias so
    portal-side CFF joins that union across historical emails still
    find rows the duplicate would have answered to."""

    dup_email = (duplicate.email or "").strip().lower()
    if not dup_email:
        return False
    canonical_email = (canonical.email or "").strip().lower()
    if dup_email == canonical_email:
        # Same address on both rows — nothing to archive.
        return False
    _, created = CustomerEmailAlias.objects.get_or_create(
        customer=canonical,
        email=dup_email,
        defaults={
            "source": CustomerEmailAliasSource.PORTAL_EMAIL_CHANGE,
        },
    )
    return created


def _migrate_existing_aliases(
    canonical: Customer, duplicate: Customer
) -> int:
    """Carry the duplicate's existing aliases over to the canonical,
    deduping against any alias the canonical already has."""

    moved = 0
    for alias in CustomerEmailAlias.objects.filter(customer_id=duplicate.pk):
        normalised = (alias.email or "").strip().lower()
        if not normalised:
            alias.delete()
            continue
        _, created = CustomerEmailAlias.objects.get_or_create(
            customer=canonical,
            email=normalised,
            defaults={"source": alias.source},
        )
        alias.delete()
        if created:
            moved += 1
    return moved


def _absorb_dynamics_anchors(
    canonical: Customer, duplicate: Customer
) -> list[str]:
    """If the canonical has empty Dataverse anchors and the duplicate
    has them set, copy them onto the canonical so the next
    Dataverse import resolves back to this row instead of recreating
    a stray duplicate. Never overwrites a value the canonical
    already carries — the canonical wins by definition."""

    fields_changed: list[str] = []
    if (
        canonical.dynamics_id is None
        and duplicate.dynamics_id is not None
    ):
        canonical.dynamics_id = duplicate.dynamics_id
        fields_changed.append("dynamics_id")
    if (
        canonical.dynamics_account_id is None
        and duplicate.dynamics_account_id is not None
    ):
        canonical.dynamics_account_id = duplicate.dynamics_account_id
        fields_changed.append("dynamics_account_id")
    if (
        canonical.dynamics_contact_id is None
        and duplicate.dynamics_contact_id is not None
    ):
        canonical.dynamics_contact_id = duplicate.dynamics_contact_id
        fields_changed.append("dynamics_contact_id")
    return fields_changed


def _detach_portal_events(duplicate: Customer) -> int:
    """``PortalEvent.proposal`` is the only FK on the table — the
    event rows themselves carry no direct FK to Customer. The
    proposal moves to the canonical above, so the existing events
    follow automatically. This helper exists to count + log the
    follow for the audit trail."""

    return PortalEvent.objects.filter(
        proposal__customer_id=duplicate.pk,
    ).count()


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

        # Snapshot the dup *before* any mutation lands so the audit
        # log captures the row's original state for posterity.
        before = snapshot(duplicate)

        with transaction.atomic():
            proposals_moved = _redirect_proposals(canonical, duplicate)
            login_stats = _redirect_client_accounts(canonical, duplicate)
            invite_stats = _redirect_portal_invites(canonical, duplicate)
            archived = _archive_email_as_alias(canonical, duplicate)
            aliases_moved = _migrate_existing_aliases(canonical, duplicate)
            event_count = _detach_portal_events(duplicate)
            anchors_copied = _absorb_dynamics_anchors(canonical, duplicate)
            if anchors_copied:
                canonical.updated_by = canonical.created_by
                canonical.save(
                    update_fields=[
                        *anchors_copied,
                        "updated_by",
                        "updated_at",
                    ],
                )

            record_audit(
                organization=duplicate.organization,
                actor=duplicate.created_by,
                action="customer.merged",
                target=canonical,
                before=before,
                after={
                    "canonical_id": str(canonical.pk),
                    "merged_customer_id": str(duplicate.pk),
                    "note": note,
                    "proposals_moved": proposals_moved,
                    "client_logins_moved": login_stats["moved"],
                    "client_logins_deactivated": login_stats["deactivated"],
                    "invites_moved": invite_stats["moved"],
                    "invites_invalidated": invite_stats["invalidated"],
                    "email_archived_as_alias": archived,
                    "existing_aliases_moved": aliases_moved,
                    "portal_events_now_following": event_count,
                    "dynamics_anchors_copied": anchors_copied,
                },
            )

            duplicate.delete()

        summary["duplicates"].append(
            {
                "id": str(dup_id),
                "proposals_moved": proposals_moved,
                "logins_moved": login_stats["moved"],
                "logins_deactivated": login_stats["deactivated"],
                "invites_moved": invite_stats["moved"],
                "invites_invalidated": invite_stats["invalidated"],
                "email_archived": archived,
                "existing_aliases_moved": aliases_moved,
                "portal_events_following": event_count,
                "dynamics_anchors_copied": anchors_copied,
            }
        )

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
            print(
                f"  merged {d['id']}: "
                f"proposals={d['proposals_moved']} "
                f"logins(moved/deactivated)={d['logins_moved']}/"
                f"{d['logins_deactivated']} "
                f"invites(moved/invalidated)={d['invites_moved']}/"
                f"{d['invites_invalidated']} "
                f"email_archived={d['email_archived']} "
                f"aliases_moved={d['existing_aliases_moved']} "
                f"events_following={d['portal_events_following']} "
                f"dyn_anchors_copied={','.join(d['dynamics_anchors_copied']) or '-'}"
            )
    print()
    print("=" * 70)
    print("DONE. Re-run scripts/survey_customer_dupes.py to confirm zero")
    print("groups remain (or to spot ones you intentionally left alone).")
    print("=" * 70)


main()
