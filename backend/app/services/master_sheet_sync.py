"""OneDrive Excel mirror of the Master List (inbound + outbound).

Pushes a **full replace** of the MasterTable inside `Lime Master Inventory.xlsx`
every time inbound/outbound activity changes the data — receipt finish,
outbound scan committed, etc. Per Tiana: "I need it to be mirror on
excel in onedrive."

Two webhook URLs (both optional, best-effort):
  - ONEDRIVE_MASTER_SHEET_WEBHOOK_URL — Logic App that overwrites
    MasterTable contents. Office Script clears the table then bulk-
    appends rows from `triggerBody().rows`.
  - ONEDRIVE_MASTER_SHEET_OPS_URL — reserved for future per-row ops.

Payload shape:
    {
      "headers": [...22 column names...],
      "rows": [
        [col1, col2, ..., col22],
        ...
      ]
    }
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings

logger = logging.getLogger(__name__)

_LA_TZ = ZoneInfo("America/Los_Angeles")


# Column order MUST match the MasterTable headers in Excel. These are
# exactly the 22 visible columns from Tiana's Lime-Inventory-Sep 2025.xlsx,
# in order.
HEADERS = [
    "invoice",
    "commodity",
    "container",
    "whpo_load_no",
    "carrier_broker",
    "driver_name",
    "drop_container",
    "received_date",
    "pickup_container",
    "pallets_in",
    "units_in",
    "sqft_in",
    "total_sqft_in",
    "to_no",
    "ship_date",
    "ship_to",
    "pallets_out",
    "units_out",
    "sqft_out",
    "total_sqft_out",
    "scanned",
    "lpn",
]


def is_configured() -> bool:
    return bool(settings.onedrive_master_sheet_webhook_url)


def _fmt_date(d: date | None) -> str:
    if d is None:
        return ""
    return d.strftime("%m/%d/%Y")


def _fmt_dt(dt: datetime | None) -> str:
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(_LA_TZ).strftime("%-m/%-d/%Y")


def _serialize(row: dict[str, Any]) -> list[Any]:
    """Project a vw_master_list row dict onto the HEADERS-ordered list
    the Logic App expects."""
    return [
        row.get("invoice") or "",
        row.get("commodity") or "",
        row.get("container_no") or "",
        row.get("whpo_load_no") or "",
        row.get("carrier_broker") or "",
        row.get("driver_name") or "",
        _fmt_date(row.get("drop_container")),
        _fmt_date(row.get("received_date")),
        _fmt_date(row.get("pickup_container")),
        row.get("pallets") or 0,
        row.get("units") or 0,
        row.get("sqft") if row.get("sqft") is not None else "",
        row.get("total_sqft") if row.get("total_sqft") is not None else "",
        row.get("to_no") or "",
        _fmt_date(row.get("ship_date")),
        row.get("ship_to") or "",
        row.get("pallets_out") if row.get("pallets_out") is not None else "",
        row.get("units_out") if row.get("units_out") is not None else "",
        row.get("sqft_out") if row.get("sqft_out") is not None else "",
        row.get("total_sqft_out") if row.get("total_sqft_out") is not None else "",
        bool(row.get("scanned")),
        row.get("lpn") or "",
    ]


async def push_full_replace(session: AsyncSession) -> bool:
    """Read the full vw_master_list + POST to the Logic App as a full
    replace. Returns True iff the webhook accepted. Caller doesn't
    fail when False — Postgres is the source of truth, OneDrive is
    the secondary sink."""
    url = settings.onedrive_master_sheet_webhook_url
    if not url:
        logger.info(
            "master sheet sync: ONEDRIVE_MASTER_SHEET_WEBHOOK_URL not set, skipping"
        )
        return False

    rows_result = await session.execute(
        text(
            """
            SELECT * FROM vw_master_list
            ORDER BY received_date DESC NULLS LAST, container_no
            """
        )
    )
    rows = [dict(r._mapping) for r in rows_result]
    payload = {
        "headers": HEADERS,
        "rows": [_serialize(r) for r in rows],
    }

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            res = await client.post(
                url, json=payload, headers={"Content-Type": "application/json"}
            )
        if res.is_success:
            logger.info(
                "master sheet sync: full replace pushed (%d rows, HTTP %s)",
                len(rows),
                res.status_code,
            )
            return True
        logger.warning(
            "master sheet sync: webhook returned %s: %s",
            res.status_code,
            res.text[:300],
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("master sheet sync: push failed: %r", e)
    return False
