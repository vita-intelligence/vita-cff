"""Pagination for the comments API.

Cursor pagination keyed on ``created_at`` so threads always stream
in stable chronological order even as new writes arrive. Default
page size is deliberately generous — a project workspace rarely
accumulates more than a few dozen comments and we want the UI to
render the full thread in one round-trip on the hot path.
"""

from __future__ import annotations

from rest_framework.pagination import CursorPagination


class CommentCursorPagination(CursorPagination):
    page_size = 100
    max_page_size = 500
    page_size_query_param = "page_size"
    ordering = "created_at"
    cursor_query_param = "cursor"
