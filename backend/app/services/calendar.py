"""Shared service for the inbound + outbound activity calendar.

Returns a flat list of CalendarDay rows over a window starting today.
Vendor-scoped + manager-wide variants both call into the same builder
— they differ only in whether they filter by customer name.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import (
    DO,
    WHPO,
    Container,
    Customer,
    OutboundContainer,
    OutboundOrder,
    Receipt,
)


# Stage labels — mirror the status timeline endpoints.
_INBOUND_LABELS = {
    "order_placed": "Order placed",
    "driver_assigned": "Driver / truck info added",
    "scanning": "Scanning in progress",
    "complete": "Scanning complete",
}
_OUTBOUND_LABELS = {
    "order_placed": "Order placed",
    "truck_attached": "Truck attached",
    "truck_arrived": "Truck arrived at dock",
    "loading": "Loading in progress",
    "sealed": "Truck sealed / departed",
}


def _inbound_stage(container: Container, receipt: Receipt | None) -> tuple[str, str]:
    if receipt and receipt.status == "completed" and receipt.finished_at:
        s = "complete"
    elif receipt and receipt.started_at:
        s = "scanning"
    elif container.driver_info_received_at:
        s = "driver_assigned"
    else:
        s = "order_placed"
    return s, _INBOUND_LABELS[s]


def _outbound_stage(
    container: OutboundContainer, receipt: Receipt | None
) -> tuple[str, str]:
    if container.sealed_at:
        s = "sealed"
    elif receipt and receipt.started_at:
        s = "loading"
    elif container.started_at:
        s = "truck_arrived"
    elif container.id:
        s = "truck_attached"
    else:
        s = "order_placed"
    return s, _OUTBOUND_LABELS[s]


async def build_calendar(
    session: AsyncSession,
    *,
    days: int = 14,
    customer_name: Optional[str] = None,
    start: Optional[date] = None,
) -> dict:
    """Build the activity calendar. `customer_name` filters to one vendor's
    activity (vendor view); leave None for the manager-wide view."""
    if start is None:
        start = datetime.now(timezone.utc).date()
    end = start + timedelta(days=days)
    norm_co = customer_name.strip().lower() if customer_name else None

    # ── Inbound containers expected in this window ───────────────────
    inbound_stmt = (
        select(Container, WHPO, Customer)
        .join(DO, Container.do_id == DO.id)
        .join(WHPO, DO.whpo_id == WHPO.id)
        .join(Customer, WHPO.customer_id == Customer.id)
        .options(selectinload(Container.lines))
        .where(Container.expected_arrival_date >= start)
        .where(Container.expected_arrival_date < end)
    )
    if norm_co:
        inbound_stmt = inbound_stmt.where(func.lower(Customer.name) == norm_co)
    inbound_rows = (await session.execute(inbound_stmt)).all()

    # Look up most recent inbound receipt per container.
    inbound_container_ids = [c.id for (c, _w, _cu) in inbound_rows]
    inbound_receipts: dict[int, Receipt] = {}
    if inbound_container_ids:
        rs = await session.scalars(
            select(Receipt)
            .where(Receipt.kind == "inbound")
            .where(Receipt.container_id.in_(inbound_container_ids))
            .order_by(Receipt.started_at.desc())
        )
        for r in rs.all():
            inbound_receipts.setdefault(r.container_id, r)

    # ── Outbound trucks scheduled in this window ─────────────────────
    # Match on scheduled_arrival_at::date when present, else fall back
    # to order_date on the parent OutboundOrder.
    outbound_stmt = (
        select(OutboundContainer, OutboundOrder, Customer)
        .join(OutboundOrder, OutboundContainer.outbound_order_id == OutboundOrder.id)
        .join(Customer, OutboundOrder.customer_id == Customer.id)
        .where(
            (
                (OutboundContainer.scheduled_arrival_at.isnot(None))
                & (func.date(OutboundContainer.scheduled_arrival_at) >= start)
                & (func.date(OutboundContainer.scheduled_arrival_at) < end)
            )
            | (
                (OutboundContainer.scheduled_arrival_at.is_(None))
                & (OutboundOrder.order_date.isnot(None))
                & (OutboundOrder.order_date >= start)
                & (OutboundOrder.order_date < end)
            )
        )
    )
    if norm_co:
        outbound_stmt = outbound_stmt.where(func.lower(Customer.name) == norm_co)
    outbound_rows = (await session.execute(outbound_stmt)).all()

    outbound_container_ids = [c.id for (c, _o, _cu) in outbound_rows]
    outbound_receipts: dict[int, Receipt] = {}
    if outbound_container_ids:
        rs = await session.scalars(
            select(Receipt)
            .where(Receipt.kind == "outbound")
            .where(Receipt.outbound_container_id.in_(outbound_container_ids))
            .order_by(Receipt.started_at.desc())
        )
        for r in rs.all():
            outbound_receipts.setdefault(r.outbound_container_id, r)

    # Also include outbound orders with no container attached yet.
    bare_outbound_stmt = (
        select(OutboundOrder, Customer)
        .join(Customer, OutboundOrder.customer_id == Customer.id)
        .outerjoin(
            OutboundContainer,
            OutboundContainer.outbound_order_id == OutboundOrder.id,
        )
        .where(OutboundOrder.order_date >= start)
        .where(OutboundOrder.order_date < end)
        .where(OutboundContainer.id.is_(None))
    )
    if norm_co:
        bare_outbound_stmt = bare_outbound_stmt.where(
            func.lower(Customer.name) == norm_co
        )
    bare_outbound_rows = (await session.execute(bare_outbound_stmt)).all()

    # ── Bucket by date ──────────────────────────────────────────────
    days_map: dict[date, dict] = {}
    for i in range(days):
        d = start + timedelta(days=i)
        days_map[d] = {
            "date": d,
            "inbound_containers": [],
            "outbound_containers": [],
        }

    for c, w, cu in inbound_rows:
        if c.expected_arrival_date is None:
            continue
        stage, label = _inbound_stage(c, inbound_receipts.get(c.id))
        days_map.setdefault(
            c.expected_arrival_date,
            {"date": c.expected_arrival_date, "inbound_containers": [], "outbound_containers": []},
        )
        days_map[c.expected_arrival_date]["inbound_containers"].append(
            {
                "container_no": c.container_no,
                "ref_no": w.whpo_number,
                "customer": cu.name,
                "current_stage": stage,
                "current_label": label,
            }
        )

    for c, o, cu in outbound_rows:
        if c.scheduled_arrival_at:
            d = c.scheduled_arrival_at.date()
        elif o.order_date:
            d = o.order_date
        else:
            continue
        stage, label = _outbound_stage(c, outbound_receipts.get(c.id))
        days_map.setdefault(
            d,
            {"date": d, "inbound_containers": [], "outbound_containers": []},
        )
        days_map[d]["outbound_containers"].append(
            {
                "container_no": c.container_no,
                "ref_no": o.transfer_order_no,
                "customer": cu.name,
                "current_stage": stage,
                "current_label": label,
            }
        )

    for o, cu in bare_outbound_rows:
        if o.order_date is None:
            continue
        days_map.setdefault(
            o.order_date,
            {"date": o.order_date, "inbound_containers": [], "outbound_containers": []},
        )
        days_map[o.order_date]["outbound_containers"].append(
            {
                "container_no": "—",
                "ref_no": o.transfer_order_no,
                "customer": cu.name,
                "current_stage": "order_placed",
                "current_label": _OUTBOUND_LABELS["order_placed"],
            }
        )

    ordered_days = sorted(days_map.values(), key=lambda x: x["date"])
    return {
        "window_start": start,
        "window_end": end,
        "days": ordered_days,
    }
