"""Customer-facing email for the FINAL spec sign-off.

Fired from :func:`apps.specifications.services.transition_status` on
``approved → sent`` when ``document_kind == FINAL`` and a customer
email is present. Best-effort dispatch — failures are logged so a
flaky SMTP relay never undoes a status flip that already committed.

Reuses the existing proposal-email infrastructure:

* ``settings.DEFAULT_FROM_EMAIL`` for the From header.
* ``settings.APP_BASE_URL`` to build the portal link.
* The ``proposals_email_extras`` template-tag library (its helpers
  are visual / formatting, not proposal-specific).
* The ``EmailMultiAlternatives`` + ``transaction.on_commit`` cadence
  that the proposal send path is already battle-tested with.
"""

from __future__ import annotations

import logging
from typing import Any

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.template.loader import render_to_string

from apps.specifications.models import (
    SpecificationDocumentKind,
    SpecificationSheet,
)


logger = logging.getLogger(__name__)


def _portal_spec_url(sheet: SpecificationSheet) -> str:
    base = getattr(settings, "APP_BASE_URL", "http://localhost:3000").rstrip("/")
    return f"{base}/portal/specs/{sheet.pk}"


def _resolve_sales_person(sheet: SpecificationSheet) -> tuple[str, str]:
    """Pick the right "kind regards" signature for the email.

    Order of preference: the assigned sales person on the linked
    proposal (if any) → the spec's ``updated_by`` (the staff member
    who just clicked Send) → blank, which suppresses the signature
    block entirely in the template.
    """

    proposal = getattr(sheet, "proposal", None)
    sales_person = getattr(proposal, "sales_person", None) if proposal else None
    if sales_person is None:
        sales_person = sheet.updated_by

    if sales_person is None:
        return "", ""

    name = (
        (
            getattr(sales_person, "get_full_name", lambda: "")()
            or getattr(sales_person, "email", "")
            or ""
        )
    ).strip()
    email = (getattr(sales_person, "email", "") or "").strip()
    return name, email


def send_final_spec_to_client(*, sheet_id: Any, actor: Any) -> None:
    """Send the customer the "ready to sign" email for a FINAL spec.

    Idempotency: the caller (``transition_status`` via
    ``transaction.on_commit``) only fires us once per
    ``approved → sent`` transition, so we don't re-fetch + re-check
    here. Every failure path logs and swallows — the email is a
    convenience nudge, not a system-of-record.
    """

    sheet = (
        SpecificationSheet.objects.select_related(
            "formulation_version__formulation",
            "organization",
            "updated_by",
            "proposal",
        )
        .filter(pk=sheet_id)
        .first()
    )
    if sheet is None:
        logger.warning("final_spec_email: sheet %s vanished before send", sheet_id)
        return

    if sheet.document_kind != SpecificationDocumentKind.FINAL:
        logger.warning(
            "final_spec_email: refusing to send for non-final sheet %s", sheet.pk
        )
        return

    recipient = (sheet.customer_email or "").strip()
    if not recipient:
        logger.info(
            "final_spec_email: sheet %s has no customer email — skipping",
            sheet.pk,
        )
        return

    formulation = sheet.formulation_version.formulation
    proposal = getattr(sheet, "proposal", None)
    sales_person_name, sales_person_email = _resolve_sales_person(sheet)

    context = {
        "sheet": sheet,
        "formulation_name": (formulation.name or sheet.code or "").strip(),
        "proposal_code": (getattr(proposal, "code", "") or "").strip()
        if proposal
        else "",
        "customer_name": (sheet.customer_name or "").strip(),
        "kiosk_url": _portal_spec_url(sheet),
        "sales_person_name": sales_person_name,
        "sales_person_email": sales_person_email,
        # The HTML template treats ``body_text`` as the caller's
        # opportunity to override the default body — leave blank so
        # the default copy (recipe + proposal reference) renders.
        "body_text": "",
    }

    subject = (
        f"Action needed: sign your final specification "
        f"({formulation.name or sheet.code or 'your product'})"
    )

    html_body = render_to_string(
        "specifications/email/final_spec_to_client.html", context
    )
    plain_body = render_to_string(
        "specifications/email/final_spec_to_client.txt", context
    )

    from_email = getattr(
        settings, "DEFAULT_FROM_EMAIL", "no-reply@localhost"
    )
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
            # Group every email about this spec into one Gmail thread.
            "X-Entity-Ref-ID": f"spec:{sheet.pk}",
        },
    )
    message.attach_alternative(html_body, "text/html")

    try:
        message.send(fail_silently=False)
    except Exception:  # noqa: BLE001 — best-effort
        logger.exception(
            "final_spec_email: SMTP send failed for sheet %s", sheet.pk
        )
        return

    logger.info(
        "final_spec_email: sent to %s for sheet %s (actor=%s)",
        recipient,
        sheet.pk,
        getattr(actor, "email", None),
    )
