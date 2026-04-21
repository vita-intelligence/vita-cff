"""Service layer for the formulations app.

The *pure* functions :func:`compute_line` and :func:`compute_totals`
mirror the Valley Low Fat Burner workbook's formulas line-for-line:

* ``compute_line`` is the Table3 ``mg/serving`` cascade:
  botanical → ``label_claim / extract_ratio``; everything else →
  ``label_claim / purity`` optionally scaled by overage.
* ``compute_totals`` is the ``Capsule Total Weight`` / ``Tablet Total
  Weight`` block plus the three traffic-light checks.

Every other function in this module is orchestration: CRUD on the
formulation workspace, version snapshotting, rollback.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable

from django.db import transaction
from django.db.models import Max, QuerySet

from apps.audit.services import record as record_audit, snapshot
from apps.catalogues.models import Catalogue, Item, RAW_MATERIALS_SLUG
from apps.formulations.constants import (
    AMINO_ACID_GROUPS,
    AMINO_ACID_KEYS,
    CAPSULE_MG_STEARATE_PCT,
    CAPSULE_SHELL_LABEL,
    CAPSULE_SILICA_PCT,
    CAPSULE_SIZES,
    COMPLIANCE_FLAGS,
    DosageForm,
    EXCIPIENT_LABEL_ANTICAKING,
    EXCIPIENT_LABEL_DCP,
    EXCIPIENT_LABEL_MCC,
    NUTRITION_KEYS,
    TABLET_DCP_PCT,
    TABLET_MCC_PCT,
    TABLET_MG_STEARATE_PCT,
    TABLET_SILICA_PCT,
    TABLET_SIZES,
    auto_pick_capsule_size,
    capsule_size_by_key,
    normalize_compliance_value,
    tablet_size_by_key,
)
from apps.formulations.models import (
    Formulation,
    FormulationLine,
    FormulationVersion,
)
from apps.organizations.models import Membership, Organization


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class FormulationNotFound(Exception):
    code = "formulation_not_found"


class FormulationCodeConflict(Exception):
    code = "formulation_code_conflict"


class FormulationVersionNotFound(Exception):
    code = "formulation_version_not_found"


class InvalidDosageForm(Exception):
    code = "invalid_dosage_form"


class InvalidCapsuleSize(Exception):
    code = "invalid_capsule_size"


class InvalidTabletSize(Exception):
    code = "invalid_tablet_size"


class RawMaterialNotInOrg(Exception):
    """Raised when a formulation line targets an item outside the
    organization's ``raw_materials`` catalogue."""

    code = "raw_material_not_in_org"


class SalesPersonNotMember(Exception):
    """Candidate user is not a member of the formulation's organization.

    Guards against cross-tenant user references: an attacker who
    guessed a valid user UUID from another tenant must not be able
    to attach them to a project they do not belong to.
    """

    code = "sales_person_not_member"


# ---------------------------------------------------------------------------
# Line math — ``Table3[mg/serving]`` in Excel
# ---------------------------------------------------------------------------


def _coerce_float(value: Any) -> float | None:
    """Parse an attribute value into a float, returning ``None`` when
    the value is missing, blank, or not a number.

    Necessary because the raw materials catalogue stores numeric
    columns (``purity``, ``nrv_mg``) as text — some source rows are
    ``N/A`` and the import auto-sniffed the column as text.
    """

    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        trimmed = value.strip()
        if not trimmed:
            return None
        try:
            return float(Decimal(trimmed))
        except (InvalidOperation, ValueError):
            return None
    return None


def _is_botanical(item: Item) -> bool:
    raw = (item.attributes or {}).get("type")
    if not isinstance(raw, str):
        return False
    return raw.strip().lower() == "botanical"


def compute_line(
    *,
    item: Item,
    label_claim_mg: Decimal | float,
    serving_size: int = 1,
) -> Decimal | None:
    """Compute the raw-powder mg/serving for a single ingredient line.

    Returns ``None`` when the line cannot be computed — specifically:

    * ``label_claim_mg`` is zero or negative (caller should surface a
      validation error rather than hide it as ``None``), OR
    * the item is tagged non-botanical but has no parseable ``purity``,
      OR
    * the item is tagged botanical but has no parseable ``extract_ratio``.

    ``serving_size`` divides the label claim before the purity /
    extract-ratio scaling, matching the workbook's ``label_claim /
    serving_size`` intermediate column.
    """

    claim = float(label_claim_mg)
    if claim <= 0:
        return None
    if serving_size <= 0:
        return None

    per_unit_claim = claim / serving_size
    attributes = item.attributes or {}

    if _is_botanical(item):
        extract_ratio = _coerce_float(attributes.get("extract_ratio"))
        if extract_ratio is None or extract_ratio <= 0:
            return None
        raw_mg = per_unit_claim / extract_ratio
    else:
        purity = _coerce_float(attributes.get("purity"))
        if purity is None or purity <= 0:
            return None
        raw_mg = per_unit_claim / purity
        overage = _coerce_float(attributes.get("overage"))
        if overage is not None and overage > 0:
            raw_mg = raw_mg + (raw_mg * overage)

    # Quantise to the same 4-decimal precision as the DB column, which
    # matches the workbook's displayed precision for mg/serving values.
    return Decimal(str(raw_mg)).quantize(Decimal("0.0001"))


# ---------------------------------------------------------------------------
# Totals + viability — ``Capsule Total Weight`` / ``Tablet Total Weight``
# ---------------------------------------------------------------------------


@dataclass
class ExcipientBreakdown:
    mg_stearate_mg: Decimal
    silica_mg: Decimal
    mcc_mg: Decimal
    dcp_mg: Decimal | None = None  # tablet-only


@dataclass
class ViabilityResult:
    #: ``CAN MAKE`` when the target form's max weight covers the total;
    #: ``CANNOT MAKE`` when it doesn't.
    fits: bool
    #: ``LESS CHALLENGING`` when the excipient headroom is comfortable.
    #: Capsule rule: MCC remaining ≥ 1% of total active. Tablet rule:
    #: total weight ≤ 75% of the selected tablet's max fill weight.
    comfort_ok: bool
    #: Machine-readable codes the UI translates to locale copy.
    codes: tuple[str, ...]


@dataclass
class FormulationTotals:
    total_active_mg: Decimal
    dosage_form: str
    #: Selected size key (auto-picked when the scientist left it blank).
    size_key: str | None
    size_label: str | None
    max_weight_mg: Decimal | None
    total_weight_mg: Decimal | None
    excipients: ExcipientBreakdown | None
    viability: ViabilityResult
    #: Per-line computed mg/serving values, keyed by the caller's own
    #: stable identifier so the UI can reconcile them to the source row
    #: without relying on ordering.
    line_values: dict[str, Decimal] = field(default_factory=dict)
    warnings: tuple[str, ...] = ()


@dataclass
class ComplianceFlagResult:
    """Aggregate answer for a single compliance flag (vegan, organic,
    halal, kosher) across every ingredient in the formulation."""

    key: str
    label: str
    #: ``True`` when every ingredient is confidently compliant;
    #: ``False`` when at least one ingredient is confidently
    #: non-compliant; ``None`` when there are no confident-compliant
    #: answers to aggregate (entire formulation missing data).
    status: bool | None
    #: Number of ingredients the catalogue flags as compliant.
    compliant_count: int
    #: Number of ingredients the catalogue flags as non-compliant.
    non_compliant_count: int
    #: Number of ingredients where the catalogue did not record a
    #: value — these do not taint the product but mean the answer is
    #: held with reduced confidence. Separate count so the UI can
    #: show a faded/tentative chip instead of a confident one.
    unknown_count: int


@dataclass
class ComplianceResult:
    flags: tuple[ComplianceFlagResult, ...]


@dataclass
class NutrientAggregate:
    """Per-nutrient aggregation for the spec sheet's nutrition panel.

    ``per_serving`` and ``per_100g`` live alongside the raw sum so the
    sheet can display both columns. ``contributors`` is the count of
    ingredients that actually had catalogue data for this nutrient —
    surfaces to the UI as a small "based on N of M ingredients" hint,
    so a half-filled catalogue does not look like a confident zero.
    """

    key: str
    per_serving: Decimal
    per_100g: Decimal
    contributors: int


@dataclass
class AminoAcidGroup:
    key: str
    acids: tuple[NutrientAggregate, ...]


@dataclass
class IngredientDeclarationEntry:
    """Per-row detail for the ingredient declaration string.

    Exposed alongside the joined string so the UI can render a table
    (line + weight + "appears as" label) when the scientist wants to
    sanity-check the label copy before the spec sheet exports it.
    """

    label: str
    mg: Decimal
    #: ``"active" | "excipient" | "shell"`` — lets the UI badge each
    #: row differently.
    category: str
    #: ``True`` when this row's source catalogue item is flagged as an
    #: allergen. The spec sheet uses this to render the ingredient's
    #: name in bold inside the declaration paragraph, per EU labelling
    #: requirement 1169/2011 art. 21 (the workbook matches this by
    #: manually bolding allergens; we do it with ``<strong>`` tags).
    is_allergen: bool = False
    #: The allergen class reported by the catalogue (``"Milk"``,
    #: ``"Soybeans"``, etc.). Blank when ``is_allergen`` is ``False``.
    allergen_source: str = ""


@dataclass
class FormulationAllergens:
    """Aggregate allergen picture for one formulation version.

    ``sources`` is the comma-sorted list of distinct allergen classes
    across every active ingredient (e.g. ``["Milk", "Soy"]``). Empty
    when the product has no allergenic ingredients — the spec sheet
    suppresses the Allergens line entirely in that case, matching
    the workbook's ``IF(T10=0, "", "Allergen:")`` convention.
    """

    sources: tuple[str, ...]
    #: Raw count of actives flagged as allergens. Usually equals
    #: ``len(sources)`` but can exceed it when two ingredients share
    #: the same source (e.g. two different milk proteins).
    allergen_count: int


def _quantise(value: float) -> Decimal:
    return Decimal(str(value)).quantize(Decimal("0.0001"))


def _empty_viability() -> ViabilityResult:
    return ViabilityResult(
        fits=False, comfort_ok=False, codes=("more_info_required",)
    )


def _compute_capsule(
    total_active: Decimal,
    requested_size_key: str | None,
) -> tuple[
    str | None, str | None, Decimal | None, Decimal | None,
    ExcipientBreakdown | None, ViabilityResult, tuple[str, ...],
]:
    warnings: list[str] = []

    if requested_size_key:
        size = capsule_size_by_key(requested_size_key)
        if size is None:
            raise InvalidCapsuleSize()
    else:
        size = auto_pick_capsule_size(float(total_active))
        if size is None:
            warnings.append("capsule_too_large")

    if size is None:
        # Cannot make — total active exceeds every auto-pickable size.
        return (
            None,
            None,
            None,
            None,
            None,
            ViabilityResult(
                fits=False,
                comfort_ok=False,
                codes=("cannot_make",),
            ),
            tuple(warnings),
        )

    stearate = float(total_active) * CAPSULE_MG_STEARATE_PCT
    silica = float(total_active) * CAPSULE_SILICA_PCT
    mcc = size.max_weight_mg - float(total_active) - stearate - silica
    # Total weight is defined as sum(active, excipients). When MCC is
    # positive this equals max_weight by construction. When MCC would
    # go negative (active + excipients overshoot max) the totals block
    # still reports the true sum so viability can flag "CANNOT MAKE".
    total_weight = float(total_active) + stearate + silica + max(mcc, 0.0)
    if mcc < 0:
        total_weight = float(total_active) + stearate + silica

    fits = size.max_weight_mg >= total_weight
    comfort_ok = fits and mcc >= (float(total_active) * 0.01)
    codes: list[str] = []
    if not fits:
        codes.append("cannot_make")
    else:
        codes.append("can_make")
        if comfort_ok:
            codes.extend(("less_challenging", "proceed_to_quote"))
        else:
            codes.extend(("more_challenging_to_make", "consult_r_and_d"))

    excipients = ExcipientBreakdown(
        mg_stearate_mg=_quantise(stearate),
        silica_mg=_quantise(silica),
        mcc_mg=_quantise(mcc),
    )

    return (
        size.key,
        size.label,
        _quantise(size.max_weight_mg),
        _quantise(total_weight),
        excipients,
        ViabilityResult(fits=fits, comfort_ok=comfort_ok, codes=tuple(codes)),
        tuple(warnings),
    )


def _compute_tablet(
    total_active: Decimal,
    requested_size_key: str | None,
) -> tuple[
    str | None, str | None, Decimal | None, Decimal | None,
    ExcipientBreakdown | None, ViabilityResult, tuple[str, ...],
]:
    active = float(total_active)
    stearate = active * TABLET_MG_STEARATE_PCT
    silica = active * TABLET_SILICA_PCT
    dcp = active * TABLET_DCP_PCT
    mcc = active * TABLET_MCC_PCT
    total_weight = active + stearate + silica + dcp + mcc

    excipients = ExcipientBreakdown(
        mg_stearate_mg=_quantise(stearate),
        silica_mg=_quantise(silica),
        mcc_mg=_quantise(mcc),
        dcp_mg=_quantise(dcp),
    )

    if not requested_size_key:
        # No tablet size chosen → we can still report the weight block
        # but viability is unknown. Caller surfaces as "select a size".
        return (
            None,
            None,
            None,
            _quantise(total_weight),
            excipients,
            ViabilityResult(
                fits=False, comfort_ok=False, codes=("tablet_size_required",)
            ),
            (),
        )

    size = tablet_size_by_key(requested_size_key)
    if size is None:
        raise InvalidTabletSize()

    fits = size.max_weight_mg >= total_weight
    comfort_ok = fits and total_weight <= (size.max_weight_mg * 0.75)
    codes: list[str] = []
    if not fits:
        codes.append("cannot_make")
    else:
        codes.append("can_make")
        if comfort_ok:
            codes.extend(("less_challenging", "proceed_to_quote"))
        else:
            codes.extend(("more_challenging_to_make", "consult_r_and_d"))

    return (
        size.key,
        size.label,
        _quantise(size.max_weight_mg),
        _quantise(total_weight),
        excipients,
        ViabilityResult(fits=fits, comfort_ok=comfort_ok, codes=tuple(codes)),
        (),
    )


def compute_totals(
    *,
    lines: Iterable[tuple[str, Item, Decimal | float, int | None]],
    dosage_form: str,
    capsule_size_key: str | None = None,
    tablet_size_key: str | None = None,
    default_serving_size: int = 1,
) -> FormulationTotals:
    """Compute the full totals block for a formulation.

    ``lines`` is an iterable of ``(external_id, item, label_claim_mg,
    serving_size_override)`` tuples. ``external_id`` is opaque to this
    function and just flows through to ``FormulationTotals.line_values``
    so callers can key the computed mg values back to their own rows.
    """

    total_active = Decimal("0")
    line_values: dict[str, Decimal] = {}

    for external_id, item, label_claim, override in lines:
        mg = compute_line(
            item=item,
            label_claim_mg=label_claim,
            serving_size=override if override is not None else default_serving_size,
        )
        if mg is not None:
            line_values[external_id] = mg
            total_active += mg

    total_active = total_active.quantize(Decimal("0.0001"))

    if total_active <= 0:
        return FormulationTotals(
            total_active_mg=total_active,
            dosage_form=dosage_form,
            size_key=None,
            size_label=None,
            max_weight_mg=None,
            total_weight_mg=None,
            excipients=None,
            viability=_empty_viability(),
            line_values=line_values,
        )

    if dosage_form == DosageForm.CAPSULE.value:
        (
            size_key,
            size_label,
            max_weight,
            total_weight,
            excipients,
            viability,
            warnings,
        ) = _compute_capsule(total_active, capsule_size_key or None)
    elif dosage_form == DosageForm.TABLET.value:
        (
            size_key,
            size_label,
            max_weight,
            total_weight,
            excipients,
            viability,
            warnings,
        ) = _compute_tablet(total_active, tablet_size_key or None)
    else:
        # Non-math dosage forms (powder, gummy, liquid, other_solid)
        # still report the total but skip the excipient block.
        return FormulationTotals(
            total_active_mg=total_active,
            dosage_form=dosage_form,
            size_key=None,
            size_label=None,
            max_weight_mg=None,
            total_weight_mg=total_active,
            excipients=None,
            viability=ViabilityResult(
                fits=True,
                comfort_ok=True,
                codes=("manual_review_required",),
            ),
            line_values=line_values,
        )

    return FormulationTotals(
        total_active_mg=total_active,
        dosage_form=dosage_form,
        size_key=size_key,
        size_label=size_label,
        max_weight_mg=max_weight,
        total_weight_mg=total_weight,
        excipients=excipients,
        viability=viability,
        line_values=line_values,
        warnings=warnings,
    )


# ---------------------------------------------------------------------------
# Formulation CRUD
# ---------------------------------------------------------------------------


def list_formulations(
    *, organization: Organization
) -> QuerySet[Formulation]:
    return (
        Formulation.objects.filter(organization=organization)
        .order_by("-updated_at")
    )


def get_formulation(
    *, organization: Organization, formulation_id: Any
) -> Formulation:
    obj = Formulation.objects.filter(
        organization=organization, id=formulation_id
    ).first()
    if obj is None:
        raise FormulationNotFound()
    return obj


#: Per-org sequential code scheme. ``PRJ-0001`` / ``PRJ-0002`` etc.
#: Short, human-readable, and monotonically increasing — useful when
#: scientists are looking at a list of a dozen drafts and need a
#: quick mental index. Scientists can rename via ``update_formulation``
#: if they prefer a domain-specific code like ``FB-001``.
_CODE_PREFIX = "PRJ"
_CODE_RE = re.compile(rf"^{_CODE_PREFIX}-(\d+)$")


def _generate_unique_code(organization: Organization) -> str:
    """Return the next ``PRJ-NNNN`` code for this organisation.

    Reads the highest existing numeric suffix across the org's
    formulations and increments by one, ignoring non-matching codes
    (manual overrides, legacy MA-style codes). Padded to four digits
    for column alignment and re-extends naturally once you cross
    10_000 projects.
    """

    existing = (
        Formulation.objects.filter(organization=organization)
        .exclude(code="")
        .values_list("code", flat=True)
    )
    highest = 0
    for code in existing:
        match = _CODE_RE.match(code)
        if match is not None:
            highest = max(highest, int(match.group(1)))
    return f"{_CODE_PREFIX}-{highest + 1:04d}"


@transaction.atomic
def create_formulation(
    *,
    organization: Organization,
    actor: Any,
    name: str,
    code: str = "",
    description: str = "",
    dosage_form: str = DosageForm.CAPSULE.value,
    capsule_size: str = "",
    tablet_size: str = "",
    serving_size: int = 1,
    servings_per_pack: int = 60,
    directions_of_use: str = "",
    suggested_dosage: str = "",
    appearance: str = "",
    disintegration_spec: str = "",
) -> Formulation:
    """Create a new formulation.

    ``code`` is deliberately auto-generated here rather than trusted
    from the caller: the New project modal used to accept a code
    field, and the AI-drafting flow emitted hard-coded suggestions
    like ``MA210367`` that collided on a second attempt. Scientists
    can still rename via :func:`update_formulation` — this function
    just guarantees the initial code is unique without the caller
    having to probe for collisions.

    When a caller explicitly passes a ``code`` we honour it only if
    it's not already taken. Preserves the admin escape hatch for
    scripted imports that do want deterministic codes.
    """

    _validate_dosage_form(dosage_form)

    if code:
        duplicate = Formulation.objects.filter(
            organization=organization, code=code
        ).exists()
        if duplicate:
            # Fall through to auto-generation rather than raising —
            # the caller wanted *a* code, and the auto-generated one
            # is strictly better than a 400.
            code = _generate_unique_code(organization)
    else:
        code = _generate_unique_code(organization)

    if capsule_size and capsule_size_by_key(capsule_size) is None:
        raise InvalidCapsuleSize()
    if tablet_size and tablet_size_by_key(tablet_size) is None:
        raise InvalidTabletSize()

    formulation = Formulation.objects.create(
        organization=organization,
        name=name,
        code=code,
        description=description,
        dosage_form=dosage_form,
        capsule_size=capsule_size,
        tablet_size=tablet_size,
        serving_size=serving_size,
        servings_per_pack=servings_per_pack,
        directions_of_use=directions_of_use,
        suggested_dosage=suggested_dosage,
        appearance=appearance,
        disintegration_spec=disintegration_spec,
        created_by=actor,
        updated_by=actor,
    )
    record_audit(
        organization=organization,
        actor=actor,
        action="formulation.create",
        target=formulation,
        after=snapshot(formulation),
    )
    return formulation


@transaction.atomic
def update_formulation(
    *,
    formulation: Formulation,
    actor: Any,
    **changes: Any,
) -> Formulation:
    mutable = {
        "name",
        "code",
        "description",
        "dosage_form",
        "capsule_size",
        "tablet_size",
        "serving_size",
        "servings_per_pack",
        "directions_of_use",
        "suggested_dosage",
        "appearance",
        "disintegration_spec",
        "project_status",
    }
    if "dosage_form" in changes and changes["dosage_form"] is not None:
        _validate_dosage_form(changes["dosage_form"])
    if changes.get("capsule_size"):
        if capsule_size_by_key(changes["capsule_size"]) is None:
            raise InvalidCapsuleSize()
    if changes.get("tablet_size"):
        if tablet_size_by_key(changes["tablet_size"]) is None:
            raise InvalidTabletSize()
    if "code" in changes and changes["code"] and changes["code"] != formulation.code:
        duplicate = (
            Formulation.objects.filter(
                organization=formulation.organization, code=changes["code"]
            )
            .exclude(pk=formulation.pk)
            .exists()
        )
        if duplicate:
            raise FormulationCodeConflict()

    # Snapshot before mutating so the audit row can show the
    # diff. Freezing the dict (not the instance) is enough — the
    # coerced values are already immutable by construction.
    before = snapshot(formulation)
    for key, value in changes.items():
        if key in mutable and value is not None:
            setattr(formulation, key, value)

    formulation.updated_by = actor
    formulation.save()
    record_audit(
        organization=formulation.organization,
        actor=actor,
        action="formulation.update",
        target=formulation,
        before=before,
        after=snapshot(formulation),
    )
    return formulation


def _validate_dosage_form(value: str) -> None:
    valid = {form.value for form in DosageForm}
    if value not in valid:
        raise InvalidDosageForm()


@transaction.atomic
def assign_sales_person(
    *,
    formulation: Formulation,
    sales_person: Any | None,
    actor: Any,
) -> Formulation:
    """Set or clear the project's commercial owner.

    * ``sales_person=None`` clears the assignment.
    * A candidate must hold a :class:`Membership` on the same
      organization as ``formulation``; otherwise
      :class:`SalesPersonNotMember` fires so the view returns a 400.
    * No-ops (assigning the same user already on the project) still
      pass through the audit trail so duplicated writes remain
      traceable — we intentionally keep the contract "every call
      recorded" rather than introducing a silent short-circuit.

    Authorization lives one layer up (the view asserts
    ``formulations.assign_sales_person``). This function is purely
    data integrity + auditing.
    """

    if sales_person is not None:
        is_member = Membership.objects.filter(
            user=sales_person,
            organization=formulation.organization,
        ).exists()
        if not is_member:
            raise SalesPersonNotMember()

    before = snapshot(formulation)
    formulation.sales_person = sales_person
    formulation.updated_by = actor
    formulation.save(update_fields=["sales_person", "updated_by", "updated_at"])
    record_audit(
        organization=formulation.organization,
        actor=actor,
        action="formulation.assign_sales_person",
        target=formulation,
        before=before,
        after=snapshot(formulation),
    )
    return formulation


# ---------------------------------------------------------------------------
# Line CRUD
# ---------------------------------------------------------------------------


@transaction.atomic
def replace_lines(
    *,
    formulation: Formulation,
    actor: Any,
    lines: list[dict[str, Any]],
) -> list[FormulationLine]:
    """Atomically replace the formulation's ingredient lines.

    ``lines`` is a list of dicts with keys ``item_id``,
    ``label_claim_mg``, optional ``serving_size_override``, optional
    ``display_order``, optional ``notes``. Raises
    :class:`RawMaterialNotInOrg` if any item is outside the
    organization's ``raw_materials`` catalogue — the formulation
    engine never crosses catalogue scopes.
    """

    catalogue = Catalogue.objects.filter(
        organization=formulation.organization, slug=RAW_MATERIALS_SLUG
    ).first()
    if catalogue is None:
        # Every org seeds raw_materials on creation; hitting this is a
        # system error, not a validation error.
        raise RawMaterialNotInOrg()

    item_ids = [line["item_id"] for line in lines]
    items_by_id = {
        str(i.id): i
        for i in Item.objects.filter(catalogue=catalogue, id__in=item_ids)
    }
    for line in lines:
        if str(line["item_id"]) not in items_by_id:
            raise RawMaterialNotInOrg()

    # Snapshot the line set pre-replacement so the audit diff can
    # show exactly which ingredients came and went.
    before_lines = _lines_snapshot(formulation)

    FormulationLine.objects.filter(formulation=formulation).delete()

    created: list[FormulationLine] = []
    for index, data in enumerate(lines):
        item = items_by_id[str(data["item_id"])]
        claim = Decimal(str(data["label_claim_mg"]))
        override = data.get("serving_size_override")
        mg = compute_line(
            item=item,
            label_claim_mg=claim,
            serving_size=override if override is not None else formulation.serving_size,
        )
        created.append(
            FormulationLine.objects.create(
                formulation=formulation,
                item=item,
                display_order=data.get("display_order", index),
                label_claim_mg=claim,
                serving_size_override=override,
                mg_per_serving_cached=mg,
                notes=data.get("notes", ""),
            )
        )

    formulation.updated_by = actor
    formulation.save(update_fields=["updated_by", "updated_at"])
    record_audit(
        organization=formulation.organization,
        actor=actor,
        action="formulation_line.replace",
        target=formulation,
        target_type="formulation_line",
        target_id=str(formulation.pk),
        before={"lines": before_lines},
        after={"lines": _lines_snapshot(formulation)},
    )
    return created


def _lines_snapshot(formulation: Formulation) -> list[dict[str, Any]]:
    """Compact snapshot of one formulation's ingredient lines for
    the audit ``before`` / ``after`` payload. Captures the
    business-relevant fields (which item, what claim, in what
    order) without the timestamps and FKs that would pollute the
    diff."""

    return [
        {
            "item_id": str(line.item_id),
            "item_name": line.item.name,
            "label_claim_mg": str(line.label_claim_mg),
            "serving_size_override": line.serving_size_override,
            "display_order": line.display_order,
            "mg_per_serving_cached": (
                str(line.mg_per_serving_cached)
                if line.mg_per_serving_cached is not None
                else None
            ),
            "notes": line.notes,
        }
        for line in formulation.lines.select_related("item").all()
    ]


# ---------------------------------------------------------------------------
# Nutrition + amino acid aggregation — scale per-100g catalogue values
# by each active's mg/serving contribution.
# ---------------------------------------------------------------------------


def _nutrient_per_100g(attributes: dict[str, Any], key: str) -> float | None:
    raw = (attributes or {}).get(key)
    if raw is None:
        return None
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        return float(raw) if raw > 0 else None
    if isinstance(raw, str):
        trimmed = raw.strip().replace(",", ".")
        if not trimmed or trimmed.upper() in {"N/A", "NA", "-"}:
            return None
        try:
            value = float(Decimal(trimmed))
            return value if value > 0 else None
        except (InvalidOperation, ValueError):
            return None
    return None


def _aggregate_nutrient(
    key: str,
    items_with_mg: Iterable[tuple[Item, Decimal]],
    total_weight_mg: Decimal | None,
) -> NutrientAggregate:
    per_serving = 0.0
    contributors = 0
    for item, mg in items_with_mg:
        per_100g = _nutrient_per_100g(item.attributes or {}, key)
        if per_100g is None:
            continue
        g_per_serving = float(mg) / 1000.0
        # Catalogue values are per 100g → scale down by the actual
        # grams of this ingredient that end up in one serving.
        per_serving += per_100g * g_per_serving / 100.0
        contributors += 1

    total_weight_g = (
        float(total_weight_mg) / 1000.0
        if total_weight_mg is not None and float(total_weight_mg) > 0
        else 0.0
    )
    per_100g_value = (
        per_serving / total_weight_g * 100.0 if total_weight_g > 0 else 0.0
    )

    return NutrientAggregate(
        key=key,
        per_serving=Decimal(str(per_serving)).quantize(Decimal("0.0001")),
        per_100g=Decimal(str(per_100g_value)).quantize(Decimal("0.0001")),
        contributors=contributors,
    )


def compute_nutrition_panel(
    *,
    items_with_mg: Iterable[tuple[Item, Decimal]],
    total_weight_mg: Decimal | None,
) -> tuple[NutrientAggregate, ...]:
    """Sum per-ingredient nutrition contributions into per-serving +
    per-100g-of-product values for each of the eleven nutrition keys.

    Ingredients with missing catalogue data contribute nothing but
    also do not block the sum; ``contributors`` on the returned
    aggregate tracks how many actually had data so the UI can surface
    "based on N of M ingredients".
    """

    items_list = list(items_with_mg)
    return tuple(
        _aggregate_nutrient(key, items_list, total_weight_mg)
        for key in NUTRITION_KEYS
    )


def compute_amino_panel(
    *,
    items_with_mg: Iterable[tuple[Item, Decimal]],
    total_weight_mg: Decimal | None,
) -> tuple[AminoAcidGroup, ...]:
    """Same scaling as :func:`compute_nutrition_panel` but grouped
    into essential / conditionally essential / non-essential blocks,
    matching the ``FINAL - Specification Sheet`` layout."""

    items_list = list(items_with_mg)
    return tuple(
        AminoAcidGroup(
            key=group_key,
            acids=tuple(
                _aggregate_nutrient(acid_key, items_list, total_weight_mg)
                for acid_key in acids
            ),
        )
        for group_key, acids in AMINO_ACID_GROUPS
    )


# ---------------------------------------------------------------------------
# Compliance aggregation — AND over every active line's flag
# ---------------------------------------------------------------------------


def compute_compliance(
    *,
    items: Iterable[Item],
) -> ComplianceResult:
    """Return the AND-aggregated compliance picture for a formulation.

    For each flag the rule is: one non-compliant ingredient taints
    the whole product. The product can only claim a flag when every
    *answered* ingredient is compliant AND at least one ingredient
    answered at all — a formulation built entirely from unanswered
    ingredients returns ``status=None`` so the UI can fade the chip.
    """

    items_list = list(items)
    flag_results: list[ComplianceFlagResult] = []
    for key, label in COMPLIANCE_FLAGS:
        compliant = 0
        non_compliant = 0
        unknown = 0
        for item in items_list:
            value = (item.attributes or {}).get(key)
            decision = normalize_compliance_value(value)
            if decision is True:
                compliant += 1
            elif decision is False:
                non_compliant += 1
            else:
                unknown += 1

        if non_compliant > 0:
            status: bool | None = False
        elif compliant > 0:
            status = True
        else:
            status = None

        flag_results.append(
            ComplianceFlagResult(
                key=key,
                label=label,
                status=status,
                compliant_count=compliant,
                non_compliant_count=non_compliant,
                unknown_count=unknown,
            )
        )
    return ComplianceResult(flags=tuple(flag_results))


# ---------------------------------------------------------------------------
# Allergen aggregation — distinct allergen classes across every active
# ---------------------------------------------------------------------------


def _is_item_allergen(item: Item) -> bool:
    """Read the catalogue's ``allergen`` flag with the same
    case-insensitive leniency as :func:`normalize_compliance_value` —
    accepts ``"Yes"``, ``True``, ``1`` as positive signals and treats
    everything else (including the catalogue's ``"#VALUE!"`` error
    artifacts) as not-an-allergen. Missing data is never promoted to
    "this is an allergen" — silence is not consent."""

    raw = (item.attributes or {}).get("allergen")
    if isinstance(raw, bool) and raw:
        return True
    if isinstance(raw, (int, float)) and bool(raw):
        return True
    if isinstance(raw, str):
        lowered = raw.strip().lower()
        if lowered in {"yes", "true", "1"}:
            return True
    # The catalogue ships many rows (wheat, barley, oat-derivatives,
    # milk fractions) where a scientist filled in
    # ``allergen_source = "Cereals containing gluten"`` but left the
    # tri-state ``allergen`` flag blank / "No". A populated source is
    # the more reliable positive signal — an ingredient with a real
    # EU-14 class is an allergen by construction. We keep the flag
    # as an explicit override (if someone sets it to "No" on a
    # borderline extract the source is ignored), so an empty / sentinel
    # source with no flag returns False.
    if _allergen_source_for_item(item):
        return True
    return False


def _allergen_source_for_item(item: Item) -> str:
    """Return the catalogue's ``Allergen Source`` field as a clean
    string. The catalogue uses ``"None"`` as the empty sentinel — we
    collapse that and the spreadsheet ``"#VALUE!"`` artifact to ``""``
    so the frontend does not render ``None`` as if it were a real
    allergen class."""

    raw = (item.attributes or {}).get("allergen_source")
    if not isinstance(raw, str):
        return ""
    trimmed = raw.strip()
    if not trimmed or trimmed.lower() in {"none", "#value!"}:
        return ""
    return trimmed


def compute_allergens(
    *,
    items: Iterable[Item],
) -> FormulationAllergens:
    """Aggregate the EU-14 allergen classes across the product's
    actives.

    Mirrors the workbook's ``TEXTJOIN(", ", TRUE,
    Table13[Allergen Source])`` approach, with one extra guarantee:
    duplicates are deduped so a formulation with two different milk
    proteins surfaces ``["Milk"]`` once, not twice. Sorted
    alphabetically for a stable, copy-paste-friendly output.
    """

    sources: set[str] = set()
    allergen_count = 0
    for item in items:
        if not _is_item_allergen(item):
            continue
        allergen_count += 1
        source = _allergen_source_for_item(item)
        if source:
            sources.add(source)

    return FormulationAllergens(
        sources=tuple(sorted(sources)),
        allergen_count=allergen_count,
    )


# ---------------------------------------------------------------------------
# Ingredient declaration — label-copy string for the product back panel
# ---------------------------------------------------------------------------


def _entry_label_for_item(item: Item) -> str:
    """Prefer the catalogue's ``ingredient_list_name`` (label-friendly
    copy written by R&D); fall back to the raw-material internal name
    if the label copy row is blank. The audit script reports any row
    still falling back so R&D can fill the gaps."""

    attrs = item.attributes or {}
    candidate = attrs.get("ingredient_list_name")
    if isinstance(candidate, str) and candidate.strip():
        return _strip_label_punctuation(candidate)
    return item.name


def _strip_label_punctuation(value: str) -> str:
    """Trim whitespace and the trailing comma R&D leaves on most
    ``ingredient_list_name`` rows (e.g. ``"Caffeine Anhydrous, "``)."""

    return value.strip().rstrip(",").strip()


# Format an mg value for label copy: drop trailing zeros so ``10.0000``
# renders as ``10`` and ``2.5000`` renders as ``2.5`` — matches the
# workbook's spec sheet output.
def _format_label_mg(value: Any) -> str:
    try:
        decimal = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return str(value)
    quantised = decimal.quantize(Decimal("0.0001")).normalize()
    text = format(quantised, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


# Match an "X% Word" marker — captures the percent value, the marker
# word(s), and any trailing punctuation. Bounded by either a comma, a
# closing paren, or end-of-string so neighbouring markers do not bleed
# into each other.
_MARKER_RE = re.compile(
    r"(\d+(?:\.\d+)?)%\s+([A-Za-z][A-Za-z0-9 \-]*?)(?=\s*(?:,|\)|$))"
)


def _scale_marker_percentages(template: str, raw_mg: Decimal) -> str:
    """Inside a templated active label, rewrite ``X% Marker`` segments
    as ``(X*raw_mg/100)mg Marker``.

    Mirrors the workbook's spec-sheet behaviour: a botanical extract
    declared as "Containing 95% Polyphenols, 45% EGCG" with 10 mg of
    raw extract becomes "9.5mg Polyphenols, 4.5mg EGCG". Also drops
    the leading "Containing " connector when present, so the output
    reads as a pure ingredient list.
    """

    raw_float = float(raw_mg)

    def _replace(match: re.Match[str]) -> str:
        percent = float(match.group(1))
        marker = match.group(2).strip()
        scaled = percent * raw_float / 100.0
        return f"{_format_label_mg(scaled)}mg {marker}"

    rewritten = _MARKER_RE.sub(_replace, template)
    # The workbook drops the connector word "Containing" when the rest
    # of the parenthesised clause becomes "<mg> <marker>" rather than
    # "<percent>% <marker>".
    rewritten = re.sub(r"\(\s*Containing\s+", "(", rewritten)
    return rewritten


def instantiate_active_label(
    *,
    nutrition_information_name: Any,
    ingredient_list_name: Any,
    item_name: str,
    raw_mg: Decimal | None,
) -> str:
    """Return the label that appears in the spec sheet's actives table.

    The Valley workbook's convention: when the catalogue provides a
    ``Nutrition information Name`` template containing the ``??mg``
    placeholder, the spec sheet renders that template with ``??``
    replaced by the actual raw extract weight and any ``X% Marker``
    fragments scaled to ``mg`` (e.g. ``95% Polyphenols`` at 10 mg
    becomes ``9.5mg Polyphenols``). When the template is absent or
    contains no placeholder, the simpler ``ingredient_list_name``
    wins so straightforward purity-based actives like
    "Caffeine Anhydrous" still render as a single tidy label.
    """

    template = (
        nutrition_information_name
        if isinstance(nutrition_information_name, str)
        and nutrition_information_name.strip()
        else None
    )

    fallback = (
        _strip_label_punctuation(ingredient_list_name)
        if isinstance(ingredient_list_name, str)
        and ingredient_list_name.strip()
        else item_name
    )

    if template is None or "??" not in template:
        return fallback

    if raw_mg is None:
        return fallback

    raw_decimal = Decimal(str(raw_mg))
    raw_text = _format_label_mg(raw_decimal)
    expanded = template.replace("??mg", f"{raw_text}mg").replace(
        "??", raw_text
    )
    expanded = _scale_marker_percentages(expanded, raw_decimal)
    # Clean up double spaces that sometimes appear when the template
    # had ``of 10:1 Extract`` and the marker rewrite removed
    # intermediate words.
    expanded = re.sub(r" {2,}", " ", expanded).strip()
    return expanded


def build_ingredient_declaration(
    *,
    items_by_external_id: dict[str, Item],
    totals: FormulationTotals,
) -> tuple[str, tuple[IngredientDeclarationEntry, ...]]:
    """Produce the product's ingredient declaration string.

    All actives + excipients + (for capsules) the shell are merged
    into a single list, sorted by ``mg/serving`` descending, and
    rendered using each row's label-friendly name. Returns the
    joined string plus the intermediate entry list so the UI can
    show a table breakdown alongside the raw string.
    """

    entries: list[IngredientDeclarationEntry] = []

    for external_id, mg in totals.line_values.items():
        item = items_by_external_id.get(external_id)
        if item is None:
            continue
        is_allergen = _is_item_allergen(item)
        entries.append(
            IngredientDeclarationEntry(
                label=_entry_label_for_item(item),
                mg=mg,
                category="active",
                is_allergen=is_allergen,
                allergen_source=(
                    _allergen_source_for_item(item) if is_allergen else ""
                ),
            )
        )

    excipients = totals.excipients
    if excipients is not None:
        if excipients.mcc_mg and excipients.mcc_mg > 0:
            entries.append(
                IngredientDeclarationEntry(
                    label=EXCIPIENT_LABEL_MCC,
                    mg=excipients.mcc_mg,
                    category="excipient",
                )
            )
        if excipients.dcp_mg is not None and excipients.dcp_mg > 0:
            entries.append(
                IngredientDeclarationEntry(
                    label=EXCIPIENT_LABEL_DCP,
                    mg=excipients.dcp_mg,
                    category="excipient",
                )
            )
        # Magnesium stearate + silicon dioxide collapse into a single
        # ``Anticaking Agents`` entry — matches the workbook's label
        # copy. Combined mg drives the ingredient-list sort order so
        # the merged entry sits at the right rank rather than each
        # half landing at the bottom on its own tiny weight.
        anticaking_mg = (excipients.mg_stearate_mg or Decimal("0")) + (
            excipients.silica_mg or Decimal("0")
        )
        if anticaking_mg > 0:
            entries.append(
                IngredientDeclarationEntry(
                    label=EXCIPIENT_LABEL_ANTICAKING,
                    mg=anticaking_mg,
                    category="excipient",
                )
            )

    if totals.dosage_form == DosageForm.CAPSULE.value and totals.size_key:
        capsule_size = capsule_size_by_key(totals.size_key)
        if capsule_size is not None and capsule_size.shell_weight_mg > 0:
            entries.append(
                IngredientDeclarationEntry(
                    label=CAPSULE_SHELL_LABEL,
                    mg=Decimal(str(capsule_size.shell_weight_mg)),
                    category="shell",
                )
            )

    entries.sort(key=lambda e: (-float(e.mg), e.label))
    declaration = ", ".join(entry.label for entry in entries)
    return declaration, tuple(entries)


def compute_formulation_totals(
    *, formulation: Formulation
) -> FormulationTotals:
    """Compute totals for the formulation's current working state."""

    tuples = [
        (
            str(line.id),
            line.item,
            line.label_claim_mg,
            line.serving_size_override,
        )
        for line in formulation.lines.select_related("item").all()
    ]
    return compute_totals(
        lines=tuples,
        dosage_form=formulation.dosage_form,
        capsule_size_key=formulation.capsule_size or None,
        tablet_size_key=formulation.tablet_size or None,
        default_serving_size=formulation.serving_size,
    )


# ---------------------------------------------------------------------------
# Version snapshots
# ---------------------------------------------------------------------------


def _snapshot_metadata(formulation: Formulation) -> dict[str, Any]:
    return {
        "name": formulation.name,
        "code": formulation.code,
        "description": formulation.description,
        "dosage_form": formulation.dosage_form,
        "capsule_size": formulation.capsule_size,
        "tablet_size": formulation.tablet_size,
        "serving_size": formulation.serving_size,
        "servings_per_pack": formulation.servings_per_pack,
        "directions_of_use": formulation.directions_of_use,
        "suggested_dosage": formulation.suggested_dosage,
        "appearance": formulation.appearance,
        "disintegration_spec": formulation.disintegration_spec,
    }


#: Attribute keys copied from each line's source raw material into the
#: snapshot. F3a's specification sheet renders from snapshots, and a
#: snapshot that omits these fields cannot reproduce the label copy,
#: %NRV column, or nutrition / amino aggregation — so the snapshot
#: carries them verbatim, frozen against whatever the catalogue said
#: at save time.
_SNAPSHOT_ATTRIBUTE_KEYS: tuple[str, ...] = (
    "type",
    "purity",
    "extract_ratio",
    "overage",
    "ingredient_list_name",
    "nutrition_information_name",
    "vegan",
    "organic",
    "halal",
    "kosher",
    "nrv_mg",
    # Allergen handling (V2 template): the ``Allergen`` flag drives the
    # bolded ingredient in the declaration copy and the ``Allergen
    # Source`` field feeds the aggregated "Allergens:" line. Country of
    # origin rides along for procurement / regulatory traceability.
    "allergen",
    "allergen_source",
    "typical_country_of_origin",
    *NUTRITION_KEYS,
    *AMINO_ACID_KEYS,
)


def _snapshot_lines(formulation: Formulation) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []
    for line in formulation.lines.select_related("item").all():
        attributes = line.item.attributes or {}
        snapshot_attributes = {
            key: attributes.get(key) for key in _SNAPSHOT_ATTRIBUTE_KEYS
        }
        lines.append(
            {
                "item_id": str(line.item_id),
                "item_name": line.item.name,
                "item_internal_code": line.item.internal_code,
                "item_attributes": snapshot_attributes,
                "display_order": line.display_order,
                "label_claim_mg": str(line.label_claim_mg),
                "serving_size_override": line.serving_size_override,
                "mg_per_serving": (
                    str(line.mg_per_serving_cached)
                    if line.mg_per_serving_cached is not None
                    else None
                ),
                "notes": line.notes,
            }
        )
    return lines


def _serialize_nutrition(
    nutrition: tuple[NutrientAggregate, ...],
) -> dict[str, Any]:
    return {
        "rows": [
            {
                "key": n.key,
                "per_serving": str(n.per_serving),
                "per_100g": str(n.per_100g),
                "contributors": n.contributors,
            }
            for n in nutrition
        ],
    }


def _serialize_amino(
    groups: tuple[AminoAcidGroup, ...],
) -> dict[str, Any]:
    return {
        "groups": [
            {
                "key": g.key,
                "acids": [
                    {
                        "key": a.key,
                        "per_serving": str(a.per_serving),
                        "per_100g": str(a.per_100g),
                        "contributors": a.contributors,
                    }
                    for a in g.acids
                ],
            }
            for g in groups
        ],
    }


def _serialize_compliance(result: ComplianceResult) -> dict[str, Any]:
    return {
        "flags": [
            {
                "key": f.key,
                "label": f.label,
                "status": f.status,
                "compliant_count": f.compliant_count,
                "non_compliant_count": f.non_compliant_count,
                "unknown_count": f.unknown_count,
            }
            for f in result.flags
        ],
    }


def _serialize_declaration(
    declaration: str,
    entries: tuple[IngredientDeclarationEntry, ...],
) -> dict[str, Any]:
    return {
        "text": declaration,
        "entries": [
            {
                "label": e.label,
                "mg": str(e.mg),
                "category": e.category,
                "is_allergen": e.is_allergen,
                "allergen_source": e.allergen_source,
            }
            for e in entries
        ],
    }


def _serialize_allergens(allergens: FormulationAllergens) -> dict[str, Any]:
    return {
        "sources": list(allergens.sources),
        "allergen_count": allergens.allergen_count,
    }


def _serialize_totals(totals: FormulationTotals) -> dict[str, Any]:
    return {
        "total_active_mg": str(totals.total_active_mg),
        "dosage_form": totals.dosage_form,
        "size_key": totals.size_key,
        "size_label": totals.size_label,
        "max_weight_mg": (
            str(totals.max_weight_mg) if totals.max_weight_mg is not None else None
        ),
        "total_weight_mg": (
            str(totals.total_weight_mg)
            if totals.total_weight_mg is not None
            else None
        ),
        "excipients": (
            {
                "mg_stearate_mg": str(totals.excipients.mg_stearate_mg),
                "silica_mg": str(totals.excipients.silica_mg),
                "mcc_mg": str(totals.excipients.mcc_mg),
                "dcp_mg": (
                    str(totals.excipients.dcp_mg)
                    if totals.excipients.dcp_mg is not None
                    else None
                ),
            }
            if totals.excipients is not None
            else None
        ),
        "viability": {
            "fits": totals.viability.fits,
            "comfort_ok": totals.viability.comfort_ok,
            "codes": list(totals.viability.codes),
        },
        "warnings": list(totals.warnings),
    }


@transaction.atomic
def save_version(
    *,
    formulation: Formulation,
    actor: Any,
    label: str = "",
) -> FormulationVersion:
    """Freeze the formulation's current state into a new version.

    Along with the mg/excipient totals, the snapshot captures the
    compliance aggregation and the ingredient declaration string, so
    historical versions preserve exactly what the label would have
    said at that moment — later catalogue edits cannot rewrite old
    snapshots.
    """

    totals = compute_formulation_totals(formulation=formulation)

    items_by_external_id = {
        str(line.id): line.item
        for line in formulation.lines.select_related("item").all()
    }
    compliance = compute_compliance(items=items_by_external_id.values())
    allergens = compute_allergens(items=items_by_external_id.values())
    declaration_text, declaration_entries = build_ingredient_declaration(
        items_by_external_id=items_by_external_id,
        totals=totals,
    )

    # Build (item, mg) pairs for the nutrition / amino aggregation.
    # Only actives with a computable mg/serving contribute — an
    # ingredient whose mg is ``None`` (missing purity / extract) is
    # silently excluded rather than counted as zero.
    items_with_mg = [
        (items_by_external_id[external_id], mg)
        for external_id, mg in totals.line_values.items()
        if external_id in items_by_external_id and mg is not None
    ]
    nutrition = compute_nutrition_panel(
        items_with_mg=items_with_mg,
        total_weight_mg=totals.total_weight_mg,
    )
    amino = compute_amino_panel(
        items_with_mg=items_with_mg,
        total_weight_mg=totals.total_weight_mg,
    )

    serialized_totals = _serialize_totals(totals)
    serialized_totals["compliance"] = _serialize_compliance(compliance)
    serialized_totals["allergens"] = _serialize_allergens(allergens)
    serialized_totals["declaration"] = _serialize_declaration(
        declaration_text, declaration_entries
    )
    serialized_totals["nutrition"] = _serialize_nutrition(nutrition)
    serialized_totals["amino_acids"] = _serialize_amino(amino)

    highest = (
        formulation.versions.aggregate(Max("version_number"))[
            "version_number__max"
        ]
        or 0
    )
    version = FormulationVersion.objects.create(
        formulation=formulation,
        version_number=highest + 1,
        label=label,
        snapshot_metadata=_snapshot_metadata(formulation),
        snapshot_lines=_snapshot_lines(formulation),
        snapshot_totals=serialized_totals,
        created_by=actor,
    )
    record_audit(
        organization=formulation.organization,
        actor=actor,
        action="formulation_version.save",
        target=version,
        after={
            "formulation_id": str(formulation.pk),
            "version_number": version.version_number,
            "label": version.label,
        },
    )
    return version


def list_versions(
    *, formulation: Formulation
) -> QuerySet[FormulationVersion]:
    return formulation.versions.all()


def get_version(
    *,
    formulation: Formulation,
    version_number: int,
) -> FormulationVersion:
    version = formulation.versions.filter(
        version_number=version_number
    ).first()
    if version is None:
        raise FormulationVersionNotFound()
    return version


@transaction.atomic
def rollback_to_version(
    *,
    formulation: Formulation,
    actor: Any,
    version_number: int,
) -> Formulation:
    """Restore the formulation's mutable state from a past snapshot.

    The snapshot is copied back onto the working rows, then a *new*
    version is appended so the rollback is itself audited — history
    is always append-only.
    """

    version = get_version(
        formulation=formulation, version_number=version_number
    )

    metadata = version.snapshot_metadata or {}
    for key in (
        "name",
        "code",
        "description",
        "dosage_form",
        "capsule_size",
        "tablet_size",
        "serving_size",
        "servings_per_pack",
        "directions_of_use",
        "suggested_dosage",
        "appearance",
        "disintegration_spec",
    ):
        if key in metadata:
            setattr(formulation, key, metadata[key])
    formulation.updated_by = actor
    formulation.save()

    snapshot_lines = version.snapshot_lines or []
    lines_payload: list[dict[str, Any]] = []
    for entry in snapshot_lines:
        lines_payload.append(
            {
                "item_id": entry["item_id"],
                "label_claim_mg": entry["label_claim_mg"],
                "serving_size_override": entry.get("serving_size_override"),
                "display_order": entry.get("display_order", 0),
                "notes": entry.get("notes", ""),
            }
        )
    replace_lines(formulation=formulation, actor=actor, lines=lines_payload)

    save_version(
        formulation=formulation,
        actor=actor,
        label=f"rollback to v{version_number}",
    )
    record_audit(
        organization=formulation.organization,
        actor=actor,
        action="formulation_version.rollback",
        target=formulation,
        after={
            "rolled_back_to_version_number": version_number,
        },
    )
    return formulation
