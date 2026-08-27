"""PSP-facing read endpoints.

Distinct from :mod:`apps.formulations.api.views` because the caller
is PSP (server-to-server), not a logged-in user — the auth chain is a
shared bearer token, not JWT. Kept small: PSP only needs the flat list
of projects still in R&D so its ``/projects`` kanban can render an
"R&D in development" column before the customer-order columns.
"""

from __future__ import annotations

from django.conf import settings
from django.http import HttpResponse
from rest_framework import status
from rest_framework.exceptions import AuthenticationFailed, NotFound
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.formulations.models import Formulation, ProjectStatus, ProjectType
from apps.payments.models import Payment
from apps.product_validation.models import ProductValidation
from apps.product_validation.services import render_validation_html
from apps.psp.token_services import verify_psp_access_token
from apps.specifications.models import SpecificationSheet
from apps.specifications.services import render_html
from apps.trial_batches.models import TrialBatch


# PSP's per-MO roadmap payload — allowlisted keys only so a rogue
# / mis-configured PSP push can't stuff arbitrary shapes into a
# JSONField that the customer portal renders. Also caps string
# fields to defensive lengths.
_MO_STRING_KEYS_MAX = {
    "uuid": 40,
    "parent_mo_uuid": 40,
    "code": 40,
    "item_name": 200,
    "stage": 32,
    "status": 32,
    "target_lot_code": 40,
    "quantity": 40,
    "quantity_produced": 40,
    # PSP ships the OUTPUT item's stock UoM symbol (kg / L / pcs /
    # mg) so the customer FE can render "10,000 pcs" instead of a
    # bare integer. Symbol column on units_of_measurement caps at
    # 16 chars.
    "uom_symbol": 16,
}

_MO_INT_KEYS = {
    "stage_index",
    "stage_total",
    "bookings_total",
    "bookings_picked_count",
    "bookings_received_count",
    "output_lots_pending_qc_count",
}

_MO_ISO_KEYS = {
    "approved_at",
    "released_to_warehouse_at",
    "pickup_started_at",
    "pickup_completed_at",
    "actual_start",
    "actual_finish",
    "closeout_completed_at",
    "due_date",
}

# WorkstationSession — nested list on each MO. Same allowlist
# discipline as the parent MO shape: strings capped, ints coerced,
# unknown keys dropped. `finished_at` may be null (active session).
_SESSION_STRING_KEYS_MAX = {
    "uuid": 40,
    "workstation_name": 120,
    "status": 32,
}

_SESSION_INT_KEYS = {"duration_seconds"}
_SESSION_ISO_KEYS = {"started_at", "finished_at"}

# Cap the sessions per MO to match PSP's own @public_sessions_cap.
# A single MO can accumulate dozens of sessions over rework; we
# only need the newest.
_MO_SESSIONS_CAP = 20

# Purchase orders supplying an MO's placeholder bookings — same
# allowlist discipline. Vendor names capped generously; PSP's
# vendors.name / legal_name column has no hard cap so we defend
# against an accidental novel.
_PO_STRING_KEYS_MAX = {
    "uuid": 40,
    "code": 40,
    "vendor_name": 200,
    "status": 32,
    # Derived payment state — "not_invoiced" / "invoiced_unpaid" /
    # "partially_paid" / "paid" / "disputed". The FE translates
    # these to customer copy.
    "payment_status": 32,
}
_PO_INT_KEYS = {"line_count"}
# expected_delivery_date is a date (YYYY-MM-DD, 10 chars); ISO cap
# of 40 covers a future full-datetime migration. `paid_at` is a
# UTC datetime once fully paid, else null.
_PO_ISO_KEYS = {"expected_delivery_date", "paid_at"}
_MO_POS_CAP = 20


def _sanitise_purchase_orders(raw) -> list[dict]:
    if not isinstance(raw, list):
        return []

    out: list[dict] = []
    for entry in raw[:_MO_POS_CAP]:
        if not isinstance(entry, dict):
            continue

        row: dict = {}
        for key, cap in _PO_STRING_KEYS_MAX.items():
            value = entry.get(key)
            row[key] = str(value)[:cap] if value is not None else None

        for key in _PO_INT_KEYS:
            value = entry.get(key)
            try:
                row[key] = int(value) if value is not None else None
            except (TypeError, ValueError):
                row[key] = None

        for key in _PO_ISO_KEYS:
            value = entry.get(key)
            row[key] = str(value)[:40] if value else None

        # Same phantom guard as sessions — a PO with no uuid is a
        # malformed row that shouldn't reach the portal.
        if not row.get("uuid"):
            continue

        out.append(row)

    return out


def _sanitise_sessions(raw) -> list[dict]:
    if not isinstance(raw, list):
        return []

    out: list[dict] = []
    for entry in raw[:_MO_SESSIONS_CAP]:
        if not isinstance(entry, dict):
            continue

        row: dict = {}
        for key, cap in _SESSION_STRING_KEYS_MAX.items():
            value = entry.get(key)
            row[key] = str(value)[:cap] if value is not None else None

        for key in _SESSION_INT_KEYS:
            value = entry.get(key)
            try:
                row[key] = int(value) if value is not None else None
            except (TypeError, ValueError):
                row[key] = None

        for key in _SESSION_ISO_KEYS:
            value = entry.get(key)
            row[key] = str(value)[:40] if value else None

        # Skip sessions with no uuid — same phantom guard as the MO
        # sanitiser above.
        if not row.get("uuid"):
            continue

        out.append(row)

    return out


_ROUTING_STATES = {
    "awaiting_customer",
    "awaiting_team_review",
    "applied_three_pl",
    "applied_shipment",
}

_ROUTING_CHOICES = {"three_pl", "shipment"}

_ROUTING_SNAPSHOT_KEYS = {
    "required_m3",
    "free_m3",
    "capacity_ok",
    "rate_per_m3_per_day",
    "estimated_days",
    "estimated_daily_charge",
    "estimated_period_charge",
    "currency_code",
}


def _sanitise_routing_snapshot(raw):
    """Whitelist the routing snapshot fields we render on the portal.
    Silent-degrade: bad values become ``None`` rather than raising —
    keeps the endpoint's ``push always succeeds`` contract even if a
    later PSP release adds new keys."""

    if not isinstance(raw, dict):
        return None

    out: dict = {}
    for key in _ROUTING_SNAPSHOT_KEYS:
        value = raw.get(key)
        if key == "capacity_ok":
            out[key] = bool(value)
        elif key == "estimated_days":
            try:
                out[key] = int(value) if value is not None else None
            except (TypeError, ValueError):
                out[key] = None
        else:
            out[key] = str(value)[:64] if value is not None else None
    return out


_DISPATCH_PROGRESS_STRING_KEYS = ("total_qty", "picked_up_qty", "remaining_qty")


def _sanitise_dispatch_progress(raw):
    """Coerce PSP's ``dispatch_progress`` block into a portal-safe
    dict or ``None`` when the CO has no live shipments yet."""

    if not isinstance(raw, dict):
        return None

    out: dict = {}
    for key in _DISPATCH_PROGRESS_STRING_KEYS:
        value = raw.get(key)
        out[key] = str(value)[:64] if value is not None else None

    for key in ("events_count", "shipments_count"):
        value = raw.get(key)
        try:
            out[key] = int(value) if value is not None else 0
        except (TypeError, ValueError):
            out[key] = 0

    for key in ("any_partial", "all_picked_up"):
        out[key] = bool(raw.get(key))

    return out


def _sanitise_routing_request(raw):
    """Coerce PSP's ``routing_request`` block into a portal-safe dict
    or ``None`` when the CO doesn't have one (standard commercial /
    no released lots yet). Unknown state or choice values are
    ignored (the portal maps unknowns to a generic label)."""

    if not isinstance(raw, dict):
        return None

    state = raw.get("state")
    if state not in _ROUTING_STATES:
        return None

    choice = raw.get("customer_choice")
    if choice not in _ROUTING_CHOICES and choice is not None:
        choice = None

    reviewed_by = raw.get("team_reviewed_by")
    reviewed_by_name = None
    if isinstance(reviewed_by, dict):
        reviewed_by_name = str(reviewed_by.get("name") or "")[:120] or None

    return {
        "uuid": str(raw.get("uuid") or "")[:64] or None,
        "state": state,
        "customer_choice": choice,
        "team_decision_reason": str(raw.get("team_decision_reason") or "")[:4000]
        or None,
        "customer_chose_at": str(raw.get("customer_chose_at") or "")[:64]
        or None,
        "team_reviewed_at": str(raw.get("team_reviewed_at") or "")[:64]
        or None,
        "team_reviewed_by": {"name": reviewed_by_name}
        if reviewed_by_name
        else None,
        "frozen_snapshot": _sanitise_routing_snapshot(raw.get("frozen_snapshot")),
        "current_snapshot": _sanitise_routing_snapshot(raw.get("current_snapshot")),
    }


def _sanitise_manufacturing_orders(raw) -> list[dict]:
    """Coerce PSP's push into a customer-safe list of MO roadmap
    entries. Drops unknown keys, caps strings, coerces int/ISO
    fields. Silent-degrade: any malformed row → empty list rather
    than raising (matches the rest of the endpoint's contract)."""

    if not isinstance(raw, list):
        return []

    out: list[dict] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue

        row: dict = {}
        for key, cap in _MO_STRING_KEYS_MAX.items():
            value = entry.get(key)
            if value is None:
                row[key] = None
            else:
                row[key] = str(value)[:cap]

        for key in _MO_INT_KEYS:
            value = entry.get(key)
            try:
                row[key] = int(value) if value is not None else None
            except (TypeError, ValueError):
                row[key] = None

        for key in _MO_ISO_KEYS:
            value = entry.get(key)
            row[key] = str(value)[:40] if value else None

        row["sessions"] = _sanitise_sessions(entry.get("sessions"))
        row["purchase_orders"] = _sanitise_purchase_orders(
            entry.get("purchase_orders")
        )

        # Skip entries with no identity — a stray push shouldn't land
        # a blank MO row that the portal renders as a phantom.
        if not row.get("uuid"):
            continue

        out.append(row)

    return out


def _extract_bearer(request: Request) -> str | None:
    raw = request.META.get("HTTP_AUTHORIZATION", "")
    if not raw.lower().startswith("bearer "):
        return None
    return raw.split(None, 1)[1].strip() or None


def _resolve_token(request: Request):
    """Resolve the caller.

    * Preferred path — the incoming bearer matches a live row in
      :class:`apps.psp.models.PspAccessToken`. Returns the token so the
      caller can scope its response to the token's organization.
    * Fallback — the incoming bearer matches the legacy
      :setting:`PSP_INTEGRATION_TOKEN` env var (kept for one release so
      existing dev setups don't break). Returns ``None`` and the view
      renders cross-tenant, exactly like the pre-DB implementation.
    * No match on either → :class:`AuthenticationFailed`.
    """

    presented = _extract_bearer(request)
    if not presented:
        raise AuthenticationFailed("missing_bearer_token")

    row = verify_psp_access_token(raw_token=presented)
    if row is not None:
        return row

    expected = str(settings.PSP_INTEGRATION_TOKEN or "").strip()
    if expected and presented == expected:
        return None

    raise AuthenticationFailed("invalid_bearer_token")


class InDevelopmentFormulationsView(APIView):
    """``GET /api/psp-integration/formulations/in-development/``.

    Returns every formulation whose project ``status`` is
    :attr:`ProjectStatus.IN_DEVELOPMENT`, ordered most-recently-updated
    first. PSP uses this to render a kanban column showing what R&D
    still has open before the customer-order pipeline picks up.

    Response shape:

    .. code-block:: json

        {
          "items": [
            {
              "id": "…uuid…",
              "code": "MA01421",
              "name": "Alex Gummies",
              "project_type": "custom",
              "customer_name": "Alex Ltd",
              "lead_scientist_name": "…" | null,
              "sales_person_name": "…" | null,
              "app_url": "http://localhost:3000/formulations/…"
            }
          ]
        }

    Cross-tenant on purpose — PSP runs one shared production pipeline
    view. If NPD ever becomes multi-tenant with PSP, the caller can
    filter by ``organization`` on its side; this endpoint keeps it
    simple until then.
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def get(self, request: Request) -> Response:
        token = _resolve_token(request)

        # Only ship CUSTOM (customer-driven) formulations to PSP's
        # production pipeline. RTGs are catalog dev — they have no
        # order attached until a customer picks one from the portal
        # and a Proposal is merged as a CustomerOrder (which reaches
        # PSP through the ProposalMerge path, not this mirror). Until
        # then they're pure catalog work with no owner and shouldn't
        # clutter the shop-floor kanban.
        queryset = Formulation.objects.filter(
            project_status=ProjectStatus.IN_DEVELOPMENT,
            project_type=ProjectType.CUSTOM,
        )
        # DB-backed token = scoped to the token's org. Env-var fallback
        # keeps the legacy cross-tenant behaviour so an existing dev
        # setup doesn't lose data on the release that introduces per-
        # org tokens.
        if token is not None:
            queryset = queryset.filter(organization=token.organization)

        formulations = list(
            queryset.select_related("lead_scientist", "sales_person")
            .order_by("-updated_at")
            .only(
                "id",
                "code",
                "name",
                "project_type",
                "lead_scientist_id",
                "sales_person_id",
                "updated_at",
            )
        )

        base_url = str(getattr(settings, "APP_BASE_URL", "") or "").rstrip("/")

        def _full_name(user) -> str | None:
            if user is None:
                return None
            get = getattr(user, "get_full_name", None)
            if callable(get):
                name = (get() or "").strip()
                return name or None
            return None

        items = []
        for f in formulations:
            items.append(
                {
                    "id": str(f.id),
                    "code": f.code or "",
                    "name": f.name or "",
                    "project_type": f.project_type,
                    "lead_scientist_name": _full_name(
                        f.lead_scientist_id and f.lead_scientist
                    ),
                    "sales_person_name": _full_name(
                        f.sales_person_id and f.sales_person
                    ),
                    "updated_at": f.updated_at.isoformat()
                    if f.updated_at
                    else None,
                    "app_url": (
                        f"{base_url}/formulations/{f.id}" if base_url else None
                    ),
                }
            )

        return Response({"items": items}, status=status.HTTP_200_OK)


class LatestSpecSheetHtmlView(APIView):
    """``GET /api/psp-integration/specifications/latest.html?psp_item_uuid=…``.

    Server-renders the latest :class:`SpecificationSheet` for the
    formulation whose :attr:`Formulation.psp_finished_product_uuid`
    matches ``psp_item_uuid``, using the same Django template
    WeasyPrint feeds into for PDF export. Returned as ``text/html``
    for a caller (PSP) to embed in an ``<iframe>``. Because PSP is
    the only caller and it authenticates with the shared integration
    bearer, this bypasses the ``FINAL``-only gate that the customer-
    facing :func:`rotate_public_token` enforces — the render is
    otherwise identical to what NPD shows internally.

    Preference order for picking a sheet:

    1. Latest ``FINAL`` (approved / sent / accepted) — the sheet a
       customer would actually see, priority for QA sign-off comparison.
    2. Latest ``DRAFT`` — for R&D lots QA still needs to compare
       against before a customer sheet exists.

    Returns 404 when the formulation isn't found or has no sheet on
    file. The bearer chain matches :class:`InDevelopmentFormulationsView`.
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def get(self, request: Request) -> HttpResponse:
        token = _resolve_token(request)

        raw_uuid = (request.query_params.get("psp_item_uuid") or "").strip()
        if not raw_uuid:
            raise NotFound("psp_item_uuid_required")

        formulations = Formulation.objects.filter(
            psp_finished_product_uuid=raw_uuid
        )
        if token is not None:
            formulations = formulations.filter(organization=token.organization)

        formulation = formulations.first()
        if formulation is None:
            raise NotFound("formulation_not_found")

        sheets = SpecificationSheet.objects.filter(
            formulation_version__formulation=formulation
        ).select_related("formulation_version", "organization")

        final_sheet = (
            sheets.filter(status__in=("approved", "sent", "accepted"))
            .order_by("-created_at")
            .first()
        )
        chosen = final_sheet or sheets.order_by("-created_at").first()

        if chosen is None:
            raise NotFound("no_spec_sheet")

        html = render_html(chosen)
        response = HttpResponse(html, content_type="text/html; charset=utf-8")
        # Cache: force-fresh; QA needs to see the latest sheet even
        # if the browser has an older render buffered from a peer tab.
        response["Cache-Control"] = "no-store, no-cache, must-revalidate"
        # Allow same-origin iframe embed from the PSP proxy (PSP will
        # serve the HTML from its own origin, so from the browser's
        # perspective this response is same-origin). Belt-and-braces
        # in case a caller ever embeds direct.
        response["X-Frame-Options"] = "SAMEORIGIN"
        return response


class LatestValidationSheetHtmlView(APIView):
    """``GET /api/psp-integration/validations/latest.html?trial_batch=…``.

    PSP mirror of :class:`LatestSpecSheetHtmlView` — returns the
    :class:`ProductValidation` sheet for a given ``trial_batch`` UUID
    (PSP has the trial batch id on the MO, which is the natural key).
    Returned as text/html for PSP to iframe on its Output QC / MO run
    pages alongside the spec sheet.

    Preference order for picking a validation:
    1. Latest ``passed`` — that's the compliance artefact QA cares
       about most.
    2. Latest ``failed`` — surfaces the fail so QA can see why.
    3. Otherwise nothing (404) — an in-progress/draft validation isn't
       meaningful to embed on the PSP QC page yet.

    Bearer chain matches :class:`InDevelopmentFormulationsView`.
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def get(self, request: Request) -> HttpResponse:
        token = _resolve_token(request)

        raw_uuid = (request.query_params.get("trial_batch") or "").strip()
        # ``formulation`` is the pure-formulation fallback: sample MOs
        # spawned from an already-approved RTG have NO
        # ``npd_trial_batch_uuid`` on the PSP side (the RTG's
        # canonical trial batch belongs to a different sample
        # payment) so PSP can't pass a ``trial_batch`` at all. Passing
        # the formulation instead lets NPD resolve "latest passed on
        # ANY trial batch of this formulation" — the compliance
        # artefact QA wants embedded on the QC page.
        raw_formulation = (request.query_params.get("formulation") or "").strip()

        if not raw_uuid and not raw_formulation:
            raise NotFound("trial_batch_or_formulation_required")

        chosen = None

        if raw_uuid:
            validations = ProductValidation.objects.filter(trial_batch_id=raw_uuid)
            if token is not None:
                validations = validations.filter(organization=token.organization)

            passed = (
                validations.filter(status="passed")
                .order_by("-updated_at")
                .first()
            )
            failed = (
                validations.filter(status="failed")
                .order_by("-updated_at")
                .first()
            )
            chosen = passed or failed

            # Formulation-level fallback from a trial-batch lookup —
            # unchanged from the prior behaviour: an in-progress /
            # draft trial batch owned by the same formulation still
            # gets the formulation's canonical passed validation
            # (which is what let this formulation be sampleable in
            # the first place).
            if chosen is None:
                from apps.trial_batches.models import TrialBatch

                formulation_id = (
                    TrialBatch.objects
                    .filter(pk=raw_uuid)
                    .values_list("formulation_version__formulation_id", flat=True)
                    .first()
                )
                if formulation_id:
                    fallback_qs = ProductValidation.objects.filter(
                        trial_batch__formulation_version__formulation_id=formulation_id,
                        status="passed",
                    )
                    if token is not None:
                        fallback_qs = fallback_qs.filter(
                            organization=token.organization
                        )
                    chosen = fallback_qs.order_by("-updated_at").first()

        # Pure-formulation path — used by PSP when the MO has no
        # ``npd_trial_batch_uuid`` (typical for sample MOs of already-
        # approved RTG products). Only ``passed`` at this stage: a
        # stale ``failed`` from a prior batch isn't the compliance
        # evidence PSP needs, and showing it would misrepresent the
        # current formulation as unfit.
        if chosen is None and raw_formulation:
            fallback_qs = ProductValidation.objects.filter(
                trial_batch__formulation_version__formulation_id=raw_formulation,
                status="passed",
            )
            if token is not None:
                fallback_qs = fallback_qs.filter(
                    organization=token.organization
                )
            chosen = fallback_qs.order_by("-updated_at").first()

        if chosen is None:
            raise NotFound("no_validation")

        html = render_validation_html(chosen)
        response = HttpResponse(html, content_type="text/html; charset=utf-8")
        response["Cache-Control"] = "no-store, no-cache, must-revalidate"
        response["X-Frame-Options"] = "SAMEORIGIN"
        return response


class PinManufacturingOrderOnTrialBatchView(APIView):
    """``POST /api/psp-integration/trial-batches/pin-mo/``.

    Called by PSP when its wizard's ``Create MO for line`` fires on a
    sample CO — PSP creates the MO locally and then pings NPD back so
    the corresponding ``TrialBatch.psp_manufacturing_order_uuid`` gets
    pinned. Without this, NPD's trial-batch page shows "No stage chain
    yet — the MO was created but hasn't booked a BOM" for any MO born
    from the PSP wizard button instead of the scientist's own
    "Create MO on PSP" button (which already pins by nature of being
    the caller — it receives the MO uuid in its own response).

    Request body (JSON):

    .. code-block:: json

        {
          "npd_sample_payment_uuid": "<payment uuid = sample CO uuid on PSP>",
          "psp_manufacturing_order_uuid": "<PSP MO uuid to pin>"
        }

    Behaviour:

    * Look up the ``TrialBatch`` where ``source_payment_id`` matches
      the incoming payment uuid.
    * If found → set ``psp_manufacturing_order_uuid`` (idempotent —
      re-pinning the same uuid is a no-op).
    * If not found (NPD hasn't spawned a trial batch yet) → return
      404 quietly so PSP's caller can silent-degrade. NPD will
      surface the MO once the trial batch is created and the
      scientist opens it.

    Auth: same bearer-token flow as the other endpoints in this
    module.
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def post(self, request: Request) -> Response:
        _resolve_token(request)

        payment_id = (request.data.get("npd_sample_payment_uuid") or "").strip()
        mo_uuid = (
            request.data.get("psp_manufacturing_order_uuid") or ""
        ).strip()

        if not payment_id or not mo_uuid:
            return Response(
                {
                    "detail": "npd_sample_payment_uuid and "
                    "psp_manufacturing_order_uuid are required."
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Resolve the payment first so we can hop to its trial batch.
        # Missing payment → 404 (silent-degrade on PSP side).
        payment = (
            Payment.objects.filter(id=payment_id).only("id").first()
        )
        if payment is None:
            return Response(
                {"detail": "payment_not_found"},
                status=status.HTTP_404_NOT_FOUND,
            )

        trial_batch = (
            TrialBatch.objects.filter(source_payment_id=payment.id)
            .order_by("-created_at")
            .first()
        )
        if trial_batch is None:
            # Sample fulfilment queue hasn't spawned a trial batch yet
            # for this payment. Nothing to pin. PSP's caller treats
            # this as a soft failure and moves on.
            return Response(
                {"detail": "trial_batch_not_found"},
                status=status.HTTP_404_NOT_FOUND,
            )

        # Idempotent — re-pinning the same uuid is a no-op. If a
        # different uuid was previously pinned (rare: MO cancelled +
        # recreated), overwrite so NPD reflects the current live MO.
        if str(trial_batch.psp_manufacturing_order_uuid) == mo_uuid:
            return Response(
                {
                    "trial_batch_id": str(trial_batch.id),
                    "psp_manufacturing_order_uuid": mo_uuid,
                    "already_pinned": True,
                },
                status=status.HTTP_200_OK,
            )

        trial_batch.psp_manufacturing_order_uuid = mo_uuid
        trial_batch.save(update_fields=["psp_manufacturing_order_uuid"])

        return Response(
            {
                "trial_batch_id": str(trial_batch.id),
                "psp_manufacturing_order_uuid": mo_uuid,
                "already_pinned": False,
            },
            status=status.HTTP_200_OK,
        )


class PspProductionStatusUpsertView(APIView):
    """``POST /api/psp-integration/production-status/upsert/``.

    PSP fires this on every ``OrderWizard.notify_co_changed`` so the
    portal always reflects the latest phase + sub-stage counters for
    a customer's project — no polling.

    Request body (JSON):

    .. code-block:: json

        {
          "formulation_uuid":       "<npd formulation uuid>",
          "psp_customer_order_uuid": "<psp CO uuid>",
          "phase":                  "in_production",
          "phase_label":            "In production",
          "next_action_title":      "Sessions in flight",
          "next_action_detail":     "Ops has started the manufacturing run.",
          "blocker_count":          0,
          "line_count":             1,
          "mo_count":               1,
          "lines_awaiting_mo":      0,
          "mos_awaiting_po_send":   0,
          "mos_awaiting_delivery":  0,
          "mos_in_production":      1,
          "mos_awaiting_closeout":  0,
          "psp_updated_at":         "2026-08-25T14:12:31Z"
        }

    Behaviour:

    * Look up the ``Formulation`` by uuid. Unknown → 404 (silent-
      degrade on PSP side, sample formulations without a PSP-visible
      NPD record fall here).
    * Upsert a :class:`PspProductionStatus` row keyed on the
      formulation. Idempotent — a re-fire with the same phase but
      updated counters just refreshes the row.

    Auth: same bearer-token flow as the other endpoints in this
    module.
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def post(self, request: Request) -> Response:
        _resolve_token(request)

        formulation_uuid = (request.data.get("formulation_uuid") or "").strip()
        if not formulation_uuid:
            return Response(
                {"detail": "formulation_uuid_required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        formulation = (
            Formulation.objects.filter(id=formulation_uuid).only("id").first()
        )
        if formulation is None:
            return Response(
                {"detail": "formulation_not_found"},
                status=status.HTTP_404_NOT_FOUND,
            )

        from apps.psp.models import PspProductionStatus
        from django.utils.dateparse import parse_datetime

        payload = request.data
        psp_co_uuid = (payload.get("psp_customer_order_uuid") or "").strip() or None
        psp_updated_at_raw = payload.get("psp_updated_at") or ""
        psp_updated_at = (
            parse_datetime(psp_updated_at_raw) if psp_updated_at_raw else None
        )

        def _int(k: str) -> int:
            try:
                return int(payload.get(k, 0) or 0)
            except (TypeError, ValueError):
                return 0

        def _str(k: str, cap: int) -> str:
            v = payload.get(k)
            return str(v)[:cap] if v is not None else ""

        from django.utils import timezone as _tz

        mos = _sanitise_manufacturing_orders(payload.get("manufacturing_orders"))
        routing_request = _sanitise_routing_request(
            payload.get("routing_request")
        )
        dispatch_progress = _sanitise_dispatch_progress(
            payload.get("dispatch_progress")
        )

        row, _created = PspProductionStatus.objects.update_or_create(
            formulation=formulation,
            defaults={
                "psp_customer_order_uuid": psp_co_uuid,
                "phase": _str("phase", 48),
                "phase_label": _str("phase_label", 120),
                "next_action_title": _str("next_action_title", 200),
                "next_action_detail": str(payload.get("next_action_detail") or ""),
                "blocker_count": _int("blocker_count"),
                "line_count": _int("line_count"),
                "mo_count": _int("mo_count"),
                "lines_awaiting_mo": _int("lines_awaiting_mo"),
                "mos_awaiting_po_send": _int("mos_awaiting_po_send"),
                "mos_awaiting_delivery": _int("mos_awaiting_delivery"),
                "mos_in_production": _int("mos_in_production"),
                "mos_awaiting_closeout": _int("mos_awaiting_closeout"),
                "manufacturing_orders": mos,
                "routing_request": routing_request,
                "dispatch_progress": dispatch_progress,
                "psp_updated_at": psp_updated_at,
                "pushed_at": _tz.now(),
            },
        )

        # Portal WebSocket fanout — the customer's project tab
        # invalidates and re-fetches without polling. Silent no-op if
        # Channels isn't wired for this deployment.
        try:
            from apps.client_portal.consumers import (
                broadcast_production_status_changed,
            )

            broadcast_production_status_changed(formulation)
        except Exception:  # noqa: BLE001 — realtime is best-effort
            pass

        return Response(
            {
                "formulation_uuid": str(formulation.id),
                "phase": row.phase,
                "pushed_at": row.pushed_at.isoformat() if row.pushed_at else None,
            },
            status=status.HTTP_200_OK,
        )
