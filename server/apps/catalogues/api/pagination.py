"""Pagination classes for the catalogues API.

Cursor pagination is the right fit for an Excel-like infinite-scroll
list: it is stable under concurrent inserts/deletes, does not pay for
``COUNT(*)`` on every request, and the client walks forward and
backward by following the opaque ``next``/``previous`` cursors.
"""

from __future__ import annotations

from rest_framework.pagination import CursorPagination


class ItemCursorPagination(CursorPagination):
    page_size = 100
    max_page_size = 500
    page_size_query_param = "page_size"
    ordering = "-created_at"
    cursor_query_param = "cursor"
