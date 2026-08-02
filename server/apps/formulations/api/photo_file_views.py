"""Views for FormulationPhoto + FormulationFile attachments.

Both surfaces live on the formulation itself (bytes on NPD storage,
mirror uuid tracked per row). On upload we persist locally, then push
to PSP's finished-product item best-effort. On delete we teardown
locally, then teardown on PSP best-effort. Silent-degrade on any PSP
failure — the operator can retry sync from the stage strip.
"""

from __future__ import annotations

import logging
import mimetypes
from typing import Any

from django.db import models, transaction
from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.formulations.api.permissions import HasFormulationsPermission
from apps.formulations.models import (
    Formulation,
    FormulationFile,
    FormulationPhoto,
)
from apps.formulations.services import (
    FormulationNotFound,
    get_formulation,
)
from apps.organizations.modules import FormulationsCapability

logger = logging.getLogger(__name__)


_ALLOWED_IMAGE_MIMES = frozenset(
    ("image/png", "image/jpeg", "image/webp", "image/gif")
)
_MAX_IMAGE_BYTES = 5 * 1024 * 1024

_ALLOWED_FILE_MIMES = frozenset(
    (
        "application/pdf",
        "image/jpeg",
        "image/png",
        "image/webp",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "text/plain",
    )
)
_MAX_FILE_BYTES = 20 * 1024 * 1024


def _photo_payload(photo: FormulationPhoto) -> dict[str, Any]:
    return {
        "id": str(photo.id),
        "url": photo.image.url if photo.image else None,
        "caption": photo.caption,
        "purpose": photo.purpose,
        "is_primary": photo.is_primary,
        "sort_order": photo.sort_order,
        "original_filename": photo.original_filename,
        "content_type": photo.content_type,
        "byte_size": photo.byte_size,
        "psp_uuid": str(photo.psp_uuid) if photo.psp_uuid else None,
        "uploaded_at": photo.uploaded_at.isoformat(),
    }


_ALLOWED_PURPOSES = frozenset(
    (FormulationPhoto.Purpose.INTERNAL, FormulationPhoto.Purpose.CATALOG)
)


def _resolve_purpose(raw: Any) -> str:
    """Coerce a client-supplied purpose to a valid choice, defaulting
    to ``internal`` so legacy callers that never sent the field keep
    behaving as they did before."""

    value = (str(raw) if raw is not None else "").strip().lower()
    if value in _ALLOWED_PURPOSES:
        return value
    return FormulationPhoto.Purpose.INTERNAL


def _file_payload(file_row: FormulationFile) -> dict[str, Any]:
    return {
        "id": str(file_row.id),
        "url": file_row.file.url if file_row.file else None,
        "kind": file_row.kind,
        "filename": file_row.filename,
        "mime": file_row.mime,
        "byte_size": file_row.byte_size,
        "psp_uuid": str(file_row.psp_uuid) if file_row.psp_uuid else None,
        "uploaded_at": file_row.uploaded_at.isoformat(),
    }


def _push_photo_to_psp(formulation: Formulation, photo: FormulationPhoto) -> None:
    """Best-effort push of a newly uploaded photo. Cascade continues
    even if PSP isn't reachable — the operator can retry via Sync now.
    Only fires when the finished-product item already exists; the BOM
    save path handles first-time creation."""

    client = _psp_client_for(formulation)
    if client is None or not formulation.psp_finished_product_uuid:
        return
    from apps.psp.services import PspError

    try:
        with photo.image.open("rb") as fh:
            content = fh.read()
    except (OSError, ValueError):
        logger.warning("photo push: read failed for %s", photo.id)
        return
    try:
        response = client.upload_item_image(
            str(formulation.psp_finished_product_uuid),
            content=content,
            filename=photo.original_filename or f"photo-{photo.id}",
            content_type=photo.content_type or None,
        )
    except PspError as exc:
        logger.info("photo push: soft-fail: %s", exc)
        return
    if response and response.get("uuid"):
        photo.psp_uuid = str(response["uuid"])
        photo.save(update_fields=["psp_uuid"])


def _psp_client_for(formulation: Formulation):
    """Return a PspClient for the org, or ``None`` when PSP isn't
    live. Encapsulates the ``is_psp_live`` → ``get_psp_config`` →
    ``_client_factory`` chain so caller sites stay flat."""

    from apps.psp.services import (
        PspInvalidConfig,
        _client_factory,
        get_psp_config,
        is_psp_live,
    )

    if not is_psp_live(formulation.organization):
        return None
    try:
        config = get_psp_config(organization=formulation.organization)
        return _client_factory(config)
    except PspInvalidConfig:
        return None


def _push_file_to_psp(formulation: Formulation, file_row: FormulationFile) -> None:
    """Best-effort push of a newly uploaded file. Same contract as
    :func:`_push_photo_to_psp`."""

    client = _psp_client_for(formulation)
    if client is None or not formulation.psp_finished_product_uuid:
        return
    from apps.psp.services import PspError
    try:
        with file_row.file.open("rb") as fh:
            content = fh.read()
    except (OSError, ValueError):
        logger.warning("file push: read failed for %s", file_row.id)
        return
    try:
        response = client.upload_item_file(
            str(formulation.psp_finished_product_uuid),
            content=content,
            filename=file_row.filename,
            content_type=file_row.mime or None,
            kind=file_row.kind,
        )
    except PspError as exc:
        logger.info("file push: soft-fail: %s", exc)
        return
    if response and response.get("uuid"):
        file_row.psp_uuid = str(response["uuid"])
        file_row.save(update_fields=["psp_uuid"])


def _delete_photo_on_psp(formulation: Formulation, psp_uuid: str) -> None:
    client = _psp_client_for(formulation)
    if client is None or not formulation.psp_finished_product_uuid:
        return
    client.delete_item_image(
        str(formulation.psp_finished_product_uuid), psp_uuid
    )


def _delete_file_on_psp(formulation: Formulation, psp_uuid: str) -> None:
    client = _psp_client_for(formulation)
    if client is None or not formulation.psp_finished_product_uuid:
        return
    client.delete_item_file(
        str(formulation.psp_finished_product_uuid), psp_uuid
    )


# ---- Photos ----------------------------------------------------------


class FormulationPhotosView(APIView):
    """``GET`` list + ``POST`` upload for a formulation's photos."""

    permission_classes = (HasFormulationsPermission,)
    parser_classes = (MultiPartParser, FormParser)

    def initial(self, request, *args, **kwargs):  # type: ignore[override]
        self.required_capability = (
            FormulationsCapability.EDIT
            if request.method == "POST"
            else FormulationsCapability.VIEW
        )
        super().initial(request, *args, **kwargs)

    def _get_formulation(self, formulation_id: str) -> Formulation:
        try:
            return get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc

    def get(self, request: Request, org_id: str, formulation_id: str) -> Response:
        formulation = self._get_formulation(formulation_id)
        rows = formulation.photos.all()
        purpose_filter = request.query_params.get("purpose")
        if purpose_filter:
            rows = rows.filter(purpose=_resolve_purpose(purpose_filter))
        return Response({"items": [_photo_payload(p) for p in rows]})

    def post(self, request: Request, org_id: str, formulation_id: str) -> Response:
        formulation = self._get_formulation(formulation_id)
        upload = request.FILES.get("file")
        if upload is None:
            return Response(
                {"error": "missing_file", "detail": "Send the image under `file`."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        mime = upload.content_type or mimetypes.guess_type(upload.name or "")[0]
        if not mime or mime not in _ALLOWED_IMAGE_MIMES:
            return Response(
                {
                    "error": "invalid_mime_type",
                    "detail": f"Unsupported image type ({mime or 'unknown'}).",
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        if upload.size > _MAX_IMAGE_BYTES:
            return Response(
                {"error": "file_too_large", "detail": f"Max {_MAX_IMAGE_BYTES // 1024 // 1024} MB."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        caption = str(request.data.get("caption", "")).strip()[:200]
        purpose = _resolve_purpose(request.data.get("purpose"))
        make_primary = str(request.data.get("is_primary", "")).lower() in {
            "true",
            "1",
            "yes",
        }
        scope = formulation.photos.filter(purpose=purpose)
        with transaction.atomic():
            if make_primary:
                scope.filter(is_primary=True).update(is_primary=False)
            elif not scope.exists():
                # First photo in this purpose scope auto-promotes so
                # the catalog card (or Setup hero) has something to
                # render without a manual "make primary" click.
                make_primary = True
            # New photos land at the end of the sort order for their
            # purpose. Reorder endpoint (below) rewrites the whole
            # sequence when the user drags things around.
            next_sort = (
                (scope.aggregate(m=models.Max("sort_order")).get("m") or 0) + 1
                if scope.exists()
                else 0
            )
            photo = FormulationPhoto.objects.create(
                formulation=formulation,
                image=upload,
                caption=caption,
                purpose=purpose,
                is_primary=make_primary,
                sort_order=next_sort,
                original_filename=upload.name or "",
                content_type=mime,
                byte_size=upload.size or 0,
                uploaded_by=request.user,
            )
        _push_photo_to_psp(formulation, photo)
        photo.refresh_from_db()
        return Response(
            {"photo": _photo_payload(photo)},
            status=status.HTTP_201_CREATED,
        )


class FormulationPhotoDetailView(APIView):
    """``PATCH`` set primary + ``DELETE`` a photo."""

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def _get_photo(self, formulation_id: str, photo_id: str) -> FormulationPhoto:
        try:
            formulation = get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc
        photo = formulation.photos.filter(id=photo_id).first()
        if photo is None:
            raise NotFound()
        return photo

    def patch(
        self, request: Request, org_id: str, formulation_id: str, photo_id: str
    ) -> Response:
        photo = self._get_photo(formulation_id, photo_id)
        replacement = request.FILES.get("file")
        changed_fields: list[str] = []
        if "caption" in request.data:
            photo.caption = str(request.data.get("caption") or "").strip()[:200]
            changed_fields.append("caption")
        if "sort_order" in request.data:
            try:
                photo.sort_order = max(0, int(request.data["sort_order"]))
            except (TypeError, ValueError):
                return Response(
                    {"error": "invalid_sort_order"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            changed_fields.append("sort_order")
        if replacement is not None:
            mime = replacement.content_type or mimetypes.guess_type(
                replacement.name or ""
            )[0]
            if not mime or mime not in _ALLOWED_IMAGE_MIMES:
                return Response(
                    {
                        "error": "invalid_mime_type",
                        "detail": f"Unsupported image type ({mime or 'unknown'}).",
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if replacement.size > _MAX_IMAGE_BYTES:
                return Response(
                    {
                        "error": "file_too_large",
                        "detail": f"Max {_MAX_IMAGE_BYTES // 1024 // 1024} MB.",
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )
            # Drop the old file first so the storage layer doesn't
            # keep an orphan. ``save=False`` lets the coming save
            # persist the new image + metadata in one write.
            photo.image.delete(save=False)
            photo.image = replacement
            photo.original_filename = replacement.name or ""
            photo.content_type = mime
            photo.byte_size = replacement.size or 0
            # Clear ``psp_uuid`` so the next push cascade re-uploads
            # the replacement bytes instead of keeping the stale
            # remote asset.
            photo.psp_uuid = None
            changed_fields.extend(
                [
                    "image",
                    "original_filename",
                    "content_type",
                    "byte_size",
                    "psp_uuid",
                ]
            )
        if str(request.data.get("is_primary", "")).lower() in {"true", "1", "yes"}:
            with transaction.atomic():
                # ``is_primary`` is scoped per purpose so making a
                # catalog photo primary doesn't unset the Setup
                # primary (or vice versa).
                photo.formulation.photos.filter(
                    purpose=photo.purpose, is_primary=True
                ).exclude(id=photo.id).update(is_primary=False)
                photo.is_primary = True
                photo.save(update_fields=["is_primary", *changed_fields])
                if replacement is not None:
                    _push_photo_to_psp(photo.formulation, photo)
                photo.refresh_from_db()
                return Response({"photo": _photo_payload(photo)})
        if changed_fields:
            photo.save(update_fields=changed_fields)
        if replacement is not None:
            _push_photo_to_psp(photo.formulation, photo)
            photo.refresh_from_db()
        return Response({"photo": _photo_payload(photo)})

    def delete(
        self, request: Request, org_id: str, formulation_id: str, photo_id: str
    ) -> Response:
        photo = self._get_photo(formulation_id, photo_id)
        psp_uuid = str(photo.psp_uuid) if photo.psp_uuid else ""
        formulation = photo.formulation
        photo.image.delete(save=False)
        photo.delete()
        if psp_uuid:
            _delete_photo_on_psp(formulation, psp_uuid)
        return Response(status=status.HTTP_204_NO_CONTENT)


class FormulationPhotoReorderView(APIView):
    """``POST`` bulk reorder for a purpose scope.

    Body: ``{"purpose": "catalog", "order": ["<uuid1>", "<uuid2>", …]}``.
    Rewrites ``sort_order`` for every listed photo to match the sequence.
    Any photo in the same purpose scope not present in ``order`` keeps
    its current sort_order (should not happen from the UI, but avoids
    accidental data loss)."""

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def post(self, request: Request, org_id: str, formulation_id: str) -> Response:
        try:
            formulation = get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc
        purpose = _resolve_purpose(request.data.get("purpose"))
        order_raw = request.data.get("order") or []
        if not isinstance(order_raw, list):
            return Response(
                {"error": "invalid_order", "detail": "`order` must be a list of UUIDs."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        order_ids = [str(x) for x in order_raw if x]
        scope = formulation.photos.filter(purpose=purpose)
        known = {str(p.id): p for p in scope}
        with transaction.atomic():
            for index, photo_id in enumerate(order_ids):
                photo = known.get(photo_id)
                if photo is None:
                    continue
                if photo.sort_order != index:
                    photo.sort_order = index
                    photo.save(update_fields=["sort_order"])
        return Response(
            {
                "items": [
                    _photo_payload(p)
                    for p in formulation.photos.filter(purpose=purpose)
                ]
            }
        )


# ---- Files -----------------------------------------------------------


class FormulationFilesView(APIView):
    """``GET`` list + ``POST`` upload for a formulation's files."""

    permission_classes = (HasFormulationsPermission,)
    parser_classes = (MultiPartParser, FormParser)

    def initial(self, request, *args, **kwargs):  # type: ignore[override]
        self.required_capability = (
            FormulationsCapability.EDIT
            if request.method == "POST"
            else FormulationsCapability.VIEW
        )
        super().initial(request, *args, **kwargs)

    def _get_formulation(self, formulation_id: str) -> Formulation:
        try:
            return get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc

    def get(self, request: Request, org_id: str, formulation_id: str) -> Response:
        formulation = self._get_formulation(formulation_id)
        rows = formulation.files.all()
        return Response({"items": [_file_payload(f) for f in rows]})

    def post(self, request: Request, org_id: str, formulation_id: str) -> Response:
        formulation = self._get_formulation(formulation_id)
        upload = request.FILES.get("file")
        if upload is None:
            return Response(
                {"error": "missing_file", "detail": "Send the file under `file`."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        mime = upload.content_type or mimetypes.guess_type(upload.name or "")[0]
        if not mime or mime not in _ALLOWED_FILE_MIMES:
            return Response(
                {
                    "error": "invalid_mime_type",
                    "detail": f"Unsupported file type ({mime or 'unknown'}).",
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        if upload.size > _MAX_FILE_BYTES:
            return Response(
                {"error": "file_too_large", "detail": f"Max {_MAX_FILE_BYTES // 1024 // 1024} MB."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        kind_raw = str(request.data.get("kind", "other")).strip() or "other"
        valid_kinds = {choice.value for choice in FormulationFile.Kind}
        if kind_raw not in valid_kinds:
            return Response(
                {"error": "invalid_kind", "detail": f"Unknown kind: {kind_raw}."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        file_row = FormulationFile.objects.create(
            formulation=formulation,
            file=upload,
            kind=kind_raw,
            filename=upload.name or "upload",
            mime=mime,
            byte_size=upload.size or 0,
            uploaded_by=request.user,
        )
        _push_file_to_psp(formulation, file_row)
        file_row.refresh_from_db()
        return Response(
            {"file": _file_payload(file_row)},
            status=status.HTTP_201_CREATED,
        )


class FormulationFileDetailView(APIView):
    """``DELETE`` a file."""

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def delete(
        self, request: Request, org_id: str, formulation_id: str, file_id: str
    ) -> Response:
        try:
            formulation = get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc
        file_row = formulation.files.filter(id=file_id).first()
        if file_row is None:
            raise NotFound()
        psp_uuid = str(file_row.psp_uuid) if file_row.psp_uuid else ""
        file_row.file.delete(save=False)
        file_row.delete()
        if psp_uuid:
            _delete_file_on_psp(formulation, psp_uuid)
        return Response(status=status.HTTP_204_NO_CONTENT)
