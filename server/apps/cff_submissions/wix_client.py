"""Thin HTTP wrapper around the Wix REST API for the CFF intake.

Stateless: each instance is bound to a single org's
:class:`WixCFFConfig` (api key + site id). The Celery task and the
verify-connection endpoint instantiate one per org per call.

Endpoints used:

* ``POST /form-submission-service/v4/submissions/namespace/query``
  — list / page through submissions for a given form. Wix's sort
  field whitelist excludes ``_createdDate desc``, so we walk the
  cursor in natural order and let the DB sort on read.
* ``POST /form-submission-service/v4/submissions/count`` — used by
  :func:`verify_wix_cff_connection` to probe the integration
  cheaply (one round-trip, no body parsing).
* ``GET /form-schema-service/v4/forms/{form_id}`` — fetches the
  form definition (field labels) for
  :class:`apps.cff_submissions.models.WixFormSchemaCache`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Iterable

import requests

logger = logging.getLogger(__name__)


WIX_API_BASE = "https://www.wixapis.com"

#: All endpoints we hit live under one of two services. Both expect
#: ``Authorization: <api_key>`` (no Bearer prefix) plus a
#: ``wix-site-id`` header — Form Submissions and Form Schema are
#: both site-level APIs.
_SUBMISSIONS_BASE = f"{WIX_API_BASE}/form-submission-service/v4/submissions"
_SCHEMA_BASE = f"{WIX_API_BASE}/form-schema-service/v4/forms"

#: Per-request timeout. Wix's p99 for these endpoints is well under
#: 5s; anything longer is a stuck connection and we'd rather fail
#: fast so the Celery task can retry on the next tick instead of
#: pinning a worker.
DEFAULT_TIMEOUT_SECONDS = 15

#: Max page size accepted by Wix's Query Submissions endpoint.
MAX_PAGE_SIZE = 100


class WixAPIError(RuntimeError):
    """Raised for any non-2xx response from the Wix API.

    Status code and response body are surfaced so callers can
    distinguish retryable (5xx, 429) from non-retryable (4xx config
    error) without re-parsing strings.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: int,
        body: str,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.body = body


@dataclass(frozen=True)
class WixSubmissionPage:
    """One page of submissions plus the cursor for the next page."""

    submissions: list[dict[str, Any]]
    next_cursor: str | None
    total: int | None


class WixClient:
    """Stateless wrapper bound to a single ``(api_key, site_id)`` pair.

    All methods translate HTTP errors into :class:`WixAPIError`.
    Retries are NOT handled here — that belongs at the Celery task
    layer which already has backoff and visibility into the broader
    import state.
    """

    def __init__(
        self,
        *,
        api_key: str,
        site_id: str,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        if not api_key:
            raise ValueError("WixClient requires an api_key.")
        if not site_id:
            raise ValueError("WixClient requires a site_id.")
        self._api_key = api_key
        self._site_id = site_id
        self._timeout = timeout_seconds

    # ------------------------------------------------------------------
    # Submissions
    # ------------------------------------------------------------------

    def query_submissions(
        self,
        *,
        form_id: str,
        namespace: str,
        cursor: str | None = None,
        limit: int = MAX_PAGE_SIZE,
    ) -> WixSubmissionPage:
        """Fetch one page of submissions for a form.

        ``cursor`` is the opaque token from the previous response's
        ``pagingMetadata.cursors.next`` (or ``None`` for the first
        page). Wix caps ``limit`` at 100; we cap higher values to
        avoid a 400 round-trip.
        """

        payload: dict[str, Any] = {
            "query": {
                "filter": {
                    "namespace": namespace,
                    "formId": {"$eq": form_id},
                },
                "paging": {"limit": min(limit, MAX_PAGE_SIZE)},
            }
        }
        if cursor:
            # Cursor and offset paging are exclusive in Wix's
            # contract — drop ``paging.limit`` once a cursor takes
            # over.
            payload["query"]["cursorPaging"] = {"cursor": cursor}
            payload["query"].pop("paging", None)

        body = self._post(f"{_SUBMISSIONS_BASE}/namespace/query", payload)
        submissions = body.get("submissions") or []
        meta = body.get("pagingMetadata") or body.get("metadata") or {}
        next_cursor = (meta.get("cursors") or {}).get("next")
        total = meta.get("total")
        return WixSubmissionPage(
            submissions=submissions,
            next_cursor=next_cursor,
            total=total,
        )

    def iter_submissions(
        self,
        *,
        form_id: str,
        namespace: str,
        page_size: int = MAX_PAGE_SIZE,
    ) -> Iterable[dict[str, Any]]:
        """Yield every submission for a form, walking the cursor.

        Defensive page cap stops us looping forever if Wix ever
        returns a self-referential cursor.
        """

        cursor: str | None = None
        pages_walked = 0
        while True:
            page = self.query_submissions(
                form_id=form_id,
                namespace=namespace,
                cursor=cursor,
                limit=page_size,
            )
            for sub in page.submissions:
                yield sub
            cursor = page.next_cursor
            pages_walked += 1
            if cursor is None:
                return
            if pages_walked > 1000:
                logger.error(
                    "wix.iter_submissions hit the 1000-page cap for form "
                    "%s — aborting to avoid an infinite loop.",
                    form_id,
                )
                return

    def count_submissions(
        self,
        *,
        form_id: str,
        namespace: str,
    ) -> int:
        """Total submissions for a form regardless of status.

        Used by :func:`verify_wix_cff_connection` as a cheap probe
        — one round-trip, integer back, no body parsing.
        """

        payload = {"formIds": [form_id], "namespace": namespace}
        body = self._post(f"{_SUBMISSIONS_BASE}/count", payload)
        counts = body.get("formsSubmissionsCount") or []
        for entry in counts:
            if entry.get("formId") == form_id:
                return int(entry.get("totalCount") or 0)
        return 0

    # ------------------------------------------------------------------
    # Form schema (field labels)
    # ------------------------------------------------------------------

    def get_form(self, form_id: str) -> dict[str, Any]:
        """Fetch the form definition. Returned shape is Wix's raw
        Form object — the caller extracts the bits it cares about
        (typically ``fields``).
        """

        return self._get(f"{_SCHEMA_BASE}/{form_id}")

    # ------------------------------------------------------------------
    # Low-level HTTP
    # ------------------------------------------------------------------

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": self._api_key,
            "wix-site-id": self._site_id,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    def _post(self, url: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            response = requests.post(
                url,
                json=payload,
                headers=self._headers(),
                timeout=self._timeout,
            )
        except requests.RequestException as exc:
            raise WixAPIError(
                f"Wix request failed: {exc}",
                status_code=0,
                body=str(exc),
            ) from exc
        return self._parse(response)

    def _get(self, url: str) -> dict[str, Any]:
        try:
            response = requests.get(
                url,
                headers=self._headers(),
                timeout=self._timeout,
            )
        except requests.RequestException as exc:
            raise WixAPIError(
                f"Wix request failed: {exc}",
                status_code=0,
                body=str(exc),
            ) from exc
        return self._parse(response)

    @staticmethod
    def _parse(response: requests.Response) -> dict[str, Any]:
        if not (200 <= response.status_code < 300):
            raise WixAPIError(
                f"Wix returned {response.status_code}",
                status_code=response.status_code,
                body=response.text[:2000],
            )
        try:
            return response.json()
        except ValueError as exc:
            raise WixAPIError(
                f"Wix returned non-JSON body: {exc}",
                status_code=response.status_code,
                body=response.text[:2000],
            ) from exc


def build_client_for_organization(organization: Any) -> WixClient:
    """Convenience: decrypt the org's stored config and return a
    ready-to-use client. Raises :class:`WixCFFNotConfigured` if the
    integration is off and :class:`WixCFFDecryptionFailed` if the
    stored ciphertext is unreadable.
    """

    # Imported lazily to keep this module's import graph minimal
    # — the client is sometimes built from tests that mock the
    # integration entirely.
    from .integration import get_wix_cff_config

    config = get_wix_cff_config(organization=organization)
    return WixClient(api_key=config.api_key, site_id=config.site_id)
