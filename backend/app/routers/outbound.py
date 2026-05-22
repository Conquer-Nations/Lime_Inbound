"""Vendor-facing outbound endpoints (Phase 2.2).

Mirrors `vendor.py` for inbound. Every endpoint is company-scoped via the
vendor JWT — a Lime account can only touch Lime's outbound orders, same
isolation rule as inbound.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db import get_session
from app.models import (
    ActivityLog,
    Customer,
    OutboundContainer,
    OutboundLine,
    OutboundLineSerial,
    OutboundOrder,
    OutboundScan,
)
from app.schemas.outbound import (
    InventoryItem,
    InventoryResponse,
    OutboundContainerAttachRequest,
    OutboundContainerAttachResponse,
    OutboundContainerRead,
    OutboundIntakeResponse,
    OutboundLineRead,
    OutboundOrderListItem,
    OutboundOrderListResponse,
    OutboundOrderRead,
    OutboundOrderSubmission,
    OutboundOrderUpdateRequest,
    OutboundUpdateResponse,
)
from app.services import outbound as outbound_service
from app.services import outbound_sheet_sync
from app.services.vendor_auth_service import current_vendor_required

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/vendor/outbound", tags=["vendor-outbound"])


def _normalize_company(s: str | None) -> str:
    return (s or "").strip().lower()


def _enforce_company_match(claims: dict, customer_name: str) -> None:
    """A vendor account can only touch outbound orders belonging to their
    own company (mirror of the inbound rule)."""
    vendor_co = _normalize_company(claims.get("company"))
    if not vendor_co:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Your session is missing a company. Sign out and back in.",
        )
    if vendor_co != _normalize_company(customer_name):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "This Transfer Order belongs to a different company. Only "
                "that company's vendor accounts can view or modify it."
            ),
        )


async def _ensure_customer(session: AsyncSession, name: str) -> Customer:
    """Get-or-create a customer row by name (case-insensitive)."""
    clean = (name or "").strip()
    if not clean:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Customer name is required.",
        )
    existing = await session.scalar(select(Customer).where(Customer.name == clean))
    if existing is not None:
        return existing
    customer = Customer(name=clean)
    session.add(customer)
    await session.flush()
    return customer


async def _load_order_for_vendor(
    session: AsyncSession, transfer_order_no: str, vendor: dict
) -> OutboundOrder:
    """Look up an outbound order by transfer_order_no; 404 if missing,
    403 if the vendor's company doesn't own it."""
    stmt = (
        select(OutboundOrder)
        .where(OutboundOrder.transfer_order_no == transfer_order_no)
        .options(
            selectinload(OutboundOrder.customer),
            selectinload(OutboundOrder.lines).selectinload(OutboundLine.serials),
            selectinload(OutboundOrder.containers),
        )
    )
    order = await session.scalar(stmt)
    if order is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Transfer Order {transfer_order_no} not found.",
        )
    _enforce_company_match(vendor, order.customer.name if order.customer else "")
    return order


def _line_to_read(line: OutboundLine, picked_qty: int = 0) -> OutboundLineRead:
    return OutboundLineRead(
        id=line.id,
        line_no=line.line_no,
        sku=line.sku_raw,
        description=line.description,
        order_qty=line.order_qty,
        picked_qty=picked_qty,
        unit=line.unit,
        serial_specific=line.serial_specific,
        serials_requested=[s.serial_number for s in (line.serials or [])],
    )


def _container_to_read(c: OutboundContainer) -> OutboundContainerRead:
    return OutboundContainerRead(
        id=c.id,
        container_no=c.container_no,
        container_type=c.container_type,
        status=c.status,
        driver_name=c.driver_name,
        driver_license=c.driver_license,
        driver_phone=c.driver_phone,
        truck_license_plate=c.truck_license_plate,
        carrier=c.carrier,
        insurance=c.insurance,
        bol_number=c.bol_number,
        scheduled_arrival_at=c.scheduled_arrival_at,
        started_at=c.started_at,
        sealed_at=c.sealed_at,
    )


# ─── Submit / update / list / view ─────────────────────────────────────


@router.post("/order", response_model=OutboundIntakeResponse, status_code=201)
async def submit_outbound_order(
    payload: OutboundOrderSubmission,
    session: AsyncSession = Depends(get_session),
    vendor: dict = Depends(current_vendor_required),
):
    _enforce_company_match(vendor, payload.customer)
    if not payload.lines:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="At least one line item is required.",
        )

    # Unique transfer_order_no enforced at DB; surface 409 if a dup
    existing = await session.scalar(
        select(OutboundOrder).where(
            OutboundOrder.transfer_order_no == payload.transfer_order_no
        )
    )
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Transfer Order {payload.transfer_order_no} already exists.",
        )

    customer = await _ensure_customer(session, payload.customer)

    # Auto-issue an internal Pickup Order # (PO-YYYY-NNNN) — the year comes
    # from the picking ticket's order_date when present, else today's year.
    po_year = (payload.order_date or datetime.now(timezone.utc).date()).year
    po_number = await outbound_service.next_po_number(session, po_year)

    order = OutboundOrder(
        transfer_order_no=payload.transfer_order_no.strip(),
        po_number=po_number,
        customer_id=customer.id,
        order_date=payload.order_date,
        priority=(payload.priority or "normal").lower(),
        memo=payload.memo,
        ship_from_name=payload.ship_from_name,
        ship_from_address=payload.ship_from_address,
        ship_to_name=payload.ship_to_name,
        ship_to_address=payload.ship_to_address,
        status="open",
        submitted_by=vendor.get("email"),
        notes=payload.notes,
    )
    session.add(order)
    await session.flush()

    for line_in in payload.lines:
        line = OutboundLine(
            outbound_order_id=order.id,
            line_no=line_in.line_no,
            sku_raw=line_in.sku.strip(),
            description=line_in.description,
            order_qty=line_in.order_qty,
            unit=line_in.unit,
            serial_specific=line_in.serial_specific,
        )
        session.add(line)
        await session.flush()
        if line_in.serial_specific and line_in.serials:
            for serial in line_in.serials:
                clean = serial.strip()
                if not clean:
                    continue
                session.add(
                    OutboundLineSerial(
                        outbound_line_id=line.id, serial_number=clean
                    )
                )

    session.add(
        ActivityLog(
            actor=vendor.get("email") or "vendor",
            kind="outbound_submitted",
            ref_type="outbound_order",
            ref_id=order.id,
            message=(
                f"Transfer Order {order.transfer_order_no} → {po_number} "
                f"submitted ({len(payload.lines)} lines) by {customer.name}"
            ),
        )
    )
    await session.commit()

    # Best-effort OneDrive Excel sync. Re-load with everything eager so
    # rows_from_order doesn't lazy-load in this async session.
    # populate_existing=True forces SQLAlchemy to OVERWRITE the already-
    # cached relationship collections — without it, expire_on_commit=False
    # on the session keeps stale `order.lines` from before the update.
    refreshed = await session.scalar(
        select(OutboundOrder)
        .options(
            selectinload(OutboundOrder.lines).selectinload(OutboundLine.serials),
            selectinload(OutboundOrder.containers),
        )
        .where(OutboundOrder.id == order.id)
        .execution_options(populate_existing=True)
    )
    if refreshed is not None and outbound_sheet_sync.is_configured():
        rows = outbound_sheet_sync.rows_from_order(refreshed, customer.name)
        await outbound_sheet_sync.append_outbound_rows(rows)

    return OutboundIntakeResponse(
        order_id=order.id,
        transfer_order_no=order.transfer_order_no,
        po_number=order.po_number,
        status=order.status,
        submitted_at=order.submitted_at,
    )


@router.put(
    "/order/{transfer_order_no}", response_model=OutboundUpdateResponse
)
async def update_outbound_order(
    transfer_order_no: str,
    payload: OutboundOrderUpdateRequest,
    session: AsyncSession = Depends(get_session),
    vendor: dict = Depends(current_vendor_required),
):
    _enforce_company_match(vendor, payload.customer)
    order = await _load_order_for_vendor(session, transfer_order_no, vendor)
    if order.status not in ("open", "picking"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Transfer Order {transfer_order_no} is {order.status} — "
                "no more edits allowed."
            ),
        )

    # Replace lines wholesale. The cascade='all, delete-orphan' on
    # OutboundOrder.lines + OutboundLine.serials handles removal of
    # the old rows when we re-assign.
    for old_line in list(order.lines):
        await session.delete(old_line)

    order.order_date = payload.order_date
    order.priority = (payload.priority or "normal").lower()
    order.memo = payload.memo
    order.ship_from_name = payload.ship_from_name
    order.ship_from_address = payload.ship_from_address
    order.ship_to_name = payload.ship_to_name
    order.ship_to_address = payload.ship_to_address
    order.notes = payload.notes
    await session.flush()

    for line_in in payload.lines:
        line = OutboundLine(
            outbound_order_id=order.id,
            line_no=line_in.line_no,
            sku_raw=line_in.sku.strip(),
            description=line_in.description,
            order_qty=line_in.order_qty,
            unit=line_in.unit,
            serial_specific=line_in.serial_specific,
        )
        session.add(line)
        await session.flush()
        if line_in.serial_specific and line_in.serials:
            for serial in line_in.serials:
                clean = serial.strip()
                if not clean:
                    continue
                session.add(
                    OutboundLineSerial(
                        outbound_line_id=line.id, serial_number=clean
                    )
                )

    session.add(
        ActivityLog(
            actor=vendor.get("email") or "vendor",
            kind="outbound_updated",
            ref_type="outbound_order",
            ref_id=order.id,
            message=f"Transfer Order {order.transfer_order_no} updated.",
        )
    )
    await session.commit()

    # Resync Excel: delete the old rows for this TO, then re-append the new
    # state. Mirrors the inbound update flow's delete-and-re-append pattern.
    # populate_existing=True is required — see the submit endpoint comment.
    if outbound_sheet_sync.is_configured():
        await outbound_sheet_sync.delete_outbound_rows_for_to(
            order.transfer_order_no
        )
        refreshed = await session.scalar(
            select(OutboundOrder)
            .options(
                selectinload(OutboundOrder.customer),
                selectinload(OutboundOrder.lines).selectinload(OutboundLine.serials),
                selectinload(OutboundOrder.containers),
            )
            .where(OutboundOrder.id == order.id)
            .execution_options(populate_existing=True)
        )
        if refreshed is not None:
            customer_name = refreshed.customer.name if refreshed.customer else ""
            rows = outbound_sheet_sync.rows_from_order(
                refreshed,
                customer_name,
                last_updated_iso=datetime.now(timezone.utc).isoformat(),
            )
            await outbound_sheet_sync.append_outbound_rows(rows)

    return OutboundUpdateResponse(
        order_id=order.id,
        transfer_order_no=order.transfer_order_no,
        po_number=order.po_number,
        status=order.status,
    )


@router.get("/orders", response_model=OutboundOrderListResponse)
async def list_my_outbound_orders(
    session: AsyncSession = Depends(get_session),
    vendor: dict = Depends(current_vendor_required),
):
    """Compact list of outbound orders for the vendor's company."""
    vendor_co = _normalize_company(vendor.get("company"))
    if not vendor_co:
        return OutboundOrderListResponse(orders=[])

    stmt = (
        select(OutboundOrder, Customer.name, func.count(OutboundLine.id))
        .join(Customer, OutboundOrder.customer_id == Customer.id)
        .outerjoin(OutboundLine, OutboundLine.outbound_order_id == OutboundOrder.id)
        .where(func.lower(Customer.name) == vendor_co)
        .group_by(OutboundOrder.id, Customer.name)
        .order_by(OutboundOrder.submitted_at.desc())
    )
    rows = (await session.execute(stmt)).all()
    return OutboundOrderListResponse(
        orders=[
            OutboundOrderListItem(
                id=o.id,
                transfer_order_no=o.transfer_order_no,
                po_number=o.po_number,
                customer_name=name,
                order_date=o.order_date,
                priority=o.priority,
                status=o.status,
                line_count=count,
                submitted_at=o.submitted_at,
            )
            for (o, name, count) in rows
        ]
    )


@router.get("/order/{transfer_order_no}", response_model=OutboundOrderRead)
async def view_outbound_order(
    transfer_order_no: str,
    session: AsyncSession = Depends(get_session),
    vendor: dict = Depends(current_vendor_required),
):
    order = await _load_order_for_vendor(session, transfer_order_no, vendor)

    # Count picked_qty per line (outbound_scans pointing at the line)
    picked_counts: dict[int, int] = {}
    if order.lines:
        line_ids = [l.id for l in order.lines]
        pq = await session.execute(
            select(OutboundScan.outbound_line_id, func.count())
            .where(OutboundScan.outbound_line_id.in_(line_ids))
            .group_by(OutboundScan.outbound_line_id)
        )
        picked_counts = {row[0]: row[1] for row in pq.all() if row[0] is not None}

    return OutboundOrderRead(
        id=order.id,
        transfer_order_no=order.transfer_order_no,
        po_number=order.po_number,
        customer_name=order.customer.name if order.customer else "",
        order_date=order.order_date,
        priority=order.priority,
        memo=order.memo,
        ship_from_name=order.ship_from_name,
        ship_from_address=order.ship_from_address,
        ship_to_name=order.ship_to_name,
        ship_to_address=order.ship_to_address,
        status=order.status,
        submitted_at=order.submitted_at,
        submitted_by=order.submitted_by,
        notes=order.notes,
        lines=[
            _line_to_read(l, picked_counts.get(l.id, 0)) for l in (order.lines or [])
        ],
        containers=[_container_to_read(c) for c in (order.containers or [])],
    )


# ─── Driver & truck info attach ────────────────────────────────────────


@router.post(
    "/order/{transfer_order_no}/container",
    response_model=OutboundContainerAttachResponse,
)
async def attach_outbound_container(
    transfer_order_no: str,
    payload: OutboundContainerAttachRequest,
    session: AsyncSession = Depends(get_session),
    vendor: dict = Depends(current_vendor_required),
):
    """Vendor attaches a truck (or, rarely, a BIC container) and the
    driver / carrier / BOL / insurance info. Outbound doesn't receive
    a container # from the vendor, so we auto-derive one when missing."""
    order = await _load_order_for_vendor(session, transfer_order_no, vendor)
    ctype = (payload.container_type or "truck").lower()
    if ctype not in ("bic", "truck"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="container_type must be 'bic' or 'truck'.",
        )

    explicit_no = (payload.container_no or "").strip().upper() or None
    plate = (payload.truck_license_plate or "").strip().upper() or None

    # Lookup existing container — by explicit container_no first, then by
    # (TO, truck plate) so editing the same truck always updates one row.
    existing = None
    if explicit_no:
        existing = await session.scalar(
            select(OutboundContainer).where(
                OutboundContainer.container_no == explicit_no
            )
        )
    elif plate:
        existing = await session.scalar(
            select(OutboundContainer).where(
                OutboundContainer.outbound_order_id == order.id,
                OutboundContainer.truck_license_plate == plate,
            )
        )

    if existing is not None:
        if existing.outbound_order_id != order.id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    f"Container {existing.container_no} is already attached "
                    "to a different Transfer Order."
                ),
            )
        c = existing
    else:
        # Auto-generate container_no when nothing was supplied. Prefer the
        # truck plate (natural key); fall back to a TO-scoped placeholder.
        synth_no = (
            explicit_no
            or plate
            or f"OUT-{order.transfer_order_no}-"
            f"{int(datetime.now(timezone.utc).timestamp())}"
        )
        c = OutboundContainer(
            outbound_order_id=order.id,
            container_no=synth_no,
            container_type=ctype,
            status="open",
        )
        session.add(c)
        await session.flush()

    c.container_type = ctype
    c.driver_name = payload.driver_name
    c.driver_license = payload.driver_license
    c.driver_phone = payload.driver_phone
    c.truck_license_plate = payload.truck_license_plate
    c.insurance = payload.insurance
    c.carrier = payload.carrier
    c.bol_number = payload.bol_number
    c.scheduled_arrival_at = payload.scheduled_arrival_at

    session.add(
        ActivityLog(
            actor=vendor.get("email") or "vendor",
            kind="outbound_container_attached",
            ref_type="outbound_container",
            ref_id=c.id,
            message=(
                f"Container {c.container_no} ({ctype}) attached to "
                f"{order.transfer_order_no}."
            ),
        )
    )
    await session.commit()

    # Resync OutboundTable so the new container + driver info shows up.
    # Delete the order's existing rows then re-append with the full
    # container set on each row (one row per container × line).
    # populate_existing=True is required — see the submit endpoint comment.
    if outbound_sheet_sync.is_configured():
        await outbound_sheet_sync.delete_outbound_rows_for_to(
            order.transfer_order_no
        )
        refreshed = await session.scalar(
            select(OutboundOrder)
            .options(
                selectinload(OutboundOrder.customer),
                selectinload(OutboundOrder.lines).selectinload(OutboundLine.serials),
                selectinload(OutboundOrder.containers),
            )
            .where(OutboundOrder.id == order.id)
            .execution_options(populate_existing=True)
        )
        if refreshed is not None:
            customer_name = refreshed.customer.name if refreshed.customer else ""
            rows = outbound_sheet_sync.rows_from_order(
                refreshed,
                customer_name,
                last_updated_iso=datetime.now(timezone.utc).isoformat(),
            )
            await outbound_sheet_sync.append_outbound_rows(rows)

    return OutboundContainerAttachResponse(
        container_id=c.id, container_no=c.container_no, status=c.status
    )


# ─── Inventory query (what's available to ship?) ───────────────────────


@router.get("/inventory", response_model=InventoryResponse)
async def list_inventory(
    session: AsyncSession = Depends(get_session),
    vendor: dict = Depends(current_vendor_required),
):
    """Available stock by SKU for the vendor's company. Computed as
    inbound scans minus outbound scans."""
    company = (vendor.get("company") or "").strip()
    if not company:
        return InventoryResponse(items=[])
    rows = await outbound_service.list_available_inventory_for_company(
        session, company
    )
    return InventoryResponse(
        items=[InventoryItem(sku=sku, available_qty=qty) for sku, qty in rows]
    )
