"""OneDrive Excel mirror of the Master List (inbound + outbound).

Pushes a **full replace** of the brand-segregated master sheet workbook
on every inbound/outbound state change — receipt finish, outbound scan
committed, new vendor shipment submitted, etc. The workbook has ONE
SHEET PER BRAND, each backed by its own table (MasterTable_<brand>).

Two webhook URLs (both optional, best-effort):
  - ONEDRIVE_MASTER_SHEET_WEBHOOK_URL — Logic App that overwrites every
    brand-table in the workbook. The Office Script clears each existing
    table and bulk-appends the new rows; if a brand sheet doesn't exist
    yet, it auto-creates one from a hidden _TEMPLATE sheet.
  - ONEDRIVE_MASTER_SHEET_OPS_URL — reserved for future per-row ops.

Payload shape (v2 — per-brand):
    {
      "headers": [...22 column names...],
      "brands": {
        "Lime":              [[col1, ..., col22], ...],
        "Pan American Wire": [[col1, ..., col22], ...],
        "Boviet Solar":      []
      }
    }

The Office Script v2 keys off `payload.brands`. Backward-compat path
(workbooks still on Office Script v1) ignores `brands` and falls back
to a flattened `payload.rows`, so we always include both during the
transition.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import date, datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings

logger = logging.getLogger(__name__)

# Simple in-process throttle. A second write can re-arm `_again` so
# the running push knows to do one trailing re-push. No Lock —
# Python's GIL gives us atomic loads/stores of these refs, which is
# enough for "is something running, do I need a re-push" semantics.
_pending: asyncio.Task | None = None
_again = False

_LA_TZ = ZoneInfo("America/Los_Angeles")


# Column order MUST match the MasterTable headers in Excel. These are
# exactly the 22 visible columns from Tiana's Lime-Inventory-Sep 2025.xlsx,
# in order.
HEADERS = [
    "invoice",
    "do_number",
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


async def maybe_push(session: AsyncSession, *, source: str) -> bool:
    """Fire-and-forget master-sheet refresh — returns immediately,
    actual push runs on a background task with its own session so the
    caller releases its DB connection and the Logic App's latency
    never blocks the request.

    Burst-collapsing: if a push is already queued or running, this
    just re-arms a "do it again when done" flag instead of fanning
    out one task per write. That keeps the workbook eventually
    consistent without thundering-herd posts on busy days (e.g.
    bulk WHPO updates or scan-finish bursts).

    Returns True if the push was scheduled (or already in flight),
    False if not configured.
    """
    if not is_configured():
        return False
    global _pending, _again
    # If something is already running, just flag "do it again when done"
    # so we coalesce bursts into ≤2 pushes instead of fanning out.
    if _pending is not None and not _pending.done():
        _again = True
        return True
    _pending = asyncio.create_task(_run_push_loop(source))
    return True


async def _run_push_loop(source: str) -> None:
    """Background worker — pushes once, then re-pushes once if more
    writes piled up while we were busy. Uses its own AsyncSession so
    the request that triggered us has long since closed its connection.
    """
    global _pending, _again
    # Import here to avoid a circular at module import time.
    from app.db import SessionLocal
    try:
        while True:
            try:
                async with SessionLocal() as session:
                    await push_full_replace(session)
            except Exception as e:  # noqa: BLE001
                logger.warning(
                    "master_sheet_sync background push (%s) failed: %r",
                    source,
                    e,
                )
            if not _again:
                return
            _again = False
            # Loop again — another write arrived during the push.
    finally:
        _pending = None


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
        row.get("do_number") or "",
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
    """Read the full vw_master_list + POST to the Logic App as a per-brand
    full replace. Returns True iff the webhook accepted. Caller never
    fails when False — Postgres is the source of truth, OneDrive is the
    secondary sink and may be unreachable transiently.

    Payload includes both the legacy flat `rows` and the new per-brand
    `brands` map so Office Script v1 and v2 both work during rollout.
    """
    url = settings.onedrive_master_sheet_webhook_url
    if not url:
        logger.info(
            "master sheet sync: ONEDRIVE_MASTER_SHEET_WEBHOOK_URL not set, skipping"
        )
        return False

    # Also pull the full customer list so brands with zero containers
    # right now still get a sheet (cleared) — keeps the workbook tab
    # structure stable across the onboarding curve, so vendors aren't
    # surprised when a brand sheet appears and disappears.
    customers_result = await session.execute(
        text("SELECT name FROM customers ORDER BY name")
    )
    all_brands: list[str] = [r[0] for r in customers_result]

    rows_result = await session.execute(
        text(
            """
            SELECT * FROM vw_master_list
            ORDER BY received_date DESC NULLS LAST, container_no
            """
        )
    )
    rows = [dict(r._mapping) for r in rows_result]

    # Group rows by customer_name. Anything missing a customer (shouldn't
    # happen given vw_master_list joins through customers) lands in the
    # special "_Unassigned" bucket so the data isn't silently dropped.
    brands_grouped: dict[str, list[list[Any]]] = {b: [] for b in all_brands}
    flat: list[list[Any]] = []
    for r in rows:
        serialized = _serialize(r)
        flat.append(serialized)
        brand = (r.get("customer_name") or "").strip() or "_Unassigned"
        brands_grouped.setdefault(brand, []).append(serialized)

    payload = {
        "headers": HEADERS,
        "brands": brands_grouped,
        # Legacy flat rows kept ONLY for backward compatibility with
        # Office Script v1. v2 ignores this. Safe to remove once every
        # workbook is on v2.
        "rows": flat,
    }

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            res = await client.post(
                url, json=payload, headers={"Content-Type": "application/json"}
            )
        # Always log the response body — that's the Office Script's return
        # value, which tells us whether addRows actually ran, how many
        # brand sheets it touched, and any errors.
        logger.info(
            "master sheet sync: pushed %d rows across %d brand(s) "
            "(HTTP %s) — script response: %s",
            len(flat),
            len(brands_grouped),
            res.status_code,
            res.text[:600],
        )
        # Echo into stdout too so it surfaces in containerStream.log
        # without waiting on logging buffer flushes.
        print(
            f"DIAG master_sheet_sync: HTTP {res.status_code} "
            f"sent {len(flat)} rows / {len(brands_grouped)} brands  "
            f"script_response={res.text[:600]}",
            flush=True,
        )
        return res.is_success
    except Exception as e:  # noqa: BLE001
        logger.warning("master sheet sync: push failed: %r", e)
        print(f"DIAG master_sheet_sync: push failed: {e!r}", flush=True)
    return False
