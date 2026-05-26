"""HTTP surface for the client portal.

Three groups of endpoints:

1. **Activation + auth** — ``/portal/activate/...``, ``/portal/auth/...``.
   Public (no portal cookie required) because they ISSUE the cookie.
2. **Identity** — ``/portal/auth/me/``. Authenticated; returns the
   minimal shape the dashboard needs to render the "Hi <Company>"
   banner without round-tripping to the customer detail endpoint.
3. **Proposals** — ``/portal/proposals/...``. Authenticated +
   ownership-gated. The list is filtered to the client's customer;
   detail / sign / reject endpoints assert
   ``proposal.customer_id == request.user.customer_id`` before any
   write happens.

Every authenticated endpoint inherits
:class:`apps.client_portal.permissions.IsClientAccount` via the
:class:`PortalAPIView` base class so a staff JWT in the portal
cookie can never accidentally pass — even if the cookie names ever
collided, the user-type check would catch it.
"""

from __future__ import annotations

import logging
import uuid

from django.core.exceptions import ValidationError
from rest_framework import status
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.client_portal.auth import PortalCookieJWTAuthentication
from apps.client_portal.cookies import (
    clear_portal_auth_cookies,
    set_portal_auth_cookies,
    tokens_for_client,
)
from apps.client_portal.email import send_portal_password_reset_email
from apps.client_portal.permissions import (
    ClientOwnsProposal,
    IsClientAccount,
)
from apps.client_portal.models import PortalEvent
from apps.client_portal.services import (
    AccountAlreadyActivated,
    ActivationCodeRateLimited,
    ActivationError,
    CustomerEmailMissing,
    InvalidActivationCode,
    InvalidActivationToken,
    InvalidCredentials,
    activate_via_token,
    authenticate_client,
    confirm_password_reset,
    preview_activation,
    record_portal_event,
    request_activation_code,
    request_password_reset,
)
from apps.client_portal.api.serializers import (
    ActivationPreviewSerializer,
    ActivationRequestSerializer,
    LoginRequestSerializer,
    MeSerializer,
    PasswordResetConfirmSerializer,
    PasswordResetRequestSerializer,
    ProposalListItemSerializer,
)


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _request_ip(request: Request) -> str:
    xff = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR", "") or ""


def _err(code: str, http_status: int, **extra) -> Response:
    body = {"code": code, "detail": [code]}
    body.update(extra)
    return Response(body, status=http_status)


class PortalAuthMixin:
    """Authenticate every portal endpoint via the portal cookie."""

    authentication_classes = (PortalCookieJWTAuthentication,)


class PortalAPIView(PortalAuthMixin, APIView):
    """Base for authenticated portal endpoints."""

    permission_classes = (IsClientAccount,)


class PortalPublicAPIView(PortalAuthMixin, APIView):
    """Base for cookie-issuing endpoints (activate, login, etc.)."""

    permission_classes = (AllowAny,)


# ---------------------------------------------------------------------------
# Activation
# ---------------------------------------------------------------------------


def _parse_token(raw: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(raw))
    except (ValueError, AttributeError, TypeError) as exc:
        raise InvalidActivationToken("Malformed activation token.") from exc


class ActivationPreviewView(PortalPublicAPIView):
    """``GET /api/portal/activate/<token>/``.

    Read-only peek so the activation page can pick the right copy
    (set password vs. sign in) before the client submits anything.
    """

    def get(self, request: Request, token: str) -> Response:
        try:
            payload = preview_activation(token=_parse_token(token))
        except CustomerEmailMissing:
            return _err("customer_email_missing", status.HTTP_409_CONFLICT)
        except InvalidActivationToken:
            return _err("invalid_activation_token", status.HTTP_404_NOT_FOUND)
        return Response(ActivationPreviewSerializer(payload).data)


class ActivationCodeRequestView(PortalPublicAPIView):
    """``POST /api/portal/activate/<token>/request-code/``.

    Mints + emails a fresh just-in-time 6-digit activation code for
    the proposal that owns ``token``. Called by the activation page
    when the customer advances to the code step (auto-fire) and on
    every "Resend code" click. Rate-limited to one send per 60s per
    proposal; codes expire after 10 minutes.
    """

    def post(self, request: Request, token: str) -> Response:
        try:
            payload = request_activation_code(token=_parse_token(token))
        except CustomerEmailMissing:
            return _err("customer_email_missing", status.HTTP_409_CONFLICT)
        except AccountAlreadyActivated:
            # Returner — the FE should route to login; defence-in-depth
            # for the case the FE hasn't yet read the preview.
            return _err(
                "account_already_activated",
                status.HTTP_409_CONFLICT,
            )
        except ActivationCodeRateLimited as exc:
            return _err(
                "activation_code_rate_limited",
                status.HTTP_429_TOO_MANY_REQUESTS,
                retry_after_seconds=exc.retry_after_seconds,
            )
        except InvalidActivationToken:
            return _err("invalid_activation_token", status.HTTP_404_NOT_FOUND)
        except ActivationError as exc:
            return _err(exc.code, status.HTTP_400_BAD_REQUEST)

        return Response(
            {
                "sent": True,
                "email_masked": payload["email_masked"],
                "retry_after_seconds": payload["retry_after_seconds"],
            },
            status=status.HTTP_200_OK,
        )


class ActivationView(PortalPublicAPIView):
    """``POST /api/portal/activate/<token>/``.

    On success: sets portal cookies + returns ``MeSerializer``.
    """

    def post(self, request: Request, token: str) -> Response:
        serializer = ActivationRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        password = serializer.validated_data["password"]
        code = serializer.validated_data["code"]

        try:
            result = activate_via_token(
                token=_parse_token(token),
                password=password,
                code=code,
            )
        except CustomerEmailMissing:
            return _err("customer_email_missing", status.HTTP_409_CONFLICT)
        except AccountAlreadyActivated:
            return _err(
                "account_already_activated",
                status.HTTP_409_CONFLICT,
            )
        except InvalidActivationCode:
            return _err(
                "invalid_activation_code",
                status.HTTP_400_BAD_REQUEST,
            )
        except InvalidActivationToken:
            return _err("invalid_activation_token", status.HTTP_404_NOT_FOUND)
        except ValidationError as exc:
            return _err(
                "weak_password",
                status.HTTP_400_BAD_REQUEST,
                messages=list(exc.messages),
            )
        except ActivationError as exc:
            return _err(exc.code, status.HTTP_400_BAD_REQUEST)

        account = result.account
        access, refresh = tokens_for_client(account)
        response = Response(_me_payload(account))
        set_portal_auth_cookies(response, access, refresh)
        return response


# ---------------------------------------------------------------------------
# Login / logout / me
# ---------------------------------------------------------------------------


class LoginView(PortalPublicAPIView):
    """``POST /api/portal/auth/login/``."""

    def post(self, request: Request) -> Response:
        serializer = LoginRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            account = authenticate_client(
                email=serializer.validated_data["email"],
                password=serializer.validated_data["password"],
                request_ip=_request_ip(request),
            )
        except InvalidCredentials:
            return _err("invalid_credentials", status.HTTP_401_UNAUTHORIZED)

        access, refresh = tokens_for_client(account)
        response = Response(_me_payload(account))
        set_portal_auth_cookies(response, access, refresh)
        record_portal_event(
            organization=account.customer.organization,
            client_account=account,
            kind=PortalEvent.Kind.SIGNED_IN,
            request=request,
        )
        return response


class LogoutView(PortalPublicAPIView):
    """``POST /api/portal/auth/logout/``.

    AllowAny because the cookie may already be expired; deleting it
    on the client is a no-op-safe operation. We don't bother to
    revoke the refresh token server-side — the cookie clear is the
    operational answer for "I want to sign out", and the access TTL
    is short (60 min) so any stolen token expires soon anyway.
    """

    def post(self, request: Request) -> Response:
        # Best-effort sign-out trace. ``request.user`` may be
        # anonymous when the cookie was already expired — we read
        # the membership defensively so a stale-session logout
        # still drops the cookies cleanly without raising here.
        account = request.user if getattr(request.user, "is_authenticated", False) else None
        if account is not None:
            record_portal_event(
                organization=account.customer.organization,
                client_account=account,
                kind=PortalEvent.Kind.SIGNED_OUT,
                request=request,
            )
        response = Response(status=status.HTTP_204_NO_CONTENT)
        clear_portal_auth_cookies(response)
        return response


class MeView(PortalAPIView):
    """``GET /api/portal/auth/me/``."""

    def get(self, request: Request) -> Response:
        return Response(_me_payload(request.user))


def _me_payload(account) -> dict:
    customer = account.customer
    return MeSerializer(
        {
            "id": account.id,
            "email": account.email,
            "customer_id": customer.id,
            "customer_company": customer.company or "",
            "customer_name": customer.name or "",
            "activated_at": account.activated_at,
            "avatar_image": account.avatar_image or "",
        }
    ).data


# ---------------------------------------------------------------------------
# Password reset
# ---------------------------------------------------------------------------


class PasswordResetRequestView(PortalPublicAPIView):
    """``POST /api/portal/auth/password-reset/request/``.

    Enumeration-safe: always returns 200 with the same body shape,
    whether or not the email matched a real account.
    """

    def post(self, request: Request) -> Response:
        serializer = PasswordResetRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        issued = request_password_reset(
            email=serializer.validated_data["email"],
            requested_ip=_request_ip(request),
        )
        if issued is not None:
            try:
                send_portal_password_reset_email(
                    to_email=issued.account.email,
                    plaintext_token=issued.plaintext_token,
                )
            except Exception:  # noqa: BLE001 — log + degrade
                logger.exception(
                    "portal.reset: failed to send reset email to %s",
                    issued.account.email,
                )
        return Response({"detail": "ok"})


class PasswordResetConfirmView(PortalPublicAPIView):
    """``POST /api/portal/auth/password-reset/confirm/``."""

    def post(self, request: Request) -> Response:
        serializer = PasswordResetConfirmSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            account = confirm_password_reset(
                token=serializer.validated_data["token"],
                new_password=serializer.validated_data["new_password"],
            )
        except ValueError:
            return _err(
                "invalid_or_expired_token",
                status.HTTP_400_BAD_REQUEST,
            )
        except ValidationError as exc:
            return _err(
                "weak_password",
                status.HTTP_400_BAD_REQUEST,
                messages=list(exc.messages),
            )

        access, refresh = tokens_for_client(account)
        response = Response(_me_payload(account))
        set_portal_auth_cookies(response, access, refresh)
        return response


# ---------------------------------------------------------------------------
# Proposals (dashboard + detail)
# ---------------------------------------------------------------------------


class ProposalListView(PortalAPIView):
    """``GET /api/portal/proposals/``.

    Lists every proposal whose ``customer_id`` matches the logged-in
    client's customer. Newest first. No pagination yet — typical
    customer has handful of proposals; revisit when a real
    enterprise client lands.
    """

    def get(self, request: Request) -> Response:
        from apps.proposals.models import Proposal

        proposals = (
            Proposal.objects
            .filter(customer_id=request.user.customer_id)
            .order_by("-updated_at")
        )
        rows = [
            {
                "id": p.id,
                "code": p.code or "",
                "title": getattr(p, "title", "") or p.code or "",
                "status": p.status,
                "updated_at": p.updated_at,
                "created_at": p.created_at,
                "public_token": p.public_token,
            }
            for p in proposals
        ]
        return Response(
            {"results": ProposalListItemSerializer(rows, many=True).data},
        )


def _load_owned_proposal(request: Request, proposal_id):
    """Resolve ``proposal_id`` against the logged-in client's
    customer, or raise ``NotFound``.

    Used by every proposal-scoped portal endpoint. Same 404 for
    "doesn't exist" and "belongs to another customer" so existence
    of proposals across the tenant never leaks.
    """

    from apps.proposals.models import Proposal

    proposal = (
        Proposal.objects
        .select_related("customer", "organization")
        .filter(pk=proposal_id)
        .first()
    )
    if proposal is None or proposal.customer_id != request.user.customer_id:
        raise NotFound("Proposal not found.")
    return proposal


class ProposalDetailView(PortalAPIView):
    """``GET /api/portal/proposals/<id>/``.

    Reuses the kiosk payload renderer from the staff app so the
    portal renders pixel-identical data to what the old
    ``PublicProposalKioskView`` produced — the only difference is
    auth.
    """

    def get(self, request: Request, proposal_id: str) -> Response:
        from apps.proposals.api.views import _render_public_proposal_payload
        from apps.proposals.services import (
            ProposalStatus,
            _ensure_attached_spec_tokens,
            _promote_attached_specs_to_sent,
        )

        proposal = _load_owned_proposal(request, proposal_id)
        # Mirror the public-kiosk behaviour: lazily mint per-spec
        # tokens (needed by the spec preview iframes) and promote
        # attached specs to ``sent`` when the parent proposal is
        # also at ``sent``. Idempotent on repeat opens.
        _ensure_attached_spec_tokens(
            proposal=proposal, actor=proposal.updated_by,
        )
        if proposal.status == ProposalStatus.SENT.value:
            _promote_attached_specs_to_sent(
                proposal=proposal, actor=proposal.updated_by,
            )
        record_portal_event(
            organization=proposal.organization,
            proposal=proposal,
            client_account=request.user,
            kind=PortalEvent.Kind.PROPOSAL_VIEWED,
            request=request,
        )
        return Response(_render_public_proposal_payload(proposal))


# ---------------------------------------------------------------------------
# Proposal write paths — sign / sign-spec / reject / finalize
# ---------------------------------------------------------------------------


def _client_signer_fields(request: Request) -> tuple[str, str, str]:
    """Compose ``(signer_name, signer_email, signer_company)`` from
    the authenticated client + their customer record.

    Replaces the kiosk-session identity the legacy public endpoints
    relied on. ``signer_email`` is the ClientAccount login (the
    address the activation email reached); ``signer_company`` /
    ``signer_name`` come off the Customer record so they always
    reflect the latest CRM state, not whatever the client typed
    into a now-deleted identity modal.
    """

    account = request.user
    customer = account.customer
    return (
        customer.name or customer.company or "",
        account.email,
        customer.company or "",
    )


def _client_ip(request: Request) -> str:
    xff = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR", "") or ""


def _user_agent(request: Request) -> str:
    return (request.META.get("HTTP_USER_AGENT") or "")[:512]


class ProposalSignView(PortalAPIView):
    """``POST /api/portal/proposals/<id>/sign/``.

    Captures the client's signature on the proposal itself. Reuses
    :func:`capture_customer_signature_on_proposal` from the staff
    service layer — the only thing that changes between the legacy
    kiosk path and this one is where the signer identity comes from.
    """

    def post(self, request: Request, proposal_id: str) -> Response:
        from apps.proposals.api.views import (
            _canonical_proposal_payload,
            _document_hash,
        )
        from apps.proposals.services import (
            InvalidProposalTransition,
            ProposalAcknowledgementsRequired,
            SignatureRequired,
            capture_customer_signature_on_proposal,
        )
        from config.signatures import SignatureImageInvalid

        proposal = _load_owned_proposal(request, proposal_id)
        signer_name, signer_email, signer_company = _client_signer_fields(request)

        payload = request.data or {}
        signature_image = payload.get("signature_image") or ""
        try:
            updated = capture_customer_signature_on_proposal(
                proposal=proposal,
                signer_name=signer_name,
                signer_email=signer_email,
                signer_company=signer_company,
                signature_image=signature_image,
                ack_spec_signing=bool(payload.get("ack_spec_signing")),
                ack_lead_times=bool(payload.get("ack_lead_times")),
                ack_terms=bool(payload.get("ack_terms")),
                ack_rd_terms=bool(payload.get("ack_rd_terms")),
                sign_ip=_client_ip(request),
                sign_user_agent=_user_agent(request),
            )
        except InvalidProposalTransition:
            return _err("invalid_proposal_transition", status.HTTP_400_BAD_REQUEST)
        except ProposalAcknowledgementsRequired:
            return _err(
                "proposal_acknowledgements_required",
                status.HTTP_400_BAD_REQUEST,
            )
        except (SignatureRequired, SignatureImageInvalid):
            return _err("signature_required", status.HTTP_400_BAD_REQUEST)

        post_sign_hash = _document_hash(_canonical_proposal_payload(updated))
        updated.customer_sign_document_hash = post_sign_hash
        updated.save(update_fields=["customer_sign_document_hash"])

        record_portal_event(
            organization=updated.organization,
            proposal=updated,
            client_account=request.user,
            kind=PortalEvent.Kind.PROPOSAL_SIGNED,
            request=request,
        )

        return Response(
            {
                "id": str(updated.id),
                "status": updated.status,
                "customer_signed_at": (
                    updated.customer_signed_at.isoformat()
                    if updated.customer_signed_at is not None
                    else None
                ),
            },
        )


class ProposalSignSpecView(PortalAPIView):
    """``POST /api/portal/proposals/<id>/specs/<sheet_id>/sign/``.

    Per-spec signature capture. The spec-on-proposal guard from the
    legacy view is preserved by the service layer: a sheet that
    isn't on this proposal raises ``KioskSpecNotOnProposal`` which
    we translate to a 404 (no existence leak across the org).
    """

    def post(
        self,
        request: Request,
        proposal_id: str,
        sheet_id: str,
    ) -> Response:
        from apps.proposals.api.views import (
            _canonical_spec_payload,
            _document_hash,
        )
        from apps.proposals.services import (
            KioskSpecNotOnProposal,
            SignatureRequired,
            capture_customer_signature_on_attached_spec,
        )
        from apps.specifications.services import (
            InvalidStatusTransition as SpecInvalidStatusTransition,
        )
        from config.signatures import SignatureImageInvalid

        proposal = _load_owned_proposal(request, proposal_id)
        signer_name, signer_email, signer_company = _client_signer_fields(request)

        signature_image = (request.data or {}).get("signature_image") or ""
        try:
            updated = capture_customer_signature_on_attached_spec(
                proposal=proposal,
                sheet_id=sheet_id,
                signer_name=signer_name,
                signer_email=signer_email,
                signer_company=signer_company,
                signature_image=signature_image,
                sign_ip=_client_ip(request),
                sign_user_agent=_user_agent(request),
            )
        except KioskSpecNotOnProposal:
            raise NotFound("Specification not found on this proposal.")
        except SpecInvalidStatusTransition:
            return _err("invalid_status_transition", status.HTTP_400_BAD_REQUEST)
        except (SignatureRequired, SignatureImageInvalid):
            return _err("signature_required", status.HTTP_400_BAD_REQUEST)

        post_sign_hash = _document_hash(_canonical_spec_payload(updated))
        updated.customer_sign_document_hash = post_sign_hash
        updated.save(update_fields=["customer_sign_document_hash"])

        record_portal_event(
            organization=proposal.organization,
            proposal=proposal,
            client_account=request.user,
            kind=PortalEvent.Kind.SPEC_SIGNED,
            metadata={"spec_id": str(updated.id)},
            request=request,
        )

        return Response(
            {
                "id": str(updated.id),
                "customer_signed_at": (
                    updated.customer_signed_at.isoformat()
                    if updated.customer_signed_at is not None
                    else None
                ),
            },
        )


class ProposalRejectView(PortalAPIView):
    """``POST /api/portal/proposals/<id>/reject/``."""

    def post(self, request: Request, proposal_id: str) -> Response:
        from apps.proposals.services import (
            InvalidProposalTransition,
            capture_customer_rejection_on_proposal,
        )

        proposal = _load_owned_proposal(request, proposal_id)
        data = request.data if isinstance(request.data, dict) else {}
        reason = str(data.get("reason") or "")

        try:
            updated = capture_customer_rejection_on_proposal(
                proposal=proposal, reason=reason,
            )
        except InvalidProposalTransition:
            return _err("invalid_proposal_transition", status.HTTP_400_BAD_REQUEST)

        record_portal_event(
            organization=updated.organization,
            proposal=updated,
            client_account=request.user,
            kind=PortalEvent.Kind.PROPOSAL_REJECTED,
            metadata={"reason": reason} if reason else None,
            request=request,
        )

        return Response(
            {
                "status": updated.status,
                "customer_rejected_at": (
                    updated.customer_rejected_at.isoformat()
                    if updated.customer_rejected_at is not None
                    else None
                ),
            },
        )


class ProposalFinalizeView(PortalAPIView):
    """``POST /api/portal/proposals/<id>/finalize/``."""

    def post(self, request: Request, proposal_id: str) -> Response:
        from apps.proposals.services import (
            InvalidProposalTransition,
            KioskSignaturesPending,
            finalize_proposal_kiosk,
        )

        proposal = _load_owned_proposal(request, proposal_id)
        try:
            result = finalize_proposal_kiosk(proposal=proposal)
        except InvalidProposalTransition:
            return _err("invalid_proposal_transition", status.HTTP_400_BAD_REQUEST)
        except KioskSignaturesPending as exc:
            return Response(
                {
                    "code": "kiosk_signatures_pending",
                    "detail": ["kiosk_signatures_pending"],
                    "pending": list(exc.args[0]) if exc.args else [],
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(result)


from django.utils.decorators import method_decorator
from django.views.decorators.clickjacking import xframe_options_sameorigin


@method_decorator(xframe_options_sameorigin, name="dispatch")
class ProposalPdfView(PortalAPIView):
    """``GET /api/portal/proposals/<id>/pdf/``.

    Renders the proposal as HTML for the in-portal preview iframe.
    Same shape as the legacy public endpoint — the new entry point
    enforces auth + ownership. The ``xframe_options_sameorigin``
    decorator overrides Django's default ``X-Frame-Options: DENY``
    so the portal page (served from the same origin via the Next
    proxy) can embed the response in an iframe; without it the
    browser shows a blank "refused to connect" frame and the
    proposal preview never paints.
    """

    def get(self, request: Request, proposal_id: str):
        from django.http import HttpResponse
        from apps.proposals.api.views import _render_proposal_html

        proposal = _load_owned_proposal(request, proposal_id)
        return HttpResponse(_render_proposal_html(proposal))


class ProposalDownloadView(PortalAPIView):
    """``GET /api/portal/proposals/<id>/download/``.

    PDF download. Cached + render-locked via the existing
    ``cached_render`` helper so peak WeasyPrint memory stays
    bounded.
    """

    def get(self, request: Request, proposal_id: str):
        from django.http import HttpResponse
        from apps.proposals.api.views import _render_proposal_pdf
        from config.pdf_cache import cached_render

        proposal = _load_owned_proposal(request, proposal_id)
        pdf_bytes = cached_render(
            f"proposal-pdf:{proposal.id}:{int(proposal.updated_at.timestamp())}",
            lambda: _render_proposal_pdf(proposal),
        )
        filename = (
            f"{(proposal.code or 'proposal').strip().replace(' ', '-')}.pdf"
        )
        response = HttpResponse(pdf_bytes, content_type="application/pdf")
        response["Content-Disposition"] = f'attachment; filename="{filename}"'
        response["Cache-Control"] = "public, max-age=300, must-revalidate"
        record_portal_event(
            organization=proposal.organization,
            proposal=proposal,
            client_account=request.user,
            kind=PortalEvent.Kind.PROPOSAL_PDF_DOWNLOADED,
            request=request,
        )
        return response
