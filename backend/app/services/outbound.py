"""Outbound shipment services.

The single source of truth for 'available stock' is:

    available =  inbound scans (with serial_number set)
              -  outbound scans that reference those inbound scans

When an outbound scan is recorded with `inbound_scan_id = X`, the unit
represented by inbound Scan X is no longer available.
"""

from __future__ import annotations

import re
from datetime import date

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Container,
    ContainerLine,
    Customer,
    DO,
    OutboundLine,
    OutboundOrder,
    OutboundScan,
    SKU,
    Scan,
    WHPO,
)


async def next_po_number(session: AsyncSession, year: int) -> str:
    """Generate the next sequential Pickup Order # for `year`. Mirror of
    inbound's `_next_do_number` — PO-YYYY-NNNN, gap-OK after wipes."""
    prefix = f"PO-{year}-"
    latest = await session.scalar(
        select(func.max(OutboundOrder.po_number)).where(
            OutboundOrder.po_number.like(f"{prefix}%")
        )
    )
    if latest is None:
        seq = 1
    else:
        m = re.search(r"(\d+)$", latest)
        seq = (int(m.group(1)) + 1) if m else 1
    return f"{prefix}{seq:04d}"


async def list_available_inventory_for_company(
    session: AsyncSession,
    customer_ids: list[int],
) -> list[tuple[str, int]]:
    """Return [(sku, available_qty)] for every SKU with stock currently on
    hand across the given customer/brand IDs.

    Caller passes a customer-id list (typically from `vendor_customer_ids`)
    so account-level logins like TQL get every brand rolling up to them.
    Previously took a single company_name and matched Customer.name —
    silently returned 0 rows for account-level logins since TQL is an
    Account, not a Customer.

    Definition: each Scan row (inbound) with serial_number != NULL counts as
    one unit. An OutboundScan with `inbound_scan_id` set marks that unit as
    shipped — we subtract those out.

    SKU comes from the ContainerLine that owns the Container of the Receipt
    of the Scan. We take the first line on the container as the SKU label
    (containers typically carry one SKU each in this 3PL flow).
    """
    if not customer_ids:
        return []
    # Inbound scans for this customer set that still have serials assigned
    inbound_q = (
        select(
            ContainerLine.sku_raw.label("sku_raw"),
            Scan.id.label("scan_id"),
        )
        .join(Container, ContainerLine.container_id == Container.id)
        .join(DO, Container.do_id == DO.id)
        .join(WHPO, DO.whpo_id == WHPO.id)
        .join(Scan, Scan.container_id == Container.id)
        .where(WHPO.customer_id.in_(customer_ids))
        .where(Scan.serial_number.isnot(None))
        .subquery()
    )

    # Outbound scans that reference any of those inbound scans
    shipped_q = select(OutboundScan.inbound_scan_id).where(
        OutboundScan.inbound_scan_id.isnot(None)
    ).subquery()

    counted = (
        select(
            inbound_q.c.sku_raw,
            func.count().label("available"),
        )
        .where(inbound_q.c.scan_id.notin_(select(shipped_q.c.inbound_scan_id)))
        .group_by(inbound_q.c.sku_raw)
        .order_by(inbound_q.c.sku_raw)
    )
    rows = (await session.execute(counted)).all()
    return [(r.sku_raw or "", r.available) for r in rows]


async def find_inbound_scan_by_serial(
    session: AsyncSession, serial: str, company_name: str
) -> Scan | None:
    """Look up an UNSHIPPED inbound scan by serial number, scoped to a
    company. Returns None if the serial isn't on hand for that company
    (either never scanned in or already shipped out)."""
    stmt = (
        select(Scan)
        .join(Container, Scan.container_id == Container.id)
        .join(DO, Container.do_id == DO.id)
        .join(WHPO, DO.whpo_id == WHPO.id)
        .where(WHPO.customer.has(name=company_name))
        .where(Scan.serial_number == serial)
        .order_by(Scan.scanned_at.asc())
        .limit(1)
    )
    scan = await session.scalar(stmt)
    if scan is None:
        return None
    # Make sure it isn't already shipped out
    already = await session.scalar(
        select(OutboundScan.id).where(OutboundScan.inbound_scan_id == scan.id)
    )
    if already is not None:
        return None
    return scan


async def find_inbound_scan_fifo(
    session: AsyncSession, sku_raw: str, company_name: str
) -> Scan | None:
    """Pick the oldest unshipped inbound scan for a given SKU + company.
    Used when an outbound line is not serial-specific — operator picks
    'any matching SKU' and we tag it FIFO."""
    shipped_subq = select(OutboundScan.inbound_scan_id).where(
        OutboundScan.inbound_scan_id.isnot(None)
    )
    stmt = (
        select(Scan)
        .join(Container, Scan.container_id == Container.id)
        .join(ContainerLine, ContainerLine.container_id == Container.id)
        .join(DO, Container.do_id == DO.id)
        .join(WHPO, DO.whpo_id == WHPO.id)
        .where(WHPO.customer.has(name=company_name))
        .where(ContainerLine.sku_raw == sku_raw)
        .where(Scan.serial_number.isnot(None))
        .where(Scan.id.notin_(shipped_subq))
        .order_by(Scan.scanned_at.asc())
        .limit(1)
    )
    return await session.scalar(stmt)


# ─── Per-container inventory dashboard ─────────────────────────────────


async def list_container_inventory_for_company(
    session: AsyncSession,
    customer_ids: list[int],
    from_date: date | None = None,
    to_date: date | None = None,
) -> list[dict]:
    """Build the per-(container, sku) inventory summary across a set of
    customer/brand IDs.

    Caller passes a customer-id list (typically from `vendor_customer_ids`)
    so account-level logins like TQL get every brand rolling up. Previously
    took a single company_name and matched Customer.name — TQL is an
    Account, so that returned 0 rows for account-level logins.

    For each inbound container line we have:
      inbound_qty  — ContainerLine.qty (manifest qty)
      outbound_qty — sum of OutboundLine.order_qty across outbound lines
                     whose source_container_no matches AND whose order
                     is not cancelled
      pending_qty  = inbound_qty - outbound_qty

    Returns dicts ready for ContainerInventoryItem; order is most-recent
    container first.
    """
    if not customer_ids:
        return []

    # 1. Inbound rows from the manifest. One row per (container, sku).
    inbound_stmt = (
        select(
            Container.container_no,
            ContainerLine.sku_raw,
            ContainerLine.product_type,
            func.sum(ContainerLine.qty),
            func.max(DO.expected_arrival_date),
        )
        .join(DO, Container.do_id == DO.id)
        .join(WHPO, DO.whpo_id == WHPO.id)
        .join(ContainerLine, ContainerLine.container_id == Container.id)
        .where(WHPO.customer_id.in_(customer_ids))
    )
    if from_date is not None:
        inbound_stmt = inbound_stmt.where(DO.expected_arrival_date >= from_date)
    if to_date is not None:
        inbound_stmt = inbound_stmt.where(DO.expected_arrival_date <= to_date)
    inbound_stmt = (
        inbound_stmt.group_by(
            Container.container_no,
            ContainerLine.sku_raw,
            ContainerLine.product_type,
        )
        .order_by(func.max(DO.expected_arrival_date).desc().nullslast())
    )
    inbound_rows = (await session.execute(inbound_stmt)).all()

    # 2. Outbound shipped — counted from actual OutboundScans. Each
    # OutboundScan links to an inbound Scan via inbound_scan_id; we trace
    # back to (container, sku) and aggregate. This is the physical truth
    # — only units the operator has actually scanned onto an outgoing
    # truck count as "outbound". Order_qty allocations on outbound_lines
    # are intent; scans are reality.
    outbound_stmt = (
        select(
            Container.container_no,
            ContainerLine.sku_raw,
            func.count(),
        )
        .join(Scan, Scan.container_id == Container.id)
        .join(OutboundScan, OutboundScan.inbound_scan_id == Scan.id)
        .join(DO, Container.do_id == DO.id)
        .join(WHPO, DO.whpo_id == WHPO.id)
        .join(ContainerLine, ContainerLine.container_id == Container.id)
        .where(WHPO.customer_id.in_(customer_ids))
        .group_by(Container.container_no, ContainerLine.sku_raw)
    )
    outbound_rows = (await session.execute(outbound_stmt)).all()
    outbound_map = {
        (r[0], r[1]): int(r[2] or 0) for r in outbound_rows
    }

    # 3. Which TO #s have drawn from each container (informational).
    allocations_stmt = (
        select(
            OutboundLine.source_container_no,
            OutboundOrder.transfer_order_no,
        )
        .join(OutboundOrder, OutboundLine.outbound_order_id == OutboundOrder.id)
        .where(OutboundOrder.customer_id.in_(customer_ids))
        .where(OutboundLine.source_container_no.isnot(None))
        .where(OutboundOrder.status != "cancelled")
        .distinct()
    )
    allocations_rows = (await session.execute(allocations_stmt)).all()
    allocations_map: dict[str, list[str]] = {}
    for source_no, tno in allocations_rows:
        allocations_map.setdefault(source_no, []).append(tno)

    out: list[dict] = []
    for container_no, sku_raw, ptype, qty, received in inbound_rows:
        inbound_qty = int(qty or 0)
        outbound_qty = outbound_map.get((container_no, sku_raw), 0)
        out.append(
            {
                "container_no": container_no,
                "sku": sku_raw or "",
                "description": ptype or None,
                "inbound_qty": inbound_qty,
                "outbound_qty": outbound_qty,
                "pending_qty": inbound_qty - outbound_qty,
                "received_date": received,
                "allocated_to": allocations_map.get(container_no, []),
            }
        )
    return out
