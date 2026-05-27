"""Label-design workflow app.

Picks up where the spec-sheet customer signature leaves off: the
project is APPROVED and now needs an actual physical-product label
that is regulation-compliant, customer-approved, and ready for
print. The app owns the state machine + reviews + customer-portal
surface for that phase, and emits a spec-derived **Compliance
Content Block** in PDF / PNG / text so designers can paste it into
whichever tool they prefer (Canva, Illustrator, Figma, Word …).

App entry-points wired in :mod:`apps.label_design.apps`.
"""

default_app_config = "apps.label_design.apps.LabelDesignConfig"
