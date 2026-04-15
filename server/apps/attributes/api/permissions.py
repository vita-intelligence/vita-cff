"""DRF permission class for the attributes API.

Attribute definitions belong to a :class:`Catalogue`, so their access
is governed by the same row-scoped ``catalogues`` permission module
the catalogue items are gated on. Managing the attribute schema
requires ``ADMIN`` on the catalogue slug.
"""

from __future__ import annotations

from apps.catalogues.api.permissions import HasCataloguePermission


class HasAttributePermission(HasCataloguePermission):
    """Alias so the attributes views can declare an obvious-name class.

    All logic lives on :class:`HasCataloguePermission` — attribute
    endpoints are just another operation on a catalogue row. Using a
    subclass keeps imports expressive without duplicating behaviour.
    """

    pass
