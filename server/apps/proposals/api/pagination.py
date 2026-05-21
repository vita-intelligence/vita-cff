"""Pagination classes for the proposals API.

Cursor pagination mirrors the formulations + catalogues APIs — the
list endpoint only ever needs forward / backward streaming as the
user scrolls; random-page jumps were never a real use case for a
``-updated_at``-ordered roster. ``ordering`` matches the queryset's
sort so the cursor's tie-break column lines up with the composite
``(organization, -updated_at)`` index already on the model.
"""

from __future__ import annotations

from rest_framework.pagination import CursorPagination


class ProposalCursorPagination(CursorPagination):
    #: 50 rows per page matches what the frontend's virtualiser
    #: comfortably buffers under one viewport — enough to fill the
    #: visible area + overscan without paying for rows the user may
    #: never scroll to.
    page_size = 50
    #: Cap raised to 500 so the short surfaces (approvals inbox,
    #: signed archive, per-project history) can pull the entire
    #: roster in one page without an infinite-scroll harness — those
    #: views are designed to render every row on a single screen.
    max_page_size = 500
    page_size_query_param = "page_size"
    ordering = "-updated_at"
    cursor_query_param = "cursor"
