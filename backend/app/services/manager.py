"""Manager-facing read endpoints and exception resolution.

Resolving an `unknown_sku` exception creates the SKU master row, attaches it
to any container lines that referenced it by raw string, and (if no other
open exceptions remain on the DO) flips the DO status to 'ready' so the
operator can proceed.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import and_, cast, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sqlalchemy.types import Date as SqlDate

from app.models import (
    SKU,
    ActivityLog,
    Container,
    ContainerLine,
    Customer,
    DO,
    ExceptionRecord,
    Floor,
    Lot,
    LotAssignment,
    OutboundScan,
    Pallet,
    Receipt,
    Scan,
    TallySheet,
    WHPO,
)

# Warehouse is in Vernon, CA — dashboard "today" should mean the
# operator's local day, not UTC. Otherwise a 5pm-PT scan rolls into
# "tomorrow" on the dashboard at midnight UTC (= 5pm PT).
_WAREHOUSE_TZ = ZoneInfo("America/Los_Angeles")


def _warehouse_today() -> date:
    return datetime.now(_WAREHOUSE_TZ).date()
from app.schemas.manager import (
    ActivityFeedItem,
    AssignmentRow,
    ContainerInDO,
    ContainerLineRow,
    DODetail,
    DOListItem,
    DashboardKPIs,
    DashboardResponse,
    ExceptionItem,
    LotDetail,
    LotMapItem,
    OperatorContainerItem,
    OperatorContainersResponse,
    OperatorStat,
    PalletInLot,
    PipelineContainer,
    ReceivingPipelineResponse,
    ResolveExceptionRequest,
    ResolveExceptionResponse,
    TodaySummary,
)


# ─── Errors ─────────────────────────────────────────────────────────────


class ManagerError(Exception):
    pass


class NotFoundError(ManagerError):
    pass


class InvalidResolutionError(ManagerError):
    pass


# ─── DO list / detail ───────────────────────────────────────────────────


async def list_dos(
    session: AsyncSession,
    *,
    status_filter: str | None = None,
    customer_id: int | None = None,
    from_date: date | None = None,
    to_date: date | None = None,
    limit: int = 100,
) -> list[DOListItem]:
    """List DOs with optional filters. Date filter applies to
    expected_arrival_date — that's the dimension a manager actually
    plans against; issued_at is the back-office timestamp."""
    q = (
        select(DO)
        .options(selectinload(DO.whpo).selectinload(WHPO.customer))
        .options(selectinload(DO.containers))
        .order_by(DO.issued_at.desc())
        .limit(limit)
    )
    if status_filter:
        q = q.where(DO.status == status_filter)
    if customer_id:
        q = q.join(DO.whpo).where(WHPO.customer_id == customer_id)
    if from_date is not None:
        q = q.where(DO.expected_arrival_date >= from_date)
    if to_date is not None:
        q = q.where(DO.expected_arrival_date <= to_date)

    dos = (await session.scalars(q)).all()

    items: list[DOListItem] = []
    for d in dos:
        open_exc = await session.scalar(
            select(func.count())
            .select_from(ExceptionRecord)
            .where(
                ExceptionRecord.ref_type == "do",
                ExceptionRecord.ref_id == d.id,
                ExceptionRecord.status == "open",
            )
        )
        items.append(
            DOListItem(
                do_id=d.id,
                do_number=d.do_number,
                whpo_number=d.whpo.whpo_number,
                customer_name=d.whpo.customer.name,
                status=d.status,
                expected_arrival_date=d.expected_arrival_date,
                issued_at=d.issued_at,
                container_count=len(d.containers),
                open_exceptions=open_exc or 0,
            )
        )
    return items


async def get_do_detail(session: AsyncSession, do_id: int) -> DODetail:
    do = await session.scalar(
        select(DO)
        .where(DO.id == do_id)
        .options(
            selectinload(DO.whpo).selectinload(WHPO.customer),
            selectinload(DO.containers)
            .selectinload(Container.lines)
            .selectinload(ContainerLine.sku),
            selectinload(DO.containers)
            .selectinload(Container.lot_assignments)
            .selectinload(LotAssignment.lot)
            .selectinload(Lot.floor),
            selectinload(DO.containers)
            .selectinload(Container.lot_assignments)
            .selectinload(LotAssignment.sku),
        )
    )
    if do is None:
        raise NotFoundError(f"DO {do_id}")

    open_exc = await session.scalar(
        select(func.count())
        .select_from(ExceptionRecord)
        .where(
            ExceptionRecord.ref_type == "do",
            ExceptionRecord.ref_id == do.id,
            ExceptionRecord.status == "open",
        )
    )

    from app.services.space import compute_line_space, DEFAULT_LOT_SQFT

    containers_out: list[ContainerInDO] = []
    for c in do.containers:
        line_rows: list[ContainerLineRow] = []
        container_total_sqft = 0.0
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
            container_total_sqft += space.total_sqft
            line_rows.append(
                ContainerLineRow(
                    line_id=ln.id,
                    sku=ln.sku.sku if ln.sku else ln.sku_raw,
                    qty=ln.qty,
                    items_per_pallet=ln.sku.items_per_pallet if ln.sku else None,
                    sqft_per_unit=ln.sku.sqft_per_unit if ln.sku else None,
                    sku_resolved=ln.sku_id is not None,
                    computed_sqft_per_unit=space.sqft_per_unit,
                    computed_total_sqft=space.total_sqft,
                    space_basis=space.basis,
                )
            )

        assignment_rows = [
            AssignmentRow(
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
        total_expected = sum(ln.qty for ln in c.lines)
        total_received = await session.scalar(
            select(func.coalesce(func.sum(Pallet.qty), 0)).where(Pallet.container_id == c.id)
        )
        containers_out.append(
            ContainerInDO(
                container_id=c.id,
                container_no=c.container_no,
                status=c.status,
                expected_arrival_date=c.expected_arrival_date,
                actual_arrival_date=c.actual_arrival_date,
                total_expected=total_expected,
                total_received=int(total_received or 0),
                lines=line_rows,
                assignments=assignment_rows,
                on_pallet=c.on_pallet,
                pallet_length_in=c.pallet_length_in,
                pallet_width_in=c.pallet_width_in,
                item_length_in=c.item_length_in,
                item_width_in=c.item_width_in,
                item_height_in=c.item_height_in,
                total_sqft_needed=round(container_total_sqft, 2),
                lots_equivalent=round(container_total_sqft / DEFAULT_LOT_SQFT, 2),
            )
        )

    return DODetail(
        do_id=do.id,
        do_number=do.do_number,
        whpo_id=do.whpo.id,
        whpo_number=do.whpo.whpo_number,
        customer_name=do.whpo.customer.name,
        status=do.status,
        expected_arrival_date=do.expected_arrival_date,
        issued_at=do.issued_at,
        containers=containers_out,
        open_exceptions=open_exc or 0,
    )


# ─── Lots ───────────────────────────────────────────────────────────────


async def list_lots(session: AsyncSession) -> list[LotMapItem]:
    placed_subq = (
        select(Pallet.lot_id, func.count().label("placed"))
        .group_by(Pallet.lot_id)
        .subquery()
    )
    reserved_subq = (
        select(
            LotAssignment.lot_id,
            func.coalesce(
                func.sum(LotAssignment.planned_pallets - LotAssignment.actual_pallets), 0
            ).label("reserved"),
        )
        .where(LotAssignment.status.in_(["planned", "active"]))
        .group_by(LotAssignment.lot_id)
        .subquery()
    )
    q = (
        select(
            Lot,
            Floor,
            func.coalesce(placed_subq.c.placed, 0).label("placed"),
            func.coalesce(reserved_subq.c.reserved, 0).label("reserved"),
        )
        .join(Floor, Floor.id == Lot.floor_id)
        .outerjoin(placed_subq, placed_subq.c.lot_id == Lot.id)
        .outerjoin(reserved_subq, reserved_subq.c.lot_id == Lot.id)
        .order_by(Floor.id, Lot.lot_code)
    )
    rows = (await session.execute(q)).all()

    out: list[LotMapItem] = []
    for lot, floor, placed, reserved in rows:
        free = max(0, lot.pallet_capacity - placed - reserved)
        occ_pct = 0.0 if lot.pallet_capacity == 0 else 100.0 * (placed + reserved) / lot.pallet_capacity
        out.append(
            LotMapItem(
                lot_id=lot.id,
                lot_code=lot.lot_code,
                floor_id=floor.id,
                floor_name=floor.name,
                type=lot.type,
                pallet_capacity=lot.pallet_capacity,
                pallets_used=int(placed),
                pallets_reserved=int(reserved),
                pallets_free=free,
                occupancy_pct=round(occ_pct, 1),
                blocked=lot.blocked,
                grid_row=lot.grid_row,
                grid_col=lot.grid_col,
            )
        )
    return out


async def get_lot_detail(session: AsyncSession, lot_id: int) -> LotDetail:
    lot = await session.scalar(
        select(Lot).where(Lot.id == lot_id).options(selectinload(Lot.floor))
    )
    if lot is None:
        raise NotFoundError(f"Lot {lot_id}")

    pallets_q = (
        select(Pallet)
        .where(Pallet.lot_id == lot_id)
        .order_by(Pallet.palletized_at.desc())
    )
    pallets = (await session.scalars(pallets_q)).all()

    pallet_rows: list[PalletInLot] = []
    for p in pallets:
        sku = await session.get(SKU, p.sku_id)
        container = await session.get(Container, p.container_id)
        pallet_rows.append(
            PalletInLot(
                pallet_id=p.id,
                sku=sku.sku if sku else "?",
                container_no=container.container_no if container else "?",
                qty=p.qty,
                level=p.level,
                palletized_at=p.palletized_at,
                palletized_by=p.palletized_by,
            )
        )

    placed = len(pallets)
    reserved = await session.scalar(
        select(
            func.coalesce(
                func.sum(LotAssignment.planned_pallets - LotAssignment.actual_pallets), 0
            )
        ).where(
            LotAssignment.lot_id == lot_id,
            LotAssignment.status.in_(["planned", "active"]),
        )
    )
    reserved = int(reserved or 0)
    free = max(0, lot.pallet_capacity - placed - reserved)

    return LotDetail(
        lot_id=lot.id,
        lot_code=lot.lot_code,
        floor_id=lot.floor.id,
        floor_name=lot.floor.name,
        type=lot.type,
        pallet_capacity=lot.pallet_capacity,
        sqft_capacity=lot.sqft_capacity,
        pallets_used=placed,
        pallets_reserved=reserved,
        pallets_free=free,
        blocked=lot.blocked,
        pallets=pallet_rows,
    )


# ─── Exceptions ─────────────────────────────────────────────────────────


async def list_exceptions(
    session: AsyncSession,
    *,
    status_filter: str | None = "open",
    kind: str | None = None,
    limit: int = 200,
) -> list[ExceptionItem]:
    q = select(ExceptionRecord).order_by(ExceptionRecord.opened_at.desc()).limit(limit)
    if status_filter:
        q = q.where(ExceptionRecord.status == status_filter)
    if kind:
        q = q.where(ExceptionRecord.kind == kind)
    rows = (await session.scalars(q)).all()
    return [
        ExceptionItem(
            exception_id=e.id,
            kind=e.kind,
            ref_type=e.ref_type,
            ref_id=e.ref_id,
            payload=e.payload,
            status=e.status,
            opened_at=e.opened_at,
            opened_by=e.opened_by,
            resolved_at=e.resolved_at,
            resolved_by=e.resolved_by,
            resolution_notes=e.resolution_notes,
        )
        for e in rows
    ]


async def resolve_exception(
    session: AsyncSession, exception_id: int, req: ResolveExceptionRequest
) -> ResolveExceptionResponse:
    exc = await session.get(ExceptionRecord, exception_id)
    if exc is None:
        raise NotFoundError(f"Exception {exception_id}")
    if exc.status != "open":
        raise InvalidResolutionError(f"Exception {exception_id} is not open (current: {exc.status})")

    created_sku_id: int | None = None
    do_id_for_response: int | None = exc.ref_id if exc.ref_type == "do" else None

    if exc.kind == "unknown_sku":
        if req.sku_data is None:
            raise InvalidResolutionError("unknown_sku resolution requires sku_data payload")

        sku_raw = exc.payload.get("sku_raw")
        customer_name = exc.payload.get("customer")
        if not sku_raw or not customer_name:
            raise InvalidResolutionError(
                "Exception payload missing sku_raw or customer — cannot create SKU"
            )

        customer = await session.scalar(
            select(Customer).where(Customer.name == customer_name)
        )
        if customer is None:
            raise InvalidResolutionError(f"Customer '{customer_name}' no longer exists")

        # Check whether the SKU was created in the meantime by another resolution
        existing = await session.scalar(
            select(SKU).where(SKU.customer_id == customer.id, SKU.sku == sku_raw)
        )
        if existing is not None:
            sku = existing
            # Update master fields from payload (caller's input wins for any blank fields)
            sku.items_per_pallet = req.sku_data.items_per_pallet
            sku.sqft_per_unit = req.sku_data.sqft_per_unit
            sku.pallet_mode = req.sku_data.pallet_mode
            sku.stackable = req.sku_data.stackable
            sku.max_stack_height = req.sku_data.max_stack_height
            sku.unit = req.sku_data.unit
            if req.sku_data.description:
                sku.description = req.sku_data.description
        else:
            sku = SKU(
                customer_id=customer.id,
                sku=sku_raw,
                description=req.sku_data.description,
                sqft_per_unit=req.sku_data.sqft_per_unit,
                items_per_pallet=req.sku_data.items_per_pallet,
                pallet_mode=req.sku_data.pallet_mode,
                stackable=req.sku_data.stackable,
                max_stack_height=req.sku_data.max_stack_height,
                unit=req.sku_data.unit,
                source="manager_resolve",
            )
            session.add(sku)
            await session.flush()

        created_sku_id = sku.id

        # Backfill: attach this SKU to all container_lines that reference it raw
        await session.execute(
            update(ContainerLine)
            .where(
                ContainerLine.sku_raw == sku_raw,
                ContainerLine.sku_id.is_(None),
            )
            .values(sku_id=sku.id)
        )

    elif exc.kind == "missing_master_data":
        if req.patch is None:
            raise InvalidResolutionError("missing_master_data resolution requires patch payload")

        sku_code = exc.payload.get("sku")
        customer_name = exc.payload.get("customer")
        sku = await session.scalar(
            select(SKU).where(
                SKU.sku == sku_code,
                SKU.customer_id == (
                    await session.scalar(select(Customer.id).where(Customer.name == customer_name))
                ),
            )
        )
        if sku is None:
            raise InvalidResolutionError(f"SKU {sku_code} not found")

        for field, value in req.patch.model_dump(exclude_unset=True).items():
            setattr(sku, field, value)
        created_sku_id = sku.id

    # Mark exception resolved
    exc.status = "resolved"
    exc.resolved_at = datetime.now(timezone.utc)
    exc.resolved_by = req.resolved_by
    exc.resolution_notes = req.notes

    # If this is a DO-scoped exception, check whether DO can be promoted to 'ready'
    do_status_changed = False
    new_do_status: str | None = None
    if do_id_for_response is not None:
        do_status_changed, new_do_status = await _refresh_do_status(session, do_id_for_response)

    session.add(
        ActivityLog(
            actor=req.resolved_by,
            kind="exception_resolved",
            ref_type="exception",
            ref_id=exc.id,
            message=f"Exception #{exc.id} ({exc.kind}) resolved",
            payload={"sku_id": created_sku_id, "do_id": do_id_for_response},
        )
    )

    await session.flush()
    return ResolveExceptionResponse(
        exception_id=exc.id,
        status=exc.status,
        sku_id=created_sku_id,
        do_id=do_id_for_response,
        do_status=new_do_status,
        do_status_changed=do_status_changed,
    )


async def _refresh_do_status(
    session: AsyncSession, do_id: int
) -> tuple[bool, str | None]:
    """If a DO is in 'pending_master_data' and has no more open exceptions
    AND no unresolved SKUs on its lines, promote to 'ready'. Returns (changed, new_status).
    """
    do = await session.get(DO, do_id)
    if do is None:
        return False, None

    if do.status != "pending_master_data":
        return False, do.status

    open_exc = await session.scalar(
        select(func.count())
        .select_from(ExceptionRecord)
        .where(
            ExceptionRecord.ref_type == "do",
            ExceptionRecord.ref_id == do.id,
            ExceptionRecord.status == "open",
        )
    )
    unresolved_lines = await session.scalar(
        select(func.count())
        .select_from(ContainerLine)
        .join(Container, Container.id == ContainerLine.container_id)
        .where(Container.do_id == do.id, ContainerLine.sku_id.is_(None))
    )

    if (open_exc or 0) == 0 and (unresolved_lines or 0) == 0:
        do.status = "ready"
        return True, "ready"
    return False, do.status


# ─── Receiving pipeline ─────────────────────────────────────────────────


async def get_receiving_pipeline(session: AsyncSession) -> ReceivingPipelineResponse:
    """Two manager worklists derived from the receiving funnel:

      vendor submits → manager files tally ("received") → operator scans → done

      - awaiting_tally: container exists but has no TallySheet and isn't
        scanned. (Vendor's done their part; we owe a tally.)
      - awaiting_scan:  has a TallySheet ("received") but the operator
        hasn't finished scanning it.

    A container is "done" (excluded from both) once it's finished —
    Container.status == 'received', stamped at scan-sheet finish. Whether a
    scan sheet is merely open (in_progress) is reported per row so the UI
    can distinguish "not started" from "in progress."
    """
    # container_ids that already have a tally row (one per container).
    tally_ids = set(
        (await session.scalars(select(TallySheet.container_id))).all()
    )

    # Inbound receipts grouped by container → is any completed, do any exist?
    # Used to derive scan_status without trusting a single status string.
    receipt_rows = (
        await session.execute(
            select(
                Receipt.container_id,
                func.bool_or(Receipt.status == "completed").label("any_done"),
            )
            .where(Receipt.container_id.is_not(None))
            .where(Receipt.kind == "inbound")
            .group_by(Receipt.container_id)
        )
    ).all()
    receipt_done: dict[int, bool] = {cid: bool(done) for cid, done in receipt_rows}

    # Candidate containers: anything not already finished. Eager-load the
    # DO → WHPO → Customer chain and lines (for the expected-qty rollup).
    containers = (
        await session.scalars(
            select(Container)
            .where(Container.status != "received")
            .options(
                selectinload(Container.do)
                .selectinload(DO.whpo)
                .selectinload(WHPO.customer),
                selectinload(Container.lines),
            )
        )
    ).all()

    awaiting_tally: list[PipelineContainer] = []
    awaiting_scan: list[PipelineContainer] = []

    for c in containers:
        # Skip anything that's effectively scanned-and-done (defensive: a
        # completed receipt without the status stamp shouldn't show up).
        if receipt_done.get(c.id):
            continue

        do = c.do
        whpo = do.whpo if do else None
        customer = whpo.customer if whpo else None

        scan_status = "in_progress" if c.id in receipt_done else "none"
        item = PipelineContainer(
            container_id=c.id,
            container_no=c.container_no,
            customer_name=customer.name if customer else "—",
            whpo_number=whpo.whpo_number if whpo else "—",
            do_number=do.do_number if do else "—",
            expected_arrival_date=c.expected_arrival_date,
            total_expected=sum(ln.qty for ln in c.lines),
            driver_info_received=c.driver_info_received_at is not None,
            scan_status=scan_status,
        )
        if c.id in tally_ids:
            awaiting_scan.append(item)
        else:
            awaiting_tally.append(item)

    # Soonest-arriving first; undated containers sink to the bottom.
    def _sort_key(p: PipelineContainer):
        return (p.expected_arrival_date is None, p.expected_arrival_date or date.max, p.container_no)

    awaiting_tally.sort(key=_sort_key)
    awaiting_scan.sort(key=_sort_key)

    return ReceivingPipelineResponse(
        awaiting_tally=awaiting_tally,
        awaiting_scan=awaiting_scan,
    )


# ─── Dashboard ──────────────────────────────────────────────────────────


async def get_dashboard(session: AsyncSession) -> DashboardResponse:
    # Warehouse-local "today" — operators in Vernon, CA expect the dashboard
    # to track their day, not UTC. Without this, anything scanned after
    # 5pm PT shows up as "tomorrow" the moment midnight UTC ticks over.
    today = _warehouse_today()

    # KPIs
    containers_expected_today = await session.scalar(
        select(func.count())
        .select_from(Container)
        .where(Container.expected_arrival_date == today)
    )

    receipts_in_progress = await session.scalar(
        select(func.count())
        .select_from(Receipt)
        .where(Receipt.status == "in_progress")
    )

    containers_finished_today = await session.scalar(
        select(func.count())
        .select_from(Container)
        .where(
            Container.status == "received",
            cast(
                func.timezone("America/Los_Angeles", Container.finished_at),
                SqlDate,
            )
            == today,
        )
    )

    open_exceptions = await session.scalar(
        select(func.count())
        .select_from(ExceptionRecord)
        .where(ExceptionRecord.status == "open")
    )

    # "Units on floor" — physical reality, not a Pallet row count. We
    # used to `COUNT(*) FROM pallets`, but (a) the cumulative pallet
    # table never decreases when stock ships out, and (b) backfilled
    # receipts (e.g. TCNU2190245) skip Pallet creation entirely. Count
    # ok-scans for received containers minus outbound scans instead.
    units_received = await session.scalar(
        select(func.count())
        .select_from(Scan)
        .join(Container, Container.id == Scan.container_id)
        .where(Container.status == "received")
        .where(Scan.result == "ok")
    ) or 0
    units_shipped = await session.scalar(
        select(func.count()).select_from(OutboundScan)
    ) or 0
    total_pallets_stored = max(int(units_received) - int(units_shipped), 0)

    # "Received today" — same logic, scoped to scans timestamped today
    # in warehouse time. Falls back to 0 cleanly when no scans landed.
    units_received_today = await session.scalar(
        select(func.count())
        .select_from(Scan)
        .join(Container, Container.id == Scan.container_id)
        .where(Container.status == "received")
        .where(Scan.result == "ok")
        .where(
            cast(
                func.timezone("America/Los_Angeles", Scan.scanned_at),
                SqlDate,
            )
            == today
        )
    )
    pallets_received_today = int(units_received_today or 0)

    # Lot occupancy: sum of placed pallets / sum of capacity
    occ_row = await session.execute(
        select(
            func.coalesce(func.sum(Lot.pallet_capacity), 0).label("cap"),
            func.coalesce(
                func.sum(
                    select(func.count())
                    .select_from(Pallet)
                    .where(Pallet.lot_id == Lot.id)
                    .correlate(Lot)
                    .scalar_subquery()
                ),
                0,
            ).label("placed"),
        )
        .select_from(Lot)
        .where(Lot.blocked.is_(False))
    )
    cap, placed = occ_row.one()
    occupancy_pct = 0.0 if cap == 0 else round(100.0 * float(placed) / float(cap), 1)

    lots_blocked = await session.scalar(
        select(func.count()).select_from(Lot).where(Lot.blocked.is_(True))
    )
    lots_total = await session.scalar(select(func.count()).select_from(Lot))

    kpis = DashboardKPIs(
        containers_expected_today=int(containers_expected_today or 0),
        receipts_in_progress=int(receipts_in_progress or 0),
        containers_finished_today=int(containers_finished_today or 0),
        open_exceptions=int(open_exceptions or 0),
        total_pallets_stored=int(total_pallets_stored or 0),
        pallets_received_today=int(pallets_received_today or 0),
        lot_occupancy_pct=occupancy_pct,
        lots_blocked=int(lots_blocked or 0),
        lots_total=int(lots_total or 0),
    )

    # Recent activity (last 50 — was 20; richer feed for the redesign)
    rows = (
        await session.scalars(
            select(ActivityLog).order_by(ActivityLog.t.desc()).limit(50)
        )
    ).all()
    feed = [
        ActivityFeedItem(
            id=r.id,
            t=r.t,
            kind=r.kind,
            actor=r.actor,
            ref_type=r.ref_type,
            ref_id=r.ref_id,
            message=r.message,
        )
        for r in rows
    ]

    # ── Today's activity rollup ──────────────────────────────────────────
    # All bucketed in warehouse-local time (PT). One round-trip:
    # count(activity_log.kind) where date(t in PT) = today, grouped by kind.
    tz_t = func.timezone("America/Los_Angeles", ActivityLog.t)
    activity_kinds_today_q = await session.execute(
        select(ActivityLog.kind, func.count())
        .where(cast(tz_t, SqlDate) == today)
        .group_by(ActivityLog.kind)
    )
    kind_counts = {k: int(c or 0) for k, c in activity_kinds_today_q.all()}

    today_summary = TodaySummary(
        containers_received=kind_counts.get("container_finished", 0)
        + kind_counts.get("container_backfilled", 0),
        # Units scanned today reuses the same scan-based metric the
        # "Units on floor +N today" KPI shows — counted from Scan rows
        # so the numbers stay consistent across tiles.
        units_scanned=int(units_received_today or 0),
        vendor_submissions=kind_counts.get("whpo_submitted", 0)
        + kind_counts.get("whpo_updated", 0),
        drivers_checked_in=kind_counts.get("driver_info_submitted", 0),
        outbound_orders_placed=kind_counts.get("outbound_submitted", 0)
        + kind_counts.get("outbound_updated", 0),
        outbound_shipments=kind_counts.get("outbound", 0),
        exceptions_resolved=kind_counts.get("exception_resolved", 0),
    )

    # ── Hourly scan histogram (24 buckets, PT) ───────────────────────────
    # Used by the dashboard chart so managers can see when scanners
    # are actually scanning during the day.
    tz_scan = func.timezone("America/Los_Angeles", Scan.scanned_at)
    hourly_q = await session.execute(
        select(
            func.extract("hour", tz_scan).label("h"),
            func.count(),
        )
        .where(Scan.result == "ok")
        .where(cast(tz_scan, SqlDate) == today)
        .group_by("h")
    )
    hourly_buckets = [0] * 24
    for h, c in hourly_q.all():
        idx = int(h or 0)
        if 0 <= idx < 24:
            hourly_buckets[idx] = int(c or 0)

    # ── Top operators today (by scan count) ──────────────────────────────
    operators_q = await session.execute(
        select(Scan.scanned_by, func.count())
        .where(Scan.result == "ok")
        .where(cast(tz_scan, SqlDate) == today)
        .where(Scan.scanned_by.is_not(None))
        .group_by(Scan.scanned_by)
        .order_by(func.count().desc())
        .limit(5)
    )
    operators_today = [
        OperatorStat(actor=str(a), scans=int(c or 0))
        for a, c in operators_q.all()
        if a
    ]

    return DashboardResponse(
        today=today,
        kpis=kpis,
        activity=feed,
        today_summary=today_summary,
        hourly_scans=hourly_buckets,
        operators_today=operators_today,
    )


async def get_operator_containers(
    session: AsyncSession,
    actor: str,
    *,
    day: date | None = None,
) -> OperatorContainersResponse:
    """Containers a given operator scanned on `day` (default: warehouse
    today), with that operator's scan count per container. Powers the
    Top-Operators dashboard drilldown: click a name → see their containers
    → click a container → its full scan detail (existing container page).

    Mirrors the dashboard's operator query: same warehouse-local day
    bucketing, same `result == "ok"` filter so counts line up with the
    "scans" number shown on the leaderboard.
    """
    if day is None:
        day = _warehouse_today()

    tz_scan = func.timezone("America/Los_Angeles", Scan.scanned_at)
    rows = (
        await session.execute(
            select(
                Container.container_no,
                Container.status,
                Customer.name,
                func.count().label("scans"),
                func.max(Scan.scanned_at).label("last_scan_at"),
            )
            .join(Container, Container.id == Scan.container_id)
            .join(DO, DO.id == Container.do_id, isouter=True)
            .join(WHPO, WHPO.id == DO.whpo_id, isouter=True)
            .join(Customer, Customer.id == WHPO.customer_id, isouter=True)
            .where(Scan.result == "ok")
            .where(Scan.scanned_by == actor)
            .where(cast(tz_scan, SqlDate) == day)
            .group_by(Container.container_no, Container.status, Customer.name)
            .order_by(func.max(Scan.scanned_at).desc())
        )
    ).all()

    containers = [
        OperatorContainerItem(
            container_no=str(cno),
            scans=int(cnt or 0),
            status=status,
            customer_name=cust,
            last_scan_at=last,
        )
        for cno, status, cust, cnt, last in rows
    ]
    return OperatorContainersResponse(
        actor=actor,
        day=day,
        total_scans=sum(c.scans for c in containers),
        containers=containers,
    )
