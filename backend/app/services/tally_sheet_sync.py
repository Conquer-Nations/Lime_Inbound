"""OneDrive Excel sync for tally sheets.

Mirror of `outbound_sheet_sync.py` but for the POD-driven tally rows
that feed billing. Pushes one row per tally to `TallyTable` inside
`Lime Tally Sheets.xlsx`, mirroring the layout that the upstream
OCR-Driver-POD repo writes to Google Sheets — so Tiana can hand the
workbook to the billing team as the source of truth instead of the
DB.

Two webhook URLs (both optional, both fired best-effort):
  - ONEDRIVE_TALLY_WEBHOOK_URL — Logic App with an Excel "Add a row
    into a table" action on Lime Tally Sheets.xlsx → TallyTable.
  - ONEDRIVE_TALLY_OPS_URL — Logic App + Office Script dispatcher for
    delete-by-tally-id (used on PATCH to wipe the old row before re-
    appending the corrected one) and clear-table (manager wipe).

Best-effort: any error is logged and swallowed. Manager POD upload
never fails because OneDrive is unreachable — the Postgres row is the
source of truth, OneDrive is the secondary sink.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from app.config import settings
from app.models import TallySheet

logger = logging.getLogger(__name__)

# Conquer Nation HQ is in Vernon, CA; render every timestamp in Pacific
# so the Excel cell formats correctly without per-row tz wrangling.
_LA_TZ = ZoneInfo("America/Los_Angeles")


def _fmt_dt(dt: datetime | None) -> str:
    """'MM/D/YYYY h:MM AM/PM' in LA time. Empty string for None.
    Excel auto-recognises this as a datetime cell."""
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(_LA_TZ).strftime("%-m/%-d/%Y %-I:%M %p")


# Column order MUST match the TallyTable headers in Excel AND the
# Logic App row-mapping. Appending new columns at the END keeps the
# existing positions stable so old Logic App versions still work.
HEADERS = [
    # Identity
    "tally_id",
    "container_no",
    "customer",                 # brand the container belongs to
    # POD audit
    "pod_filename",
    "tallied_at",
    "tallied_by",
    # Snapshot from container (locked at tally time for audit)
    "driver_name",
    "driver_license",
    "driver_phone",
    "carrier",
    "truck_plate",
    # OCR / manual fields
    "from_location",
    "to_location",
    "seal_no",
    "chassis_no",
    "ocr_engine",
    # Billing
    "billing_status",
    "billing_notes",
    "updated_at",
]


def is_configured() -> bool:
    return bool(settings.onedrive_tally_webhook_url)


def _row_from_tally(tally: TallySheet, customer_name: str) -> dict[str, Any]:
    """Project a TallySheet ORM row into the HEADERS dict shape."""
    return {
        "tally_id": tally.id,
        "container_no": tally.matched_container_no,
        "customer": customer_name,
        "pod_filename": tally.pod_filename,
        "tallied_at": _fmt_dt(tally.tallied_at),
        "tallied_by": tally.tallied_by,
        "driver_name": tally.matched_driver_name or "",
        "driver_license": tally.matched_driver_license or "",
        "driver_phone": tally.matched_driver_phone or "",
        "carrier": tally.matched_carrier or "",
        "truck_plate": tally.matched_truck_plate or "",
        "from_location": tally.ocr_from_location or "",
        "to_location": tally.ocr_to_location or "",
        "seal_no": tally.manual_seal_no or "",
        "chassis_no": tally.manual_chassis_no or "",
        "ocr_engine": tally.ocr_engine or "",
        "billing_status": tally.billing_status,
        "billing_notes": tally.billing_notes or "",
        "updated_at": _fmt_dt(tally.updated_at),
    }


def _serialize(row: dict[str, Any]) -> list[Any]:
    return [row.get(h) if row.get(h) is not None else "" for h in HEADERS]


async def append_tally_row(tally: TallySheet, customer_name: str) -> bool:
    """Fire-and-log append. Returns True iff the webhook accepted.
    Caller does NOT fail when this returns False."""
    url = settings.onedrive_tally_webhook_url
    if not url:
        logger.info(
            "tally sheet sync: ONEDRIVE_TALLY_WEBHOOK_URL not set, skipping"
        )
        return False

    row = _row_from_tally(tally, customer_name)
    payload = {"rows": [_serialize(row)]}
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.post(url, json=payload, headers={"Content-Type": "application/json"})
        if r.is_success:
            logger.info(
                "tally sheet sync: appended tally %d for %s (HTTP %s)",
                tally.id,
                tally.matched_container_no,
                r.status_code,
            )
            return True
        logger.warning(
            "tally sheet sync: webhook returned %s: %s",
            r.status_code,
            r.text[:200],
        )
    except Exception as e:
        logger.warning("tally sheet sync: append failed: %s", e)
    return False


async def delete_tally_row(tally_id: int) -> bool:
    """Delete the row whose tally_id column matches. Called by PATCH
    before re-appending the corrected row so the Excel reflects current
    state. Routed through ONEDRIVE_TALLY_OPS_URL (Logic App + Office
    Script dispatcher, mirror of vendors_ops / outbound_ops)."""
    url = settings.onedrive_tally_ops_url
    if not url:
        return False
    body = {"action": "delete_tally_row", "payload": str(tally_id)}
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(url, json=body)
        if r.is_success:
            return True
        logger.warning(
            "tally sheet sync: delete %d returned %s: %s",
            tally_id,
            r.status_code,
            r.text[:200],
        )
    except Exception as e:
        logger.warning("tally sheet sync: delete %d failed: %s", tally_id, e)
    return False


async def clear_tally_table() -> int:
    """Wipe every row from TallyTable. For the manager wipe-transactional
    flow. Returns count of rows deleted (0 if URL unset or call fails)."""
    url = settings.onedrive_tally_ops_url
    if not url:
        return 0
    body = {"action": "clear_tally_table", "payload": "{}"}
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(url, json=body)
        if r.is_success:
            try:
                data = r.json()
                return int(data.get("deleted", 0)) if isinstance(data, dict) else 0
            except (ValueError, TypeError):
                return 0
        logger.warning(
            "tally sheet sync: clear_tally_table returned %s: %s",
            r.status_code,
            r.text[:200],
        )
    except Exception as e:
        logger.warning("tally sheet sync: clear_tally_table failed: %s", e)
    return 0
