"""OneDrive Excel sync for finished outbound scan sheets.

Mirror of `scan_sheet_onedrive.py`. When the operator finishes loading
an outbound truck/container, the backend POSTs to the Logic App URL in
`settings.onedrive_outbound_scan_sheet_url`. The Logic App runs an
Office Script (`OutboundScanSheetAppend`) on `Lime Outbound Scan
Data.xlsx`, creating (or replacing) a worksheet named after the
container/truck and writing the header + scan rows.

Best-effort: every error is logged and swallowed so the operator's
finish flow never fails because of a OneDrive hiccup.
"""
from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


def is_configured() -> bool:
    return bool(settings.onedrive_outbound_scan_sheet_url)


async def push_outbound_scan_sheet(
    *,
    container_no: str,
    transfer_order_no: str,
    po_number: str | None,
    customer_name: str,
    bol_number: str | None,
    scheduled_arrival_at: str | None,
    sealed_at: str | None,
    rows: list[dict[str, Any]],
) -> bool:
    """Push the just-finished outbound load as a new worksheet in the
    OneDrive workbook. Each row: container_no | sku | serial | imei |
    inbound_container_no | scanned_at | scanned_by | notes."""
    if not is_configured():
        logger.info(
            "outbound_scan_sheet_onedrive: ONEDRIVE_OUTBOUND_SCAN_SHEET_URL "
            "not set, skipping push"
        )
        return False

    serialized_rows: list[list[str]] = []
    for r in rows:
        serialized_rows.append(
            [
                container_no,
                str(r.get("sku") or ""),
                str(r.get("serial_number") or ""),
                str(r.get("imei") or ""),
                str(r.get("inbound_container_no") or ""),
                str(r.get("scanned_at") or ""),
                str(r.get("scanned_by") or ""),
                str(r.get("notes") or ""),
            ]
        )

    header_payload = {
        "container_no": container_no,
        "transfer_order_no": transfer_order_no,
        "po_number": po_number or "",
        "customer_name": customer_name,
        "bol_number": bol_number or "",
        "scheduled_arrival_at": scheduled_arrival_at or "",
        "sealed_at": sealed_at or "",
        "total_scanned": len(serialized_rows),
    }
    body = {
        "containerNo": container_no,
        "headerJson": json.dumps(header_payload),
        "rowsJson": json.dumps(serialized_rows),
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(
                settings.onedrive_outbound_scan_sheet_url, json=body
            )
    except Exception as e:
        logger.warning("outbound_scan_sheet_onedrive push errored: %s", e)
        return False

    if not r.is_success:
        logger.warning(
            "outbound_scan_sheet_onedrive push returned %s: %s",
            r.status_code,
            r.text[:200],
        )
        return False
    return True
