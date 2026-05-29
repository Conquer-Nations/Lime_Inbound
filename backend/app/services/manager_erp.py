"""Manager ERP drilldown — assemble everything connected to a container
or a transfer order in one round-trip.

The browser hits /manager/containers/{container_no} (or .../outbound-orders/{tno})
and gets back the entire shipment context: order chain, driver/truck, scan
sheet, lot put-away, documents, downstream outbound TOs, exceptions, audit
trail. Designed to be the single pane of glass the manager uses before
invoicing.

Heavy on selectinload to keep the round-trip count flat — adding new fields
should not turn this into an N+1.
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import (
    ActivityLog,
    Container,
    ContainerDocument,
    ContainerLine,
    Customer,
    DO,
    ExceptionRecord,
    Lot,
    LotAssignment,
    OutboundContainer,
    OutboundLine,
    OutboundOrder,
    OutboundScan,
    Pallet,
    Receipt,
    Scan,
    SKU,
    WHPO,
)
from app.schemas.manager_erp import (
    ActivityEntry,
    ContainerDetailResponse,
    ContainerDocumentSummary,
    ContainerLineSummary,
    ExceptionSummary,
    LotAssignmentSummary,
    OutboundContainerSummary,
    OutboundLineDetail,
    OutboundLinkSummary,
    OutboundOrderDetailResponse,
    ScanRowSummary,
    StageEvent,
)
from app.services.space import DEFAULT_LOT_SQFT, compute_line_space
from app.services.vendor_uploads import DOCUMENT_KINDS


class NotFound(Exception):
    pass


# ─── Inbound container drilldown ───────────────────────────────────────


async def get_container_detail(
    session: AsyncSession, container_no: str
) -> ContainerDetailResponse:
    """Pull a container with every connected table needed for the ERP
    detail page. Single function — frontend just renders the sections."""
    container_no = (container_no or "").strip().upper()
    if not container_no:
        raise NotFound("container_no required")

    c = await session.scalar(
        select(Container)
        .where(Container.container_no == container_no)
        .options(
            selectinload(Container.do)
            .selectinload(DO.whpo)
            .selectinload(WHPO.customer),
            selectinload(Container.lines).selectinload(ContainerLine.sku),
            selectinload(Container.lot_assignments)
            .selectinload(LotAssignment.lot)
            .selectinload(Lot.floor),
            selectinload(Container.lot_assignments).selectinload(LotAssignment.sku),
            selectinload(Container.documents),
        )
    )
    if c is None:
        raise NotFound(f"Container {container_no} not found")

    do = c.do
    whpo = do.whpo

    # ─── Lines + sqft ──────────────────────────────────────────────────
    lines: list[ContainerLineSummary] = []
    total_sqft = 0.0
    total_expected = 0
    for ln in c.lines:
        space = compute_line_space(
            qty=ln.qty,
            on_pallet=c.on_pallet,
            pallet_length_in=c.pallet_length_in,
            pallet_width_in=c.pallet_width_in,
            item_length_in=c.item_length_in,
            item_width_in=c.item_width_in,
            items_per_pallet=ln.sku.items_per_pallet if ln.sku else None,
            sku_sqft_per_unit=ln.sku.sqft_per_unit if ln.sku else None,
            stackable=ln.sku.stackable if ln.sku else False,
            max_stack_height=ln.sku.max_stack_height if ln.sku else None,
            sku_pallet_sqft=ln.sku.pallet_sqft if ln.sku else None,
        )
        total_sqft += space.total_sqft
        total_expected += ln.qty
        lines.append(
            ContainerLineSummary(
                line_id=ln.id,
                sku=ln.sku.sku if ln.sku else ln.sku_raw,
                sku_raw=ln.sku_raw,
                qty=ln.qty,
                product_type=ln.product_type,
                sku_resolved=ln.sku_id is not None,
                description=ln.sku.description if ln.sku else None,
            )
        )

    # ─── Lot assignments ───────────────────────────────────────────────
    lot_assignments = [
        LotAssignmentSummary(
            assignment_order=a.assignment_order,
            lot_code=a.lot.lot_code,
            floor_name=a.lot.floor.name,
            sku=a.sku.sku,
            planned_pallets=a.planned_pallets,
            actual_pallets=a.actual_pallets,
            status=a.status,
        )
        for a in sorted(c.lot_assignments, key=lambda x: x.assignment_order)
    ]

    total_received = await session.scalar(
        select(func.coalesce(func.sum(Pallet.qty), 0)).where(Pallet.container_id == c.id)
    )

    # ─── Receipt + scans ───────────────────────────────────────────────
    receipt = await session.scalar(
        select(Receipt)
        .where(Receipt.container_id == c.id)
        .where(Receipt.kind == "inbound")
        .order_by(Receipt.started_at.desc())
    )

    recent_scans: list[ScanRowSummary] = []
    total_scanned = 0
    last_scan_at: datetime | None = None
    if receipt is not None:
        scans_q = await session.scalars(
            select(Scan)
            .where(Scan.receipt_id == receipt.id)
            .where(Scan.serial_number.isnot(None))
            .order_by(Scan.scanned_at.desc())
            .limit(50)
        )
        scans = list(scans_q.all())
        sku_default = _pick_line_sku(c)
        for idx, s in enumerate(scans):
            recent_scans.append(
                ScanRowSummary(
                    id=s.id,
                    serial_number=s.serial_number,
                    imei=s.imei,
                    sku=sku_default,
                    box_number=None,  # box # is derived in the operator UI, not stored
                    scanned_by=s.scanned_by,
                    scanned_at=s.scanned_at,
                    notes=s.row_notes,
                    result=s.result,
                )
            )
        total_scanned = await session.scalar(
            select(func.count())
            .select_from(Scan)
            .where(Scan.receipt_id == receipt.id)
            .where(Scan.serial_number.isnot(None))
        ) or 0
        if scans:
            last_scan_at = scans[0].scanned_at

    # ─── Documents ─────────────────────────────────────────────────────
    documents: list[ContainerDocumentSummary] = []
    for d in c.documents:
        documents.append(
            ContainerDocumentSummary(
                kind=d.kind,
                label=DOCUMENT_KINDS.get(d.kind, d.kind.replace("_", " ").title()),
                filename=d.filename,
                content_type=d.content_type,
                file_size=d.file_size,
                uploaded_at=d.uploaded_at,
                uploaded_by=d.uploaded_by,
                url=f"/vendor/container/{c.container_no}/documents/{d.kind}/file",
            )
        )

    # ─── Outbound links — TOs that source from this container ──────────
    outbound_link_q = await session.execute(
        select(
            OutboundLine,
            OutboundOrder,
            Customer.name,
        )
        .join(OutboundOrder, OutboundOrder.id == OutboundLine.outbound_order_id)
        .join(Customer, Customer.id == OutboundOrder.customer_id)
        .where(OutboundLine.source_container_no == c.container_no)
        .order_by(OutboundOrder.submitted_at.desc(), OutboundLine.line_no)
    )
    outbound_links: list[OutboundLinkSummary] = []
    for ln, order, cust_name in outbound_link_q.all():
        # Picked qty = outbound_scans for this line
        picked = await session.scalar(
            select(func.count())
            .select_from(OutboundScan)
            .where(OutboundScan.outbound_line_id == ln.id)
        ) or 0
        outbound_links.append(
            OutboundLinkSummary(
                outbound_order_id=order.id,
                transfer_order_no=order.transfer_order_no,
                po_number=order.po_number,
                customer_name=cust_name,
                order_status=order.status,
                line_id=ln.id,
                line_no=ln.line_no,
                sku=ln.sku_raw,
                order_qty=ln.order_qty,
                picked_qty=int(picked),
                order_date=order.order_date,
            )
        )

    # ─── Exceptions on the parent DO ───────────────────────────────────
    exc_rows = await session.scalars(
        select(ExceptionRecord)
        .where(ExceptionRecord.ref_type == "do")
        .where(ExceptionRecord.ref_id == do.id)
        .order_by(ExceptionRecord.opened_at.desc())
    )
    exceptions = [
        ExceptionSummary(
            exception_id=e.id,
            kind=e.kind,
            status=e.status,
            opened_at=e.opened_at,
            opened_by=e.opened_by,
            resolved_at=e.resolved_at,
            resolved_by=e.resolved_by,
            payload=e.payload,
        )
        for e in exc_rows.all()
    ]
    open_exceptions = sum(1 for e in exceptions if e.status == "open")

    # ─── Activity log (DO + container scope) ───────────────────────────
    act_rows = await session.scalars(
        select(ActivityLog)
        .where(
            or_(
                (ActivityLog.ref_type == "do") & (ActivityLog.ref_id == do.id),
                (ActivityLog.ref_type == "container") & (ActivityLog.ref_id == c.id),
                (ActivityLog.ref_type == "whpo") & (ActivityLog.ref_id == whpo.id),
                (ActivityLog.ref_type == "receipt")
                & (ActivityLog.ref_id == (receipt.id if receipt else -1)),
            )
        )
        .order_by(ActivityLog.t.desc())
        .limit(50)
    )
    activity = [
        ActivityEntry(id=a.id, t=a.t, actor=a.actor, kind=a.kind, message=a.message)
        for a in act_rows.all()
    ]

    # ─── Status timeline (mirror of vendor /whpo/{n}/status, per-container) ─
    timeline = [
        StageEvent(stage="order_placed", label="Order placed", at=whpo.received_at),
        StageEvent(
            stage="driver_assigned",
            label="Driver / truck info added",
            at=c.driver_info_received_at,
        ),
        StageEvent(
            stage="scanning",
            label="Scanning in progress",
            at=receipt.started_at if receipt else None,
        ),
        StageEvent(
            stage="complete",
            label="Scanning complete",
            at=(receipt.finished_at if (receipt and receipt.status == "completed") else None),
        ),
    ]
    current_stage = "order_placed"
    for ev in timeline:
        if ev.at is not None:
            current_stage = ev.stage

    return ContainerDetailResponse(
        container_id=c.id,
        container_no=c.container_no,
        status=c.status,
        customer_name=whpo.customer.name,
        whpo_id=whpo.id,
        whpo_number=whpo.whpo_number,
        do_id=do.id,
        do_number=do.do_number,
        bol_number=whpo.bol_number,
        expected_arrival_date=c.expected_arrival_date,
        expected_arrival_time=c.expected_arrival_time.strftime("%H:%M")
        if c.expected_arrival_time
        else None,
        actual_arrival_date=c.actual_arrival_date,
        actual_arrival_time=c.actual_arrival_time.strftime("%H:%M")
        if c.actual_arrival_time
        else None,
        started_at=c.started_at,
        finished_at=c.finished_at,
        started_by=c.started_by,
        finished_by=c.finished_by,
        driver_name=c.driver_name,
        driver_license=c.driver_license,
        driver_phone=c.driver_phone,
        truck_license_plate=c.truck_license_plate,
        carrier=c.carrier,
        insurance=c.insurance,
        driver_info_received_at=c.driver_info_received_at,
        on_pallet=c.on_pallet,
        pallet_length_in=c.pallet_length_in,
        pallet_width_in=c.pallet_width_in,
        item_length_in=c.item_length_in,
        item_width_in=c.item_width_in,
        item_height_in=c.item_height_in,
        total_sqft_needed=round(total_sqft, 2),
        lots_equivalent=round(total_sqft / DEFAULT_LOT_SQFT, 2),
        total_expected_qty=total_expected,
        total_received_qty=int(total_received or 0),
        lines=lines,
        lot_assignments=lot_assignments,
        receipt_id=receipt.id if receipt else None,
        receipt_status=receipt.status if receipt else None,
        total_scanned=int(total_scanned),
        last_scan_at=last_scan_at,
        recent_scans=recent_scans,
        documents=documents,
        outbound_links=outbound_links,
        exceptions=exceptions,
        open_exceptions=open_exceptions,
        activity=activity,
        timeline=timeline,
        current_stage=current_stage,
    )


def _pick_line_sku(c: Container) -> str | None:
    for ln in c.lines or []:
        if ln.sku is not None and ln.sku.sku:
            return ln.sku.sku
        if ln.sku_raw:
            return ln.sku_raw
    return None


# ─── Outbound transfer-order drilldown ─────────────────────────────────


async def get_outbound_order_detail(
    session: AsyncSession, transfer_order_no: str
) -> OutboundOrderDetailResponse:
    tno = (transfer_order_no or "").strip()
    if not tno:
        raise NotFound("transfer_order_no required")

    order = await session.scalar(
        select(OutboundOrder)
        .where(OutboundOrder.transfer_order_no == tno)
        .options(
            selectinload(OutboundOrder.customer),
            selectinload(OutboundOrder.lines).selectinload(OutboundLine.sku),
            selectinload(OutboundOrder.lines).selectinload(OutboundLine.serials),
            selectinload(OutboundOrder.containers),
        )
    )
    if order is None:
        raise NotFound(f"Transfer Order {transfer_order_no} not found")

    # ─── Lines + picked_qty ────────────────────────────────────────────
    lines: list[OutboundLineDetail] = []
    total_order_qty = 0
    total_picked_qty = 0
    for ln in sorted(order.lines, key=lambda x: x.line_no):
        picked = await session.scalar(
            select(func.count())
            .select_from(OutboundScan)
            .where(OutboundScan.outbound_line_id == ln.id)
        ) or 0
        lines.append(
            OutboundLineDetail(
                line_id=ln.id,
                line_no=ln.line_no,
                sku=ln.sku.sku if ln.sku else ln.sku_raw,
                description=ln.description or (ln.sku.description if ln.sku else None),
                order_qty=ln.order_qty,
                picked_qty=int(picked),
                unit=ln.unit,
                serial_specific=ln.serial_specific,
                serials_requested=[s.serial_number for s in ln.serials],
                source_container_no=ln.source_container_no,
            )
        )
        total_order_qty += ln.order_qty
        total_picked_qty += int(picked)

    # ─── Containers attached to this TO ────────────────────────────────
    containers: list[OutboundContainerSummary] = []
    earliest_scan_at: datetime | None = None
    sealed_at: datetime | None = None
    for oc in order.containers:
        receipt = await session.scalar(
            select(Receipt)
            .where(Receipt.outbound_container_id == oc.id)
            .where(Receipt.kind == "outbound")
            .order_by(Receipt.started_at.desc())
        )
        scanned = await session.scalar(
            select(func.count())
            .select_from(OutboundScan)
            .where(OutboundScan.outbound_container_id == oc.id)
        ) or 0
        containers.append(
            OutboundContainerSummary(
                container_id=oc.id,
                container_no=oc.container_no,
                container_type=oc.container_type,
                status=oc.status,
                driver_name=oc.driver_name,
                driver_license=oc.driver_license,
                driver_phone=oc.driver_phone,
                truck_license_plate=oc.truck_license_plate,
                carrier=oc.carrier,
                bol_number=oc.bol_number,
                scheduled_arrival_at=oc.scheduled_arrival_at,
                started_at=oc.started_at,
                sealed_at=oc.sealed_at,
                total_scanned=int(scanned),
                receipt_id=receipt.id if receipt else None,
                receipt_status=receipt.status if receipt else None,
            )
        )
        if oc.started_at and (earliest_scan_at is None or oc.started_at < earliest_scan_at):
            earliest_scan_at = oc.started_at
        if oc.sealed_at:
            if sealed_at is None or oc.sealed_at > sealed_at:
                sealed_at = oc.sealed_at

    # ─── Linked inbound containers (sources) ───────────────────────────
    linked_inbound = sorted(
        {ln.source_container_no for ln in order.lines if ln.source_container_no}
    )

    # ─── Timeline ──────────────────────────────────────────────────────
    has_truck = any(c.driver_name for c in order.containers)
    has_truck_at: datetime | None = None
    for oc in order.containers:
        if oc.driver_name:
            # Use scheduled_arrival_at or fallback to TO submitted_at
            has_truck_at = oc.scheduled_arrival_at or order.submitted_at
            break

    timeline = [
        StageEvent(stage="order_placed", label="Order placed", at=order.submitted_at),
        StageEvent(
            stage="truck_assigned",
            label="Truck / driver assigned",
            at=has_truck_at if has_truck else None,
        ),
        StageEvent(
            stage="loading",
            label="Loading in progress",
            at=earliest_scan_at,
        ),
        StageEvent(
            stage="sealed",
            label="Truck sealed",
            at=sealed_at,
        ),
        StageEvent(
            stage="shipped",
            label="Shipped",
            at=sealed_at if order.status == "shipped" else None,
        ),
    ]
    current_stage = "order_placed"
    for ev in timeline:
        if ev.at is not None:
            current_stage = ev.stage

    # ─── Activity ──────────────────────────────────────────────────────
    container_ids = [oc.id for oc in order.containers]
    receipt_ids: list[int] = []
    if container_ids:
        rids_q = await session.scalars(
            select(Receipt.id)
            .where(Receipt.kind == "outbound")
            .where(Receipt.outbound_container_id.in_(container_ids))
        )
        receipt_ids = list(rids_q.all())

    conds = [
        (ActivityLog.ref_type == "outbound_order") & (ActivityLog.ref_id == order.id),
    ]
    if container_ids:
        conds.append(
            (ActivityLog.ref_type == "outbound_container")
            & (ActivityLog.ref_id.in_(container_ids))
        )
    if receipt_ids:
        conds.append(
            (ActivityLog.ref_type == "receipt") & (ActivityLog.ref_id.in_(receipt_ids))
        )

    act_rows = await session.scalars(
        select(ActivityLog)
        .where(or_(*conds))
        .order_by(ActivityLog.t.desc())
        .limit(50)
    )
    activity = [
        ActivityEntry(id=a.id, t=a.t, actor=a.actor, kind=a.kind, message=a.message)
        for a in act_rows.all()
    ]

    return OutboundOrderDetailResponse(
        order_id=order.id,
        transfer_order_no=order.transfer_order_no,
        po_number=order.po_number,
        customer_name=order.customer.name if order.customer else "",
        status=order.status,
        order_date=order.order_date,
        priority=order.priority,
        memo=order.memo,
        ship_from_name=order.ship_from_name,
        ship_from_address=order.ship_from_address,
        ship_to_name=order.ship_to_name,
        ship_to_address=order.ship_to_address,
        submitted_at=order.submitted_at,
        submitted_by=order.submitted_by,
        notes=order.notes,
        lines=lines,
        total_order_qty=total_order_qty,
        total_picked_qty=total_picked_qty,
        containers=containers,
        linked_inbound_containers=linked_inbound,
        timeline=timeline,
        current_stage=current_stage,
        activity=activity,
    )


# ─── List outbound orders for the manager (cross-customer) ─────────────


async def list_outbound_orders_all(
    session: AsyncSession,
    *,
    customer_id: int | None = None,
    from_date: date | None = None,
    to_date: date | None = None,
    limit: int = 500,
) -> list[dict]:
    """Cross-customer list of every outbound TO. Powers the manager's
    Delivery Orders companion view for outbound shipments.

    Date filter applies to `order_date` — the dimension a manager
    plans against (when the truck should leave). submitted_at is just
    the back-office timestamp."""
    q = (
        select(
            OutboundOrder.id,
            OutboundOrder.transfer_order_no,
            OutboundOrder.po_number,
            Customer.name,
            OutboundOrder.status,
            OutboundOrder.order_date,
            OutboundOrder.priority,
            OutboundOrder.submitted_at,
            func.count(OutboundLine.id).label("line_count"),
        )
        .join(Customer, Customer.id == OutboundOrder.customer_id)
        .outerjoin(OutboundLine, OutboundLine.outbound_order_id == OutboundOrder.id)
        .group_by(
            OutboundOrder.id,
            Customer.name,
        )
        .order_by(OutboundOrder.submitted_at.desc())
        .limit(limit)
    )
    if customer_id is not None:
        q = q.where(OutboundOrder.customer_id == customer_id)
    if from_date is not None:
        q = q.where(OutboundOrder.order_date >= from_date)
    if to_date is not None:
        q = q.where(OutboundOrder.order_date <= to_date)
    rows_q = await session.execute(q)
    out = []
    for r in rows_q.all():
        # Picked qty across all lines on this TO
        picked = await session.scalar(
            select(func.count())
            .select_from(OutboundScan)
            .join(OutboundLine, OutboundLine.id == OutboundScan.outbound_line_id)
            .where(OutboundLine.outbound_order_id == r[0])
        ) or 0
        # Container count for this TO
        truck_count = await session.scalar(
            select(func.count())
            .select_from(OutboundContainer)
            .where(OutboundContainer.outbound_order_id == r[0])
        ) or 0
        out.append(
            {
                "order_id": r[0],
                "transfer_order_no": r[1],
                "po_number": r[2],
                "customer_name": r[3],
                "status": r[4],
                "order_date": r[5].isoformat() if r[5] else None,
                "priority": r[6],
                "submitted_at": r[7].isoformat() if r[7] else None,
                "line_count": int(r[8]) if r[8] else 0,
                "truck_count": int(truck_count),
                "picked_qty": int(picked),
            }
        )
    return out
