"""Payments app.

Records customer payments against a project. Two-step lifecycle:
``record_payment`` writes the row in ``PENDING`` status; an approver
with ``FinanceCapability.APPROVE_PAYMENT`` flips it to ``APPROVED``,
which unlocks the downstream :class:`apps.label_design.models.LabelDesign`
workflow (``PAYMENT_PENDING -> LABEL_PATH_PENDING``).

Kept separate from the ``label_design`` app on purpose — payments
outlive label design (a customer can re-buy a project after a
labelling failure / re-spec), and the finance role is genuinely
orthogonal to labelling.
"""

default_app_config = "apps.payments.apps.PaymentsConfig"
