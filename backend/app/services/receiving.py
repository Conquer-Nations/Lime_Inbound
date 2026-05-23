"""Operator-facing business logic: container lookup, scan, finish.

Logical-pallet mode is fully supported (each scan is one item, pallets
auto-close at items_per_pallet). Physical-pallet mode is supported as
"1 scan = 1 pallet"; partial last pallet is sized from remaining qty.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import (
    SKU,
    ActivityLog,
    Container,
    ContainerLine,
    Floor,
    Lot,
    LotAssignment,
    Pallet,
    Receipt,
    Scan,
)
from app.schemas.operator import (
    Alert,
    AssignmentRow,
    ContainerLookupResponse,
    FinishResponse,
    LineRow,
    ScanResponse,
)
from app.services.assignment import assign_container_lots
from app.services.space import compute_line_space


# ─── Errors ────────────────────────────────────────────────────────────


class ReceivingError(Exception):
    """Base for receiving flow errors."""


class ContainerNotFoundError(ReceivingError):
    pass


class ReceiptNotFoundError(ReceivingError):
    pass


# ─── Lookup ────────────────────────────────────────────────────────────


async def lookup_container(
    session: AsyncSession, container_no: str, operator: str
) -> ContainerLookupResponse:
    container = await session.scalar(
        select(Container)
        .where(Container.container_no == container_no)
        .options(
            selectinload(Container.do),
            selectinload(Container.lines).selectinload(ContainerLine.sku),
        )
    )
    if container is None:
        raise ContainerNotFoundError(container_no)

    do = container.do
    whpo = await _eager_whpo(session, do.whpo_id)
    customer = await _eager_customer(session, whpo.customer_id)

    alerts: list[Alert] = []
    today = date.today()
    if container.expected_arrival_date and container.expected_arrival_date != today:
        alerts.append(
            Alert(
                kind="date_mismatch",
                message=(
                    f"Container expected on {container.expected_arrival_date.isoformat()} "
                    f"but arriving on {today.isoformat()}. Verify billing dates."
                ),
                payload={
                    "expected": container.expected_arrival_date.isoformat(),
                    "actual": today.isoformat(),
                },
            )
        )

    # Ensure lot assignments exist
    existing_assignments = (
        await session.scalars(
            select(LotAssignment).where(LotAssignment.container_id == container.id)
        )
    ).all()
    if not existing_assignments:
        await assign_container_lots(session, container.id)

    # Find or create active receipt for this container
    receipt = await session.scalar(
        select(Receipt).where(
            Receipt.container_id == container.id,
            Receipt.status == "in_progress",
        )
    )
    if receipt is None:
        receipt = Receipt(
            container_id=container.id,
            started_by=operator,
            status="in_progress",
        )
        session.add(receipt)
        await session.flush()

    # Transition container status — log it as activity the first time
    if container.status == "expected":
        container.status = "receiving"
        container.started_at = datetime.now(timezone.utc)
        container.started_by = operator
        container.actual_arrival_date = today
        session.add(
            ActivityLog(
                actor=operator,
                kind="container_started",
                ref_type="container",
                ref_id=container.id,
                message=f"{operator} started receiving container {container.container_no}",
                payload={"do_number": do.do_number, "container_no": container.container_no},
            )
        )

    await session.flush()

    return await _build_lookup_response(session, container, do, whpo, customer, receipt, alerts)


# ─── Scan ──────────────────────────────────────────────────────────────


async def record_scan(
    session: AsyncSession, receipt_id: int, item_barcode: str, operator: str
) -> ScanResponse:
    receipt = await session.scalar(
        select(Receipt)
        .where(Receipt.id == receipt_id)
        .options(
            selectinload(Receipt.container)
            .selectinload(Container.lines)
            .selectinload(ContainerLine.sku)
        )
    )
    if receipt is None:
        raise ReceiptNotFoundError(receipt_id)

    container = receipt.container

    # Duplicate check inside this container
    existing = await session.scalar(
        select(Scan).where(
            Scan.container_id == container.id,
            Scan.item_barcode == item_barcode,
            Scan.result == "ok",
        )
    )
    if existing:
        session.add(
            Scan(
                receipt_id=receipt.id,
                container_id=container.id,
                item_barcode=item_barcode,
                scanned_by=operator,
                result="duplicate",
                error_reason="Already scanned for this container",
            )
        )
        await session.flush()
        return await _build_scan_response(
            session,
            receipt,
            accepted=False,
            result="duplicate",
            error_reason="Already scanned for this container",
        )

    # v1 assumption: single-line containers only. Multi-SKU requires barcode→SKU mapping.
    if len(container.lines) != 1:
        raise NotImplementedError(
            "Multi-SKU container scanning needs a barcode→SKU resolver (v2)."
        )
    line = container.lines[0]
    sku = line.sku
    if sku is None or not sku.items_per_pallet:
        session.add(
            Scan(
                receipt_id=receipt.id,
                container_id=container.id,
                item_barcode=item_barcode,
                scanned_by=operator,
                result="unknown",
                error_reason="SKU master data incomplete",
            )
        )
        await session.flush()
        return await _build_scan_response(
            session,
            receipt,
            accepted=False,
            result="unknown",
            error_reason="SKU master data incomplete",
        )

    # Find the current active assignment for this SKU
    assignments = (
        await session.scalars(
            select(LotAssignment)
            .where(
                LotAssignment.container_id == container.id,
                LotAssignment.sku_id == sku.id,
            )
            .order_by(LotAssignment.assignment_order)
        )
    ).all()

    current = next((a for a in assignments if a.status in ("planned", "active")), None)
    if current is None:
        return await _build_scan_response(
            session,
            receipt,
            accepted=False,
            result="container_complete",
            error_reason="All assignments full",
        )

    if current.status == "planned":
        current.status = "active"

    items_per_pallet = sku.items_per_pallet
    expected_items_in_current = current.planned_pallets * items_per_pallet

    items_placed = await _items_in_assignment(session, container.id, sku.id, current.lot_id)

    auto_cut = False
    auto_finish = False

    # Compute the footprint a full pallet of this SKU occupies — used to set
    # Pallet.sqft and to grow LotAssignment.actual_sqft as pallets complete.
    space = compute_line_space(
        qty=items_per_pallet,
        on_pallet=container.on_pallet,
        pallet_length_in=container.pallet_length_in,
        pallet_width_in=container.pallet_width_in,
        item_length_in=container.item_length_in,
        item_width_in=container.item_width_in,
        items_per_pallet=items_per_pallet,
        sku_sqft_per_unit=sku.sqft_per_unit,
        stackable=sku.stackable,
        max_stack_height=sku.max_stack_height,
        sku_pallet_sqft=sku.pallet_sqft,
    )
    pallet_footprint_sqft = space.total_sqft  # sqft for one full pallet

    if sku.pallet_mode == "logical":
        pallet = await session.scalar(
            select(Pallet)
            .where(
                Pallet.container_id == container.id,
                Pallet.sku_id == sku.id,
                Pallet.lot_id == current.lot_id,
                Pallet.qty < items_per_pallet,
            )
            .order_by(Pallet.id.desc())
            .limit(1)
        )
        if pallet is None:
            pallet = Pallet(
                receipt_id=receipt.id,
                container_id=container.id,
                sku_id=sku.id,
                lot_id=current.lot_id,
                qty=0,
                level=1,
                pallet_mode_at_receipt="logical",
                sqft=pallet_footprint_sqft,  # commit footprint when pallet starts
                palletized_by=operator,
            )
            session.add(pallet)
            await session.flush()

        pallet.qty += 1
        items_placed += 1

        if pallet.qty >= items_per_pallet:
            current.actual_pallets += 1
            current.actual_sqft += pallet_footprint_sqft

    else:  # physical
        scanned_so_far_for_line = await session.scalar(
            select(func.coalesce(func.sum(Pallet.qty), 0)).where(
                Pallet.container_id == container.id,
                Pallet.sku_id == sku.id,
            )
        )
        remaining = line.qty - (scanned_so_far_for_line or 0)
        pallet_qty = min(items_per_pallet, max(remaining, 0))

        pallet = Pallet(
            receipt_id=receipt.id,
            container_id=container.id,
            sku_id=sku.id,
            lot_id=current.lot_id,
            qty=pallet_qty,
            level=1,
            pallet_mode_at_receipt="physical",
            sqft=pallet_footprint_sqft,
            palletized_by=operator,
        )
        session.add(pallet)
        await session.flush()

        items_placed += pallet_qty
        current.actual_pallets += 1
        current.actual_sqft += pallet_footprint_sqft

    # Audit
    session.add(
        Scan(
            receipt_id=receipt.id,
            pallet_id=pallet.id,
            container_id=container.id,
            sku_id=sku.id,
            item_barcode=item_barcode,
            scanned_by=operator,
            result="ok",
        )
    )

    # Auto-cut?
    if items_placed >= expected_items_in_current or current.actual_pallets >= current.planned_pallets:
        current.status = "full"
        auto_cut = True

    # Auto-finish?
    total_scanned = await _total_scanned(session, container.id)
    total_expected = sum(line.qty for line in container.lines)
    if total_scanned >= total_expected:
        auto_finish = True

    await session.flush()

    return await _build_scan_response(
        session,
        receipt,
        accepted=True,
        result="ok",
        auto_cut=auto_cut,
        auto_finish=auto_finish,
    )


# ─── Finish ────────────────────────────────────────────────────────────


async def finish_container(
    session: AsyncSession, receipt_id: int, operator: str
) -> FinishResponse:
    receipt = await session.scalar(
        select(Receipt)
        .where(Receipt.id == receipt_id)
        .options(selectinload(Receipt.container).selectinload(Container.lines))
    )
    if receipt is None:
        raise ReceiptNotFoundError(receipt_id)

    container = receipt.container
    now = datetime.now(timezone.utc)
    receipt.status = "completed"
    receipt.finished_at = now
    receipt.finished_by = operator

    container.status = "received"
    container.finished_at = now
    container.finished_by = operator

    # Mark any remaining 'active' assignments as completed
    active_assignments = await session.scalars(
        select(LotAssignment).where(
            LotAssignment.container_id == container.id,
            LotAssignment.status.in_(["active", "planned"]),
        )
    )
    for a in active_assignments:
        a.status = "completed"

    total_scanned = await _total_scanned(session, container.id)
    total_expected = sum(line.qty for line in container.lines)
    pallets_created = await session.scalar(
        select(func.count()).select_from(Pallet).where(Pallet.container_id == container.id)
    )

    session.add(
        ActivityLog(
            actor=operator,
            kind="container_finished",
            ref_type="container",
            ref_id=container.id,
            message=(
                f"{operator} closed {container.container_no}: "
                f"{total_scanned}/{total_expected} items in {pallets_created or 0} pallets"
            ),
            payload={
                "container_no": container.container_no,
                "total_scanned": total_scanned,
                "total_expected": total_expected,
                "pallets_created": pallets_created or 0,
            },
        )
    )

    await session.flush()

    return FinishResponse(
        receipt_id=receipt.id,
        container_no=container.container_no,
        container_status=container.status,
        receipt_status=receipt.status,
        finished_at=now,
        total_scanned=total_scanned,
        total_expected=total_expected,
        pallets_created=pallets_created or 0,
    )


# ─── Internal helpers ──────────────────────────────────────────────────


async def _eager_whpo(session: AsyncSession, whpo_id: int):
    from app.models import WHPO

    return await session.get(WHPO, whpo_id)


async def _eager_customer(session: AsyncSession, customer_id: int):
    from app.models import Customer

    return await session.get(Customer, customer_id)


async def _items_in_assignment(
    session: AsyncSession, container_id: int, sku_id: int, lot_id: int
) -> int:
    total = await session.scalar(
        select(func.coalesce(func.sum(Pallet.qty), 0)).where(
            Pallet.container_id == container_id,
            Pallet.sku_id == sku_id,
            Pallet.lot_id == lot_id,
        )
    )
    return int(total or 0)


async def _total_scanned(session: AsyncSession, container_id: int) -> int:
    total = await session.scalar(
        select(func.coalesce(func.sum(Pallet.qty), 0)).where(
            Pallet.container_id == container_id
        )
    )
    return int(total or 0)


async def _assignment_row(session: AsyncSession, a: LotAssignment) -> AssignmentRow:
    lot = await session.get(Lot, a.lot_id)
    floor = await session.get(Floor, lot.floor_id)
    sku = await session.get(SKU, a.sku_id)
    items_placed = await _items_in_assignment(session, a.container_id, a.sku_id, a.lot_id)
    items_expected = a.planned_pallets * (sku.items_per_pallet or 1)
    return AssignmentRow(
        assignment_order=a.assignment_order,
        lot_id=lot.id,
        lot_code=lot.lot_code,
        floor_name=floor.name,
        sku=sku.sku,
        planned_pallets=a.planned_pallets,
        actual_pallets=a.actual_pallets,
        items_placed=items_placed,
        items_expected=items_expected,
        status=a.status,
    )


async def _build_lookup_response(
    session: AsyncSession,
    container: Container,
    do,
    whpo,
    customer,
    receipt: Receipt,
    alerts: list[Alert],
) -> ContainerLookupResponse:
    line_rows: list[LineRow] = []
    for line in container.lines:
        scanned = 0
        if line.sku_id is not None:
            scanned = int(
                (
                    await session.scalar(
                        select(func.coalesce(func.sum(Pallet.qty), 0)).where(
                            Pallet.container_id == container.id,
                            Pallet.sku_id == line.sku_id,
                        )
                    )
                )
                or 0
            )
        line_rows.append(
            LineRow(
                sku=line.sku.sku if line.sku else line.sku_raw,
                description=line.sku.description if line.sku else None,
                qty=line.qty,
                items_per_pallet=line.sku.items_per_pallet if line.sku else None,
                pallet_mode=line.sku.pallet_mode if line.sku else "logical",
                scanned=scanned,
            )
        )

    assignment_rows: list[AssignmentRow] = []
    raw_assignments = (
        await session.scalars(
            select(LotAssignment)
            .where(LotAssignment.container_id == container.id)
            .order_by(LotAssignment.assignment_order)
        )
    ).all()
    for a in raw_assignments:
        assignment_rows.append(await _assignment_row(session, a))

    total_scanned = await _total_scanned(session, container.id)
    total_expected = sum(line.qty for line in container.lines)

    return ContainerLookupResponse(
        container_no=container.container_no,
        do_number=do.do_number,
        whpo_number=whpo.whpo_number,
        customer_name=customer.name,
        expected_arrival_date=container.expected_arrival_date,
        container_status=container.status,
        receipt_id=receipt.id,
        lines=line_rows,
        assignments=assignment_rows,
        alerts=alerts,
        total_scanned=total_scanned,
        total_expected=total_expected,
    )


async def _build_scan_response(
    session: AsyncSession,
    receipt: Receipt,
    accepted: bool,
    result: str,
    error_reason: str | None = None,
    auto_cut: bool = False,
    auto_finish: bool = False,
) -> ScanResponse:
    container_id = receipt.container_id
    assignments = (
        await session.scalars(
            select(LotAssignment)
            .where(LotAssignment.container_id == container_id)
            .order_by(LotAssignment.assignment_order)
        )
    ).all()

    current = next((a for a in assignments if a.status == "active"), None)
    if current is None:
        current = next((a for a in assignments if a.status == "planned"), None)
    next_a = None
    if current is not None:
        for a in assignments:
            if a.assignment_order > current.assignment_order and a.status in ("planned", "active"):
                next_a = a
                break
    elif assignments:
        next_a = next((a for a in assignments if a.status in ("planned", "active")), None)

    current_row = await _assignment_row(session, current) if current else None
    next_row = await _assignment_row(session, next_a) if next_a else None

    total_scanned = await _total_scanned(session, container_id)
    total_expected = await session.scalar(
        select(func.coalesce(func.sum(ContainerLine.qty), 0)).where(
            ContainerLine.container_id == container_id
        )
    )

    return ScanResponse(
        receipt_id=receipt.id,
        accepted=accepted,
        result=result,
        error_reason=error_reason,
        current_assignment=current_row,
        next_assignment=next_row,
        auto_cut=auto_cut,
        auto_finish=auto_finish,
        total_scanned=total_scanned,
        total_expected=int(total_expected or 0),
    )
