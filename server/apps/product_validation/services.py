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


class TargetsIncomplete(Exception):
    """Raised when ``draft → in_progress`` is attempted while one or
    more target/spec fields (weight target, tolerance, disintegration
    limit / temperature, organoleptic target descriptors) are still
    blank. The scientist has to define the pass/fail criteria BEFORE
    they start recording samples — otherwise there's no yardstick to
    measure against.

    ``missing_fields`` is a list of dot-paths (e.g. ``weight.target_mg``,
    ``organoleptic.target.colour``) so the FE can highlight the
    specific inputs that are still empty.
    """

    code = "targets_incomplete"

    def __init__(self, missing_fields: list[str]) -> None:
        super().__init__(f"missing targets: {', '.join(missing_fields)}")
        self.missing_fields = missing_fields


class SamplesIncomplete(Exception):
    """Raised when ``in_progress → passed`` is attempted while one or
    more sections are still missing samples / actual readings. Passing
    the batch without evidence in every section skips real measurement
    — the RD manager would be signing off on empty test data.

    Same shape as :class:`TargetsIncomplete` so the FE can render both
    the same way (banner + per-field highlights). ``failed`` deliberately
    does NOT trigger this gate — a scientist can fail early on a bad
    weight without also being forced to record disintegration + organoleptic
    samples.
    """

    code = "samples_incomplete"

    def __init__(self, missing_fields: list[str]) -> None:
        super().__init__(f"missing samples: {', '.join(missing_fields)}")
        self.missing_fields = missing_fields


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


def _missing_target_fields(validation: ProductValidation) -> list[str]:
    """Dot-paths of target/spec fields that are still blank.

    Used by the draft → in_progress gate (see :func:`transition_status`)
    and the wizard readiness check. A field counts as ``missing`` when
    it's ``None``, an empty / whitespace-only string, or (for numeric
    fields) can't be coerced to a number.

    Paths mirror the ``ProductValidation`` JSON schema so the FE can
    highlight the specific input without an ad-hoc mapping.
    """

    missing: list[str] = []

    def _numeric_missing(container: dict[str, Any] | None, key: str) -> bool:
        if not isinstance(container, dict):
            return True
        value = container.get(key)
        if value is None or value == "":
            return True
        try:
            float(value)
        except (TypeError, ValueError):
            return True
        return False

    def _string_missing(container: dict[str, Any] | None, key: str) -> bool:
        if not isinstance(container, dict):
            return True
        value = container.get(key)
        return not isinstance(value, str) or value.strip() == ""

    weight = validation.weight_test or {}
    if _numeric_missing(weight, "target_mg"):
        missing.append("weight.target_mg")
    if _numeric_missing(weight, "tolerance_pct"):
        missing.append("weight.tolerance_pct")

    disintegration = validation.disintegration_test or {}
    if _numeric_missing(disintegration, "limit_minutes"):
        missing.append("disintegration.limit_minutes")
    if _numeric_missing(disintegration, "temperature_c"):
        missing.append("disintegration.temperature_c")

    organoleptic = validation.organoleptic_test or {}
    target = organoleptic.get("target") if isinstance(organoleptic, dict) else None
    if _string_missing(target, "colour"):
        missing.append("organoleptic.target.colour")
    if _string_missing(target, "taste"):
        missing.append("organoleptic.target.taste")
    if _string_missing(target, "odour"):
        missing.append("organoleptic.target.odour")

    return missing


def _missing_sample_fields(validation: ProductValidation) -> list[str]:
    """Dot-paths of sample/actual fields that are still blank.

    Used by the ``in_progress → passed`` gate. A section counts as
    complete when:

      * ``weight``          — at least one numeric sample
      * ``disintegration``  — at least one numeric sample
      * ``organoleptic``    — all three actual descriptors filled AND
        the pass/fail toggle explicitly set (not left as ``None``)

    Failing the validation deliberately skips this check — see
    :class:`SamplesIncomplete`.
    """

    missing: list[str] = []

    def _samples_missing(container: dict[str, Any] | None) -> bool:
        if not isinstance(container, dict):
            return True
        samples = container.get("samples") or []
        if not isinstance(samples, list) or len(samples) == 0:
            return True
        # Every sample must be numeric — an empty entry counts as no
        # measurement even though it's in the list.
        for s in samples:
            try:
                float(s)
            except (TypeError, ValueError):
                return True
        return False

    def _string_missing(container: dict[str, Any] | None, key: str) -> bool:
        if not isinstance(container, dict):
            return True
        value = container.get(key)
        return not isinstance(value, str) or value.strip() == ""

    if _samples_missing(validation.weight_test):
        missing.append("weight.samples")
    if _samples_missing(validation.disintegration_test):
        missing.append("disintegration.samples")

    organoleptic = validation.organoleptic_test or {}
    actual = organoleptic.get("actual") if isinstance(organoleptic, dict) else None
    if _string_missing(actual, "colour"):
        missing.append("organoleptic.actual.colour")
    if _string_missing(actual, "taste"):
        missing.append("organoleptic.actual.taste")
    if _string_missing(actual, "odour"):
        missing.append("organoleptic.actual.odour")
    if not isinstance(organoleptic, dict) or organoleptic.get("passed") is None:
        missing.append("organoleptic.passed")

    return missing


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
    # Checklist is retained on the model for historical rows but no
    # longer gates the overall verdict — PSP is the ERP source of
    # truth, so "raw materials / finished product / BOMs" being
    # created is now the outcome of the MO push cascade, not a manual
    # ticklist the scientist rides. Computed for stats-payload back-
    # compat only; not appended to ``section_outcomes``.
    checklist = _compute_checklist(validation.mrpeasy_checklist or {})

    section_outcomes = [
        weight.passed,
        hardness.passed,
        thickness.passed,
        disintegration.passed,
        organoleptic.passed,
    ]

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

    # Gate: draft → in_progress requires the target/spec fields to be
    # defined. Recording samples without a target means there's no
    # pass/fail yardstick, and the scientist could game the verdict
    # by back-filling targets to match samples. The FE walks the
    # scientist through these as a wizard so this gate is normally
    # unreachable via the UI — enforced here for the direct-API path.
    if (
        validation.status == ValidationStatus.DRAFT
        and next_status == ValidationStatus.IN_PROGRESS
    ):
        missing = _missing_target_fields(validation)
        if missing:
            raise TargetsIncomplete(missing)

    # Gate: in_progress → passed requires every section to have
    # samples / actual readings. Signing off "passed" against empty
    # test data is exactly the audit trail failure this system exists
    # to prevent. ``failed`` deliberately skips this gate — see
    # SamplesIncomplete.
    if (
        validation.status == ValidationStatus.IN_PROGRESS
        and next_status == ValidationStatus.PASSED
    ):
        missing = _missing_sample_fields(validation)
        if missing:
            raise SamplesIncomplete(missing)

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

    # Note: we deliberately do NOT auto-create the FINAL spec sheet
    # here anymore. A pass verdict now surfaces a "final spec is
    # available for creation" banner on the project workspace instead
    # (see ``compute_project_overview.final_spec_available``). The
    # banner opens a modal where the scientist explicitly links the
    # trial batch + formulation version — the pair that will be
    # cited on the audit trail as the evidentiary basis for the spec.
    #
    # Rationale: a pass verdict doesn't always mean "we're ready to
    # freeze the recipe". Scientists routinely re-tune the formulation
    # between a passed trial and the FINAL (e.g. tightening a filler
    # ratio after tasting notes). Auto-creating the FINAL on pass
    # pinned it to the trial's version and forced a manual archive
    # cycle to swap it. The explicit-create flow lets them re-run,
    # tweak, and then pick the version + trial they actually want
    # cited on the FINAL.

    # Push the state snapshot to PSP so its Output QC page can (a)
    # flip the status pill from "Not started" → "In progress" the
    # moment the scientist starts, (b) unblock the Pass QC button
    # on ``passed``, or (c) auto-fail the output lot on ``failed``.
    #
    # Swallowed like the spec-sheet auto-create above: the transition
    # is the source of truth; a PSP sync hiccup must not undo it.
    # Missed syncs get picked up next transition (idempotent on PSP).
    if next_status in (
        ValidationStatus.IN_PROGRESS,
        ValidationStatus.PASSED,
        ValidationStatus.FAILED,
    ):
        try:
            _sync_validation_state_to_psp(validation)
        except Exception:  # pragma: no cover - defence in depth
            import logging

            logging.getLogger(__name__).exception(
                "psp trial_validation sync failed for validation %s",
                validation.pk,
            )

    return validation


def _sync_validation_state_to_psp(validation: ProductValidation) -> None:
    """Push the current validation status to PSP's Output QC gate.

    Extracted so tests can patch a single seam. Silently returns when
    the org has no PSP integration or when the validation isn't linked
    to a trial batch (nothing for PSP to key on).
    """

    from apps.psp.services import (
        PspNotConfigured,
        _client_factory,
        get_psp_config,
        is_psp_live,
    )

    trial_batch = getattr(validation, "trial_batch", None)
    if trial_batch is None:
        return

    org = validation.organization
    if not is_psp_live(org):
        return

    try:
        config = get_psp_config(organization=org)
    except PspNotConfigured:
        return
    client = _client_factory(config)

    status = validation.status
    failure_reason = (validation.notes or "").strip() if status == "failed" else None

    client.sync_trial_validation(
        npd_trial_batch_uuid=str(trial_batch.id),
        validation_uuid=str(validation.id),
        status=status,
        failure_reason=failure_reason,
    )


# ---------------------------------------------------------------------------
# Sheet rendering (WeasyPrint HTML + PDF)
# ---------------------------------------------------------------------------


def _fmt_num(value: Any, decimals: int = 2) -> str:
    """Format a numeric value for the sheet. Blank ⇒ ``—``; strips
    trailing zeros so ``1270.00`` becomes ``1270``."""

    if value is None or value == "":
        return "—"
    try:
        n = float(value)
    except (TypeError, ValueError):
        return "—"
    text = f"{n:.{decimals}f}".rstrip("0").rstrip(".")
    return text if text != "-0" else "0"


def build_sheet_context(validation: ProductValidation) -> dict[str, Any]:
    """Assemble the template context for
    ``product_validation/sheet.html``.

    Pure function — no I/O, no side effects. All numeric formatting
    uses ``.`` decimals and no thousands separator to match the
    editor's `formatNumber` on the FE (avoids "1,143 vs 1143"
    confusion in locales that use ``,`` as a decimal mark).
    """

    from apps.audit.models import AuditLog  # local import — avoids app-loading order issues

    stats = compute_stats(validation)

    trial_batch = getattr(validation, "trial_batch", None)
    version = getattr(trial_batch, "formulation_version", None) if trial_batch else None
    formulation = getattr(version, "formulation", None) if version else None

    # Prefer the RTG display name (customer-friendly, e.g. "Vita Gummy
    # Multivitamin") over the internal ``name`` (which is often a
    # code-ish slug like "RTG00001"). Falls back gracefully when the
    # formulation isn't an RTG variant or the field is blank.
    formulation_display = ""
    if formulation is not None:
        display = (getattr(formulation, "rtg_display_name", "") or "").strip()
        formulation_display = display or (formulation.name or "")

    weight_samples_fmt = [_fmt_num(s) for s in stats.weight.samples]
    weight_pass_flags = list(stats.weight.per_sample_passed)
    weight_ctx = {
        "target_mg": _fmt_num(stats.weight.target_mg),
        "tolerance_pct": _fmt_num(stats.weight.tolerance_pct),
        "range_display": (
            f"{_fmt_num(stats.weight.min_allowed_mg)} – {_fmt_num(stats.weight.max_allowed_mg)} mg"
            if stats.weight.min_allowed_mg is not None
            and stats.weight.max_allowed_mg is not None
            else "—"
        ),
        "samples": weight_samples_fmt,
        "per_sample_passed": weight_pass_flags,
        # Pre-zipped rows so the template can iterate ``(value, passed)``
        # pairs without needing an index-by-variable filter (Django's
        # built-in ``|slice`` doesn't accept a loop-var index).
        "sample_rows": [
            {"index": i + 1, "value": v, "passed": bool(p)}
            for i, (v, p) in enumerate(
                zip(weight_samples_fmt, weight_pass_flags)
            )
        ],
        "mean_display": (
            f"{_fmt_num(stats.weight.mean)} mg"
            if stats.weight.mean is not None
            else "—"
        ),
        "stdev_display": (
            f"{_fmt_num(stats.weight.stdev)} mg"
            if stats.weight.stdev is not None
            else "—"
        ),
        "out_of_range_count": sum(
            1 for p in stats.weight.per_sample_passed if not p
        ),
        "passed": stats.weight.passed,
        "notes": (validation.weight_test or {}).get("notes", ""),
    }

    dis_samples_fmt = [_fmt_num(s) for s in stats.disintegration.samples]
    dis_pass_flags = list(stats.disintegration.per_sample_passed)
    disintegration_ctx = {
        "limit_minutes": _fmt_num(stats.disintegration.limit_minutes),
        "temperature_c": _fmt_num(stats.disintegration.temperature_c),
        "samples": dis_samples_fmt,
        "per_sample_passed": dis_pass_flags,
        "sample_rows": [
            {"index": i + 1, "value": v, "passed": bool(p)}
            for i, (v, p) in enumerate(zip(dis_samples_fmt, dis_pass_flags))
        ],
        "worst_display": (
            f"{_fmt_num(stats.disintegration.worst_minutes)} min"
            if stats.disintegration.worst_minutes is not None
            else "—"
        ),
        "passed": stats.disintegration.passed,
        "notes": (validation.disintegration_test or {}).get("notes", ""),
    }

    org = validation.organoleptic_test or {}
    target = org.get("target") or {}
    actual = org.get("actual") or {}
    organoleptic_ctx = {
        "target": {
            "colour": target.get("colour", ""),
            "taste": target.get("taste", ""),
            "odour": target.get("odour", ""),
        },
        "actual": {
            "colour": actual.get("colour", ""),
            "taste": actual.get("taste", ""),
            "odour": actual.get("odour", ""),
        },
        "passed": stats.organoleptic.passed,
        "notes": org.get("notes", ""),
    }

    def _actor(actor: Any, signed_at: Any, signature_image: str) -> dict[str, Any] | None:
        if actor is None or signed_at is None:
            return None
        return {
            "name": (actor.get_full_name() or actor.email or "").strip(),
            "signed_at": signed_at.strftime("%d %b %Y, %H:%M UTC")
            if signed_at
            else "",
            "signature_image": signature_image or "",
        }

    scientist_ctx = _actor(
        validation.scientist_signature,
        validation.scientist_signed_at,
        validation.scientist_signature_image or "",
    )
    rd_manager_ctx = _actor(
        validation.rd_manager_signature,
        validation.rd_manager_signed_at,
        validation.rd_manager_signature_image or "",
    )

    # Change history — every audit row targeted at this validation,
    # newest first. `record_audit` uses ``target_type = "productvalidation"``
    # (model_name of the class); mirror that literal here.
    audit_rows = (
        AuditLog.objects.filter(
            organization=validation.organization,
            target_type="productvalidation",
            target_id=str(validation.pk),
        )
        .select_related("actor")
        .order_by("-created_at")
    )
    history: list[dict[str, Any]] = []
    for row in audit_rows:
        summary_bits: list[str] = []
        if row.action == "product_validation.status_transition":
            before = (row.before or {}).get("status")
            after = (row.after or {}).get("status")
            if before and after:
                summary_bits.append(f"Status: {before} → {after}")
            elif after:
                summary_bits.append(f"Status → {after}")
        else:
            # Fall back to the raw action slug so unknown events
            # still show up rather than silently drop.
            summary_bits.append(row.action)
        actor_name = "System"
        if row.actor is not None:
            actor_name = (
                row.actor.get_full_name() or row.actor.email or "Unknown"
            ).strip()
        history.append(
            {
                "when": row.created_at.strftime("%d %b %Y, %H:%M UTC"),
                "actor_name": actor_name,
                "summary": " · ".join(summary_bits) or "—",
                "notes": "",
            }
        )

    organization_name = ""
    try:
        organization_name = validation.organization.name or ""
    except Exception:  # pragma: no cover
        pass

    return {
        "sheet": {
            "code": (formulation and getattr(formulation, "code", None))
            or "PV",
            "status": validation.status,
        },
        "formulation": {
            "name": formulation_display or "Untitled",
            "version_number": getattr(version, "version_number", 1),
        },
        "trial_batch": {
            "label": getattr(trial_batch, "label", "") or "",
        },
        "weight": weight_ctx,
        "disintegration": disintegration_ctx,
        "organoleptic": organoleptic_ctx,
        "overall_passed": stats.overall_passed,
        "overall_notes": validation.notes or "",
        "scientist": scientist_ctx,
        "rd_manager": rd_manager_ctx,
        "history": history,
        "report_date": timezone.now().strftime("%d %b %Y"),
        "organization_name": organization_name,
    }


def render_validation_html(validation: ProductValidation) -> str:
    """Render the WeasyPrint template to an HTML string. Callers with
    an HTTP response can send the string as-is; the PDF endpoint hands
    it to WeasyPrint for PDF conversion."""

    from django.template.loader import render_to_string

    context = build_sheet_context(validation)
    return render_to_string("product_validation/sheet.html", context)


def render_validation_pdf(validation: ProductValidation) -> tuple[bytes, str]:
    """Render the validation sheet as a PDF. Returns (bytes, filename)
    so the view can set ``Content-Disposition`` without re-deriving
    the code."""

    from weasyprint import HTML  # local import — heavy dependency, keep out of module load

    html_string = render_validation_html(validation)
    pdf_bytes = HTML(string=html_string).write_pdf()

    code_parts: list[str] = []
    trial_batch = getattr(validation, "trial_batch", None)
    if trial_batch is not None:
        version = getattr(trial_batch, "formulation_version", None)
        formulation = getattr(version, "formulation", None) if version else None
        if formulation is not None and formulation.code:
            code_parts.append(formulation.code)
    filename = "-".join(code_parts) if code_parts else "validation"
    return pdf_bytes, f"{filename}-validation.pdf"
