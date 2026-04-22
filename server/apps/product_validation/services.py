"""Service layer for product validation.

The public surface is CRUD + two pure functions: :func:`compute_stats`
turns the raw JSON test blobs into a derived summary (mean, stdev,
per-sample and overall pass/fail), and :func:`empty_tests` returns the
canonical "blank" shape used when a validation is first created.

Nothing here writes derived values back to the model. A future
tolerance tweak should change pass/fail on every rendered validation
without migrating historic rows.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

from django.db import transaction
from django.db.models import QuerySet
from django.utils import timezone

from apps.audit.services import record as record_audit, snapshot
from apps.organizations.models import Organization
from apps.product_validation.models import ProductValidation, ValidationStatus
from apps.trial_batches.models import TrialBatch
from config.signatures import (
    SignatureImageInvalid,
    validate_signature_image,
)


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class ValidationNotFound(Exception):
    code = "validation_not_found"


class TrialBatchNotInOrg(Exception):
    """Tried to attach a validation to a batch that belongs to a
    different organisation. Loud failure — cross-tenant leaks are
    never silently accepted."""

    code = "trial_batch_not_in_org"


class ValidationAlreadyExists(Exception):
    """Each trial batch carries at most one validation. A second
    create call surfaces this rather than silently returning the
    existing row — the caller should use :func:`get_validation` for
    that path."""

    code = "validation_already_exists"


class InvalidValidationTransition(Exception):
    code = "invalid_validation_transition"


class SignatureRequired(Exception):
    """Raised when a transition that demands a captured signature is
    attempted without one."""

    code = "signature_required"


#: Permissible moves through the validation lifecycle. Kept explicit
#: (rather than "any transition to any state") so a misclick in the
#: UI cannot mark a validation as ``passed`` straight from ``draft``
#: without having to first advance through ``in_progress``.
ALLOWED_TRANSITIONS: dict[str, frozenset[str]] = {
    ValidationStatus.DRAFT: frozenset({ValidationStatus.IN_PROGRESS}),
    ValidationStatus.IN_PROGRESS: frozenset(
        {
            ValidationStatus.PASSED,
            ValidationStatus.FAILED,
            ValidationStatus.DRAFT,
        }
    ),
    ValidationStatus.PASSED: frozenset({ValidationStatus.IN_PROGRESS}),
    ValidationStatus.FAILED: frozenset({ValidationStatus.IN_PROGRESS}),
}


# ---------------------------------------------------------------------------
# Canonical blank test shapes
# ---------------------------------------------------------------------------


def _empty_weight_test() -> dict[str, Any]:
    return {
        "target_mg": None,
        "tolerance_pct": 10,
        "samples": [],
        "notes": "",
    }


def _empty_hardness_test() -> dict[str, Any]:
    return {
        "target_min_n": None,
        "target_max_n": None,
        "samples": [],
        "notes": "",
    }


def _empty_thickness_test() -> dict[str, Any]:
    return {
        "target_mm": None,
        "tolerance_mm": None,
        "samples": [],
        "notes": "",
    }


def _empty_disintegration_test() -> dict[str, Any]:
    return {
        "limit_minutes": 60,
        "temperature_c": 37,
        "samples": [],
        "notes": "",
    }


def _empty_organoleptic_test() -> dict[str, Any]:
    return {
        "target": {"colour": "", "taste": "", "odour": ""},
        "actual": {"colour": "", "taste": "", "odour": ""},
        "passed": None,
        "notes": "",
    }


def _empty_mrpeasy_checklist() -> dict[str, Any]:
    return {
        "raw_materials_created": False,
        "finished_product_created": False,
        "boms_verified": False,
    }


def empty_tests() -> dict[str, dict[str, Any]]:
    """Return the canonical blank shape for every JSON field on
    :class:`ProductValidation`. Used at creation time so a
    newly-opened validation already has a populated form skeleton
    rather than a grab-bag of ``None`` values."""

    return {
        "weight_test": _empty_weight_test(),
        "hardness_test": _empty_hardness_test(),
        "thickness_test": _empty_thickness_test(),
        "disintegration_test": _empty_disintegration_test(),
        "organoleptic_test": _empty_organoleptic_test(),
        "mrpeasy_checklist": _empty_mrpeasy_checklist(),
    }


# ---------------------------------------------------------------------------
# Stats — pure functions over the JSON blobs
# ---------------------------------------------------------------------------


@dataclass
class WeightStats:
    target_mg: float | None
    tolerance_pct: float
    min_allowed_mg: float | None
    max_allowed_mg: float | None
    samples: list[float]
    per_sample_passed: list[bool]
    mean: float | None
    stdev: float | None
    passed: bool | None


@dataclass
class HardnessStats:
    target_min_n: float | None
    target_max_n: float | None
    samples: list[float]
    per_sample_passed: list[bool]
    mean: float | None
    stdev: float | None
    passed: bool | None


@dataclass
class ThicknessStats:
    target_mm: float | None
    tolerance_mm: float | None
    min_allowed_mm: float | None
    max_allowed_mm: float | None
    samples: list[float]
    per_sample_passed: list[bool]
    mean: float | None
    stdev: float | None
    passed: bool | None


@dataclass
class DisintegrationStats:
    limit_minutes: float | None
    temperature_c: float | None
    samples: list[float]
    per_sample_passed: list[bool]
    worst_minutes: float | None
    passed: bool | None


@dataclass
class OrganolepticStats:
    target: dict[str, str]
    actual: dict[str, str]
    passed: bool | None


@dataclass
class ChecklistStats:
    raw_materials_created: bool
    finished_product_created: bool
    boms_verified: bool
    passed: bool


@dataclass
class ValidationStats:
    weight: WeightStats
    hardness: HardnessStats
    thickness: ThicknessStats
    disintegration: DisintegrationStats
    organoleptic: OrganolepticStats
    checklist: ChecklistStats
    #: ``True`` when every applicable test has passed; ``False`` when
    #: any test that has data has failed; ``None`` when the scientist
    #: has not entered enough data to judge either way.
    overall_passed: bool | None


def _coerce_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        trimmed = value.strip().replace(",", ".")
        if not trimmed:
            return None
        try:
            return float(Decimal(trimmed))
        except (InvalidOperation, ValueError):
            return None
    return None


def _coerce_samples(raw: Any) -> list[float]:
    if not isinstance(raw, (list, tuple)):
        return []
    out: list[float] = []
    for item in raw:
        parsed = _coerce_float(item)
        if parsed is not None:
            out.append(parsed)
    return out


def _mean(samples: list[float]) -> float | None:
    if not samples:
        return None
    return statistics.fmean(samples)


def _stdev(samples: list[float]) -> float | None:
    # Use population stdev (pstdev) rather than sample stdev so a
    # single-sample batch does not raise; more importantly, in QC
    # context we treat the sample set as the full population of the
    # batch rather than drawing inference about an unseen mean.
    if len(samples) < 1:
        return None
    return statistics.pstdev(samples)


def _compute_weight(blob: dict[str, Any]) -> WeightStats:
    target = _coerce_float(blob.get("target_mg"))
    tol_pct = _coerce_float(blob.get("tolerance_pct")) or 0.0
    samples = _coerce_samples(blob.get("samples"))

    min_allowed: float | None = None
    max_allowed: float | None = None
    if target is not None and tol_pct > 0:
        band = target * tol_pct / 100.0
        min_allowed = target - band
        max_allowed = target + band

    per_sample: list[bool] = []
    for sample in samples:
        if min_allowed is None or max_allowed is None:
            per_sample.append(False)
        else:
            per_sample.append(min_allowed <= sample <= max_allowed)

    if not samples or target is None:
        passed: bool | None = None
    else:
        passed = all(per_sample)

    return WeightStats(
        target_mg=target,
        tolerance_pct=tol_pct,
        min_allowed_mg=min_allowed,
        max_allowed_mg=max_allowed,
        samples=samples,
        per_sample_passed=per_sample,
        mean=_mean(samples),
        stdev=_stdev(samples),
        passed=passed,
    )


def _compute_hardness(blob: dict[str, Any]) -> HardnessStats:
    target_min = _coerce_float(blob.get("target_min_n"))
    target_max = _coerce_float(blob.get("target_max_n"))
    samples = _coerce_samples(blob.get("samples"))

    per_sample: list[bool] = []
    for sample in samples:
        if target_min is None or target_max is None:
            per_sample.append(False)
        else:
            per_sample.append(target_min <= sample <= target_max)

    if not samples or target_min is None or target_max is None:
        passed: bool | None = None
    else:
        passed = all(per_sample)

    return HardnessStats(
        target_min_n=target_min,
        target_max_n=target_max,
        samples=samples,
        per_sample_passed=per_sample,
        mean=_mean(samples),
        stdev=_stdev(samples),
        passed=passed,
    )


def _compute_thickness(blob: dict[str, Any]) -> ThicknessStats:
    target = _coerce_float(blob.get("target_mm"))
    tolerance = _coerce_float(blob.get("tolerance_mm"))
    samples = _coerce_samples(blob.get("samples"))

    min_allowed: float | None = None
    max_allowed: float | None = None
    if target is not None and tolerance is not None:
        min_allowed = target - tolerance
        max_allowed = target + tolerance

    per_sample: list[bool] = []
    for sample in samples:
        if min_allowed is None or max_allowed is None:
            per_sample.append(False)
        else:
            per_sample.append(min_allowed <= sample <= max_allowed)

    if not samples or target is None or tolerance is None:
        passed: bool | None = None
    else:
        passed = all(per_sample)

    return ThicknessStats(
        target_mm=target,
        tolerance_mm=tolerance,
        min_allowed_mm=min_allowed,
        max_allowed_mm=max_allowed,
        samples=samples,
        per_sample_passed=per_sample,
        mean=_mean(samples),
        stdev=_stdev(samples),
        passed=passed,
    )


def _compute_disintegration(blob: dict[str, Any]) -> DisintegrationStats:
    limit = _coerce_float(blob.get("limit_minutes"))
    temperature = _coerce_float(blob.get("temperature_c"))
    samples = _coerce_samples(blob.get("samples"))

    per_sample: list[bool] = []
    for sample in samples:
        if limit is None:
            per_sample.append(False)
        else:
            per_sample.append(sample <= limit)

    worst = max(samples) if samples else None

    if not samples or limit is None:
        passed: bool | None = None
    else:
        passed = all(per_sample)

    return DisintegrationStats(
        limit_minutes=limit,
        temperature_c=temperature,
        samples=samples,
        per_sample_passed=per_sample,
        worst_minutes=worst,
        passed=passed,
    )


def _compute_organoleptic(blob: dict[str, Any]) -> OrganolepticStats:
    target = blob.get("target") or {}
    actual = blob.get("actual") or {}
    passed = blob.get("passed")
    if not isinstance(passed, bool):
        passed = None
    return OrganolepticStats(
        target={
            "colour": str(target.get("colour", "") or ""),
            "taste": str(target.get("taste", "") or ""),
            "odour": str(target.get("odour", "") or ""),
        },
        actual={
            "colour": str(actual.get("colour", "") or ""),
            "taste": str(actual.get("taste", "") or ""),
            "odour": str(actual.get("odour", "") or ""),
        },
        passed=passed,
    )


def _compute_checklist(blob: dict[str, Any]) -> ChecklistStats:
    raw = bool(blob.get("raw_materials_created"))
    finished = bool(blob.get("finished_product_created"))
    boms = bool(blob.get("boms_verified"))
    return ChecklistStats(
        raw_materials_created=raw,
        finished_product_created=finished,
        boms_verified=boms,
        passed=raw and finished and boms,
    )


def compute_stats(validation: ProductValidation) -> ValidationStats:
    """Derive the full stats block from the validation's JSON fields.

    Safe to call on a freshly-created validation — every section
    degrades to ``passed=None`` when the scientist hasn't entered
    enough data yet. ``overall_passed`` rolls up in the same way:
    ``True`` only when every section with data has passed, ``False``
    when any section with data has failed, ``None`` otherwise.
    """

    weight = _compute_weight(validation.weight_test or {})
    hardness = _compute_hardness(validation.hardness_test or {})
    thickness = _compute_thickness(validation.thickness_test or {})
    disintegration = _compute_disintegration(
        validation.disintegration_test or {}
    )
    organoleptic = _compute_organoleptic(validation.organoleptic_test or {})
    checklist = _compute_checklist(validation.mrpeasy_checklist or {})

    section_outcomes = [
        weight.passed,
        hardness.passed,
        thickness.passed,
        disintegration.passed,
        organoleptic.passed,
    ]
    # Fold the checklist in as a required gate — the batch cannot pass
    # until its ERP wiring is confirmed, so any missing checkbox is a
    # fail. Represent it as ``True``/``False`` (never ``None``) since
    # the checkboxes always carry a value.
    section_outcomes.append(checklist.passed)

    resolved = [o for o in section_outcomes if o is not None]
    if not resolved:
        overall: bool | None = None
    elif any(o is False for o in resolved):
        overall = False
    elif all(o is True for o in resolved):
        overall = True
    else:
        overall = None

    return ValidationStats(
        weight=weight,
        hardness=hardness,
        thickness=thickness,
        disintegration=disintegration,
        organoleptic=organoleptic,
        checklist=checklist,
        overall_passed=overall,
    )


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


def list_validations(
    *,
    organization: Organization,
    formulation_id: Any | None = None,
) -> QuerySet[ProductValidation]:
    """List validations newest-first, optionally scoped to one
    formulation. The workspace's QC tab filters by
    ``formulation_id``; the global list omits it."""

    queryset = ProductValidation.objects.filter(organization=organization)
    if formulation_id is not None:
        queryset = queryset.filter(
            trial_batch__formulation_version__formulation_id=formulation_id
        )
    return queryset.select_related(
        "trial_batch__formulation_version__formulation",
        "created_by",
        "scientist_signature",
        "rd_manager_signature",
    ).order_by("-updated_at")


def get_validation(
    *, organization: Organization, validation_id: Any
) -> ProductValidation:
    validation = (
        ProductValidation.objects.select_related(
            "trial_batch__formulation_version__formulation",
            "created_by",
            "updated_by",
            "scientist_signature",
            "rd_manager_signature",
        )
        .filter(organization=organization, id=validation_id)
        .first()
    )
    if validation is None:
        raise ValidationNotFound()
    return validation


def get_validation_for_batch(
    *, organization: Organization, batch_id: Any
) -> ProductValidation | None:
    """Return the batch's validation if one exists; ``None`` otherwise.

    Unlike :func:`get_validation`, this one does **not** raise — the
    frontend uses it to decide between "open existing" and "start
    new" on the trial-batch detail page, and both outcomes are
    normal.
    """

    return (
        ProductValidation.objects.select_related(
            "trial_batch__formulation_version__formulation",
            "created_by",
            "updated_by",
            "scientist_signature",
            "rd_manager_signature",
        )
        .filter(organization=organization, trial_batch_id=batch_id)
        .first()
    )


@transaction.atomic
def create_validation(
    *,
    organization: Organization,
    actor: Any,
    trial_batch_id: Any,
    notes: str = "",
) -> ProductValidation:
    batch = (
        TrialBatch.objects.select_related("organization")
        .filter(id=trial_batch_id)
        .first()
    )
    if batch is None or batch.organization_id != organization.id:
        raise TrialBatchNotInOrg()

    existing = ProductValidation.objects.filter(
        organization=organization, trial_batch=batch
    ).first()
    if existing is not None:
        raise ValidationAlreadyExists()

    blanks = empty_tests()
    validation = ProductValidation.objects.create(
        organization=organization,
        trial_batch=batch,
        notes=notes,
        status=ValidationStatus.DRAFT,
        created_by=actor,
        updated_by=actor,
        **blanks,
    )
    record_audit(
        organization=organization,
        actor=actor,
        action="product_validation.create",
        target=validation,
        after={
            "id": str(validation.pk),
            "trial_batch_id": str(batch.pk),
            "status": validation.status,
        },
    )
    return validation


#: Top-level fields a PATCH payload may update. The JSON test blobs
#: are overwritten wholesale on update — the caller sends the full
#: list of samples, we don't merge with the previous version. This
#: keeps the UX obvious (what you see on the form is what's stored)
#: and avoids subtle merge bugs when a row is removed.
_MUTABLE_FIELDS: frozenset[str] = frozenset(
    {
        "weight_test",
        "hardness_test",
        "thickness_test",
        "disintegration_test",
        "organoleptic_test",
        "mrpeasy_checklist",
        "notes",
    }
)


@transaction.atomic
def update_validation(
    *,
    validation: ProductValidation,
    actor: Any,
    **changes: Any,
) -> ProductValidation:
    touched: list[str] = []
    for key, value in changes.items():
        if key in _MUTABLE_FIELDS and value is not None:
            setattr(validation, key, value)
            touched.append(key)

    validation.updated_by = actor
    validation.save()
    record_audit(
        organization=validation.organization,
        actor=actor,
        action="product_validation.update",
        target=validation,
        after={"touched_fields": touched, "status": validation.status},
    )
    return validation


@transaction.atomic
def transition_status(
    *,
    validation: ProductValidation,
    actor: Any,
    next_status: str,
    signature_image: str | None = None,
) -> ProductValidation:
    """Move the validation between lifecycle states.

    Transitions that produce a sign-off require a drawn signature to
    be submitted alongside the status change:

    * ``draft → in_progress`` demands the scientist's signature.
    * ``in_progress → passed`` and ``in_progress → failed`` both
      demand the R&D manager's signature.

    The signature image is a base64 PNG the client captures on the
    signature pad; it is validated by :func:`validate_signature_image`
    before being stored. Rewinding transitions (anything back to
    ``draft`` or back to ``in_progress``) keep the historical
    signatures intact — the audit log cares about who signed and
    when, not who un-signed.

    Same-state transitions are no-ops so a misclick on the advance
    button does not re-stamp a different actor over an earlier
    sign-off.
    """

    if next_status == validation.status:
        return validation

    allowed = ALLOWED_TRANSITIONS.get(validation.status, frozenset())
    if next_status not in allowed:
        raise InvalidValidationTransition()

    scientist_sign = (
        next_status == ValidationStatus.IN_PROGRESS
        and validation.status == ValidationStatus.DRAFT
    )
    manager_sign = next_status in (
        ValidationStatus.PASSED,
        ValidationStatus.FAILED,
    )

    normalised_image: str | None = None
    if scientist_sign or manager_sign:
        try:
            normalised_image = validate_signature_image(signature_image)
        except SignatureImageInvalid as exc:
            raise SignatureRequired() from exc

    previous_status = validation.status
    now = timezone.now()
    update_fields = ["status", "updated_by", "updated_at"]

    validation.status = next_status

    if scientist_sign:
        validation.scientist_signature = actor
        validation.scientist_signed_at = now
        validation.scientist_signature_image = normalised_image or ""
        update_fields += [
            "scientist_signature",
            "scientist_signed_at",
            "scientist_signature_image",
        ]

    if manager_sign:
        validation.rd_manager_signature = actor
        validation.rd_manager_signed_at = now
        validation.rd_manager_signature_image = normalised_image or ""
        update_fields += [
            "rd_manager_signature",
            "rd_manager_signed_at",
            "rd_manager_signature_image",
        ]

    validation.updated_by = actor
    validation.save(update_fields=update_fields)
    record_audit(
        organization=validation.organization,
        actor=actor,
        action="product_validation.status_transition",
        target=validation,
        before={"status": previous_status},
        after={"status": next_status},
    )
    return validation
