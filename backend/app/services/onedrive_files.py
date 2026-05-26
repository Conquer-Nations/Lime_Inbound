"""OneDrive mirror for vendor-uploaded container documents.

A separate Logic App (`cn-warehouse-vendor-files`) accepts a JSON payload with
a base64-encoded file plus path components, walks the OneDrive folder chain
(creating folders that don't exist), and uploads the file with conflict
behavior = replace.

Tree layout:

    /{root}/{Company}/{YYYY}/{MM - Month}/WHPO {whpo}/{container_no}/{kind}.{ext}

`root` defaults to "Vendor Files" (config: ONEDRIVE_VENDOR_FILES_ROOT).

Best-effort: every helper here logs and swallows failures. Vendor uploads
never fail because OneDrive is unreachable — Postgres + the local file are
the source of truth; the OneDrive copy is a convenience mirror.
"""

from __future__ import annotations

import base64
import logging
import re
from datetime import date
from pathlib import Path

import httpx

from app.config import settings
from app.services import vendor_uploads

logger = logging.getLogger(__name__)


# ─── Config ─────────────────────────────────────────────────────────────


def is_configured() -> bool:
    return bool(settings.onedrive_vendor_files_url)


# ─── Path-component helpers ─────────────────────────────────────────────

# OneDrive disallows: \ / : * ? " < > |  and trailing whitespace.
_ILLEGAL_FOLDER_CHARS = re.compile(r'[\\/:*?"<>|]+')


def sanitize(component: str) -> str:
    """Strip OneDrive-illegal characters out of a single folder/file name."""
    cleaned = _ILLEGAL_FOLDER_CHARS.sub(" ", component).strip()
    # Collapse runs of whitespace.
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned or "untitled"


def year_folder(d: date) -> str:
    return f"{d.year:04d}"


def month_folder(d: date) -> str:
    """Format like '05 - May' so alphabetical sort = chronological."""
    return f"{d.month:02d} - {d.strftime('%B')}"


def whpo_folder(whpo_number: str) -> str:
    return f"WHPO {whpo_number.strip()}"


def container_folder(container_no: str) -> str:
    return container_no.strip().upper()


def file_name(kind: str, original_filename: str, content_type: str) -> str:
    """Use the kind as the basename so multiple uploads of the same kind end
    up at the same OneDrive path → replace overwrites in place."""
    ext = vendor_uploads.pick_extension(original_filename, content_type)
    return f"{kind}{ext}"


def build_path_parts(
    *,
    company: str,
    arrival_date: date,
    whpo_number: str,
    container_no: str,
    kind: str,
    original_filename: str,
    content_type: str,
) -> dict[str, str]:
    """Compute every component of the OneDrive path. Returns a dict the Logic
    App can use directly to build its folder chain + upload URL."""
    return {
        "root": sanitize(settings.onedrive_vendor_files_root),
        "company": sanitize(company),
        "year": sanitize(year_folder(arrival_date)),
        "month": sanitize(month_folder(arrival_date)),
        "whpo": sanitize(whpo_folder(whpo_number)),
        "container": sanitize(container_folder(container_no)),
        "filename": sanitize(file_name(kind, original_filename, content_type)),
        # Convenience: full path so Logic App can use a single expression if
        # it prefers Graph PUT (which auto-creates intermediate folders).
        "full_path": "/".join(
            [
                sanitize(settings.onedrive_vendor_files_root),
                sanitize(company),
                sanitize(year_folder(arrival_date)),
                sanitize(month_folder(arrival_date)),
                sanitize(whpo_folder(whpo_number)),
                sanitize(container_folder(container_no)),
                sanitize(file_name(kind, original_filename, content_type)),
            ]
        ),
    }


# ─── Container-folder hierarchy (Account/Brand/Quarter/Month/Container) ──
#
# Per Tiana's request, every document related to a container (POD, generated
# tally sheet, driver license, truck photos, etc.) lands in a single folder:
#
#   /{root}/{Account}/{Brand}/Q{n} {YYYY}/{Month YYYY}/{Container}/{file}
#
# e.g. /Vendor Files/TQL Trading Inc/Lime/Q2 2026/May 2026/ZCSU7954612/POD.pdf
#
# Brands roll up to billing Accounts (TQL → Lime / Boviet / Pan Am / NP).
# Quarter + Month derive from the container's actual or expected arrival
# date. If no arrival date is on file we default to today so the upload
# still lands somewhere reasonable.


def quarter_folder(d: date) -> str:
    """'Q2 2026'-style. Calendar quarters."""
    return f"Q{((d.month - 1) // 3) + 1} {d.year:04d}"


def month_year_folder(d: date) -> str:
    """'May 2026'-style. Reading-order, matches Tiana's request."""
    return d.strftime("%B %Y")


def build_container_path_parts(
    *,
    account: str | None,
    brand: str,
    arrival_date: date | None,
    container_no: str,
    filename: str,
) -> dict[str, str]:
    """Compute Account/Brand/Quarter/Month/Container path components.
    `account` is optional: a direct-bill brand with no parent account
    drops the Account folder so the path becomes
    /{root}/{Brand}/Q.../Month .../{Container}/{file}."""
    from datetime import date as _date
    eff_date = arrival_date or _date.today()
    components: list[str] = [
        sanitize(settings.onedrive_vendor_files_root),
    ]
    if account:
        components.append(sanitize(account))
    components.extend(
        [
            sanitize(brand),
            sanitize(quarter_folder(eff_date)),
            sanitize(month_year_folder(eff_date)),
            sanitize(container_folder(container_no)),
            sanitize(filename),
        ]
    )
    return {
        "root": sanitize(settings.onedrive_vendor_files_root),
        "account": sanitize(account) if account else "",
        "brand": sanitize(brand),
        "quarter": sanitize(quarter_folder(eff_date)),
        "month": sanitize(month_year_folder(eff_date)),
        "container": sanitize(container_folder(container_no)),
        "filename": sanitize(filename),
        "full_path": "/".join(components),
    }


async def upload_to_container_folder(
    *,
    account: str | None,
    brand: str,
    arrival_date: date | None,
    container_no: str,
    data: bytes,
    filename: str,
    content_type: str,
) -> None:
    """Upload `data` (raw bytes) to OneDrive under
    {root}/{Account}/{Brand}/Q.../Month.../{Container}/{filename}.
    Best-effort. Logged + swallowed on any failure.

    Routes to the dedicated `onedrive_container_files_url` Logic App
    when set (the one whose Office Script handles the new hierarchy).
    Falls back to the legacy vendor-files Logic App when unset — but
    that one expects the old WHPO-based layout, so the file will land
    in the wrong spot. Always set the env var in App Service config."""
    target_url = (
        settings.onedrive_container_files_url
        or settings.onedrive_vendor_files_url
    )
    if not target_url:
        return
    parts = build_container_path_parts(
        account=account,
        brand=brand,
        arrival_date=arrival_date,
        container_no=container_no,
        filename=filename,
    )
    payload = {
        **parts,
        "content_type": content_type,
        "data_base64": base64.b64encode(data).decode("ascii"),
        "hierarchy": "container",
    }
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            res = await client.post(target_url, json=payload)
            if res.status_code >= 400:
                logger.warning(
                    "onedrive container upload %s/%s: HTTP %s — %s",
                    container_no,
                    filename,
                    res.status_code,
                    res.text[:300],
                )
            else:
                logger.info(
                    "onedrive container upload ok: %s",
                    parts.get("full_path"),
                )
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "onedrive container upload %s/%s failed: %r",
            container_no,
            filename,
            e,
        )


# ─── Sync actions ───────────────────────────────────────────────────────


async def _post(payload: dict, *, label: str) -> None:
    if not is_configured():
        return
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            res = await client.post(
                settings.onedrive_vendor_files_url, json=payload
            )
            if res.status_code >= 400:
                logger.warning(
                    "onedrive_files %s: %s — %s",
                    label,
                    res.status_code,
                    res.text[:300],
                )
            else:
                logger.info(
                    "onedrive_files %s ok (status=%s, path=%s)",
                    label,
                    res.status_code,
                    payload.get("full_path"),
                )
    except Exception as e:  # noqa: BLE001
        logger.warning("onedrive_files %s failed: %r", label, e)


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
    """Read the just-saved local file and POST it to the Logic App as base64.
    Falls back to today's date when `arrival_date` is None."""
    if not is_configured():
        return

    effective_date = arrival_date or date.today()
    abs_path = vendor_uploads.absolute_path(storage_path)
    if not abs_path.is_file():
        logger.warning(
            "onedrive_files upload skipped: file missing on disk (%s)", abs_path
        )
        return

    try:
        data_b64 = base64.b64encode(abs_path.read_bytes()).decode("ascii")
    except OSError as e:
        logger.warning("onedrive_files upload read failed: %r", e)
        return

    parts = build_path_parts(
        company=company,
        arrival_date=effective_date,
        whpo_number=whpo_number,
        container_no=container_no,
        kind=kind,
        original_filename=original_filename,
        content_type=content_type,
    )

    payload = {
        "action": "upload",
        **parts,
        "kind": kind,
        "content_type": content_type,
        "original_filename": original_filename,
        "data_b64": data_b64,
        "size": Path(abs_path).stat().st_size,
    }
    await _post(payload, label="upload")


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
    """Best-effort delete on OneDrive after a Postgres delete."""
    if not is_configured():
        return

    effective_date = arrival_date or date.today()
    parts = build_path_parts(
        company=company,
        arrival_date=effective_date,
        whpo_number=whpo_number,
        container_no=container_no,
        kind=kind,
        original_filename=original_filename,
        content_type=content_type,
    )
    payload = {"action": "delete", **parts, "kind": kind}
    await _post(payload, label="delete")
