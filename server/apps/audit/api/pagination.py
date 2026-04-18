"""Cursor pagination for the audit log list endpoint.

Same pattern as the catalogues items list — cursor pagination keeps
the UI's infinite-scroll behaviour stable even as new audit rows
stream in while the user is paging through history. Default page
size favours readability over throughput; the UI can bump it for
CSV-style exports if needed.
"""

from __future__ import annotations

from rest_framework.pagination import CursorPagination


class AuditLogCursorPagination(CursorPagination):
    page_size = 50
    max_page_size = 200
    page_size_query_param = "page_size"
    ordering = "-created_at"
    cursor_query_param = "cursor"
