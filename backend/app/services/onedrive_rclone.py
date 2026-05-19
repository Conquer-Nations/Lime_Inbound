"""Upload vendor documents to OneDrive via the rclone CLI.

rclone is a third-party file-sync tool that ships with its own pre-
registered multi-tenant Microsoft app. When USC (or any tenant) blocks
Microsoft first-party client IDs (Azure CLI, Graph PowerShell, etc.)
from talking to Graph, rclone often still works — different consent
gate.

One-time setup on the machine running the backend:

    brew install rclone        # or `apt install rclone` on Linux
    rclone config              # follow prompts to add a OneDrive remote

When `rclone config` asks for the type, pick `onedrive`. When it asks
about the OAuth flow, it opens a browser to sign in as your USC user.
After you grant consent, rclone stores a refresh token locally.

After setup, put the remote name (e.g. "onedrive") into .env:

    ONEDRIVE_RCLONE_ENABLED=true
    ONEDRIVE_RCLONE_REMOTE=onedrive
    ONEDRIVE_RCLONE_ROOT="Vendor Files"

Best-effort: every helper here logs and swallows failures. Vendor
uploads never fail because rclone is unreachable.
"""
from __future__ import annotations

import asyncio
import logging
import re
import shutil
from datetime import date
from pathlib import Path

from app.config import settings
from app.services import vendor_uploads

logger = logging.getLogger(__name__)

_ILLEGAL = re.compile(r'[\\/:*?"<>|]+')


def _sanitize(s: str) -> str:
    cleaned = _ILLEGAL.sub(" ", s).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned or "untitled"


def is_configured() -> bool:
    """True iff rclone is enabled, a remote name is set, AND the rclone
    binary is on $PATH."""
    if not settings.onedrive_rclone_enabled:
        return False
    if not settings.onedrive_rclone_remote:
        return False
    binary = settings.onedrive_rclone_binary or "rclone"
    return shutil.which(binary) is not None


def _build_remote_path(
    *,
    company: str,
    arrival_date: date,
    whpo_number: str,
    container_no: str,
    kind: str,
    original_filename: str,
    content_type: str,
) -> str:
    """`{remote}:{root}/{Company}/{YYYY}/{MM - Month}/WHPO {whpo}/{container}/{kind}.{ext}`"""
    year = f"{arrival_date.year:04d}"
    month = f"{arrival_date.month:02d} - {arrival_date.strftime('%B')}"
    whpo = f"WHPO {whpo_number.strip()}"
    container = container_no.strip().upper()
    ext = vendor_uploads.pick_extension(original_filename, content_type)
    filename = f"{kind}{ext}"
    parts = [
        _sanitize(settings.onedrive_rclone_root),
        _sanitize(company.strip()),
        _sanitize(year),
        _sanitize(month),
        _sanitize(whpo),
        _sanitize(container),
        _sanitize(filename),
    ]
    return f"{settings.onedrive_rclone_remote}:{'/'.join(parts)}"


async def _run(*args: str, timeout: float = 120.0) -> tuple[int, str, str]:
    """Run rclone with the given args. Returns (returncode, stdout, stderr)."""
    binary = settings.onedrive_rclone_binary or "rclone"
    try:
        proc = await asyncio.create_subprocess_exec(
            binary,
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        logger.warning("onedrive_rclone: binary not found: %s", binary)
        return 127, "", f"rclone binary not found: {binary}"

    try:
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=timeout
        )
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        logger.warning("onedrive_rclone: timed out after %.0fs", timeout)
        return 124, "", "rclone timed out"

    return (
        proc.returncode or 0,
        stdout.decode("utf-8", errors="replace"),
        stderr.decode("utf-8", errors="replace"),
    )


async def upload_document(
    *,
    company: str,
    arrival_date: date | None,
    whpo_number: str,
    container_no: str,
    kind: str,
    storage_path: str,
    original_filename: str,
    content_type: str,
) -> None:
    if not is_configured():
        return
    effective_date = arrival_date or date.today()
    dest = _build_remote_path(
        company=company,
        arrival_date=effective_date,
        whpo_number=whpo_number,
        container_no=container_no,
        kind=kind,
        original_filename=original_filename,
        content_type=content_type,
    )
    try:
        src = vendor_uploads.absolute_path(storage_path)
    except vendor_uploads.UploadError:
        logger.warning("onedrive_rclone: bad storage path %s", storage_path)
        return
    if not src.is_file():
        logger.warning("onedrive_rclone: source missing %s", src)
        return

    # `copyto` lets us specify the destination filename (vs `copy` which
    # treats the second arg as a folder). rclone's default behavior is
    # to overwrite if size or hash differs, which matches our "replace
    # on re-upload" semantics.
    rc, out, err = await _run("copyto", str(src), dest)
    if rc == 0:
        logger.info("onedrive_rclone: uploaded %s", dest)
    else:
        logger.warning(
            "onedrive_rclone: upload failed rc=%s dest=%s stderr=%s",
            rc,
            dest,
            err.strip()[:500],
        )


async def delete_document(
    *,
    company: str,
    arrival_date: date | None,
    whpo_number: str,
    container_no: str,
    kind: str,
    original_filename: str,
    content_type: str,
) -> None:
    if not is_configured():
        return
    effective_date = arrival_date or date.today()
    dest = _build_remote_path(
        company=company,
        arrival_date=effective_date,
        whpo_number=whpo_number,
        container_no=container_no,
        kind=kind,
        original_filename=original_filename,
        content_type=content_type,
    )
    rc, out, err = await _run("deletefile", dest)
    if rc == 0:
        logger.info("onedrive_rclone: deleted %s", dest)
    else:
        # rclone returns non-zero if the file doesn't exist — fine, we
        # tolerate it (vendor double-deletes, etc.). Just log at info.
        logger.info(
            "onedrive_rclone: delete rc=%s (often 'not found') dest=%s",
            rc,
            dest,
        )
