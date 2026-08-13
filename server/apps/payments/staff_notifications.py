"""Staff-facing email notifications for sample-order lifecycle events.

Two flavors, fired at different lifecycle moments:

* :func:`notify_finance_new_sample_payment` — one email per finance
  team member the moment a fresh sample payment lands in ``PENDING``.
  Prompts them to open the finance queue and approve so the scientist
  can start on the batch.
* :func:`notify_scientists_sample_ready` — one email per scientist
  the moment finance approves a sample payment. Signals that a fresh
  trial-batch slot is available.

Both are best-effort — a broken SMTP relay never rolls back the
mutation that fired them (callers wrap in ``transaction.on_commit``).
Empty recipient lists are silently no-op'd; no exception propagates.

Recipients come from :class:`apps.organizations.Membership.groups`
which carries free-text role tags (``"finance"``, ``"scientist"``,
``"sales"``, ``"designer"``). See ``MEMBERSHIP_GROUPS``.

Only fires for **sample** payments (``kind=FINAL`` +
``formulation.project_type = ready_to_go``). Custom-formulation
payments (DEPOSIT + FINAL from the internal proposal flow) have
their own notification story and are intentionally out of scope.
"""

from __future__ import annotations

import logging
from typing import Any

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.template.loader import render_to_string

from apps.payments.constants import PaymentKind
from apps.payments.models import Payment


logger = logging.getLogger(__name__)


def _is_sample_payment(payment: Payment) -> bool:
    if payment.kind != PaymentKind.FINAL:
        return False
    formulation = getattr(payment, "formulation", None)
    if formulation is None:
        return False
    return getattr(formulation, "project_type", None) == "ready_to_go"


def _recipients_with_role(*, organization: Any, role: str) -> list[tuple[str, str]]:
    """Return ``[(email, display_name), ...]`` for every active member
    of ``organization`` whose ``Membership.groups`` includes ``role``.

    Owners always receive both flavours regardless of tag — they're
    responsible for anything nobody else is watching. Skips members
    with empty email addresses (users invited but never confirmed).
    """

    # Local import — the app registry order sometimes has payments
    # loading before organizations; keep the FK walk lazy.
    from apps.organizations.models import Membership

    memberships = (
        Membership.objects.filter(organization=organization)
        .select_related("user")
        .order_by("user__email")
    )

    out: list[tuple[str, str]] = []
    seen_emails: set[str] = set()
    for m in memberships:
        user = m.user
        if user is None:
            continue
        email = (getattr(user, "email", "") or "").strip()
        if not email or email.lower() in seen_emails:
            continue
        # Owner OR the role tag is present. ``groups`` is a JSON list
        # of strings ('scientist'/'sales'/'designer'/'finance').
        role_match = isinstance(m.groups, list) and role in m.groups
        if not (m.is_owner or role_match):
            continue
        name = (
            (getattr(user, "get_full_name", lambda: "")() or "").strip()
            or getattr(user, "email", "")
        )
        out.append((email, name))
        seen_emails.add(email.lower())
    return out


def _portal_finance_url() -> str:
    base = getattr(settings, "APP_BASE_URL", "http://localhost:3000").rstrip("/")
    return f"{base}/payments"


def _portal_samples_url() -> str:
    base = getattr(settings, "APP_BASE_URL", "http://localhost:3000").rstrip("/")
    return f"{base}/samples"


def _formulation_display(payment: Payment) -> tuple[str, str]:
    formulation = getattr(payment, "formulation", None)
    if formulation is None:
        return "", ""
    name = (getattr(formulation, "name", "") or "").strip()
    code = (getattr(formulation, "code", "") or "").strip()
    return name, code


def _customer_display(payment: Payment) -> str:
    customer = getattr(payment, "customer", None)
    if customer is None:
        return ""
    company = (getattr(customer, "company", "") or "").strip()
    if company:
        return company
    return (getattr(customer, "name", "") or "").strip()


def _amount_label(payment: Payment) -> str:
    if payment.amount is None:
        return ""
    currency = (payment.currency or "").strip()
    return f"{payment.amount} {currency}".strip()


def _send_role_email(
    *,
    recipients: list[tuple[str, str]],
    subject: str,
    template_base: str,
    context: dict,
) -> None:
    """Render + dispatch one email per recipient. Isolates failures so
    a single flaky SMTP result doesn't block the rest of the batch.
    """

    if not recipients:
        return

    from_email = getattr(settings, "DEFAULT_FROM_EMAIL", "no-reply@example.com")

    text_body = render_to_string(f"{template_base}.txt", context)
    html_body = render_to_string(f"{template_base}.html", context)

    for email, _name in recipients:
        try:
            msg = EmailMultiAlternatives(
                subject=subject,
                body=text_body,
                from_email=from_email,
                to=[email],
            )
            msg.attach_alternative(html_body, "text/html")
            msg.send(fail_silently=False)
        except Exception:
            logger.exception(
                "staff_notifications: failed to email %s (template=%s)",
                email,
                template_base,
            )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def notify_finance_new_sample_payment(*, payment_id: Any) -> None:
    """Email every finance-tagged member (plus owners) that a new
    sample payment is waiting for approval. Called from
    ``record_payment`` via ``transaction.on_commit``.
    """

    payment = (
        Payment.objects.select_related("organization", "formulation", "customer")
        .filter(pk=payment_id)
        .first()
    )
    if payment is None or not _is_sample_payment(payment):
        return

    recipients = _recipients_with_role(
        organization=payment.organization, role="finance"
    )
    if not recipients:
        return

    name, code = _formulation_display(payment)
    context = {
        "project_name": name or code or "a sample kit",
        "project_code": code,
        "customer_name": _customer_display(payment),
        "amount": _amount_label(payment),
        "portal_url": _portal_finance_url(),
    }
    subject = (
        f"[Vita] New sample payment awaiting approval — "
        f"{context['project_name']}"
    )
    _send_role_email(
        recipients=recipients,
        subject=subject,
        template_base="payments/email/finance_new_sample_payment",
        context=context,
    )


def notify_scientists_sample_ready(*, payment_id: Any) -> None:
    """Email every scientist-tagged member (plus owners) that a fresh
    sample slot is ready to be picked up. Called from
    ``approve_payment`` via ``transaction.on_commit``.
    """

    payment = (
        Payment.objects.select_related("organization", "formulation", "customer")
        .filter(pk=payment_id)
        .first()
    )
    if payment is None or not _is_sample_payment(payment):
        return

    recipients = _recipients_with_role(
        organization=payment.organization, role="scientist"
    )
    if not recipients:
        return

    name, code = _formulation_display(payment)
    context = {
        "project_name": name or code or "a sample kit",
        "project_code": code,
        "customer_name": _customer_display(payment),
        "portal_url": _portal_samples_url(),
    }
    subject = (
        f"[Vita] New sample ready for a trial batch — "
        f"{context['project_name']}"
    )
    _send_role_email(
        recipients=recipients,
        subject=subject,
        template_base="payments/email/scientist_new_sample_ready",
        context=context,
    )
