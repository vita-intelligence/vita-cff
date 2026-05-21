"""Portal inbox endpoints — backs the bell + dropdown surface on
the customer-facing app.

Mirrors the staff messenger inbox in :mod:`apps.comments.api.inbox_views`
but scoped to one :class:`apps.client_portal.models.ClientAccount`
and the proposals + specs that account can actually see (joined
through the parent ``Customer`` so the customer never sees a thread
on someone else's proposal).

Endpoints:

* ``GET /api/portal/inbox/`` — every thread the client account
  has activity in, newest first, with unread count + 1-line
  preview. Frontend renders a dropdown.
* ``GET /api/portal/inbox/unread_count/`` — total unread across
  every thread. Frontend renders a badge.

Read-pointer writes still go through the per-thread routes
(``…/proposal-messages/read/`` and ``…/specs/<id>/messages/read/``)
— no new write surface here.
"""

from __future__ import annotations

import datetime as _dt
from typing import Any

from django.contrib.contenttypes.models import ContentType
from rest_framework.request import Request
from rest_framework.response import Response

from apps.client_portal.api.views import PortalAPIView
from apps.comments.models import Comment, CommentReadState


_UNIX_EPOCH = _dt.datetime.fromtimestamp(0, tz=_dt.timezone.utc)


def _author_snapshot(comment: Comment) -> dict[str, Any]:
    """One-line author identity used by the bell preview row. Mirrors
    the staff inbox shape so the FE rendering stays simple."""

    # Mirror :func:`apps.client_portal.api.messaging_views._author_payload`
    # so the bell preview row reads with the same identity rules as
    # the in-thread bubble. Staff authors render as the consistent
    # "Vita team" brand voice rather than the operator's individual
    # name — same constraint the per-page chat panels apply.
    if comment.client_account_id is not None:
        ca = comment.client_account
        name = (
            (ca.customer.company or "").strip()
            or (ca.customer.name or "").strip()
            or (ca.email or "").strip()
            or "Customer"
        )
        return {"kind": "client", "name": name}
    if comment.author_id is not None:
        return {"kind": "staff", "name": "Vita team"}
    return {"kind": "system", "name": "System"}


def _preview(comment: Comment) -> str:
    """Single-line preview for the bell dropdown row. Hard-truncate
    so a multi-paragraph rant doesn't blow up the layout."""

    if comment.is_deleted:
        return "(deleted)"
    body = (comment.body or "").replace("\n", " ").strip()
    if len(body) > 140:
        return body[:137] + "…"
    return body


def _gather_proposal_threads(client_account) -> list[dict[str, Any]]:
    """Build the inbox rows for every proposal the client owns that
    has at least one shared comment.

    "Owned" = the proposal's customer is the client's customer (the
    same join the per-thread endpoints use), so a client of customer
    A never sees a thread on customer B's proposal even if they
    guess the URL.
    """

    from apps.proposals.models import Proposal

    proposal_ct = ContentType.objects.get_for_model(Proposal)
    proposals = (
        Proposal.objects
        .filter(customer_id=client_account.customer_id)
        .filter(
            comments__visibility=Comment.Visibility.SHARED,
            comments__is_deleted=False,
        )
        .distinct()
    )
    read_rows = (
        CommentReadState.objects
        .filter(
            viewer_client=client_account,
            content_type=proposal_ct,
            object_id__in=[p.id for p in proposals],
        )
        .values_list("object_id", "last_read_at")
    )
    last_read_by_pid = {str(pid): ts for pid, ts in read_rows}

    rows: list[dict[str, Any]] = []
    for proposal in proposals:
        latest = (
            Comment.objects
            .filter(
                proposal=proposal,
                visibility=Comment.Visibility.SHARED,
                is_deleted=False,
            )
            .select_related("author", "client_account__customer")
            .order_by("-created_at")
            .first()
        )
        if latest is None:
            continue
        last_read = last_read_by_pid.get(str(proposal.id), _UNIX_EPOCH)
        unread = (
            Comment.objects
            .filter(
                proposal=proposal,
                visibility=Comment.Visibility.SHARED,
                is_deleted=False,
                created_at__gt=last_read,
            )
            .exclude(client_account=client_account)
            .count()
        )
        rows.append(
            {
                "entity_kind": "proposal",
                "entity_id": str(proposal.id),
                "entity_title": proposal.code or "Proposal",
                "deep_link": f"/portal/proposals/{proposal.id}",
                "unread_count": unread,
                "last_message_at": latest.created_at.isoformat(),
                "last_message_preview": _preview(latest),
                "last_message_author": _author_snapshot(latest),
            }
        )
    return rows


def _gather_spec_threads(client_account) -> list[dict[str, Any]]:
    """Build the inbox rows for every spec attached to one of the
    client's proposals (per-line + legacy 1-to-1) that has at least
    one shared comment.

    Spec IDs are deduplicated so a sheet referenced from multiple
    proposals appears once in the bell.
    """

    from apps.proposals.models import Proposal, ProposalLine
    from apps.specifications.models import SpecificationSheet

    proposal_qs = Proposal.objects.filter(customer_id=client_account.customer_id)

    sheet_ids: set[str] = set()
    sheet_to_proposal: dict[str, Any] = {}

    # Per-line attachments — newest proposal wins (matches the
    # specs list view's tie-break).
    for line in (
        ProposalLine.objects
        .filter(
            proposal__in=proposal_qs,
            specification_sheet__isnull=False,
        )
        .select_related("specification_sheet", "proposal")
        .order_by("-proposal__updated_at")
    ):
        sid = str(line.specification_sheet_id)
        if sid in sheet_ids:
            continue
        sheet_ids.add(sid)
        sheet_to_proposal[sid] = line.proposal

    # Legacy 1-to-1 attachments.
    for proposal in (
        proposal_qs.select_related("specification_sheet")
    ):
        sheet = proposal.specification_sheet
        if sheet is None:
            continue
        sid = str(sheet.id)
        if sid in sheet_ids:
            continue
        sheet_ids.add(sid)
        sheet_to_proposal[sid] = proposal

    if not sheet_ids:
        return []

    spec_ct = ContentType.objects.get_for_model(SpecificationSheet)
    read_rows = (
        CommentReadState.objects
        .filter(
            viewer_client=client_account,
            content_type=spec_ct,
            object_id__in=list(sheet_ids),
        )
        .values_list("object_id", "last_read_at")
    )
    last_read_by_sid = {str(sid): ts for sid, ts in read_rows}

    rows: list[dict[str, Any]] = []
    sheets = SpecificationSheet.objects.filter(id__in=list(sheet_ids))
    for sheet in sheets:
        sid = str(sheet.id)
        latest = (
            Comment.objects
            .filter(
                specification_sheet=sheet,
                visibility=Comment.Visibility.SHARED,
                is_deleted=False,
            )
            .select_related("author", "client_account__customer")
            .order_by("-created_at")
            .first()
        )
        if latest is None:
            continue
        last_read = last_read_by_sid.get(sid, _UNIX_EPOCH)
        unread = (
            Comment.objects
            .filter(
                specification_sheet=sheet,
                visibility=Comment.Visibility.SHARED,
                is_deleted=False,
                created_at__gt=last_read,
            )
            .exclude(client_account=client_account)
            .count()
        )
        parent_proposal = sheet_to_proposal.get(sid)
        title = (
            (sheet.code or "").strip()
            or (
                sheet.formulation_version.formulation.name
                if sheet.formulation_version_id
                else ""
            )
            or "Specification"
        )
        rows.append(
            {
                "entity_kind": "specification",
                "entity_id": sid,
                "entity_title": title,
                "deep_link": f"/portal/specs/{sid}",
                "unread_count": unread,
                "last_message_at": latest.created_at.isoformat(),
                "last_message_preview": _preview(latest),
                "last_message_author": _author_snapshot(latest),
                "parent_proposal": (
                    {
                        "id": str(parent_proposal.id),
                        "code": parent_proposal.code or "",
                    }
                    if parent_proposal else None
                ),
            }
        )
    return rows


def _gather_cff_threads(client_account) -> list[dict[str, Any]]:
    """Build the inbox rows for every CFF this customer owns that
    has at least one shared comment.

    Ownership follows the same union rule as
    :func:`apps.cff_submissions.services.list_customer_cffs` —
    email match OR project link — so the bell never surfaces a
    CFF the customer can't actually open.
    """

    from apps.cff_submissions.models import CFFSubmission
    from apps.cff_submissions.services import list_customer_cffs

    # Only the CFFs that own at least one shared comment matter
    # here — the dropdown is "your conversations", not "your full
    # CFF history". Walks the ownership queryset and prunes to
    # rows with at least one ``shared`` non-deleted comment.
    cffs = (
        list_customer_cffs(client_account=client_account)
        .filter(
            comments__visibility=Comment.Visibility.SHARED,
            comments__is_deleted=False,
        )
        .distinct()
    )
    cff_ids = [c.id for c in cffs]
    if not cff_ids:
        return []

    cff_ct = ContentType.objects.get_for_model(CFFSubmission)
    read_rows = (
        CommentReadState.objects
        .filter(
            viewer_client=client_account,
            content_type=cff_ct,
            object_id__in=cff_ids,
        )
        .values_list("object_id", "last_read_at")
    )
    last_read_by_id = {str(pk): ts for pk, ts in read_rows}

    rows: list[dict[str, Any]] = []
    for cff in cffs:
        latest = (
            Comment.objects
            .filter(
                cff_submission=cff,
                visibility=Comment.Visibility.SHARED,
                is_deleted=False,
            )
            .select_related("author", "client_account__customer")
            .order_by("-created_at")
            .first()
        )
        if latest is None:
            continue
        last_read = last_read_by_id.get(str(cff.id), _UNIX_EPOCH)
        unread = (
            Comment.objects
            .filter(
                cff_submission=cff,
                visibility=Comment.Visibility.SHARED,
                is_deleted=False,
                created_at__gt=last_read,
            )
            .exclude(client_account=client_account)
            .count()
        )
        # CFF rows don't have a clean human title — the Wix
        # form-submission ID is opaque. Use the project code when
        # the CFF has been routed to one, otherwise a short id
        # slice so the row still has *something* to read against.
        title = (
            f"CFF · {cff.project.code or cff.project.name}"
            if cff.project_id is not None and cff.project is not None
            else f"CFF · {str(cff.id)[:8]}"
        )
        rows.append(
            {
                "entity_kind": "cff_submission",
                "entity_id": str(cff.id),
                "entity_title": title,
                "deep_link": f"/portal/cffs/{cff.id}",
                "unread_count": unread,
                "last_message_at": latest.created_at.isoformat(),
                "last_message_preview": _preview(latest),
                "last_message_author": _author_snapshot(latest),
            }
        )
    return rows


def _all_threads(client_account) -> list[dict[str, Any]]:
    rows = (
        _gather_proposal_threads(client_account)
        + _gather_spec_threads(client_account)
        + _gather_cff_threads(client_account)
    )
    rows.sort(key=lambda r: r["last_message_at"], reverse=True)
    return rows


class PortalInboxListView(PortalAPIView):
    """``GET /api/portal/inbox/``."""

    def get(self, request: Request) -> Response:
        threads = _all_threads(request.user)
        return Response(
            {
                "results": threads,
                "total_unread": sum(t["unread_count"] for t in threads),
            },
        )


class PortalInboxUnreadCountView(PortalAPIView):
    """``GET /api/portal/inbox/unread_count/``."""

    def get(self, request: Request) -> Response:
        threads = _all_threads(request.user)
        return Response(
            {"unread_count": sum(t["unread_count"] for t in threads)},
        )
