"""Mirror vendor-uploaded documents into the local OneDrive sync folder.

The OneDrive desktop client (running on the same machine as the backend)
handles all the cloud sync — folder creation, file uploads, replacements,
deletions. We just write files locally in the desired structure and let
OneDrive's own sync engine push them to the cloud.

Tree shape inside the configured sync root:

    {sync_root}/{Company}/{YYYY}/{MM - Month}/WHPO {whpo}/{container}/{kind}.{ext}

Best-effort: every helper here logs and swallows failures. Vendor uploads
never fail because the OneDrive mirror is unreachable — Postgres + the
backend-managed local file are the source of truth; the OneDrive copy is
a convenience mirror.
"""
from __future__ import annotations

import logging
import re
import shutil
from datetime import date
from pathlib import Path

from app.config import settings
from app.services import vendor_uploads

logger = logging.getLogger(__name__)

# OneDrive disallows these in folder / file names.
_ILLEGAL = re.compile(r'[\\/:*?"<>|]+')


def is_configured() -> bool:
    """True iff a sync root is configured AND points at an existing folder.
    Returning False here makes every public helper a no-op."""
    if not settings.onedrive_local_sync_dir:
        return False
    return Path(settings.onedrive_local_sync_dir).expanduser().is_dir()


def _sanitize(s: str) -> str:
    cleaned = _ILLEGAL.sub(" ", s).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned or "untitled"


def compute_path(
    *,
    company: str,
    arrival_date: date,
    whpo_number: str,
    container_no: str,
    kind: str,
    original_filename: str,
    content_type: str,
) -> Path | None:
    """The exact spot a given document should land on disk. Returns None
    when the mirror isn't configured."""
    if not is_configured():
        return None
    base = Path(settings.onedrive_local_sync_dir).expanduser().resolve()
    year = f"{arrival_date.year:04d}"
    month = f"{arrival_date.month:02d} - {arrival_date.strftime('%B')}"
    whpo = f"WHPO {whpo_number.strip()}"
    container = container_no.strip().upper()
    ext = vendor_uploads.pick_extension(original_filename, content_type)
    filename = f"{kind}{ext}"
    return (
        base
        / _sanitize(company.strip())
        / _sanitize(year)
        / _sanitize(month)
        / _sanitize(whpo)
        / _sanitize(container)
        / _sanitize(filename)
    )


async def save_copy(
    *,
    company: str,
    arrival_date: date | None,
    whpo_number: str,
    container_no: str,
    kind: str,
    local_storage_path: str,
    original_filename: str,
    content_type: str,
) -> None:
    """Copy the just-saved local file into the OneDrive sync folder at the
    structured path. Idempotent (overwrites on re-upload)."""
    if not is_configured():
        return
    effective_date = arrival_date or date.today()
    target = compute_path(
        company=company,
        arrival_date=effective_date,
        whpo_number=whpo_number,
        container_no=container_no,
        kind=kind,
        original_filename=original_filename,
        content_type=content_type,
    )
    if target is None:
        return

    try:
        src = vendor_uploads.absolute_path(local_storage_path)
    except vendor_uploads.UploadError:
        logger.warning(
            "onedrive_local_sync: bad storage path %s", local_storage_path
        )
        return
    if not src.is_file():
        logger.warning("onedrive_local_sync: source missing %s", src)
        return

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        # copy2 preserves mtime — OneDrive's sync detects it as a new write.
        shutil.copy2(src, target)
        logger.info("onedrive_local_sync: wrote %s", target)
    except OSError as e:
        logger.warning(
            "onedrive_local_sync: write failed target=%s err=%r", target, e
        )


async def delete_copy(
    *,
    company: str,
    arrival_date: date | None,
    whpo_number: str,
    container_no: str,
    kind: str,
    original_filename: str,
    content_type: str,
) -> None:
    """Remove the OneDrive-mirrored file (and prune empty parent folders up
    to the company level)."""
    if not is_configured():
        return
    effective_date = arrival_date or date.today()
    target = compute_path(
        company=company,
        arrival_date=effective_date,
        whpo_number=whpo_number,
        container_no=container_no,
        kind=kind,
        original_filename=original_filename,
        content_type=content_type,
    )
    if target is None or not target.is_file():
        return
    try:
        target.unlink()
        logger.info("onedrive_local_sync: deleted %s", target)
    except OSError as e:
        logger.warning(
            "onedrive_local_sync: delete failed target=%s err=%r", target, e
        )
        return

    # Best-effort prune of now-empty container / WHPO / month / year /
    # company folders. Stop at the configured base.
    base = Path(settings.onedrive_local_sync_dir).expanduser().resolve()
    parent = target.parent
    while parent != base and parent.is_dir():
        try:
            next(parent.iterdir())
            break  # not empty — stop here
        except StopIteration:
            try:
                parent.rmdir()
            except OSError:
                break
            parent = parent.parent
