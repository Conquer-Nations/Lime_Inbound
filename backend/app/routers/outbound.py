"""Vendor-facing outbound endpoints (Phase 2.2).

Mirrors `vendor.py` for inbound. Every endpoint is company-scoped via the
vendor JWT — a Lime account can only touch Lime's outbound orders, same
isolation rule as inbound.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db import get_session
from app.models import (
    DO,
    WHPO,
    ActivityLog,
    Container,
    ContainerLine,
    Customer,
    OutboundContainer,
    OutboundLine,
    OutboundLineSerial,
    OutboundOrder,
    OutboundScan,
    Receipt,
)
from app.schemas.outbound import (
    ContainerInventoryItem,
    ContainerInventoryResponse,
    InventoryItem,
    InventoryResponse,
    OutboundContainerAttachRequest,
    OutboundContainerAttachResponse,
    OutboundContainerRead,
    OutboundContainerStatus,
    OutboundIntakeResponse,
    OutboundLineRead,
    OutboundOrderListItem,
    OutboundOrderListResponse,
    OutboundOrderRead,
    OutboundOrderStatusResponse,
    OutboundOrderSubmission,
    OutboundOrderUpdateRequest,
    OutboundStatusEvent,
    OutboundUpdateResponse,
)
from app.services import outbound as outbound_service
from app.services import outbound_sheet_sync
from app.services.vendor_auth_service import current_vendor_required

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/vendor/outbound", tags=["vendor-outbound"])


# Outbound vendor↔customer scoping. Lives in app.services.vendor_scoping
# so the rule (direct brand match OR Account→brand under it) stays in
# one place. The inbound message reads "shipment"; the wording carrying
# over here ("This shipment belongs to…") is acceptable for outbound too
# since the helper is generic.
from app.services.vendor_scoping import (
    enforce_company_match as _enforce_company_match,
    vendor_customer_ids as _vendor_customer_ids,
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


async def _fifo_pick_source_container(
    session: AsyncSession,
    *,
    customer_id: int,
    sku_raw: str,
) -> str | None:
    """FIFO source-container picker for outbound order lines.

    Returns the container_no of the oldest received inbound container
    belonging to `customer_id` that contains this SKU. None if no such
    container exists (vendor will need to wait for a fresh inbound).

    "Oldest received" = earliest `containers.finished_at` (when the
    operator sealed the scan sheet). Pre-receipt containers aren't
    picked since their inventory isn't physically on the floor yet.

    NOTE: this is an MVP first pass. It doesn't yet account for
    remaining stock per container (a container that's been fully
    shipped out should be skipped). That refinement requires summing
    outbound_scans by source_container_no minus container_lines qty
    — to be done when partial-outbound tracking lands."""
    sku_clean = sku_raw.strip()
    if not sku_clean:
        return None
    row = await session.execute(
        select(Container.container_no)
        .join(DO, DO.id == Container.do_id)
        .join(WHPO, WHPO.id == DO.whpo_id)
        .join(ContainerLine, ContainerLine.container_id == Container.id)
        .where(WHPO.customer_id == customer_id)
        .where(func.lower(ContainerLine.sku_raw) == sku_clean.lower())
        .where(Container.finished_at.is_not(None))
        .order_by(Container.finished_at.asc())
        .limit(1)
    )
    container_no = row.scalar_one_or_none()
    if container_no:
        logger.info(
            "FIFO auto-pick: customer=%s sku=%s → container=%s",
            customer_id,
            sku_clean,
            container_no,
        )
    else:
        logger.info(
            "FIFO auto-pick: no received container found for customer=%s sku=%s",
            customer_id,
            sku_clean,
        )
    return container_no


def order_company_name(order: OutboundOrder) -> str:
    """Best-effort customer name lookup that doesn't lazy-load. Returns
    empty string if the customer relationship isn't already populated."""
    try:
        if order.customer is not None:
            return order.customer.name or ""
    except Exception:
        pass
    return ""


async def _refresh_inventory_snapshot(
    session: AsyncSession, company_name: str
) -> None:
    """Recompute the per-container inventory summary for a company and
    push it to the ContainerInventory worksheet in OneDrive. Best-effort:
    any failure is logged and swallowed so vendor flows never break.

    `company_name` is the vendor's claim, which may be either a Customer
    (brand) name OR an Account name. Resolve to a customer-id list via
    the same logic vendor scoping uses, so account-level flows roll up
    every brand under the account.
    """
    if not company_name:
        return
    try:
        from app.services.vendor_scoping import vendor_customer_ids
        ids = await vendor_customer_ids(session, {"company": company_name})
        if not ids:
            return
        items = await outbound_service.list_container_inventory_for_company(
            session, ids
        )
        rows = outbound_sheet_sync.inventory_rows_from_items(company_name, items)
        await outbound_sheet_sync.replace_container_inventory_for_company(
            company_name, rows
        )
    except Exception as e:
        logger.warning("Inventory snapshot refresh failed: %s", e)


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
    await _enforce_company_match(session, vendor, order.customer.name if order.customer else "")
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
        source_container_no=line.source_container_no,
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
    await _enforce_company_match(session, vendor, payload.customer)
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
        # FIFO auto-pick: when the vendor didn't specify a source container,
        # find the oldest received inbound container for this customer that
        # contains the SKU. Per Tiana: "if they don't select, the system
        # should auto-determine a FIFO system to tell the respective items
        # from which inbound container they need to go."
        source_container = (line_in.source_container_no or "").strip() or None
        if source_container is None:
            source_container = await _fifo_pick_source_container(
                session,
                customer_id=order.customer_id,
                sku_raw=line_in.sku.strip(),
            )

        line = OutboundLine(
            outbound_order_id=order.id,
            line_no=line_in.line_no,
            sku_raw=line_in.sku.strip(),
            description=line_in.description,
            order_qty=line_in.order_qty,
            unit=line_in.unit,
            serial_specific=line_in.serial_specific,
            source_container_no=source_container,
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

    await _refresh_inventory_snapshot(session, customer.name)

    # Master sheet's `to_no` + `ship_date` + `ship_to` + `units_out`
    # columns all derive from outbound_orders / outbound_lines — push
    # so the vendor + manager Master Sheet views match the new TO.
    from app.services import master_sheet_sync
    await master_sheet_sync.maybe_push(session, source="outbound_submitted")

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
    await _enforce_company_match(session, vendor, payload.customer)
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
        # FIFO auto-pick when vendor didn't specify (mirror of submit path).
        source_container = (line_in.source_container_no or "").strip() or None
        if source_container is None:
            source_container = await _fifo_pick_source_container(
                session,
                customer_id=order.customer_id,
                sku_raw=line_in.sku.strip(),
            )
        line = OutboundLine(
            outbound_order_id=order.id,
            line_no=line_in.line_no,
            sku_raw=line_in.sku.strip(),
            description=line_in.description,
            order_qty=line_in.order_qty,
            unit=line_in.unit,
            serial_specific=line_in.serial_specific,
            source_container_no=source_container,
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
                last_updated_at=datetime.now(timezone.utc),
            )
            await outbound_sheet_sync.append_outbound_rows(rows)
        await _refresh_inventory_snapshot(session, order_company_name(order))

    # TO updates change source_container assignments / order_qty / ship_to
    # — all of which flow through the master sheet outbound columns.
    from app.services import master_sheet_sync
    await master_sheet_sync.maybe_push(session, source="outbound_updated")

    return OutboundUpdateResponse(
        order_id=order.id,
        transfer_order_no=order.transfer_order_no,
        po_number=order.po_number,
        status=order.status,
    )


_OUTBOUND_DOC_KINDS = {"bol", "packing_list"}
_OUTBOUND_DOC_LABELS = {"bol": "Bill of Lading", "packing_list": "Packing List"}
_ALLOWED_DOC_TYPES = {
    "image/jpeg", "image/jpg", "image/png", "image/webp",
    "image/heic", "image/heif", "image/gif", "application/pdf",
}


@router.post("/order/{transfer_order_no}/document/{kind}")
async def upload_outbound_document(
    transfer_order_no: str,
    kind: str,
    file: UploadFile = File(...),
    session: AsyncSession = Depends(get_session),
    vendor: dict = Depends(current_vendor_required),
) -> dict:
    """Vendor uploads a BOL or Packing List for an outbound order.
    Replaces any prior file of the same kind (one BOL / one packing
    list per TO). Both files mirror to OneDrive's container folder
    when the order has containers attached."""
    from app.services import vendor_uploads

    if kind not in _OUTBOUND_DOC_KINDS:
        raise HTTPException(
            400,
            f"Unknown document kind '{kind}'. Allowed: {sorted(_OUTBOUND_DOC_KINDS)}",
        )
    order = await _load_order_for_vendor(session, transfer_order_no, vendor)

    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    content_type = (file.content_type or "").lower()
    if content_type not in _ALLOWED_DOC_TYPES:
        raise HTTPException(
            415,
            f"Unsupported content type {content_type!r}. Allowed: {sorted(_ALLOWED_DOC_TYPES)}",
        )
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(413, "File too large (>20 MB)")

    # Save bytes under outbound_orders/{id}/{kind}-{uuid}.{ext}. We
    # reuse the inbound vendor_uploads helper since the on-disk layout
    # is fine for both — the path is keyed by a synthetic "container id"
    # which here is the order id + 1_000_000 offset to avoid collisions.
    # (Outbound orders live in a separate table from inbound containers
    # but use the same storage tree.)
    rel_path, _abs = vendor_uploads.save_bytes(
        1_000_000 + order.id,
        f"outbound_{kind}",
        data,
        file.filename or kind,
        content_type,
    )

    # Replace any prior file of the same kind to avoid orphans.
    prior_path = getattr(order, f"{kind}_storage_path")
    if prior_path and prior_path != rel_path:
        try:
            vendor_uploads.delete_storage_file(prior_path)
        except Exception:
            pass

    setattr(order, f"{kind}_filename", file.filename or kind)
    setattr(order, f"{kind}_storage_path", rel_path)
    setattr(order, f"{kind}_content_type", content_type)

    session.add(
        ActivityLog(
            actor=vendor.get("email") or "vendor",
            kind=f"outbound_{kind}_uploaded",
            ref_type="outbound_order",
            ref_id=order.id,
            message=(
                f"{_OUTBOUND_DOC_LABELS[kind]} uploaded for TO "
                f"{order.transfer_order_no}"
            ),
        )
    )
    await session.commit()
    return {
        "transfer_order_no": order.transfer_order_no,
        "kind": kind,
        "filename": file.filename or kind,
        "content_type": content_type,
        "size": len(data),
    }


@router.get("/orders", response_model=OutboundOrderListResponse)
async def list_my_outbound_orders(
    session: AsyncSession = Depends(get_session),
    vendor: dict = Depends(current_vendor_required),
):
    """Compact list of outbound orders the vendor can see — direct brand
    match OR any brand rolling up to their Account (if account-level login)."""
    customer_ids = await _vendor_customer_ids(session, vendor)
    if not customer_ids:
        return OutboundOrderListResponse(orders=[])

    stmt = (
        select(OutboundOrder, Customer.name, func.count(OutboundLine.id))
        .join(Customer, OutboundOrder.customer_id == Customer.id)
        .outerjoin(OutboundLine, OutboundLine.outbound_order_id == OutboundOrder.id)
        .where(OutboundOrder.customer_id.in_(customer_ids))
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
        has_bol=bool(order.bol_storage_path),
        bol_filename=order.bol_filename,
        has_packing_list=bool(order.packing_list_storage_path),
        packing_list_filename=order.packing_list_filename,
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
                last_updated_at=datetime.now(timezone.utc),
            )
            await outbound_sheet_sync.append_outbound_rows(rows)
        await _refresh_inventory_snapshot(session, order_company_name(order))

    # Attaching an outbound container changes the units_out / pallets_out
    # / to_no columns on every inbound container the new truck draws
    # from. Keep the master sheet mirror in sync.
    from app.services import master_sheet_sync
    await master_sheet_sync.maybe_push(session, source="outbound_container_attached")

    return OutboundContainerAttachResponse(
        container_id=c.id, container_no=c.container_no, status=c.status
    )


# ─── Inventory query (what's available to ship?) ───────────────────────


@router.get("/inventory", response_model=InventoryResponse)
async def list_inventory(
    session: AsyncSession = Depends(get_session),
    vendor: dict = Depends(current_vendor_required),
):
    """Available stock by SKU across every brand the vendor's JWT can
    access (direct-brand or account-level rollup). Computed as inbound
    scans minus outbound scans."""
    from app.services.vendor_scoping import vendor_customer_ids
    ids = await vendor_customer_ids(session, vendor)
    if not ids:
        return InventoryResponse(items=[])
    rows = await outbound_service.list_available_inventory_for_company(
        session, ids
    )
    return InventoryResponse(
        items=[InventoryItem(sku=sku, available_qty=qty) for sku, qty in rows]
    )


@router.get(
    "/container-inventory", response_model=ContainerInventoryResponse
)
async def container_inventory(
    customer_id: int | None = None,
    from_date: date | None = None,
    to_date: date | None = None,
    session: AsyncSession = Depends(get_session),
    vendor: dict = Depends(current_vendor_required),
):
    """Per-(container, sku) inventory dashboard across every brand the
    vendor's JWT can access (direct-brand or account-level rollup).
    Each row shows inbound (manifest) qty, outbound qty already allocated
    to Transfer Orders, and pending (remaining) qty.

    Optional filters (FilterBar): `customer_id` narrows to a single brand
    (must be in the vendor's allowed scope), `from_date`/`to_date` filter
    by container expected arrival date.
    """
    from app.services.vendor_scoping import vendor_customer_ids
    ids = await vendor_customer_ids(session, vendor)
    if not ids:
        return ContainerInventoryResponse(
            containers=[],
            total_inbound=0,
            total_outbound=0,
            total_pending=0,
        )
    # Intersect requested customer_id with allowed scope — never trust
    # the client to broaden access.
    if customer_id is not None:
        if customer_id not in ids:
            return ContainerInventoryResponse(
                containers=[],
                total_inbound=0,
                total_outbound=0,
                total_pending=0,
            )
        ids = [customer_id]
    rows = await outbound_service.list_container_inventory_for_company(
        session, ids, from_date=from_date, to_date=to_date
    )
    items = [ContainerInventoryItem(**r) for r in rows]
    return ContainerInventoryResponse(
        containers=items,
        total_inbound=sum(i.inbound_qty for i in items),
        total_outbound=sum(i.outbound_qty for i in items),
        total_pending=sum(i.pending_qty for i in items),
    )


@router.get(
    "/order/{transfer_order_no}/status",
    response_model=OutboundOrderStatusResponse,
)
async def get_outbound_order_status(
    transfer_order_no: str,
    session: AsyncSession = Depends(get_session),
    vendor: dict = Depends(current_vendor_required),
):
    """Status timeline for each truck on a Transfer Order. Vendor-visible
    outbound progress: order placed → truck attached → truck arrived →
    loading → sealed."""
    order = await _load_order_for_vendor(session, transfer_order_no, vendor)
    order_placed_at = order.submitted_at

    # Pull outbound receipts (kind='outbound') for these containers.
    receipts_by_container: dict[int, Receipt] = {}
    container_ids = [c.id for c in (order.containers or [])]
    if container_ids:
        rs = await session.scalars(
            select(Receipt)
            .where(Receipt.kind == "outbound")
            .where(Receipt.outbound_container_id.in_(container_ids))
            .order_by(Receipt.started_at.desc())
        )
        for r in rs.all():
            receipts_by_container.setdefault(r.outbound_container_id, r)

    containers_out: list[OutboundContainerStatus] = []
    for c in sorted(order.containers or [], key=lambda x: x.container_no):
        receipt = receipts_by_container.get(c.id)
        # truck_attached = the OutboundContainer was created. We don't
        # have a dedicated attached_at column, so approximate with
        # started_at or scheduled_arrival_at (earliest non-null);
        # fall back to order_placed_at if neither set yet.
        attached_at = c.started_at or c.scheduled_arrival_at or order_placed_at
        truck_arrived_at = c.started_at  # operator opening scan sheet
        loading_at = receipt.started_at if receipt else c.started_at
        sealed_at = c.sealed_at

        timeline = [
            OutboundStatusEvent(stage="order_placed", label="Order placed", at=order_placed_at),
            OutboundStatusEvent(stage="truck_attached", label="Truck attached", at=attached_at),
            OutboundStatusEvent(
                stage="truck_arrived",
                label="Truck arrived at dock",
                at=truck_arrived_at,
            ),
            OutboundStatusEvent(stage="loading", label="Loading in progress", at=loading_at),
            OutboundStatusEvent(stage="sealed", label="Truck sealed / departed", at=sealed_at),
        ]
        current_stage = "order_placed"
        for ev in timeline:
            if ev.at is not None:
                current_stage = ev.stage
        containers_out.append(
            OutboundContainerStatus(
                container_no=c.container_no,
                current_stage=current_stage,
                timeline=timeline,
            )
        )

    return OutboundOrderStatusResponse(
        transfer_order_no=order.transfer_order_no,
        po_number=order.po_number,
        customer_name=order.customer.name if order.customer else "",
        order_placed_at=order_placed_at,
        containers=containers_out,
    )
