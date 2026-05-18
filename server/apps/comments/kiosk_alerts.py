"""Service layer for the manual "Notify client" email.

The team member clicks **Notify client** on a spec-sheet chat;
the view delegates here. We:

  1. Look up every identified, non-revoked :class:`KioskSession`
     for the sheet and collapse them by email — one customer who
     identified twice (e.g. cleared cookies + re-identified) gets
     exactly one email, not two.
  2. Filter against the cooldown ledger
     (:class:`KioskAlert` rows in the last
     :data:`KIOSK_ALERT_COOLDOWN_SECONDS`). Anyone in cooldown
     gets a ``SKIPPED`` ledger row instead of an email so the UI
     can still report "we did try, but you'd already pinged them
     a moment ago".
  3. Render the bulletproof HTML template (matched to the
     proposal send-to-client email — same visual family) and
     dispatch via ``EmailMultiAlternatives``.

Failures inside delivery are isolated per recipient: one bad
address never blocks the email to the next customer.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.template.loader import render_to_string
from django.utils import timezone

from apps.audit.services import record as record_audit, snapshot
from apps.comments.models import (
    KIOSK_ALERT_COOLDOWN_SECONDS,
    KioskAlert,
    KioskAlertStatus,
    KioskSession,
)
from apps.specifications.models import SpecificationSheet


logger = logging.getLogger(__name__)


#: Brand string in the email subject + footer. Pulled from settings
#: when the deployment has overridden it; otherwise we use the
#: canonical "Vita NPD" name.
BRAND_NAME = getattr(settings, "APP_BRAND_NAME", "Vita NPD")


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class NoIdentifiedClients(Exception):
    """Sheet has no kiosk session with an email on file — the team
    cannot notify a customer who has never identified themselves."""

    api_code = "no_identified_clients"


class CustomNoteTooLong(Exception):
    """Soft cap on the custom-note body to keep the email readable
    and the dialog reasonable. 1k chars is generous."""

    api_code = "custom_note_too_long"


CUSTOM_NOTE_MAX_LENGTH = 1000


# ---------------------------------------------------------------------------
# Public entrypoint
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class KioskAlertResult:
    """Outcome of one Notify-client gesture."""

    sent_emails: tuple[str, ...]
    skipped_emails: tuple[str, ...]
    failed_emails: tuple[str, ...]

    @property
    def notified_count(self) -> int:
        return len(self.sent_emails)


def notify_kiosk_clients(
    *,
    sheet: SpecificationSheet,
    actor,
    custom_note: str = "",
) -> KioskAlertResult:
    """Send a "we have new updates" email to every identified
    customer attached to ``sheet``.

    ``actor`` is the team member who clicked the button — recorded
    in the ledger so an admin can answer "who notified the client
    and when?" without trawling SMTP logs.
    """

    cleaned_note = (custom_note or "").strip()
    if len(cleaned_note) > CUSTOM_NOTE_MAX_LENGTH:
        raise CustomNoteTooLong()

    emails = _collect_recipient_emails(sheet)
    if not emails:
        raise NoIdentifiedClients()

    in_cooldown = _emails_in_cooldown(sheet=sheet, emails=emails)
    sent: list[str] = []
    skipped: list[str] = []
    failed: list[str] = []

    triggered_by_label, triggered_by_email = _actor_labels(actor)

    for email in emails:
        if email in in_cooldown:
            _record_skipped(
                sheet=sheet,
                actor=actor,
                email=email,
                custom_note=cleaned_note,
            )
            skipped.append(email)
            continue

        row = KioskAlert.objects.create(
            sheet=sheet,
            organization=sheet.organization,
            triggered_by=actor if getattr(actor, "id", None) else None,
            recipient_email=email,
            custom_note=cleaned_note,
            status=KioskAlertStatus.QUEUED,
        )
        try:
            _send_email(
                sheet=sheet,
                recipient_email=email,
                custom_note=cleaned_note,
                triggered_by_name=triggered_by_label,
                triggered_by_email=triggered_by_email,
            )
        except Exception as exc:  # noqa: BLE001 — isolate per-recipient
            logger.exception(
                "Failed to send kiosk alert (sheet=%s to=%s)",
                sheet.id,
                email,
            )
            row.status = KioskAlertStatus.FAILED
            row.error = repr(exc)[:1000]
            row.save(update_fields=["status", "error"])
            failed.append(email)
            continue

        row.status = KioskAlertStatus.SENT
        row.sent_at = timezone.now()
        row.save(update_fields=["status", "sent_at"])
        sent.append(email)

    # One audit row per Notify-client click — captures the aggregate
    # outcome so an org admin can see "Max notified 2 clients about
    # CFF-128 on Thursday, one skipped due to cooldown."
    record_audit(
        organization=sheet.organization,
        actor=actor,
        action="kiosk_alert.send",
        target=sheet,
        after=snapshot(
            sheet,
            extra={
                "sent_emails": sent,
                "skipped_emails": skipped,
                "failed_emails": failed,
                "custom_note": cleaned_note,
            },
        ),
    )

    return KioskAlertResult(
        sent_emails=tuple(sent),
        skipped_emails=tuple(skipped),
        failed_emails=tuple(failed),
    )


def latest_alert_for_sheet(sheet: SpecificationSheet) -> KioskAlert | None:
    """Return the most-recent KioskAlert row for the sheet, regardless
    of recipient — backs the "Last notified X ago" hint in the UI so
    a teammate sees at a glance whether the customer has already been
    pinged."""

    return (
        KioskAlert.objects.filter(sheet=sheet)
        .order_by("-created_at")
        .first()
    )


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _collect_recipient_emails(sheet: SpecificationSheet) -> list[str]:
    """Distinct, lowercased, non-empty emails from every identified
    kiosk session attached to this sheet that hasn't been revoked.

    The lowercase normalisation is the dedupe key — two sessions for
    ``Bob@Acme.com`` and ``bob@acme.com`` collapse to one send."""

    raw = (
        KioskSession.objects.filter(
            public_token=sheet.public_token,
            revoked_at__isnull=True,
        )
        .exclude(guest_email="")
        .values_list("guest_email", flat=True)
    )
    seen: set[str] = set()
    out: list[str] = []
    for email in raw:
        normalised = (email or "").strip().lower()
        if not normalised or normalised in seen:
            continue
        seen.add(normalised)
        out.append(normalised)
    return out


def _emails_in_cooldown(
    *, sheet: SpecificationSheet, emails: list[str]
) -> set[str]:
    """Return the subset of ``emails`` that received a ``SENT`` alert
    on this sheet within the cooldown window."""

    if not emails:
        return set()
    threshold = timezone.now() - timezone.timedelta(
        seconds=KIOSK_ALERT_COOLDOWN_SECONDS
    )
    rows = KioskAlert.objects.filter(
        sheet=sheet,
        status=KioskAlertStatus.SENT,
        recipient_email__in=emails,
        sent_at__gte=threshold,
    ).values_list("recipient_email", flat=True)
    return {(value or "").lower() for value in rows}


def _record_skipped(
    *,
    sheet: SpecificationSheet,
    actor,
    email: str,
    custom_note: str,
) -> None:
    KioskAlert.objects.create(
        sheet=sheet,
        organization=sheet.organization,
        triggered_by=actor if getattr(actor, "id", None) else None,
        recipient_email=email,
        custom_note=custom_note,
        status=KioskAlertStatus.SKIPPED,
    )


def _actor_labels(actor) -> tuple[str, str]:
    """Return ``(display_name, email)`` for the team member sender.

    Empty strings when ``actor`` is anonymous (shouldn't happen via
    the REST gate but keep it total)."""

    if actor is None or not getattr(actor, "id", None):
        return ("", "")
    name = (actor.get_full_name() or actor.email or "").strip()
    return (name, getattr(actor, "email", "") or "")


def _send_email(
    *,
    sheet: SpecificationSheet,
    recipient_email: str,
    custom_note: str,
    triggered_by_name: str,
    triggered_by_email: str,
) -> None:
    """Render the templates and ship the email via Django mail."""

    kiosk_url = _kiosk_url_for_sheet(sheet)
    context: dict[str, Any] = {
        "brand": BRAND_NAME,
        "sheet": sheet,
        "sheet_code": (sheet.code or "").strip(),
        "kiosk_url": kiosk_url,
        "recipient_name": _recipient_name_for(sheet, recipient_email),
        "custom_note": custom_note,
        "triggered_by_name": triggered_by_name,
        "triggered_by_email": triggered_by_email,
    }

    subject = render_to_string(
        "comments/email/kiosk_alert.subject.txt", context
    ).strip()
    text_body = render_to_string(
        "comments/email/kiosk_alert.body.txt", context
    )
    html_body = render_to_string(
        "comments/email/kiosk_alert.body.html", context
    )

    message = EmailMultiAlternatives(
        subject=subject,
        body=text_body,
        from_email=getattr(
            settings, "DEFAULT_FROM_EMAIL", "no-reply@localhost"
        ),
        to=[recipient_email],
    )
    message.attach_alternative(html_body, "text/html")
    message.send(fail_silently=False)


def _kiosk_url_for_sheet(sheet: SpecificationSheet) -> str:
    """The customer-facing kiosk URL. Mirrors the route shape
    ``app/[locale]/p/[token]`` on the FE."""

    base = getattr(settings, "APP_BASE_URL", "")
    return f"{base.rstrip('/')}/p/{sheet.public_token}/"


def _recipient_name_for(
    sheet: SpecificationSheet, recipient_email: str
) -> str:
    """Best-effort first-name greeting — pulls from the most recent
    identified KioskSession for this email. Falls back to empty so
    the template renders a generic ``Hi,`` rather than ``Hi None,``.
    """

    row = (
        KioskSession.objects.filter(
            public_token=sheet.public_token,
            guest_email__iexact=recipient_email,
        )
        .order_by("-last_seen_at")
        .values_list("guest_name", flat=True)
        .first()
    )
    return (row or "").strip()
