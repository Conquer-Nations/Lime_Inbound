"""OneDrive Excel sync for finished scan sheets.

Backend POSTs to a Logic App (URL in `settings.onedrive_scan_sheet_url`) on
every receipt FINISH. The Logic App runs an Office Script
`ScanSheetAppend` on `Lime Scan Data.xlsx` that creates (or replaces) a
worksheet named after the container_no and writes the receipt header +
scan rows in the same layout as TEMPLATE.xlsx.

Best-effort: every error is logged and swallowed so the operator's finish
flow never fails because of a OneDrive hiccup.
"""

from __future__ import annotations

import json
import logging

import httpx

from app.config import settings
from app.schemas.scan_sheet import AuditSheetDetail

logger = logging.getLogger(__name__)


def is_configured() -> bool:
    return bool(settings.onedrive_scan_sheet_url)


def _serialize_row(container_no: str, r) -> list[str]:
    """Match the column order in TEMPLATE.xlsx data rows (A..G):
       container_no | sku | qty | serial_number | imei | scanned_by | notes"""
    return [
        container_no,
        r.sku or "",
        str(r.qty),
        r.serial_number or "",
        r.imei or "",
        r.scanned_by or "",
        r.notes or "",
    ]


async def push_scan_sheet(detail: AuditSheetDetail) -> bool:
    """Push the just-finished receipt as a new sheet in the OneDrive workbook.
    Returns True on success, False on any error (caller swallows; we just log)."""
    if not is_configured():
        logger.info("scan_sheet_onedrive: not configured, skipping push")
        return False

    h = detail.header
    rows = [_serialize_row(h.container_no, r) for r in detail.rows]

    header_payload = {
        "container_no": h.container_no,
        "whpo_number": h.whpo_number,
        "do_number": h.do_number,
        "customer_name": h.customer_name,
        "bol_number": h.bol_number or "",
        "received_date": h.received_date.isoformat(),
        "start_timestamp": h.start_timestamp.isoformat(),
        "completed_timestamp": (
            h.completed_timestamp.isoformat() if h.completed_timestamp else ""
        ),
        "location": h.location,
        "is_completed": h.is_completed,
    }

    body = {
        "containerNo": h.container_no,
        "headerJson": json.dumps(header_payload),
        "rowsJson": json.dumps(rows),
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(settings.onedrive_scan_sheet_url, json=body)
    except Exception as e:
        logger.warning("scan_sheet_onedrive push errored: %s", e)
        return False

    if not r.is_success:
        logger.warning(
            "scan_sheet_onedrive push returned %s: %s",
            r.status_code,
            r.text[:300],
        )
        return False

    logger.info(
        "scan_sheet_onedrive: pushed %s (%d rows) → OneDrive",
        h.container_no,
        len(rows),
    )
    return True
