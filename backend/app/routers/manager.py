from __future__ import annotations

import csv
import io
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import (
    SKU,
    ActivityLog,
    Container,
    ContainerLine,
    Customer,
    DO,
    Floor,
    Lot,
    LotAssignment,
    Pallet,
    Receipt,
    Scan,
    WHPO,
)
from app.schemas.manager import (
    DODetail,
    DOListItem,
    DashboardResponse,
    ExceptionItem,
    LotDetail,
    LotMapItem,
    ResolveExceptionRequest,
    ResolveExceptionResponse,
)
from app.services import sheet_sync
from app.services.manager import (
    InvalidResolutionError,
    NotFoundError,
    get_dashboard,
    get_do_detail,
    get_lot_detail,
    list_dos,
    list_exceptions,
    list_lots,
    resolve_exception,
)

router = APIRouter(prefix="/manager", tags=["manager"])


@router.get("/dashboard", response_model=DashboardResponse)
async def dashboard(session: AsyncSession = Depends(get_session)):
    return await get_dashboard(session)


@router.get("/dos", response_model=list[DOListItem])
async def get_dos(
    session: AsyncSession = Depends(get_session),
    status_filter: str | None = Query(None, alias="status"),
    customer_id: int | None = None,
    limit: int = Query(100, ge=1, le=500),
):
    return await list_dos(
        session, status_filter=status_filter, customer_id=customer_id, limit=limit
    )


@router.get("/dos/{do_id}", response_model=DODetail)
async def get_do(do_id: int, session: AsyncSession = Depends(get_session)):
    try:
        return await get_do_detail(session, do_id)
    except NotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"DO {do_id} not found")


@router.get("/lots", response_model=list[LotMapItem])
async def get_lots(session: AsyncSession = Depends(get_session)):
    return await list_lots(session)


@router.get("/lots/{lot_id}", response_model=LotDetail)
async def get_lot(lot_id: int, session: AsyncSession = Depends(get_session)):
    try:
        return await get_lot_detail(session, lot_id)
    except NotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Lot {lot_id} not found")


@router.get("/exceptions", response_model=list[ExceptionItem])
async def get_exceptions(
    session: AsyncSession = Depends(get_session),
    status_filter: str | None = Query("open", alias="status"),
    kind: str | None = None,
    limit: int = Query(200, ge=1, le=500),
):
    return await list_exceptions(session, status_filter=status_filter, kind=kind, limit=limit)


@router.post("/exceptions/{exception_id}/resolve", response_model=ResolveExceptionResponse)
async def resolve(
    exception_id: int,
    req: ResolveExceptionRequest,
    session: AsyncSession = Depends(get_session),
):
    try:
        result = await resolve_exception(session, exception_id, req)
    except NotFoundError:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"Exception {exception_id} not found"
        )
    except InvalidResolutionError as e:
        await session.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    await session.commit()
    return result


# ─── Data explorer: read-only browse of every table ────────────────────


_TABLE_REGISTRY = [
    "customers",
    "skus",
    "whpos",
    "dos",
    "containers",
    "container_lines",
    "lots",
    "lot_assignments",
    "receipts",
    "pallets",
    "scans",
    "activity_log",
]


@router.get("/database/tables")
async def list_tables(session: AsyncSession = Depends(get_session)):
    """Row count per browseable table — drives the Data Explorer index."""
    out = []
    for name, model in [
        ("customers", Customer),
        ("skus", SKU),
        ("whpos", WHPO),
        ("dos", DO),
        ("containers", Container),
        ("container_lines", ContainerLine),
        ("lots", Lot),
        ("lot_assignments", LotAssignment),
        ("receipts", Receipt),
        ("pallets", Pallet),
        ("scans", Scan),
        ("activity_log", ActivityLog),
    ]:
        n = await session.scalar(select(func.count()).select_from(model))
        out.append({"name": name, "rows": int(n or 0)})
    return out


@router.get("/database/rows/{table_name}")
async def get_table_rows(
    table_name: str,
    limit: int = Query(200, ge=1, le=1000),
    session: AsyncSession = Depends(get_session),
):
    if table_name == "customers":
        rows = (
            await session.execute(
                select(Customer.id, Customer.name, Customer.contact_email, Customer.created_at)
                .order_by(Customer.id)
                .limit(limit)
            )
        ).all()
        return [
            {"id": r[0], "name": r[1], "contact_email": r[2], "created_at": _iso(r[3])}
            for r in rows
        ]

    if table_name == "skus":
        rows = (
            await session.execute(
                select(
                    SKU.id,
                    Customer.name,
                    SKU.sku,
                    SKU.description,
                    SKU.sqft_per_unit,
                    SKU.items_per_pallet,
                    SKU.pallet_mode,
                    SKU.stackable,
                    SKU.unit,
                    SKU.source,
                )
                .join(Customer, Customer.id == SKU.customer_id)
                .order_by(Customer.name, SKU.sku)
                .limit(limit)
            )
        ).all()
        return [
            {
                "id": r[0],
                "customer": r[1],
                "sku": r[2],
                "description": r[3],
                "sqft_per_unit": r[4],
                "items_per_pallet": r[5],
                "pallet_mode": r[6],
                "stackable": r[7],
                "unit": r[8],
                "source": r[9],
            }
            for r in rows
        ]

    if table_name == "whpos":
        rows = (
            await session.execute(
                select(WHPO.id, WHPO.whpo_number, Customer.name, WHPO.received_at, WHPO.notes)
                .join(Customer, Customer.id == WHPO.customer_id)
                .order_by(WHPO.received_at.desc())
                .limit(limit)
            )
        ).all()
        return [
            {
                "id": r[0],
                "whpo_number": r[1],
                "customer": r[2],
                "received_at": _iso(r[3]),
                "notes": r[4],
            }
            for r in rows
        ]

    if table_name == "dos":
        rows = (
            await session.execute(
                select(
                    DO.id,
                    DO.do_number,
                    WHPO.whpo_number,
                    Customer.name,
                    DO.status,
                    DO.expected_arrival_date,
                    DO.issued_at,
                )
                .join(WHPO, WHPO.id == DO.whpo_id)
                .join(Customer, Customer.id == WHPO.customer_id)
                .order_by(DO.issued_at.desc())
                .limit(limit)
            )
        ).all()
        return [
            {
                "id": r[0],
                "do_number": r[1],
                "whpo_number": r[2],
                "customer": r[3],
                "status": r[4],
                "expected_arrival_date": _iso(r[5]),
                "issued_at": _iso(r[6]),
            }
            for r in rows
        ]

    if table_name == "containers":
        rows = (
            await session.execute(
                select(
                    Container.id,
                    Container.container_no,
                    DO.do_number,
                    Customer.name,
                    Container.status,
                    Container.expected_arrival_date,
                    Container.actual_arrival_date,
                    Container.started_at,
                    Container.finished_at,
                )
                .join(DO, DO.id == Container.do_id)
                .join(WHPO, WHPO.id == DO.whpo_id)
                .join(Customer, Customer.id == WHPO.customer_id)
                .order_by(Container.id.desc())
                .limit(limit)
            )
        ).all()
        return [
            {
                "id": r[0],
                "container_no": r[1],
                "do_number": r[2],
                "customer": r[3],
                "status": r[4],
                "expected_arrival_date": _iso(r[5]),
                "actual_arrival_date": _iso(r[6]),
                "started_at": _iso(r[7]),
                "finished_at": _iso(r[8]),
            }
            for r in rows
        ]

    if table_name == "container_lines":
        rows = (
            await session.execute(
                select(
                    ContainerLine.id,
                    Container.container_no,
                    ContainerLine.sku_raw,
                    SKU.sku,
                    ContainerLine.qty,
                    ContainerLine.line_index,
                )
                .join(Container, Container.id == ContainerLine.container_id)
                .outerjoin(SKU, SKU.id == ContainerLine.sku_id)
                .order_by(ContainerLine.id.desc())
                .limit(limit)
            )
        ).all()
        return [
            {
                "id": r[0],
                "container_no": r[1],
                "sku_raw": r[2],
                "sku_resolved": r[3],
                "qty": r[4],
                "line_index": r[5],
            }
            for r in rows
        ]

    if table_name == "lots":
        rows = (
            await session.execute(
                select(
                    Lot.id,
                    Floor.name,
                    Lot.lot_code,
                    Lot.type,
                    Lot.sqft_capacity,
                    Lot.pallet_capacity,
                    Lot.blocked,
                    Lot.grid_row,
                    Lot.grid_col,
                )
                .join(Floor, Floor.id == Lot.floor_id)
                .order_by(Floor.id, Lot.lot_code)
                .limit(limit)
            )
        ).all()
        return [
            {
                "id": r[0],
                "floor": r[1],
                "lot_code": r[2],
                "type": r[3],
                "sqft_capacity": r[4],
                "pallet_capacity": r[5],
                "blocked": r[6],
                "grid_row": r[7],
                "grid_col": r[8],
            }
            for r in rows
        ]

    if table_name == "lot_assignments":
        rows = (
            await session.execute(
                select(
                    LotAssignment.id,
                    Container.container_no,
                    Lot.lot_code,
                    SKU.sku,
                    LotAssignment.assignment_order,
                    LotAssignment.planned_pallets,
                    LotAssignment.actual_pallets,
                    LotAssignment.status,
                    LotAssignment.created_at,
                )
                .join(Container, Container.id == LotAssignment.container_id)
                .join(Lot, Lot.id == LotAssignment.lot_id)
                .join(SKU, SKU.id == LotAssignment.sku_id)
                .order_by(LotAssignment.created_at.desc())
                .limit(limit)
            )
        ).all()
        return [
            {
                "id": r[0],
                "container_no": r[1],
                "lot_code": r[2],
                "sku": r[3],
                "order": r[4],
                "planned_pallets": r[5],
                "actual_pallets": r[6],
                "status": r[7],
                "created_at": _iso(r[8]),
            }
            for r in rows
        ]

    if table_name == "receipts":
        rows = (
            await session.execute(
                select(
                    Receipt.id,
                    Container.container_no,
                    Receipt.status,
                    Receipt.started_by,
                    Receipt.finished_by,
                    Receipt.started_at,
                    Receipt.finished_at,
                )
                .join(Container, Container.id == Receipt.container_id)
                .order_by(Receipt.started_at.desc())
                .limit(limit)
            )
        ).all()
        return [
            {
                "id": r[0],
                "container_no": r[1],
                "status": r[2],
                "started_by": r[3],
                "finished_by": r[4],
                "started_at": _iso(r[5]),
                "finished_at": _iso(r[6]),
            }
            for r in rows
        ]

    if table_name == "pallets":
        rows = (
            await session.execute(
                select(
                    Pallet.id,
                    Container.container_no,
                    SKU.sku,
                    Lot.lot_code,
                    Pallet.qty,
                    Pallet.level,
                    Pallet.pallet_mode_at_receipt,
                    Pallet.palletized_by,
                    Pallet.palletized_at,
                )
                .join(Container, Container.id == Pallet.container_id)
                .join(SKU, SKU.id == Pallet.sku_id)
                .join(Lot, Lot.id == Pallet.lot_id)
                .order_by(Pallet.palletized_at.desc())
                .limit(limit)
            )
        ).all()
        return [
            {
                "id": r[0],
                "container_no": r[1],
                "sku": r[2],
                "lot_code": r[3],
                "qty": r[4],
                "level": r[5],
                "mode": r[6],
                "palletized_by": r[7],
                "palletized_at": _iso(r[8]),
            }
            for r in rows
        ]

    if table_name == "scans":
        rows = (
            await session.execute(
                select(
                    Scan.id,
                    Container.container_no,
                    Scan.item_barcode,
                    Scan.result,
                    Scan.error_reason,
                    Scan.scanned_by,
                    Scan.scanned_at,
                )
                .outerjoin(Container, Container.id == Scan.container_id)
                .order_by(Scan.scanned_at.desc())
                .limit(limit)
            )
        ).all()
        return [
            {
                "id": r[0],
                "container_no": r[1],
                "item_barcode": r[2],
                "result": r[3],
                "error_reason": r[4],
                "scanned_by": r[5],
                "scanned_at": _iso(r[6]),
            }
            for r in rows
        ]

    if table_name == "activity_log":
        rows = (
            await session.execute(
                select(
                    ActivityLog.id,
                    ActivityLog.t,
                    ActivityLog.actor,
                    ActivityLog.kind,
                    ActivityLog.ref_type,
                    ActivityLog.ref_id,
                    ActivityLog.message,
                )
                .order_by(ActivityLog.t.desc())
                .limit(limit)
            )
        ).all()
        return [
            {
                "id": r[0],
                "t": _iso(r[1]),
                "actor": r[2],
                "kind": r[3],
                "ref_type": r[4],
                "ref_id": r[5],
                "message": r[6],
            }
            for r in rows
        ]

    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND, detail=f"Unknown table '{table_name}'"
    )


def _iso(v):
    return v.isoformat() if v is not None else None


# ─── Inbound: flat view of what the vendor actually sent ────────────────

INBOUND_COLUMNS = [
    "container_no",
    "whpo_number",
    "expected_arrival_date",
    "expected_arrival_time",
    "qty",
    "product_type",
    "sku",
    "customer",
    "do_number",
    "submitter_name",
    "submitter_email",
    "submitted_at",
    "driver_name",
    "driver_license",
    "driver_phone",
    "truck_license_plate",
    "insurance",
    "carrier",
    "last_updated_at",
    "bol_number",     # New (column 20). Kept in sync with sheet_sync.HEADERS.
]


async def _fetch_inbound(session: AsyncSession, limit: int = 1000):
    """Join WHPO → DO → Container → ContainerLine into one flat row per line.

    This is the canonical "what the vendor sent us" view. Append-only — every
    new vendor submission adds rows here. WHPO is the dedupe key (re-submitting
    the same WHPO# is idempotent and returns the existing rows, doesn't
    duplicate them).
    """
    q = (
        select(
            Container.container_no,
            WHPO.whpo_number,
            WHPO.bol_number,
            Container.expected_arrival_date,
            Container.expected_arrival_time,
            ContainerLine.qty,
            ContainerLine.product_type,
            ContainerLine.sku_raw.label("sku"),
            Customer.name.label("customer"),
            DO.do_number,
            WHPO.raw_payload.label("raw_payload"),
            WHPO.received_at,
            Container.driver_name,
            Container.driver_license,
            Container.driver_phone,
            Container.truck_license_plate,
            Container.insurance,
            Container.carrier,
        )
        .join(DO, DO.id == Container.do_id)
        .join(WHPO, WHPO.id == DO.whpo_id)
        .join(Customer, Customer.id == WHPO.customer_id)
        .join(ContainerLine, ContainerLine.container_id == Container.id)
        .order_by(WHPO.received_at.desc(), Container.container_no, ContainerLine.line_index)
        .limit(limit)
    )
    rows = (await session.execute(q)).all()

    # Per-DO last-updated timestamp from vendor amendments (whpo_updated).
    # We only flag updates here, not original submissions — the chip in the
    # Inbound view is meant to signal "this changed AFTER submission".
    from sqlalchemy import func as _func

    do_numbers = {r.do_number for r in rows}
    last_updated_by_do: dict[str, str] = {}
    if do_numbers:
        upd_q = (
            select(DO.do_number, _func.max(ActivityLog.t).label("last_t"))
            .join(ActivityLog, ActivityLog.ref_id == DO.id)
            .where(ActivityLog.ref_type == "do")
            .where(ActivityLog.kind == "whpo_updated")
            .where(DO.do_number.in_(do_numbers))
            .group_by(DO.do_number)
        )
        for do_num, last_t in (await session.execute(upd_q)).all():
            if last_t:
                last_updated_by_do[do_num] = last_t.isoformat()

    out: list[dict] = []
    for r in rows:
        payload = r.raw_payload or {}
        # Key order kept in sync with sheet_sync.HEADERS — bol_number is
        # appended at the end (column 20) so existing Logic App positional
        # mappings stay intact.
        out.append(
            {
                "container_no": r.container_no,
                "whpo_number": r.whpo_number,
                "expected_arrival_date": _iso(r.expected_arrival_date),
                "expected_arrival_time": _iso(r.expected_arrival_time),
                "qty": r.qty,
                "product_type": r.product_type,
                "sku": r.sku,
                "customer": r.customer,
                "do_number": r.do_number,
                "submitter_name": payload.get("submitter_name"),
                "submitter_email": payload.get("submitter_email"),
                "submitted_at": _iso(r.received_at),
                "driver_name": r.driver_name,
                "driver_license": r.driver_license,
                "driver_phone": r.driver_phone,
                "truck_license_plate": r.truck_license_plate,
                "insurance": r.insurance,
                "carrier": r.carrier,
                "last_updated_at": last_updated_by_do.get(r.do_number),
                "bol_number": r.bol_number,
            }
        )
    return out


@router.get("/database/inbound")
async def list_inbound(
    session: AsyncSession = Depends(get_session),
    limit: int = Query(1000, ge=1, le=10000),
):
    return await _fetch_inbound(session, limit=limit)


@router.post("/database/inbound/sync")
async def sync_inbound_to_excel(
    session: AsyncSession = Depends(get_session),
):
    """Re-fire the driver-info UPDATE webhook for every container in DB that
    has driver fields populated. Idempotent — Excel rows get their driver
    columns set in place; nothing is appended.

    Use case: an earlier UPDATE webhook call failed (Logic App down, Office
    Script transient error, etc.) and the Excel row still shows blank driver
    fields. This endpoint pushes them all again.

    Pre-existing rows in the InboundTable are expected — they're inserted by
    the new-shipment APPEND path at submission time. This endpoint does NOT
    insert missing rows.
    """
    if not sheet_sync.is_update_configured():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Driver-info update webhook isn't configured. Set "
                "ONEDRIVE_UPDATE_WEBHOOK_URL in backend .env."
            ),
        )

    rows = await _fetch_inbound(session, limit=10000)
    # Dedupe by container_no — `rows` is per container × SKU line, but
    # driver info is per container. Take the first row's driver fields.
    seen: set[str] = set()
    to_update: list[dict] = []
    for r in rows:
        cn = (r.get("container_no") or "").strip()
        if not cn or cn in seen:
            continue
        if not r.get("driver_name"):
            continue  # No driver info yet — nothing to update with.
        seen.add(cn)
        to_update.append(r)

    sent = 0
    failed: list[str] = []
    for r in to_update:
        try:
            ok = await sheet_sync.update_driver_for_container(
                container_no=r["container_no"],
                driver_name=r.get("driver_name") or "",
                driver_license=r.get("driver_license") or "",
                driver_phone=r.get("driver_phone") or "",
                truck_license_plate=r.get("truck_license_plate") or "",
                insurance=r.get("insurance") or "",
                carrier=r.get("carrier") or "",
            )
            if ok:
                sent += 1
            else:
                failed.append(r["container_no"])
        except Exception:
            failed.append(r["container_no"])

    return {
        "synced": sent,
        "containers_attempted": len(to_update),
        "containers_failed": failed,
        "configured": True,
    }


@router.post("/database/wipe-transactional")
async def wipe_transactional_data(
    session: AsyncSession = Depends(get_session),
):
    """Destructive: wipe all transactional Postgres data (WHPOs, DOs,
    containers, lines, lot assignments, receipts, pallets, scans, exceptions,
    activity log) AND clear every row from the OneDrive Excel InboundTable.

    Preserves master data: customers, seeded SKUs, floors, lots. Also
    preserves the VendorUsers Excel sheet (real accounts).

    Use for development reset / pre-production cleanup. Atomic across both
    stores so they can't drift.
    """
    # Step 1: clear Excel InboundTable
    excel_deleted = 0
    if sheet_sync.is_update_configured():
        try:
            excel_deleted = await sheet_sync.clear_inbound_table()
        except Exception as e:
            raise HTTPException(
                status_code=502,
                detail=f"Excel InboundTable clear failed — aborting before Postgres wipe to keep stores consistent. Error: {e}",
            )

    # Step 2: wipe Postgres transactional tables.
    # Includes outbound tables (orders, lines, line_serials, containers,
    # scans) so a wipe leaves the DB fully empty for test runs.
    from sqlalchemy import text as _text

    await session.execute(
        _text(
            "TRUNCATE "
            "outbound_scans, outbound_line_serials, outbound_lines, "
            "outbound_containers, outbound_orders, "
            "scans, pallets, receipts, lot_assignments, "
            "container_lines, containers, dos, whpos, exceptions, "
            "activity_log RESTART IDENTITY CASCADE"
        )
    )
    await session.execute(
        _text("DELETE FROM skus WHERE source IS DISTINCT FROM 'seed'")
    )
    await session.commit()

    # Step 3: verify Postgres is clean
    counts = {}
    for tbl in (
        "whpos",
        "dos",
        "containers",
        "container_lines",
        "activity_log",
        "exceptions",
        "outbound_orders",
        "outbound_lines",
        "outbound_containers",
        "outbound_scans",
    ):
        n = await session.scalar(_text(f"SELECT count(*) FROM {tbl}"))
        counts[tbl] = n

    return {
        "excel_rows_deleted": excel_deleted,
        "postgres_rows_remaining": counts,
        "next_do_number": "DO-2026-0001",
        "next_po_number": "PO-2026-0001",
    }


@router.post("/database/inbound/full-resync")
async def full_resync_inbound_to_excel(
    session: AsyncSession = Depends(get_session),
):
    """Wipe every row from the InboundTable in OneDrive Excel and re-append
    the full current state from Postgres. Use sparingly — schema changes,
    backfill, or recovery from a corrupted sheet.

    Preserves headers. Driver fields, carrier, last_updated_at all carry
    through from Postgres.
    """
    if not sheet_sync.is_configured() or not sheet_sync.is_update_configured():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Excel/OneDrive sync isn't configured (ONEDRIVE_VENDORS_OPS_URL).",
        )

    # Step 1: delete every row from InboundTable
    try:
        deleted = await sheet_sync.clear_inbound_table()
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"clear_inbound_table failed: {e}",
        )

    # Step 2: fetch all inbound rows from Postgres and append
    rows = await _fetch_inbound(session, limit=10000)
    appended = 0
    if rows:
        appended = await sheet_sync.append_rows(rows)

    return {
        "deleted_from_excel": deleted,
        "appended_to_excel": appended,
        "rows_in_db": len(rows),
    }


@router.post("/database/inbound/pull-from-excel")
async def pull_inbound_from_excel(
    session: AsyncSession = Depends(get_session),
):
    """Read every row from the InboundTable in OneDrive Excel and push manual
    edits to driver fields back into Postgres. Use case: manager fixed a
    typo (driver name / phone / plate / insurance) directly in Excel and
    wants Postgres + the product to reflect it.

    Limited to driver fields. Shipment data (qty, dates, SKUs) is never
    overwritten — those came from the vendor and shouldn't be edited in
    Excel.
    """
    from app.services import vendor_excel

    if not vendor_excel.is_configured():
        raise HTTPException(
            status_code=503,
            detail="Excel ops URL isn't configured (ONEDRIVE_VENDORS_OPS_URL).",
        )

    try:
        rows = await vendor_excel.list_inbound_rows()
    except vendor_excel.VendorExcelError as e:
        raise HTTPException(status_code=502, detail=str(e))

    # Dedupe by container_no — each container has 1 row per SKU in Excel,
    # but driver info is per-container.
    seen: dict[str, dict] = {}
    for r in rows:
        cn = (r.get("container_no") or "").strip()
        if cn and cn not in seen:
            seen[cn] = r

    updated = 0
    not_found: list[str] = []
    no_change: list[str] = []

    for cn, row in seen.items():
        c = await session.scalar(select(Container).where(Container.container_no == cn))
        if c is None:
            not_found.append(cn)
            continue

        changed = False
        for col in (
            "driver_name",
            "driver_license",
            "driver_phone",
            "truck_license_plate",
            "insurance",
            "carrier",
        ):
            excel_val = (row.get(col) or "").strip() or None
            pg_val = getattr(c, col, None)
            if excel_val != pg_val:
                setattr(c, col, excel_val)
                changed = True

        if changed:
            if c.driver_name and not c.driver_info_received_at:
                from datetime import datetime, timezone
                c.driver_info_received_at = datetime.now(timezone.utc)
            updated += 1
        else:
            no_change.append(cn)

    if updated > 0:
        await session.commit()

    return {
        "rows_in_excel": len(rows),
        "containers_in_excel": len(seen),
        "containers_updated_in_db": updated,
        "containers_unchanged": len(no_change),
        "containers_not_in_db": not_found,
    }


@router.get("/database/inbound/status")
async def inbound_sync_status():
    """Whether the Excel/OneDrive sync is wired up. Used by the Inbound view
    to decide whether to show the Sync button. `update_configured` reflects
    the driver-info UPDATE path (which the Sync button now uses)."""
    return {
        "configured": sheet_sync.is_configured(),
        "update_configured": sheet_sync.is_update_configured(),
    }


@router.post("/database/vendor-files/backfill")
async def backfill_vendor_files_to_onedrive(
    session: AsyncSession = Depends(get_session),
):
    """Re-mirror every locally-stored vendor document into the OneDrive
    sync folder (and / or the legacy Logic App if it's still wired up).
    Useful after first configuring `ONEDRIVE_LOCAL_SYNC_DIR`, or after
    renaming a company / changing folder-naming rules.

    Idempotent — re-running just overwrites existing files at the same
    paths.

    Runs synchronously (not as background tasks) so the response reports
    pass/fail counts.
    """
    from app.models import ContainerDocument
    from app.services import onedrive_files, onedrive_graph, onedrive_local_sync
    from sqlalchemy.orm import selectinload

    graph_on = onedrive_graph.is_configured()
    local_on = onedrive_local_sync.is_configured()
    webhook_on = onedrive_files.is_configured()
    if not (graph_on or local_on or webhook_on):
        raise HTTPException(
            status_code=503,
            detail=(
                "No OneDrive mirror is configured. Enable one of: "
                "ONEDRIVE_GRAPH_ENABLED (recommended for cloud-only), "
                "ONEDRIVE_LOCAL_SYNC_DIR (if OneDrive desktop sync is set up), "
                "or ONEDRIVE_VENDOR_FILES_URL (legacy Logic App)."
            ),
        )

    docs = (
        (
            await session.execute(
                select(ContainerDocument).options(
                    selectinload(ContainerDocument.container)
                    .selectinload(Container.do)
                    .selectinload(DO.whpo)
                    .selectinload(WHPO.customer),
                )
            )
        )
        .scalars()
        .all()
    )

    graph_ok = graph_failed = 0
    local_ok = local_failed = 0
    webhook_ok = webhook_failed = 0
    skipped = 0
    for d in docs:
        c = d.container
        if c is None or c.do is None or c.do.whpo is None or c.do.whpo.customer is None:
            skipped += 1
            continue
        common = {
            "company": c.do.whpo.customer.name,
            "arrival_date": c.expected_arrival_date,
            "whpo_number": c.do.whpo.whpo_number,
            "container_no": c.container_no,
            "kind": d.kind,
            "original_filename": d.filename,
            "content_type": d.content_type,
        }
        if graph_on:
            try:
                await onedrive_graph.upload_document(
                    **common, storage_path=d.storage_path
                )
                graph_ok += 1
            except Exception:  # noqa: BLE001
                graph_failed += 1
        if local_on:
            try:
                await onedrive_local_sync.save_copy(
                    **common, local_storage_path=d.storage_path
                )
                local_ok += 1
            except Exception:  # noqa: BLE001
                local_failed += 1
        if webhook_on:
            try:
                await onedrive_files.upload_document(
                    **common, storage_path=d.storage_path
                )
                webhook_ok += 1
            except Exception:  # noqa: BLE001
                webhook_failed += 1

    return {
        "documents_total": len(docs),
        "graph": {
            "configured": graph_on,
            "uploaded": graph_ok,
            "failed": graph_failed,
        },
        "local_sync": {
            "configured": local_on,
            "written": local_ok,
            "failed": local_failed,
        },
        "webhook": {
            "configured": webhook_on,
            "uploaded": webhook_ok,
            "failed": webhook_failed,
        },
        "skipped_missing_refs": skipped,
    }


@router.get("/database/inbound.csv")
async def export_inbound_csv(session: AsyncSession = Depends(get_session)):
    rows = await _fetch_inbound(session, limit=10000)
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(INBOUND_COLUMNS)
    for r in rows:
        writer.writerow([r.get(c, "") if r.get(c) is not None else "" for c in INBOUND_COLUMNS])
    csv_text = output.getvalue()
    filename = f"cn-warehouse-inbound-{date.today().isoformat()}.csv"
    return StreamingResponse(
        iter([csv_text]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
