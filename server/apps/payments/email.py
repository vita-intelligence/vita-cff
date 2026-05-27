"""Customer-facing email for "payment received, label design starts now".

Fired from :func:`apps.payments.services.approve_payment` on
``pending → approved``. Best-effort dispatch — failures are logged so
a flaky SMTP relay never undoes the approval that already committed.

Mirrors the cadence of
:mod:`apps.specifications.email` (final-spec sign-off email) so both
customer-facing notifications share the same Outlook + dark-mode
plumbing. Specifically:

* ``settings.DEFAULT_FROM_EMAIL`` for the From header.
* ``settings.APP_BASE_URL`` to build the portal link.
* The ``proposals_email_extras`` template-tag library (its helpers
  are visual / formatting, not proposal-specific).
* The ``EmailMultiAlternatives`` + ``transaction.on_commit`` cadence
  the proposal send path is already battle-tested with.
"""

from __future__ import annotations

import logging
from typing import Any

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.template.loader import render_to_string

from apps.payments.constants import PaymentStatus
from apps.payments.models import Payment


logger = logging.getLogger(__name__)


def _portal_product_url(formulation_id: Any) -> str:
    base = getattr(settings, "APP_BASE_URL", "http://localhost:3000").rstrip("/")
    return f"{base}/portal/products/{formulation_id}"


def _resolve_recipient(payment: Payment) -> tuple[str, str]:
    """Find the customer's email + display name for this payment.

    Walks: ``LabelDesign.formulation`` → most-recent ``Proposal`` →
    ``Proposal.customer.email`` (preferred) → ``Proposal.customer_email``
    snapshot. Returns ``("", "")`` if no email is reachable, in which
    case the email send is skipped.
    """

    from apps.proposals.models import Proposal

    proposal = (
        Proposal.objects.filter(
            organization=payment.organization,
            formulation_version__formulation_id=payment.formulation_id,
        )
        .select_related("customer")
        .order_by("-updated_at")
        .first()
    )
    if proposal is None:
        return "", ""

    customer = getattr(proposal, "customer", None)
    email = ""
    name = ""
    if customer is not None:
        email = (getattr(customer, "email", "") or "").strip()
        name = (getattr(customer, "name", "") or "").strip()
    if not email:
        email = (getattr(proposal, "customer_email", "") or "").strip()
    if not name:
        name = (getattr(proposal, "customer_name", "") or "").strip()
    return email, name


def _resolve_sales_person(payment: Payment) -> tuple[str, str]:
    """Pick the right "kind regards" signature. Prefer the linked
    proposal's sales person, fall back to the staff user who
    approved this payment.
    """

    from apps.proposals.models import Proposal

    proposal = (
        Proposal.objects.filter(
            organization=payment.organization,
            formulation_version__formulation_id=payment.formulation_id,
        )
        .select_related("sales_person")
        .order_by("-updated_at")
        .first()
    )
    sales_person = (
        getattr(proposal, "sales_person", None) if proposal is not None else None
    )
    if sales_person is None:
        sales_person = payment.approved_by or payment.recorded_by
    if sales_person is None:
        return "", ""
    name = (
        getattr(sales_person, "get_full_name", lambda: "")()
        or getattr(sales_person, "email", "")
        or ""
    ).strip()
    email = (getattr(sales_person, "email", "") or "").strip()
    return name, email


def send_payment_received_to_client(*, payment_id: Any, actor: Any) -> None:
    """Send the customer the "payment received, label design starts
    now" email. Idempotent only by trigger — the caller is the
    ``approve_payment`` service inside ``transaction.on_commit``, so
    each approval fires once. Failures log + swallow.
    """

    payment = (
        Payment.objects.select_related("formulation", "organization")
        .filter(pk=payment_id)
        .first()
    )
    if payment is None:
        logger.warning(
            "payment_received_email: payment %s vanished before send", payment_id
        )
        return

    if payment.status != PaymentStatus.APPROVED:
        logger.warning(
            "payment_received_email: refusing to send for non-approved %s",
            payment.pk,
        )
        return

    recipient, customer_name = _resolve_recipient(payment)
    if not recipient:
        logger.info(
            "payment_received_email: payment %s has no customer email — skipping",
            payment.pk,
        )
        return

    sales_person_name, sales_person_email = _resolve_sales_person(payment)

    formulation = payment.formulation
    amount_label = ""
    if payment.amount is not None:
        amount_label = f"{payment.amount} {(payment.currency or '').strip()}".strip()

    paid_at_label = (
        payment.paid_at.strftime("%d %b %Y") if payment.paid_at else ""
    )

    context = {
        "project_code": (formulation.code or "").strip(),
        "project_name": (formulation.name or "").strip(),
        "customer_name": customer_name,
        "amount": str(payment.amount) if payment.amount is not None else "",
        "amount_label": amount_label,
        "invoice_number": (payment.invoice_number or "").strip(),
        "reference": (payment.external_reference or "").strip(),
        "paid_at_label": paid_at_label,
        "portal_url": _portal_product_url(formulation.pk),
        "sales_person_name": sales_person_name,
        "sales_person_email": sales_person_email,
    }

    subject = (
        f"Payment received — {formulation.name or formulation.code or 'your project'}"
    )

    html_body = render_to_string(
        "payments/email/payment_received.html", context
    )
    plain_body = render_to_string(
        "payments/email/payment_received.txt", context
    )

    from_email = getattr(settings, "DEFAULT_FROM_EMAIL", "no-reply@localhost")
    reply_to = [sales_person_email] if sales_person_email else None
    bcc = (
        [sales_person_email]
        if sales_person_email
        and sales_person_email.lower() != recipient.lower()
        else None
    )

    message = EmailMultiAlternatives(
        subject=subject,
        body=plain_body,
        from_email=from_email,
        to=[recipient],
        bcc=bcc,
        reply_to=reply_to,
        headers={
            "X-Auto-Response-Suppress": "All",
            # Group every email about this payment / project under one
            # Gmail thread.
            "X-Entity-Ref-ID": f"payment:{payment.pk}",
        },
    )
    message.attach_alternative(html_body, "text/html")

    try:
        message.send(fail_silently=False)
    except Exception:  # noqa: BLE001 — best-effort
        logger.exception(
            "payment_received_email: SMTP send failed for payment %s",
            payment.pk,
        )
        return

    logger.info(
        "payment_received_email: sent to %s for payment %s (actor=%s)",
        recipient,
        payment.pk,
        getattr(actor, "email", None),
    )
