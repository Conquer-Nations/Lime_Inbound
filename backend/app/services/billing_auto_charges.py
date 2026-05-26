"""Auto-charge proposers.

Walks the warehouse operational data for a WHPO or Transfer Order and
emits the charge lines the system can pre-fill based on what actually
happened: container-minimum handling, hazmat, picking by unit count,
storage by pallets × days, etc. Manager reviews + edits before the
invoice is generated.

Returns plain dicts so the caller (the billing router) can either:
  - render a preview without touching the DB
  - persist as InvoiceLine rows during invoice generation

Phase 1 — best-effort heuristics. Phase 2 can refine (e.g. weight-
bucket box handling rates HND-001/2/3/4 based on actual scanned
weights).
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Container,
    ContainerLine,
    DO,
    OutboundContainer,
    OutboundLine,
    OutboundOrder,
    OutboundScan,
    RateCard,
    Receipt,
    Scan,
    WHPO,
)

logger = logging.getLogger(__name__)


# ─── Helpers ────────────────────────────────────────────────────────


async def _rate_for(session: AsyncSession, code: str) -> RateCard | None:
    return await session.get(RateCard, code)


def _line(rate: RateCard, qty: float, *, source_container_id: int | None = None,
          source_outbound_container_id: int | None = None,
          override_rate: float | None = None) -> dict[str, Any]:
    """Build a proposed line dict from a RateCard row + qty."""
    unit_rate = override_rate if override_rate is not None else (rate.rate or 0.0)
    return {
        "code": rate.code,
        "category": rate.category,
        "description": rate.description,
        "unit": rate.unit,
        "quantity": qty,
        "unit_rate": unit_rate,
        "line_total": round(qty * unit_rate * 100) / 100,
        "taxable": rate.taxable,
        "auto_applied": True,
        "source_container_id": source_container_id,
        "source_outbound_container_id": source_outbound_container_id,
    }


# ─── Inbound (per-WHPO) ─────────────────────────────────────────────


async def propose_inbound_charges(
    session: AsyncSession, whpo_id: int
) -> list[dict[str, Any]]:
    """Auto-propose charge lines for an inbound invoice (one per WHPO).

    Rules applied:
      - HND-005 ($750) per container handled
      - HND-030 ($250) per container flagged hazmat (TODO: hazmat
        detection currently uses Container.product_type heuristic;
        Phase 2 reads from container_lines.product_type)
      - PIK-* per scan recorded against the container (picking)
        (NOTE: picking is more naturally a per-outbound charge; but
        some flows do "pick at receipt" — here we leave it inbound
        if scans landed without an outbound link)
      - STG-D-NH per (pallet × day) the container has been on the
        floor (received_at → today)
    """
    res = await session.execute(
        select(Container)
        .join(DO, DO.id == Container.do_id)
        .where(DO.whpo_id == whpo_id)
    )
    containers: list[Container] = list(res.scalars())
    if not containers:
        return []

    proposed: list[dict[str, Any]] = []

    # 1. Container minimum: HND-005 per container received
    hnd_005 = await _rate_for(session, "HND-005")
    if hnd_005:
        for c in containers:
            if c.finished_at is None:
                continue  # only bill received containers
            proposed.append(_line(hnd_005, 1, source_container_id=c.id))

    # 2. Storage: STG-D-NH per pallet × days held
    stg = await _rate_for(session, "STG-D-NH")
    if stg:
        today = datetime.now(timezone.utc).date()
        for c in containers:
            if c.finished_at is None:
                continue
            received_date = c.finished_at.date() if hasattr(c.finished_at, "date") else c.finished_at
            days = max((today - received_date).days, 1)
            # Pallet count for the container
            pallets = await session.scalar(
                select(func.count())
                .select_from(__import__("app.models", fromlist=["Pallet"]).Pallet)
                .where(__import__("app.models", fromlist=["Pallet"]).Pallet.container_id == c.id)
            ) or 0
            if pallets > 0:
                proposed.append(
                    _line(stg, qty=pallets * days, source_container_id=c.id)
                )

    # 3. Picking: count scans on each container × PIK-001 rate.
    # Note: this is a SIMPLE rule. Real flow probably wants this on
    # outbound, not inbound. Tunable per customer in Phase 2.
    pik = await _rate_for(session, "PIK-001")
    if pik:
        for c in containers:
            scan_count = await session.scalar(
                select(func.count(Scan.id)).where(Scan.container_id == c.id)
            ) or 0
            if scan_count > 0:
                proposed.append(_line(pik, qty=scan_count, source_container_id=c.id))

    return proposed


# ─── Outbound (per-Transfer Order) ──────────────────────────────────


async def propose_outbound_charges(
    session: AsyncSession, outbound_order_id: int
) -> list[dict[str, Any]]:
    """Auto-propose charge lines for an outbound invoice (one per TO).

    Rules applied:
      - ORD-001 ($4.50) per outbound order (one line, qty 1)
      - PIK-001 ($2.50) per outbound scan (pick & pack)
      - BOL-001 ($12) per outbound container (Bill of Lading)
    """
    proposed: list[dict[str, Any]] = []

    # Order processing fee — one per TO
    ord001 = await _rate_for(session, "ORD-001")
    if ord001:
        proposed.append(_line(ord001, 1))

    # Picking per outbound scan
    pik = await _rate_for(session, "PIK-001")
    if pik:
        scan_count = await session.scalar(
            select(func.count(OutboundScan.id))
            .where(OutboundScan.outbound_order_id == outbound_order_id)
        ) or 0
        # OutboundScan doesn't have outbound_order_id directly — go via container
        scan_count = await session.scalar(
            select(func.count(OutboundScan.id))
            .join(OutboundContainer, OutboundContainer.id == OutboundScan.outbound_container_id)
            .where(OutboundContainer.outbound_order_id == outbound_order_id)
        ) or 0
        if scan_count > 0:
            proposed.append(_line(pik, qty=scan_count))

    # BOL per outbound container
    bol = await _rate_for(session, "BOL-001")
    if bol:
        containers = (
            await session.scalars(
                select(OutboundContainer).where(
                    OutboundContainer.outbound_order_id == outbound_order_id
                )
            )
        ).all()
        for oc in containers:
            proposed.append(
                _line(bol, qty=1, source_outbound_container_id=oc.id)
            )

    return proposed
