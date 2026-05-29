"""Warehouse inventory reports: aging + per-container remaining inventory.

Two manager-facing views, both computed from source-of-truth tables at
query time:

  1. /manager/inventory/aging
     One row per received container. Shows days-since-received, units in
     vs out, "aging bucket" (active / aging / stale) for at-a-glance
     dashboards. Per Tiana: "we need to keep track about how long the
     container has been sitting without going for outbound."

  2. /manager/inventory/container/{container_no}/remaining
     Per-SKU + per-serial breakdown of what's still on the floor for a
     specific container. Per Tiana: "if 100 are shipped in as part of
     inbound, not all get shipped out as outbound. Sometimes a few
     remain. I need to track which serial number from which container
     is left."

Aging buckets (calendar days since Container.finished_at):
    0-29   → active        (normal turnover)
    30-59  → aging          (push to outbound soon)
    60+    → stale          (long-term storage / billing concern)
   any age, units_remaining = 0  → fully_shipped (display-only)
"""
from __future__ import annotations

import logging
from datetime import date as _date, datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import (
    DO,
    WHPO,
    Container,
    ContainerLine,
    Customer,
    OutboundOrder,
    OutboundScan,
    Receipt,
    Scan,
)

_WAREHOUSE_TZ = ZoneInfo("America/Los_Angeles")


def _today() -> _date:
    """Warehouse-local 'today' — Vernon, CA. Late-evening scans land
    on the same calendar day for operators, even after midnight UTC."""
    return datetime.now(_WAREHOUSE_TZ).date()
from app.schemas.inventory_reports import (
    ContainerAgingResponse,
    ContainerAgingRow,
    RemainingInventoryResponse,
    RemainingInventorySkuRow,
    RemainingSerialRow,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/manager", tags=["manager-inventory-reports"])


def _bucket(days: int | None, units_remaining: int, in_progress: bool) -> str:
    """Pure function so frontend tests can mirror the rule trivially.

    `in_progress` overrides the day-count: a container the operator is
    actively scanning right now (Receipt.status='in_progress') should
    surface in aging so managers can see what's on the dock, not after
    the receipt is finalized.
    """
    if in_progress:
        return "active"
    if days is None:
        return "active"
    if units_remaining <= 0:
        return "fully_shipped"
    if days < 30:
        return "active"
    if days < 60:
        return "aging"
    return "stale"


@router.get("/inventory/aging", response_model=ContainerAgingResponse)
async def container_aging(
    bucket: str | None = Query(
        None,
        description="Filter to one bucket: active | aging | stale | fully_shipped",
        pattern=r"^(active|aging|stale|fully_shipped)$",
    ),
    brand: str | None = Query(None, description="Exact brand name filter"),
    limit: int = Query(500, ge=1, le=2000),
    session: AsyncSession = Depends(get_session),
) -> ContainerAgingResponse:
    today = _today()

    # Containers that are either finished OR have an in-progress receipt
    # both belong in the aging view — managers want to see what's on the
    # dock right now, not just what's already wrapped up.
    in_progress_subq = (
        select(Receipt.container_id)
        .where(Receipt.status == "in_progress")
        .subquery()
    )

    base = (
        select(
            Container.id.label("cid"),
            Container.container_no.label("container_no"),
            Customer.name.label("brand"),
            DO.do_number.label("invoice_no"),
            WHPO.whpo_number.label("whpo_number"),
            Container.finished_at.label("finished_at"),
            Container.status.label("status"),
        )
        .join(DO, DO.id == Container.do_id, isouter=True)
        .join(WHPO, WHPO.id == DO.whpo_id, isouter=True)
        .join(Customer, Customer.id == WHPO.customer_id, isouter=True)
        .where(
            or_(
                Container.finished_at.is_not(None),
                Container.id.in_(select(in_progress_subq.c.container_id)),
            )
        )
    )
    if brand:
        base = base.where(Customer.name == brand)
    # Newest first so in-progress + recent receipts surface above stale ones.
    base = base.order_by(Container.finished_at.desc().nullsfirst()).limit(limit)

    rows = (await session.execute(base)).all()

    # For each container, pull aggregates. Two extra round-trips total
    # (not per-row) so this stays fast even at hundreds of containers.
    container_ids = [r.cid for r in rows]

    units_in_map: dict[int, int] = {}
    units_out_map: dict[int, int] = {}
    if container_ids:
        # SUM(container_lines.qty) per container
        ui = await session.execute(
            select(ContainerLine.container_id, func.coalesce(func.sum(ContainerLine.qty), 0))
            .where(ContainerLine.container_id.in_(container_ids))
            .group_by(ContainerLine.container_id)
        )
        units_in_map = {row[0]: int(row[1] or 0) for row in ui.all()}

        # COUNT(outbound_scans joined to scans) per inbound container
        uo = await session.execute(
            select(Scan.container_id, func.count(OutboundScan.id))
            .join(OutboundScan, OutboundScan.inbound_scan_id == Scan.id)
            .where(Scan.container_id.in_(container_ids))
            .group_by(Scan.container_id)
        )
        units_out_map = {row[0]: int(row[1] or 0) for row in uo.all()}

    items: list[ContainerAgingRow] = []
    counts = {"active": 0, "aging": 0, "stale": 0, "fully_shipped": 0}
    for r in rows:
        finished_date = r.finished_at.date() if r.finished_at else None
        days = (today - finished_date).days if finished_date else None
        units_in = units_in_map.get(r.cid, 0)
        units_out = units_out_map.get(r.cid, 0)
        units_remaining = max(units_in - units_out, 0)
        # Container.status tracks the in-progress / received transition;
        # treat anything still being scanned as the freshest possible row.
        in_progress = r.status == "in_progress"
        agb = _bucket(days, units_remaining, in_progress)
        counts[agb] = counts.get(agb, 0) + 1
        if bucket and agb != bucket:
            continue
        items.append(
            ContainerAgingRow(
                container_no=r.container_no,
                brand=r.brand,
                invoice_no=r.invoice_no,
                whpo_number=r.whpo_number,
                received_date=finished_date,
                days_since_received=days,
                units_in=units_in,
                units_out=units_out,
                units_remaining=units_remaining,
                aging_bucket=agb,
                fully_shipped=units_remaining == 0 and units_in > 0,
            )
        )

    return ContainerAgingResponse(
        items=items,
        total=len(items),
        counts=counts,
    )


@router.get(
    "/inventory/container/{container_no}/remaining",
    response_model=RemainingInventoryResponse,
)
async def container_remaining_inventory(
    container_no: str,
    session: AsyncSession = Depends(get_session),
) -> RemainingInventoryResponse:
    """Per-SKU and per-serial breakdown of what's still on the floor for
    one inbound container. Used by manager drill-down + future WMS."""
    row = await session.execute(
        select(
            Container.id.label("cid"),
            Container.container_no.label("container_no"),
            Customer.name.label("brand"),
            Container.finished_at.label("finished_at"),
        )
        .join(DO, DO.id == Container.do_id, isouter=True)
        .join(WHPO, WHPO.id == DO.whpo_id, isouter=True)
        .join(Customer, Customer.id == WHPO.customer_id, isouter=True)
        .where(Container.container_no == container_no.upper())
    )
    rec = row.first()
    if rec is None:
        raise HTTPException(404, f"Container {container_no} not found")
    cid = rec.cid
    finished_date = rec.finished_at.date() if rec.finished_at else None
    days = (_date.today() - finished_date).days if finished_date else None

    # ── Per-SKU rollup ────────────────────────────────────────────────
    # qty_received  = SUM(container_lines.qty) per sku
    # qty_scanned_in = COUNT(scans) per sku (only ones tied to a serial,
    #                  but include legacy w/o serial — counted by sku_id
    #                  match against ContainerLine sku_id)
    # qty_shipped_out = COUNT(outbound_scans joined to scans) per sku
    received = (
        await session.execute(
            select(ContainerLine.sku_raw, func.coalesce(func.sum(ContainerLine.qty), 0))
            .where(ContainerLine.container_id == cid)
            .group_by(ContainerLine.sku_raw)
        )
    ).all()
    sku_to_received = {r[0]: int(r[1] or 0) for r in received}

    scanned_in = (
        await session.execute(
            select(ContainerLine.sku_raw, func.count(Scan.id))
            .join(Scan, Scan.sku_id == ContainerLine.sku_id)
            .where(Scan.container_id == cid)
            .where(ContainerLine.container_id == cid)
            .group_by(ContainerLine.sku_raw)
        )
    ).all()
    sku_to_scanned_in = {r[0]: int(r[1] or 0) for r in scanned_in}

    shipped_out = (
        await session.execute(
            select(ContainerLine.sku_raw, func.count(OutboundScan.id))
            .join(Scan, Scan.sku_id == ContainerLine.sku_id)
            .join(OutboundScan, OutboundScan.inbound_scan_id == Scan.id)
            .where(Scan.container_id == cid)
            .where(ContainerLine.container_id == cid)
            .group_by(ContainerLine.sku_raw)
        )
    ).all()
    sku_to_shipped_out = {r[0]: int(r[1] or 0) for r in shipped_out}

    all_skus = set(sku_to_received) | set(sku_to_scanned_in) | set(sku_to_shipped_out)
    per_sku: list[RemainingInventorySkuRow] = []
    for sku in sorted(all_skus):
        rcv = sku_to_received.get(sku, 0)
        sin = sku_to_scanned_in.get(sku, 0)
        out = sku_to_shipped_out.get(sku, 0)
        per_sku.append(
            RemainingInventorySkuRow(
                sku_raw=sku,
                qty_received=rcv,
                qty_scanned_in=sin,
                qty_shipped_out=out,
                qty_remaining=max(sin - out, 0),
            )
        )

    # ── Serial-level breakdown ────────────────────────────────────────
    # Each serial-bearing scan is either still in warehouse or shipped.
    serial_rows = (
        await session.execute(
            select(
                Scan.id,
                Scan.serial_number,
                Scan.scanned_at,
                ContainerLine.sku_raw,
                OutboundScan.id.label("out_scan_id"),
                OutboundScan.scanned_at.label("out_scanned_at"),
                OutboundOrder.transfer_order_no.label("transfer_order_no"),
            )
            .join(ContainerLine, ContainerLine.sku_id == Scan.sku_id, isouter=True)
            .join(OutboundScan, OutboundScan.inbound_scan_id == Scan.id, isouter=True)
            .join(OutboundOrder, OutboundOrder.id == OutboundScan.outbound_order_id, isouter=True)
            .where(Scan.container_id == cid)
            .where(ContainerLine.container_id == cid)
            .where(Scan.serial_number.is_not(None))
            .order_by(Scan.scanned_at.asc())
        )
    ).all()

    serials: list[RemainingSerialRow] = []
    seen_serial_ids: set[int] = set()
    for sr in serial_rows:
        # The container_line join can return one row per matching
        # (scan × line); dedupe by scan id.
        if sr.id in seen_serial_ids:
            continue
        seen_serial_ids.add(sr.id)
        serials.append(
            RemainingSerialRow(
                serial_number=sr.serial_number,
                sku_raw=sr.sku_raw,
                scanned_at=sr.scanned_at,
                status="shipped" if sr.out_scan_id else "in_warehouse",
                shipped_to=sr.transfer_order_no,
                shipped_at=sr.out_scanned_at,
            )
        )

    return RemainingInventoryResponse(
        container_no=rec.container_no,
        brand=rec.brand,
        received_date=finished_date,
        days_since_received=days,
        per_sku=per_sku,
        serials=serials,
    )
