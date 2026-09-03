"""Enums + state-machine tables + compliance checklist for label design.

Kept in a dedicated module (rather than at the foot of ``models.py``)
so the constants can be imported without dragging the model layer in,
which matters for the API serializers + the frontend type generator.
"""

from __future__ import annotations

from dataclasses import dataclass

from django.db import models
from django.utils.translation import gettext_lazy as _


# ---------------------------------------------------------------------------
# Workflow status
# ---------------------------------------------------------------------------


class LabelDesignStatus(models.TextChoices):
    """The state of a label-design workflow row.

    Strict forward-only progression with two exception points:

    * Any reviewer can reject back to ``DESIGN_IN_PROGRESS`` — that
      kicks off a fresh revision. Multiple rejections do NOT pile up
      review rows on the same revision; each revision gets its own
      reviews.
    * ``ON_HOLD`` is the staff escape hatch (the customer rejects
      repeatedly, the workflow stalls, or the project pauses for
      external reasons). Resuming from ``ON_HOLD`` returns to the
      status the row was holding before — the previous status is
      restored from the most recent :class:`LabelDesignTransition`
      whose ``to_status`` is not ``ON_HOLD``.
    """

    PAYMENT_PENDING = "payment_pending", _("Payment pending")
    LABEL_PATH_PENDING = "label_path_pending", _("Awaiting design path")
    #: DESIGN_BY_US only — created after the customer picks the
    #: "you design" path, when the org has a non-zero
    #: ``label_design_fee_amount`` configured. A
    #: ``Payment(kind=LABEL_DESIGN)`` row is fired at the same
    #: transition; finance approving that payment auto-advances the
    #: workflow to ``DESIGN_PREFERENCES_PENDING``.
    DESIGN_FEE_PENDING = "design_fee_pending", _("Awaiting design fee")
    DESIGN_PREFERENCES_PENDING = (
        "design_preferences_pending",
        _("Awaiting design preferences"),
    )
    DESIGN_IN_PROGRESS = "design_in_progress", _("Design in progress")
    SCIENTIST_REVIEW = "scientist_review", _("Scientist review")
    DIRECTOR_REVIEW = "director_review", _("Director review")
    CUSTOMER_APPROVAL = "customer_approval", _("Customer approval")
    LABEL_APPROVED = "label_approved", _("Label approved")
    #: Terminal — customer explicitly opted out of labelling at the
    #: choose-path step (unbranded / bulk order, warehouse-only fill,
    #: or their own downstream labelling line). PSP renders this on
    #: the CO badge as "No label required" and production doesn't
    #: wait on any label workflow. Cannot be undone without staff
    #: intervention (same posture as ``LABEL_APPROVED``).
    NO_LABEL_REQUIRED = "no_label_required", _("No label required")
    ON_HOLD = "on_hold", _("On hold")


#: The forward edges of the workflow graph. ``transition_status``
#: refuses any (from, to) pair that is not in this map. Every cell
#: is hand-curated against the spec (see plan §State machine) — adding
#: a new edge means thinking through who can trigger it, what side
#: effects it has, and a corresponding test in
#: :mod:`apps.label_design.tests.test_transitions`.
#:
#: The CUSTOMER_APPROVAL → LABEL_APPROVED edge is the only path on the
#: DESIGN_BY_US lane; on DESIGN_BY_CUSTOMER the director's approval
#: jumps straight to LABEL_APPROVED because the customer already
#: authored the artwork.
ALLOWED_TRANSITIONS: dict[str, frozenset[str]] = {
    LabelDesignStatus.PAYMENT_PENDING: frozenset(
        {
            LabelDesignStatus.LABEL_PATH_PENDING,
            LabelDesignStatus.ON_HOLD,
        }
    ),
    LabelDesignStatus.LABEL_PATH_PENDING: frozenset(
        {
            #: DESIGN_BY_US with a configured design fee lands here
            #: while finance approves the LABEL_DESIGN payment.
            LabelDesignStatus.DESIGN_FEE_PENDING,
            #: DESIGN_BY_US with a 0/unset fee (or DESIGN_BY_CUSTOMER
            #: on the design-brief-required org policy) can jump
            #: straight to the brief step.
            LabelDesignStatus.DESIGN_PREFERENCES_PENDING,
            #: DESIGN_BY_CUSTOMER is free — go straight to design.
            LabelDesignStatus.DESIGN_IN_PROGRESS,
            #: NO_LABEL closes the workflow instantly — no design fee,
            #: no brief, no review chain. Terminal.
            LabelDesignStatus.NO_LABEL_REQUIRED,
            LabelDesignStatus.ON_HOLD,
        }
    ),
    LabelDesignStatus.DESIGN_FEE_PENDING: frozenset(
        {
            LabelDesignStatus.DESIGN_PREFERENCES_PENDING,
            LabelDesignStatus.ON_HOLD,
        }
    ),
    LabelDesignStatus.DESIGN_PREFERENCES_PENDING: frozenset(
        {
            LabelDesignStatus.DESIGN_IN_PROGRESS,
            LabelDesignStatus.ON_HOLD,
        }
    ),
    LabelDesignStatus.DESIGN_IN_PROGRESS: frozenset(
        {
            LabelDesignStatus.SCIENTIST_REVIEW,
            LabelDesignStatus.ON_HOLD,
        }
    ),
    LabelDesignStatus.SCIENTIST_REVIEW: frozenset(
        {
            LabelDesignStatus.DIRECTOR_REVIEW,
            LabelDesignStatus.DESIGN_IN_PROGRESS,
            LabelDesignStatus.ON_HOLD,
        }
    ),
    LabelDesignStatus.DIRECTOR_REVIEW: frozenset(
        {
            LabelDesignStatus.CUSTOMER_APPROVAL,
            LabelDesignStatus.LABEL_APPROVED,
            LabelDesignStatus.DESIGN_IN_PROGRESS,
            LabelDesignStatus.ON_HOLD,
        }
    ),
    LabelDesignStatus.CUSTOMER_APPROVAL: frozenset(
        {
            LabelDesignStatus.LABEL_APPROVED,
            LabelDesignStatus.DESIGN_IN_PROGRESS,
            LabelDesignStatus.ON_HOLD,
        }
    ),
    LabelDesignStatus.LABEL_APPROVED: frozenset(),  # terminal
    LabelDesignStatus.NO_LABEL_REQUIRED: frozenset(),  # terminal
    LabelDesignStatus.ON_HOLD: frozenset(
        {
            # Resume targets — see ``services.resume_from_hold`` which
            # picks the right one from the transition history. Listed
            # here so the validator accepts the move.
            LabelDesignStatus.PAYMENT_PENDING,
            LabelDesignStatus.LABEL_PATH_PENDING,
            LabelDesignStatus.DESIGN_FEE_PENDING,
            LabelDesignStatus.DESIGN_PREFERENCES_PENDING,
            LabelDesignStatus.DESIGN_IN_PROGRESS,
            LabelDesignStatus.SCIENTIST_REVIEW,
            LabelDesignStatus.DIRECTOR_REVIEW,
            LabelDesignStatus.CUSTOMER_APPROVAL,
        }
    ),
}


#: How many consecutive customer rejections we tolerate before the
#: workflow auto-routes to ``ON_HOLD`` and demands staff intervention.
#: The threshold lives here so the test suite + the documentation
#: cite the same number.
MAX_CUSTOMER_REJECTIONS_BEFORE_HOLD = 3


# ---------------------------------------------------------------------------
# Design path + revision source
# ---------------------------------------------------------------------------


class LabelDesignPath(models.TextChoices):
    """Which side of the table is doing the artistic work.

    ``NO_LABEL`` is the "we won't be labelling this order" opt-out —
    the workflow terminates at pick-time (see
    :attr:`LabelDesignStatus.NO_LABEL_REQUIRED`) so downstream
    consumers can treat the label stage as skipped rather than
    stalled.
    """

    DESIGN_BY_US = "design_by_us", _("Vita designs")
    DESIGN_BY_CUSTOMER = "design_by_customer", _("Customer designs")
    NO_LABEL = "no_label", _("No label required")


class RevisionSource(models.TextChoices):
    STAFF_UPLOAD = "staff_upload", _("Staff upload")
    CUSTOMER_UPLOAD = "customer_upload", _("Customer upload")


# ---------------------------------------------------------------------------
# Review enums
# ---------------------------------------------------------------------------


class ReviewKind(models.TextChoices):
    SCIENTIST = "scientist", _("Scientist")
    DIRECTOR = "director", _("Director")


class ReviewOutcome(models.TextChoices):
    APPROVED = "approved", _("Approved")
    REQUIRES_REVISION = "requires_revision", _("Requires revisions")


# ---------------------------------------------------------------------------
# Design preferences enums (MA-ST-B-009)
# ---------------------------------------------------------------------------


class DesignStyle(models.TextChoices):
    MODERN = "modern", _("Modern")
    MINIMALIST = "minimalist", _("Minimalist")
    BOLD = "bold", _("Bold")
    LUXURY = "luxury", _("Luxury")


class MaterialType(models.TextChoices):
    MATTE = "matte", _("Matte")
    GLOSSY = "glossy", _("Glossy")


# ---------------------------------------------------------------------------
# Compliance checklist (MA-PD-B-012)
# ---------------------------------------------------------------------------


class ChecklistSection(models.TextChoices):
    GENERAL = "general", _("General label compliance")
    REGULATORY = "regulatory", _("Regulatory & claims")
    CUSTOMER_CLAIMS = "customer_claims", _("Customer claims compliance")
    ALLERGEN = "allergen", _("Allergen declaration & warnings")
    PRINT_PACKAGING = "print_packaging", _("Print & packaging")


@dataclass(frozen=True)
class ChecklistItem:
    """One reviewable line on the Label Review form.

    ``key`` is the wire identifier — never change an existing key
    without a migration plan, because review rows reference it
    inside their JSON ``checklist_responses`` payload. The label /
    help text can be edited freely.
    """

    key: str
    section: str
    label: str
    help_text: str = ""


#: The 22 yes/no checks from form MA-PD-B-012 rev 01. Hard-coded by
#: design: edits require a deploy, but the form's revision cadence
#: (Rev 00 → Rev 01 in over a year) makes that acceptable.
COMPLIANCE_CHECKLIST: tuple[ChecklistItem, ...] = (
    # ----- II. General label compliance -----
    ChecklistItem(
        key="general.spelling_grammar",
        section=ChecklistSection.GENERAL,
        label="Spelling & grammar",
    ),
    ChecklistItem(
        key="general.formatting_readability",
        section=ChecklistSection.GENERAL,
        label="Formatting & readability",
    ),
    ChecklistItem(
        key="general.layout_consistency",
        section=ChecklistSection.GENERAL,
        label="Label layout consistency",
    ),
    ChecklistItem(
        key="general.font_legibility",
        section=ChecklistSection.GENERAL,
        label="Font size & legibility",
    ),
    # ----- III. Regulatory & claims compliance -----
    ChecklistItem(
        key="regulatory.product_name_description",
        section=ChecklistSection.REGULATORY,
        label="Compliant product name & description",
    ),
    ChecklistItem(
        key="regulatory.health_claims",
        section=ChecklistSection.REGULATORY,
        label="Permitted health & nutritional claims",
        help_text=(
            "Each claim must map to an authorised EFSA / FSA / FDA register "
            "entry. NRV values must double when the serving doubles."
        ),
    ),
    ChecklistItem(
        key="regulatory.ingredient_list",
        section=ChecklistSection.REGULATORY,
        label="Approved ingredient list in correct order",
    ),
    ChecklistItem(
        key="regulatory.international_compliance",
        section=ChecklistSection.REGULATORY,
        label="Complies with local & international regulations (FSA / EFSA / FDA)",
    ),
    ChecklistItem(
        key="regulatory.certification_logos",
        section=ChecklistSection.REGULATORY,
        label="Correct use of certification logos (Organic, Vegan, etc.)",
    ),
    ChecklistItem(
        key="regulatory.net_quantity",
        section=ChecklistSection.REGULATORY,
        label="Net quantity declared",
    ),
    ChecklistItem(
        key="regulatory.storage_conditions",
        section=ChecklistSection.REGULATORY,
        label="Storage condition provided",
    ),
    ChecklistItem(
        key="regulatory.dosage_instructions",
        section=ChecklistSection.REGULATORY,
        label="Instruction of use / dosage provided",
    ),
    ChecklistItem(
        key="regulatory.business_address",
        section=ChecklistSection.REGULATORY,
        label="Business name and address present",
    ),
    ChecklistItem(
        key="regulatory.country_of_origin",
        section=ChecklistSection.REGULATORY,
        label="Country of origin declared (if present)",
    ),
    ChecklistItem(
        key="regulatory.nrv_declared",
        section=ChecklistSection.REGULATORY,
        label="NRV declared",
    ),
    # ----- IV. Customer claims & compliance -----
    ChecklistItem(
        key="customer_claims.no_medical_claims",
        section=ChecklistSection.CUSTOMER_CLAIMS,
        label="No medical or misleading claims",
    ),
    ChecklistItem(
        key="customer_claims.nutrition_claims_permitted",
        section=ChecklistSection.CUSTOMER_CLAIMS,
        label="Nutrition / health claims permitted",
    ),
    ChecklistItem(
        key="customer_claims.dosage_safe",
        section=ChecklistSection.CUSTOMER_CLAIMS,
        label="Dosage instruction safe and appropriate",
    ),
    # ----- V. Allergen declaration & warnings -----
    ChecklistItem(
        key="allergen.highlighted",
        section=ChecklistSection.ALLERGEN,
        label="Allergens clearly highlighted (bold / emphasis)",
    ),
    ChecklistItem(
        key="allergen.contains_statement",
        section=ChecklistSection.ALLERGEN,
        label='"Contains" statement correct',
    ),
    ChecklistItem(
        key="allergen.may_contain",
        section=ChecklistSection.ALLERGEN,
        label='"May contain" statement justified & risk-assessed',
    ),
    ChecklistItem(
        key="allergen.matches_specification",
        section=ChecklistSection.ALLERGEN,
        label="Allergen information matches specification",
    ),
    # ----- VI. Print & packaging -----
    ChecklistItem(
        key="print_packaging.barcode_qr_placement",
        section=ChecklistSection.PRINT_PACKAGING,
        label="Correct barcode & QR code placement",
    ),
    ChecklistItem(
        key="print_packaging.size_matches_packaging",
        section=ChecklistSection.PRINT_PACKAGING,
        label="Label size matches packaging",
    ),
    ChecklistItem(
        key="print_packaging.print_colours",
        section=ChecklistSection.PRINT_PACKAGING,
        label="Correct print colours & branding",
    ),
    ChecklistItem(
        key="print_packaging.waterproof",
        section=ChecklistSection.PRINT_PACKAGING,
        label="Waterproof & smudge-proof labelling verified",
    ),
)


#: Set of valid checklist keys — used by the review serializer to
#: validate that the submitted payload covers exactly the checklist
#: (no missing items, no extras). Materialised at import time so the
#: validator is O(1) per key.
COMPLIANCE_CHECKLIST_KEYS: frozenset[str] = frozenset(
    item.key for item in COMPLIANCE_CHECKLIST
)
