"""OneDrive Excel sync for outbound Transfer Orders.

Mirror of `sheet_sync.py` but for the outbound side. Pushes one row per
(Transfer Order × line item) to the `OutboundTable` worksheet inside
`Lime Outbound Data.xlsx`.

Two webhook URLs (both optional, both fired on every append):
  - ONEDRIVE_OUTBOUND_WEBHOOK_URL — Logic App with an Excel "Add a row
    into a table" action on Lime Outbound Data.xlsx → OutboundTable.
  - ONEDRIVE_OUTBOUND_OPS_URL — Logic App running an Office Script
    (mirror of VendorOps) for delete-by-TO + clear-table ops.

Best-effort: any error is logged and swallowed. Vendor submissions never
fail because OneDrive is unreachable.
"""
from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


# Column order MUST match the OutboundTable headers in Excel and the
# Logic App row-mapping. Appending new columns at the end keeps the
# existing positions stable.
HEADERS = [
    # Order header (cols 0-9)
    "transfer_order_no",
    "po_number",
    "customer",
    "order_date",
    "priority",
    "memo",
    "ship_from_name",
    "ship_from_address",
    "ship_to_name",
    "ship_to_address",
    # Line item (cols 10-16)
    "line_no",
    "sku",
    "description",
    "order_qty",
    "unit",
    "serial_specific",
    "serials_requested",  # semicolon-joined when serial_specific = True
    # Order meta (cols 17-20)
    "status",
    "submitter_email",
    "submitted_at",
    "notes",
    # Container + driver block (cols 21-29) — populated for each
    # OutboundContainer attached to the order. One row is emitted per
    # (container × line); when no container is attached yet, these fields
    # are blank. Mirrors inbound's (container × line) layout.
    "container_no",
    "container_type",
    "driver_name",
    "driver_license",
    "driver_phone",
    "truck_license_plate",
    "carrier",
    "insurance",
    "bol_number",
    # Audit (col 30)
    "last_updated_at",
    # Outbound-specific: when the truck is scheduled to arrive at the
    # dock. Appended at the end so existing column positions stay locked.
    # (col 31)
    "scheduled_arrival_at",
]


def is_configured() -> bool:
    return bool(settings.onedrive_outbound_webhook_url)


def _serialize(row: dict[str, Any]) -> list[Any]:
    return [row.get(h) if row.get(h) is not None else "" for h in HEADERS]


async def append_outbound_rows(rows: list[dict[str, Any]]) -> int:
    """Fire-and-log append. Returns count of rows successfully sent (best-
    effort; the caller doesn't fail on errors)."""
    if not rows:
        return 0
    url = settings.onedrive_outbound_webhook_url
    if not url:
        logger.info(
            "outbound sheet sync: ONEDRIVE_OUTBOUND_WEBHOOK_URL not set, skipping"
        )
        return 0

    payload = {"rows": [_serialize(r) for r in rows]}
    headers = {"Content-Type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.post(url, json=payload, headers=headers)
        if r.is_success:
            logger.info(
                "outbound sheet sync: appended %d rows (status %s)",
                len(rows),
                r.status_code,
            )
            return len(rows)
        logger.warning(
            "outbound sheet sync: webhook returned %s: %s",
            r.status_code,
            r.text[:200],
        )
    except Exception as e:
        logger.warning("outbound sheet sync: append failed: %s", e)
    return 0


async def delete_outbound_rows_for_to(transfer_order_no: str) -> int:
    """Delete every row in OutboundTable whose transfer_order_no matches.
    Called by the update flow before re-appending the new state.

    Routed through ONEDRIVE_OUTBOUND_OPS_URL (Logic App + Office Script
    dispatcher). Returns the count of deleted rows reported by Excel."""
    url = settings.onedrive_outbound_ops_url
    if not url:
        logger.info(
            "outbound sheet sync: ONEDRIVE_OUTBOUND_OPS_URL not set, "
            "skipping delete_outbound_rows_for_to"
        )
        return 0
    body = {
        "action": "delete_to_rows",
        "payload": json.dumps({"transfer_order_no": transfer_order_no}),
    }
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(url, json=body)
        if r.is_success:
            try:
                data = r.json()
                deleted = int(data.get("deleted", 0)) if isinstance(data, dict) else 0
                logger.info(
                    "outbound sheet sync: deleted %d rows for TO %s",
                    deleted,
                    transfer_order_no,
                )
                return deleted
            except (ValueError, TypeError):
                return 0
        logger.warning(
            "outbound sheet sync: delete webhook returned %s: %s",
            r.status_code,
            r.text[:200],
        )
    except Exception as e:
        logger.warning("outbound sheet sync: delete failed: %s", e)
    return 0


def _container_block(container) -> dict[str, Any]:
    """Build the container/driver column dict from one OutboundContainer.
    Pass None for no-container-yet → all fields blank."""
    if container is None:
        return {
            "container_no": "",
            "container_type": "",
            "driver_name": "",
            "driver_license": "",
            "driver_phone": "",
            "truck_license_plate": "",
            "carrier": "",
            "insurance": "",
            "bol_number": "",
            "scheduled_arrival_at": "",
        }
    sched = getattr(container, "scheduled_arrival_at", None)
    return {
        "container_no": container.container_no or "",
        "container_type": container.container_type or "",
        "driver_name": container.driver_name or "",
        "driver_license": container.driver_license or "",
        "driver_phone": container.driver_phone or "",
        "truck_license_plate": container.truck_license_plate or "",
        "carrier": container.carrier or "",
        "insurance": container.insurance or "",
        "bol_number": container.bol_number or "",
        "scheduled_arrival_at": sched.isoformat() if sched else "",
    }


def rows_from_order(order, customer_name: str, last_updated_iso: str | None = None) -> list[dict[str, Any]]:
    """Materialise an OutboundOrder + its lines into Excel rows. Pure
    function — no DB access. Caller passes customer_name (already resolved)
    to avoid lazy-loading inside an async session.

    Layout:
      - If the order has N containers, emit N × M rows (one per container
        × line) so each container's driver/truck info is on every row that
        belongs to it. Mirrors inbound's (container × line) layout.
      - If no containers are attached yet, emit M rows (one per line)
        with the container/driver block blank.
    """
    base = {
        "transfer_order_no": order.transfer_order_no,
        "po_number": order.po_number or "",
        "customer": customer_name,
        "order_date": order.order_date.isoformat() if order.order_date else "",
        "priority": order.priority or "normal",
        "memo": order.memo or "",
        "ship_from_name": order.ship_from_name or "",
        "ship_from_address": order.ship_from_address or "",
        "ship_to_name": order.ship_to_name or "",
        "ship_to_address": order.ship_to_address or "",
        "status": order.status or "open",
        "submitter_email": order.submitted_by or "",
        "submitted_at": order.submitted_at.isoformat() if order.submitted_at else "",
        "notes": order.notes or "",
        "last_updated_at": last_updated_iso or "",
    }

    # Containers list: real OutboundContainer rows OR a single None
    # placeholder so the inner loop always runs at least once.
    containers = list(order.containers or []) or [None]

    rows: list[dict[str, Any]] = []
    for container in containers:
        cblock = _container_block(container)
        for line in (order.lines or []):
            serials_joined = ""
            if line.serial_specific and line.serials:
                serials_joined = ";".join(
                    s.serial_number for s in line.serials if s.serial_number
                )
            rows.append(
                {
                    **base,
                    "line_no": line.line_no,
                    "sku": line.sku_raw or "",
                    "description": line.description or "",
                    "order_qty": line.order_qty,
                    "unit": line.unit or "EA",
                    "serial_specific": "yes" if line.serial_specific else "no",
                    "serials_requested": serials_joined,
                    **cblock,
                }
            )
    return rows
