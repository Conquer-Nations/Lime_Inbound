"""Outbound shipment services.

The single source of truth for 'available stock' is:

    available =  inbound scans (with serial_number set)
              -  outbound scans that reference those inbound scans

When an outbound scan is recorded with `inbound_scan_id = X`, the unit
represented by inbound Scan X is no longer available.
"""

from __future__ import annotations

import re

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Container,
    ContainerLine,
    DO,
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
    session: AsyncSession, company_name: str
) -> list[tuple[str, int]]:
    """Return [(sku, available_qty)] for every SKU with stock currently on
    hand for `company_name`.

    Definition: each Scan row (inbound) with serial_number != NULL counts as
    one unit. An OutboundScan with `inbound_scan_id` set marks that unit as
    shipped — we subtract those out.

    SKU comes from the ContainerLine that owns the Container of the Receipt
    of the Scan. We take the first line on the container as the SKU label
    (containers typically carry one SKU each in this 3PL flow).
    """
    # Inbound scans for this company that still have serials assigned
    inbound_q = (
        select(
            ContainerLine.sku_raw.label("sku_raw"),
            Scan.id.label("scan_id"),
        )
        .join(Container, ContainerLine.container_id == Container.id)
        .join(DO, Container.do_id == DO.id)
        .join(WHPO, DO.whpo_id == WHPO.id)
        .join(Scan, Scan.container_id == Container.id)
        .where(WHPO.customer.has(name=company_name))
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
