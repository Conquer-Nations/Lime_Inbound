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
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

# Conquer Nation HQ is in Vernon, CA, so we render every OutboundTable
# timestamp in Pacific time. Excel still picks the value up as a real
# datetime — Tiana (or anyone) can apply different cell formatting later.
_LA_TZ = ZoneInfo("America/Los_Angeles")


def _fmt_dt(dt: datetime | None) -> str:
    """Render a datetime as 'MM/DD/YYYY h:MM AM/PM' in LA time. Returns
    empty string for None. Excel auto-detects this format as a datetime
    cell."""
    if dt is None:
        return ""
    if dt.tzinfo is None:
        # Naive datetime — assume UTC defensively.
        dt = dt.replace(tzinfo=timezone.utc)
    local = dt.astimezone(_LA_TZ)
    # %-I / %-m strip leading zeros (Linux only — App Service is Linux).
    return local.strftime("%-m/%-d/%Y %-I:%M %p")


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
    # Source inbound container the vendor is drawing this line from.
    # (col 32)
    "source_container_no",
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
        "scheduled_arrival_at": _fmt_dt(
            getattr(container, "scheduled_arrival_at", None)
        ),
    }


def rows_from_order(
    order,
    customer_name: str,
    last_updated_at: datetime | None = None,
) -> list[dict[str, Any]]:
    """Materialise an OutboundOrder + its lines into Excel rows. Pure
    function — no DB access. Caller passes customer_name (already resolved)
    to avoid lazy-loading inside an async session.

    All datetime fields are rendered as `MM/DD/YYYY h:MM AM/PM` in LA time
    (Excel auto-detects as a real datetime cell). `order_date` stays
    `MM/DD/YYYY` since it doesn't carry a time component.

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
        "order_date": (
            order.order_date.strftime("%-m/%-d/%Y") if order.order_date else ""
        ),
        "priority": order.priority or "normal",
        "memo": order.memo or "",
        "ship_from_name": order.ship_from_name or "",
        "ship_from_address": order.ship_from_address or "",
        "ship_to_name": order.ship_to_name or "",
        "ship_to_address": order.ship_to_address or "",
        "status": order.status or "open",
        "submitter_email": order.submitted_by or "",
        "submitted_at": _fmt_dt(order.submitted_at),
        "notes": order.notes or "",
        "last_updated_at": _fmt_dt(last_updated_at),
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
                    "source_container_no": (
                        getattr(line, "source_container_no", None) or ""
                    ),
                    **cblock,
                }
            )
    return rows


# ─── ContainerInventory worksheet sync ─────────────────────────────────

# Headers for the dedicated ContainerInventory worksheet in
# Lime Outbound Data.xlsx. One row per (container, sku) — the dashboard
# is a flat per-line snapshot, not append-only.
INVENTORY_HEADERS = [
    "customer",
    "container_no",
    "sku",
    "description",
    "inbound_qty",
    "outbound_qty",
    "pending_qty",
    "received_date",
    "allocated_to",  # semicolon-joined TO numbers
    "last_refreshed_at",
]


def _serialize_inventory(row: dict[str, Any]) -> list[Any]:
    return [row.get(h) if row.get(h) is not None else "" for h in INVENTORY_HEADERS]


async def replace_container_inventory_for_company(
    company_name: str, rows: list[dict[str, Any]]
) -> dict:
    """Snapshot-replace the ContainerInventory worksheet rows for a company.
    Delegated to the OPS Logic App's `replace_inventory_rows` action — the
    Office Script deletes every existing ContainerInventory row matching
    the company, then writes the new ones in one Excel transaction (no
    race window).
    """
    url = settings.onedrive_outbound_ops_url
    if not url:
        logger.info(
            "outbound sheet sync: ONEDRIVE_OUTBOUND_OPS_URL not set, "
            "skipping replace_container_inventory_for_company"
        )
        return {"deleted": 0, "added": 0}
    body = {
        "action": "replace_inventory_rows",
        "payload": json.dumps(
            {
                "customer": company_name,
                "rows": [_serialize_inventory(r) for r in rows],
            }
        ),
    }
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(url, json=body)
        if r.is_success:
            try:
                data = r.json()
                return {
                    "deleted": int(data.get("deleted", 0))
                    if isinstance(data, dict)
                    else 0,
                    "added": int(data.get("added", 0))
                    if isinstance(data, dict)
                    else 0,
                }
            except (ValueError, TypeError):
                return {"deleted": 0, "added": 0}
        logger.warning(
            "outbound sheet sync: inventory webhook returned %s: %s",
            r.status_code,
            r.text[:200],
        )
    except Exception as e:
        logger.warning("outbound sheet sync: inventory replace failed: %s", e)
    return {"deleted": 0, "added": 0}


def inventory_rows_from_items(
    company_name: str,
    items: list[dict],
    refreshed_at: datetime | None = None,
) -> list[dict[str, Any]]:
    """Convert ContainerInventory items (per the service layer) into the
    flat dict shape append_outbound_rows / replace expects."""
    ts = _fmt_dt(refreshed_at or datetime.now(timezone.utc))
    out: list[dict[str, Any]] = []
    for it in items:
        received = it.get("received_date")
        out.append(
            {
                "customer": company_name,
                "container_no": it.get("container_no") or "",
                "sku": it.get("sku") or "",
                "description": it.get("description") or "",
                "inbound_qty": it.get("inbound_qty") or 0,
                "outbound_qty": it.get("outbound_qty") or 0,
                "pending_qty": it.get("pending_qty") or 0,
                "received_date": (
                    received.strftime("%-m/%-d/%Y") if received else ""
                ),
                "allocated_to": "; ".join(it.get("allocated_to") or []),
                "last_refreshed_at": ts,
            }
        )
    return out
