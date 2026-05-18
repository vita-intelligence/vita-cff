"""REST surface for the "Notify client" team action.

Two endpoints:

* ``POST /api/comments/organizations/<org>/specifications/<sheet>/notify-client/``
  — fires the email to every identified kiosk customer on the sheet
  (subject to cooldown). Returns the per-recipient outcome so the
  FE can show a precise toast ("notified 2 clients, 1 already
  notified moments ago").

* ``GET  /api/comments/organizations/<org>/specifications/<sheet>/notify-client/``
  — peek the most-recent alert + recipient roster so the button's
  hint line ("Last notified X ago, to 2 clients") renders correctly
  on mount.

Authorisation matches the rest of the comments REST surface:
``comments_write`` on the org's formulations module. The team
member needs to be able to post on the chat to also be able to
push a Notify-client gesture.
"""

from __future__ import annotations

from typing import Any

from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.comments.api.permissions import HasCommentsPermission
from apps.comments.kiosk_alerts import (
    CUSTOM_NOTE_MAX_LENGTH,
    CustomNoteTooLong,
    KioskAlertResult,
    NoIdentifiedClients,
    latest_alert_for_sheet,
    notify_kiosk_clients,
)
from apps.comments.models import KioskAlert, KioskSession
from apps.organizations.modules import FormulationsCapability
from apps.specifications.models import SpecificationSheet


class NotifyClientView(APIView):
    """``POST /notify-client/`` + ``GET`` peek for the bell hint."""

    permission_classes = (HasCommentsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        # GET only needs to see comments; POST adds an external side
        # effect (email) so we require the write capability for it.
        self.required_capability = (
            FormulationsCapability.COMMENTS_WRITE
            if request.method == "POST"
            else FormulationsCapability.COMMENTS_VIEW
        )
        super().initial(request, *args, **kwargs)

    # ------------------------------------------------------------------

    def get(self, request: Request, *args, **kwargs) -> Response:
        sheet = self._load_sheet(**kwargs)
        return Response(_summary_payload(sheet), status=status.HTTP_200_OK)

    def post(self, request: Request, *args, **kwargs) -> Response:
        sheet = self._load_sheet(**kwargs)
        note = request.data.get("note", "") if isinstance(request.data, dict) else ""
        if isinstance(note, str) is False:
            return Response(
                {"note": ["custom_note_invalid"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            result = notify_kiosk_clients(
                sheet=sheet,
                actor=request.user,
                custom_note=note,
            )
        except CustomNoteTooLong as exc:
            return Response(
                {"note": [exc.api_code]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except NoIdentifiedClients as exc:
            return Response(
                {"detail": exc.api_code},
                status=status.HTTP_409_CONFLICT,
            )

        return Response(
            _result_payload(sheet, result),
            status=status.HTTP_200_OK,
        )

    # ------------------------------------------------------------------

    def _load_sheet(self, **url_kwargs) -> SpecificationSheet:
        sheet = (
            SpecificationSheet.objects.filter(
                organization=self.organization,
                id=url_kwargs.get("sheet_id"),
            ).first()
        )
        if sheet is None:
            raise NotFound()
        return sheet


# ---------------------------------------------------------------------------
# Serialisation helpers
# ---------------------------------------------------------------------------


def _summary_payload(sheet: SpecificationSheet) -> dict[str, Any]:
    """Information the FE needs to render the button + hint without
    a separate fetch: who can be notified + when the last alert went
    out."""

    latest = latest_alert_for_sheet(sheet)
    recipient_count = (
        KioskSession.objects.filter(
            public_token=sheet.public_token,
            revoked_at__isnull=True,
        )
        .exclude(guest_email="")
        .values("guest_email")
        .distinct()
        .count()
    )
    return {
        "recipient_count": recipient_count,
        "last_alert": _latest_alert_payload(latest),
        "custom_note_max_length": CUSTOM_NOTE_MAX_LENGTH,
    }


def _result_payload(
    sheet: SpecificationSheet, result: KioskAlertResult
) -> dict[str, Any]:
    latest = latest_alert_for_sheet(sheet)
    return {
        "notified_count": result.notified_count,
        "sent_emails": list(result.sent_emails),
        "skipped_emails": list(result.skipped_emails),
        "failed_emails": list(result.failed_emails),
        "last_alert": _latest_alert_payload(latest),
    }


def _latest_alert_payload(latest: KioskAlert | None) -> dict[str, Any] | None:
    if latest is None:
        return None
    return {
        "id": str(latest.id),
        "status": latest.status,
        "recipient_email": latest.recipient_email,
        "triggered_by": (
            (latest.triggered_by.get_full_name() or latest.triggered_by.email).strip()
            if latest.triggered_by_id and latest.triggered_by is not None
            else ""
        ),
        "created_at": latest.created_at.isoformat(),
        "sent_at": latest.sent_at.isoformat() if latest.sent_at else None,
    }
