"""Read-only audit of duplicate :class:`Customer` rows across every org.

Groups customers three ways:

1. **Same lowercased email** within the same organization — the
   highest-fidelity signal, since portal logins ultimately bind
   per-email.
2. **Same lowercased company name** within the same organization
   (only flagged when at least one row in the group has a real
   company set, to skip the "everyone left it blank" noise).
3. **Same ``dynamics_account_id``** within the same organization —
   forward-only after the account-anchor migration, but worth
   surfacing in case a legacy row still collides.

For every group the script prints, per row:

* ``id`` — the Customer row's UUID (used by the consolidation
  script that follows).
* ``email`` / ``company`` / ``name`` — what staff sees in the
  picker.
* ``dyn_id`` / ``dyn_acct`` / ``dyn_contact`` — Dataverse anchors
  so you can tell a manual row apart from an imported one.
* ``portal_logins`` — count of bound ``ClientAccount`` rows,
  with ``A`` next to any activated one. **The activated row is
  the one that decides which proposals the customer actually
  sees on the portal.**
* ``proposals`` — count of ``Proposal`` rows anchored on this
  customer. The sum across a group is the total the portal
  *should* be showing the customer; the activated row's number
  is what they actually see today.
* ``invites`` / ``aliases`` — open portal invites + email
  aliases pinned to the row. Kept so the consolidator knows
  what side-tables to migrate.
* ``created`` — when the row was minted; older rows are usually
  the canonical ones with portal logins attached.

Run with::

    .venv/bin/python manage.py shell < scripts/survey_customer_dupes.py

Non-destructive: reads only, never writes. Safe to run on prod
any number of times.
"""

from __future__ import annotations

from collections import defaultdict

from django.db.models import Count, Exists, OuterRef, Q
from django.db.models.functions import Lower

from apps.client_portal.models import ClientAccount, CustomerPortalInvite
from apps.customers.models import Customer, CustomerEmailAlias
from apps.organizations.models import Organization
from apps.proposals.models import Proposal


def _annotate(qs):
    """Decorate a Customer queryset with the per-row counts the
    survey output prints. One ``Exists`` + three ``Count`` keep the
    cost bounded regardless of group size."""

    return qs.annotate(
        n_proposals=Count("proposals", distinct=True),
        n_invites=Count("portal_invites", distinct=True),
        n_aliases=Count("email_aliases", distinct=True),
        has_activated=Exists(
            ClientAccount.objects.filter(
                customer_id=OuterRef("pk"),
                activated_at__isnull=False,
            )
        ),
        n_logins=Count("client_accounts", distinct=True),
    )


def _row_line(c) -> str:
    activated_marker = "A" if c.has_activated else " "
    return (
        f"  id={c.id} "
        f"email={(c.email or '-'):<40} "
        f"company={(c.company or '-'):<35} "
        f"name={(c.name or '-'):<25} "
        f"dyn_id={c.dynamics_id or '-'} "
        f"dyn_acct={c.dynamics_account_id or '-'} "
        f"dyn_contact={c.dynamics_contact_id or '-'} "
        f"logins={c.n_logins}{activated_marker} "
        f"proposals={c.n_proposals} "
        f"invites={c.n_invites} "
        f"aliases={c.n_aliases} "
        f"created={c.created_at:%Y-%m-%d}"
    )


def _print_group(header: str, rows: list, totals_intro: str) -> None:
    """Render one duplicate group.

    The portal-impact line is the punch — it tells the operator
    how many proposals are HIDDEN from the customer today
    (sum minus the activated row's count). Zero hidden = the
    duplicates are bookkeeping noise; non-zero = the customer is
    genuinely missing data on their portal.
    """

    print()
    print(header)
    proposal_total = sum(r.n_proposals for r in rows)
    activated_rows = [r for r in rows if r.has_activated]
    if activated_rows:
        activated_count = activated_rows[0].n_proposals
        hidden = proposal_total - activated_count
        impact = (
            f"  → portal impact: customer sees {activated_count}/"
            f"{proposal_total} proposals "
            f"({hidden} HIDDEN by the duplication)"
        )
    else:
        impact = (
            f"  → portal impact: no activated portal login on any "
            f"row; total {proposal_total} proposals across the group"
        )
    print(impact)
    print(f"  {totals_intro}")
    for row in rows:
        print(_row_line(row))


def _survey_by_email(org: Organization) -> int:
    """Group rows by ``lower(email)`` within the org. Skips empty
    emails — a blank-email pile is its own problem (no portal login
    can ever be issued) and would create false-positive groups."""

    qs = (
        _annotate(Customer.objects.filter(organization=org))
        .exclude(email="")
        .annotate(_email_l=Lower("email"))
        .order_by("_email_l", "created_at")
    )
    groups: dict[str, list] = defaultdict(list)
    for c in qs:
        groups[c._email_l].append(c)
    dupes = {k: v for k, v in groups.items() if len(v) > 1}
    if not dupes:
        return 0
    print()
    print(f"=== org={org.name!r}: {len(dupes)} EMAIL duplicate group(s) ===")
    for email, rows in sorted(dupes.items()):
        _print_group(
            header=f"[email] {email}  ({len(rows)} rows)",
            rows=rows,
            totals_intro="rows:",
        )
    return len(dupes)


def _survey_by_company(org: Organization) -> int:
    """Catch groups that share a company but have *different* emails —
    the Dataverse account/contact split that landed before the
    account-anchor fix usually shows up here.

    Skips the "company is blank on every row" group: the legitimate
    "freelancer with no company" case shares no useful identifier
    and isn't actionable from a single-column survey.
    """

    qs = (
        _annotate(Customer.objects.filter(organization=org))
        .exclude(company="")
        .annotate(_company_l=Lower("company"))
        .order_by("_company_l", "created_at")
    )
    groups: dict[str, list] = defaultdict(list)
    for c in qs:
        groups[c._company_l].append(c)
    # Only show groups that the email survey didn't already cover.
    # If two rows share BOTH company AND email they show under
    # email — listing them again here is noise.
    company_dupes: dict[str, list] = {}
    for company, rows in groups.items():
        if len(rows) < 2:
            continue
        # Two rows in this company group share an email — leave
        # them to the email survey and only surface the remaining
        # "different email, same company" residue.
        emails = {(r.email or "").strip().lower() for r in rows}
        emails.discard("")
        if len(emails) == len(rows):
            company_dupes[company] = rows
        else:
            # Mixed case — at least one email overlap. Show rows
            # whose emails don't collide so the operator sees the
            # full picture without double-printing.
            seen_emails: set[str] = set()
            distinct_rows = []
            for r in rows:
                key = (r.email or "").strip().lower()
                if key and key in seen_emails:
                    continue
                seen_emails.add(key)
                distinct_rows.append(r)
            if len(distinct_rows) > 1:
                company_dupes[company] = distinct_rows
    if not company_dupes:
        return 0
    print()
    print(
        f"=== org={org.name!r}: {len(company_dupes)} COMPANY-only "
        f"duplicate group(s) ==="
    )
    for company, rows in sorted(company_dupes.items()):
        _print_group(
            header=f"[company] {company!r}  ({len(rows)} rows)",
            rows=rows,
            totals_intro="rows:",
        )
    return len(company_dupes)


def _survey_by_dynamics_account(org: Organization) -> int:
    """Should be empty post-migration — the unique constraint refuses
    a second row with the same ``(org, dynamics_account_id)``. But a
    legacy row that was minted before the column existed could still
    collide via ``dynamics_id``, so we scan both columns and report
    any cross-column overlap."""

    rows_by_acct: dict[str, list] = defaultdict(list)
    qs = (
        _annotate(Customer.objects.filter(organization=org))
        .filter(
            Q(dynamics_account_id__isnull=False)
            | Q(dynamics_id__isnull=False)
        )
        .order_by("created_at")
    )
    for c in qs:
        if c.dynamics_account_id is not None:
            rows_by_acct[f"acct:{c.dynamics_account_id}"].append(c)
        if c.dynamics_id is not None:
            rows_by_acct[f"id:{c.dynamics_id}"].append(c)
    dupes = {k: v for k, v in rows_by_acct.items() if len(v) > 1}
    if not dupes:
        return 0
    print()
    print(
        f"=== org={org.name!r}: {len(dupes)} DYNAMICS-ID duplicate "
        f"group(s) ==="
    )
    for key, rows in sorted(dupes.items()):
        _print_group(
            header=f"[dynamics] {key}  ({len(rows)} rows)",
            rows=rows,
            totals_intro="rows:",
        )
    return len(dupes)


def main() -> None:
    total_customers = Customer.objects.count()
    total_aliases = CustomerEmailAlias.objects.count()
    total_invites = CustomerPortalInvite.objects.count()
    total_logins = ClientAccount.objects.count()
    total_proposals = Proposal.objects.count()
    print("=" * 70)
    print("CUSTOMER DUPLICATE SURVEY")
    print("=" * 70)
    print(f"customers      : {total_customers}")
    print(f"  email aliases: {total_aliases}")
    print(f"  portal invites: {total_invites}")
    print(f"  client logins : {total_logins}")
    print(f"  proposals     : {total_proposals}")

    orgs = list(Organization.objects.order_by("name"))
    print(f"  orgs          : {len(orgs)}")

    grand_total = 0
    for org in orgs:
        n = (
            _survey_by_email(org)
            + _survey_by_company(org)
            + _survey_by_dynamics_account(org)
        )
        grand_total += n
    print()
    print("=" * 70)
    if grand_total:
        print(
            f"DONE — {grand_total} duplicate group(s) found across "
            f"{len(orgs)} org(s)."
        )
        print(
            "Pick canonical IDs + duplicate IDs per group, then run "
            "scripts/consolidate_customer_dupes.py to merge."
        )
    else:
        print("DONE — no duplicate groups found.")
    print("=" * 70)


main()
