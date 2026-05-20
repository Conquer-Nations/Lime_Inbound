"""Vendor document uploads — driver's license, insurance, plate photos, etc.

Files live on the backend filesystem under settings.uploads_dir. We keep one
file per (container_id, kind); a re-upload overwrites both the row and the
disk file. The database holds the metadata + relative storage path.
"""
from __future__ import annotations

import mimetypes
import os
import uuid
from pathlib import Path
from typing import Final

from app.config import settings


# The seven document kinds the vendor must (or may) provide alongside the
# driver/truck text fields. Key = stable identifier persisted to the DB; value
# = human label rendered in the UI / activity log.
DOCUMENT_KINDS: Final[dict[str, str]] = {
    "front_license_plate": "Front license plate",
    "back_license_plate": "Back license plate",
    "door_mc_dot": "Door (MC / DOT no.)",
    "driver_license": "Driver's license",
    "insurance": "Insurance",
    "registration": "Registration",
    "dispatch_order": "Driver info sheet / Dispatch order / Tender",
    # Bill of Lading — uploaded via the Update Shipment screen before
    # the truck arrives. Paired with WHPO.bol_number (text input on the
    # same screen) which is what populates F5 on the scan sheet.
    "bol": "Bill of Lading (BOL)",
}


ALLOWED_CONTENT_TYPES: Final[set[str]] = {
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
    "image/gif",
    "application/pdf",
}


class UploadError(Exception):
    pass


def is_valid_kind(kind: str) -> bool:
    return kind in DOCUMENT_KINDS


def _base_dir() -> Path:
    base = Path(settings.uploads_dir).expanduser().resolve()
    base.mkdir(parents=True, exist_ok=True)
    return base


def container_dir(container_id: int) -> Path:
    d = _base_dir() / "containers" / str(container_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def absolute_path(storage_path: str) -> Path:
    """Resolve a relative `storage_path` (as persisted in the DB) to an
    absolute path under `uploads_dir`. Guards against `..` traversal."""
    base = _base_dir()
    resolved = (base / storage_path).resolve()
    if not str(resolved).startswith(str(base)):
        raise UploadError("Path traversal blocked.")
    return resolved


def pick_extension(filename: str, content_type: str) -> str:
    """Pick a sensible extension. Trust the original filename's suffix if it
    has one; otherwise infer from content_type. Always lowercase."""
    suffix = Path(filename).suffix.lower()
    if suffix:
        return suffix
    guessed = mimetypes.guess_extension(content_type or "") or ".bin"
    return guessed.lower()


def save_bytes(
    container_id: int,
    kind: str,
    data: bytes,
    original_filename: str,
    content_type: str,
) -> tuple[str, str]:
    """Write `data` to disk under containers/{container_id}/. Returns
    (storage_path_relative, absolute_path_str).

    Uses a uuid-suffixed filename so a re-upload doesn't clobber a stale-but-
    still-referenced file on disk before the DB row is updated. The caller is
    responsible for deleting any prior file once the new row is committed.
    """
    ext = pick_extension(original_filename, content_type)
    fname = f"{kind}-{uuid.uuid4().hex[:12]}{ext}"
    dest_dir = container_dir(container_id)
    abs_path = dest_dir / fname
    abs_path.write_bytes(data)
    base = _base_dir()
    rel = abs_path.relative_to(base).as_posix()
    return rel, str(abs_path)


def delete_storage_file(storage_path: str) -> None:
    """Best-effort delete of a previously stored file. Silent on missing."""
    try:
        p = absolute_path(storage_path)
    except UploadError:
        return
    try:
        if p.is_file():
            p.unlink()
    except OSError:
        # Permission / IO error — log and move on; the DB row still gets
        # replaced, just leaves a stray file on disk for ops to clean up.
        return


def public_url(container_no: str, kind: str) -> str:
    """The URL the frontend uses to fetch the stored file."""
    return f"/api/vendor/container/{container_no}/documents/{kind}/file"
