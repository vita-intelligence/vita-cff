"""Pagination classes for the formulations API.

Cursor pagination matches the pattern used by the catalogues API —
the list endpoint never needs random-page access, only forward and
backward streaming as the scientist scrolls through their workspace.
"""

from __future__ import annotations

from rest_framework.pagination import CursorPagination


class FormulationCursorPagination(CursorPagination):
    page_size = 50
    max_page_size = 200
    page_size_query_param = "page_size"
    ordering = "-updated_at"
    cursor_query_param = "cursor"
