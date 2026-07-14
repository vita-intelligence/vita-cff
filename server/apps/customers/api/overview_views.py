"""Customer detail-page aggregator endpoint.

Everything the staff detail page needs about a customer — the row
itself, their proposal history, their CFF submissions (Wix + portal),
and their portal accounts — in a single round-trip. Keeps the FE
detail page free of "N spinners loading" jank and centralises the
"what have we ever done with this customer?" query in one place the
audit + reporting surfaces can share later.

Deliberately does not paginate. A customer with hundreds of proposals
is atypical (most sit under a dozen); if we hit that ceiling we'll
paginate then, not preemptively.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from rest_framework.exceptions import NotFound
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.cff_submissions.api.serializers import CFFSubmissionSerializer
from apps.cff_submissions.models import CFFSubmission
from apps.client_portal.models import ClientAccount
from apps.customers.api.serializers import CustomerReadSerializer
from apps.customers.services import CustomerNotFound, get_customer
from apps.formulations.api.permissions import HasFormulationsPermission
from apps.organizations.modules import FormulationsCapability
from apps.proposals.models import Proposal, ProposalStatus


def _proposal_summary(proposal: Proposal) -> dict[str, Any]:
    """Compact wire shape for the proposals table on the customer
    detail page.

    Excludes the heavy fields (raw acknowledgements, cover_notes,
    signature blobs) — the page links out to
    ``/proposals/<id>`` for the full view. Every field here is
    something the operator needs to scan the row at a glance.
    """

    version = getattr(proposal, "formulation_version", None)
    formulation = getattr(version, "formulation", None) if version else None
    total = proposal.total_excl_vat
    return {
        "id": str(proposal.id),
        "code": proposal.code or "",
        "status": proposal.status,
        "template_type": proposal.template_type,
        "currency": proposal.currency or "GBP",
        "quantity": proposal.quantity,
        "unit_price": (
            str(proposal.unit_price) if proposal.unit_price is not None else None
        ),
        "total_excl_vat": str(total) if total is not None else None,
        "valid_until": (
            proposal.valid_until.isoformat() if proposal.valid_until else None
        ),
        "updated_at": proposal.updated_at.isoformat(),
        "created_at": proposal.created_at.isoformat(),
        "formulation": (
            {
                "id": str(formulation.id),
                "code": formulation.code or "",
                "name": formulation.name,
                "project_type": formulation.project_type,
            }
            if formulation
            else None
        ),
        "sales_person": (
            {
                "id": str(proposal.sales_person_id),
                "full_name": (
                    proposal.sales_person.get_full_name()
                    or proposal.sales_person.email
                ),
                "email": proposal.sales_person.email,
            }
            if proposal.sales_person_id
            else None
        ),
    }


def _portal_account_summary(account: ClientAccount) -> dict[str, Any]:
    """Compact wire shape for the portal-accounts panel. Trims
    password-hash + signature blobs that live on the same row."""

    return {
        "id": str(account.id),
        "email": account.email,
        "is_active": account.is_active,
        "activated_at": (
            account.activated_at.isoformat() if account.activated_at else None
        ),
        "last_login_at": (
            account.last_login.isoformat() if account.last_login else None
        ),
        "created_at": account.created_at.isoformat(),
        "privacy_accepted_at": (
            account.privacy_accepted_at.isoformat()
            if account.privacy_accepted_at
            else None
        ),
    }


class CustomerOverviewView(APIView):
    """``GET`` ``/api/organizations/<org>/customers/<id>/overview/``.

    Returns everything the staff customer detail page needs to
    render in one hit:

    * ``customer`` — full :class:`CustomerReadSerializer` payload.
    * ``portal_accounts`` — list of :class:`ClientAccount` rows on
      this customer (login email, activation state, last login).
    * ``proposals`` — every proposal linked to this customer,
      newest first. Trimmed to the fields the summary table
      needs; the full proposal lives on ``/proposals/<id>``.
    * ``cff_submissions`` — every CFF this customer has authored
      via any of their portal accounts (submissions from anonymous
      Wix visitors won't appear here unless they later map to a
      portal account with the same email).
    * ``totals`` — cheap-to-compute rollups used by the header
      chips (order count, accepted count, revenue accepted).

    Gated on ``formulations.view`` — same as the customer detail
    endpoint the page fetches alongside. Customers rides the
    formulations module by design (there is no separate Customers
    capability; the sales roles that access customers always live
    inside the projects module).
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(
        self, request: Request, org_id: str, customer_id: str
    ) -> Response:
        try:
            customer = get_customer(
                organization=self.organization, customer_id=customer_id
            )
        except CustomerNotFound as exc:
            raise NotFound() from exc

        proposals_qs = (
            Proposal.objects.filter(
                organization=self.organization, customer=customer
            )
            .select_related(
                "formulation_version",
                "formulation_version__formulation",
                "sales_person",
            )
            .order_by("-updated_at")
        )
        proposals = [_proposal_summary(p) for p in proposals_qs]

        accepted_revenue = Decimal("0")
        accepted_count = 0
        for proposal in proposals_qs:
            if proposal.status == ProposalStatus.ACCEPTED.value:
                accepted_count += 1
                total = proposal.total_excl_vat
                if total is not None:
                    accepted_revenue += total

        # Portal accounts: only rows tied directly to this customer.
        # Legacy multi-customer accounts aren't a thing here — the FK
        # is single-valued — but we still ``order_by`` deterministically
        # so the FE never picks up spurious re-orderings between reads.
        portal_accounts_qs = ClientAccount.objects.filter(
            customer=customer
        ).order_by("-created_at")
        portal_accounts = [
            _portal_account_summary(row) for row in portal_accounts_qs
        ]

        # CFF submissions authored through any of the customer's
        # portal accounts. Anonymous Wix submissions won't appear
        # here unless a later import maps them to a portal login
        # under the same email.
        cff_qs = (
            CFFSubmission.objects.filter(
                organization=self.organization,
                submitted_by_client_account__customer=customer,
            )
            .prefetch_related("assignments__project")
            .select_related("drafted_proposal", "rejected_by")
            .order_by("-imported_at")
        )
        cff_submissions = CFFSubmissionSerializer(cff_qs, many=True).data

        return Response(
            {
                "customer": CustomerReadSerializer(customer).data,
                "portal_accounts": portal_accounts,
                "proposals": proposals,
                "cff_submissions": cff_submissions,
                "totals": {
                    "proposals_count": len(proposals),
                    "accepted_proposals_count": accepted_count,
                    "accepted_revenue": str(accepted_revenue),
                    "cff_submissions_count": len(cff_submissions),
                    "portal_accounts_count": len(portal_accounts),
                },
            }
        )
