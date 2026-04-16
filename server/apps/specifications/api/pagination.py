"""Pagination for the specifications API.

Matches the cursor shape the formulations list uses so the frontend
reuses the same infinite-scroll pattern.
"""

from __future__ import annotations

from rest_framework.pagination import CursorPagination


class SpecificationCursorPagination(CursorPagination):
    page_size = 50
    max_page_size = 200
    page_size_query_param = "page_size"
    ordering = "-updated_at"
    cursor_query_param = "cursor"
