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
    Account,
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
    AccountCreateRequest,
    AccountRead,
    AccountUpdateRequest,
    CustomerCreateRequest,
    CustomerRead,
    CustomerUpdateRequest,
    DODetail,
    DOListItem,
    DashboardResponse,
    ExceptionItem,
    LotDetail,
    LotMapItem,
    ResolveExceptionRequest,
    ResolveExceptionResponse,
    SKUAdminCreateRequest,
    SKUAdminUpdateRequest,
    SKURead,
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

    # Step 1b: clear outbound Excel sheets (OutboundTable + ContainerInventory).
    # Best-effort — these are independent workbooks; failures log and proceed
    # so we don't block the Postgres wipe on a transient OneDrive hiccup.
    from app.services import outbound_sheet_sync as _out_sync
    from app.services import scan_sheet_onedrive as _scan_od
    from app.services import outbound_scan_sheet_onedrive as _out_scan_od

    outbound_rows_deleted = 0
    inventory_rows_deleted = 0
    scan_sheets_deleted = 0
    outbound_scan_sheets_deleted = 0
    try:
        outbound_rows_deleted = await _out_sync.clear_outbound_table()
        inventory_rows_deleted = await _out_sync.clear_container_inventory()
        scan_sheets_deleted = await _scan_od.clear_all_scan_worksheets()
        outbound_scan_sheets_deleted = await _out_scan_od.clear_all_outbound_scan_worksheets()
    except Exception as e:
        # Don't 502 here — operator's test resets shouldn't fail because
        # the outbound ops Logic App is unreachable.
        import logging as _log
        _log.getLogger(__name__).warning(
            "wipe-transactional: outbound excel clear failed: %s", e
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
        "outbound_excel_rows_deleted": outbound_rows_deleted,
        "container_inventory_rows_deleted": inventory_rows_deleted,
        "scan_worksheets_deleted": scan_sheets_deleted,
        "outbound_scan_worksheets_deleted": outbound_scan_sheets_deleted,
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


@router.post("/database/update-whpo-number")
async def update_whpo_number(
    payload: dict,
    session: AsyncSession = Depends(get_session),
):
    """Rename a WHPO. Used to fix typos after submission.

    Body: {"old_whpo_number": "36824324", "new_whpo_number": "36824322"}

    Validates the old WHPO exists and the new one doesn't, updates the
    Postgres row, then resyncs InboundTable in OneDrive (delete old rows
    + re-append with the new WHPO #). Atomic on the Postgres side; Excel
    resync is best-effort and logged on failure.
    """
    from app.services.intake import fetch_inbound_rows_for_do

    old_no = str(payload.get("old_whpo_number") or "").strip()
    new_no = str(payload.get("new_whpo_number") or "").strip()
    if not old_no or not new_no:
        raise HTTPException(
            status_code=400,
            detail="Both old_whpo_number and new_whpo_number are required.",
        )
    if old_no == new_no:
        raise HTTPException(
            status_code=400,
            detail="old and new WHPO numbers are the same.",
        )

    whpo = await session.scalar(
        select(WHPO).where(WHPO.whpo_number == old_no)
    )
    if whpo is None:
        raise HTTPException(
            status_code=404,
            detail=f"WHPO {old_no} not found.",
        )
    clash = await session.scalar(
        select(WHPO.id).where(WHPO.whpo_number == new_no)
    )
    if clash is not None:
        raise HTTPException(
            status_code=409,
            detail=f"WHPO {new_no} already exists — pick a different number.",
        )

    whpo.whpo_number = new_no
    await session.commit()

    # Resync Excel: delete old rows, re-append under the new WHPO #.
    excel_status = "skipped"
    if sheet_sync.is_update_configured():
        try:
            await sheet_sync.delete_inbound_rows_for_whpo(old_no)
            # Re-fetch this WHPO's DO + rows and re-append.
            do = await session.scalar(
                select(DO).where(DO.whpo_id == whpo.id)
            )
            if do is not None:
                rows = await fetch_inbound_rows_for_do(session, do.id)
                if rows:
                    await sheet_sync.append_rows(rows)
                excel_status = "resynced"
            else:
                excel_status = "no_do"
        except Exception as e:
            excel_status = f"error: {e}"
            import logging as _log
            _log.getLogger(__name__).warning(
                "update_whpo_number: Excel resync failed: %s", e
            )

    return {
        "old_whpo_number": old_no,
        "new_whpo_number": new_no,
        "excel": excel_status,
    }


@router.post("/database/wipe-except-container")
async def wipe_except_container(
    payload: dict,
    session: AsyncSession = Depends(get_session),
):
    """Destructive: wipe everything EXCEPT one inbound container and its
    parent WHPO / DO / lines / receipts / scans. Outbound side is wiped
    completely (orders, containers, scans). InboundTable in Excel is
    cleared and re-appended with the kept container's rows.

    Body: {"container_no": "TGBU6260274"}

    Note: per-container worksheets in Lime Scan Data.xlsx are NOT touched
    by this endpoint — delete unwanted ones manually in Excel if needed.
    """
    from sqlalchemy import text as _text
    from app.services.intake import fetch_inbound_rows_for_do

    container_no = str(payload.get("container_no") or "").strip().upper()
    if not container_no:
        raise HTTPException(
            status_code=400, detail="container_no is required."
        )

    target = await session.scalar(
        select(Container).where(Container.container_no == container_no)
    )
    if target is None:
        raise HTTPException(
            status_code=404, detail=f"Container {container_no} not found."
        )
    target_id = target.id
    target_do_id = target.do_id
    target_do = await session.scalar(select(DO).where(DO.id == target_do_id))
    target_whpo_id = target_do.whpo_id if target_do else None

    # 1. Nuke outbound entirely + exceptions + activity_log.
    # SKUs are NOT touched — the kept container's lines still reference
    # them via container_lines.sku_id (would violate FK on delete).
    await session.execute(
        _text(
            "TRUNCATE outbound_scans, outbound_line_serials, outbound_lines, "
            "outbound_containers, outbound_orders, "
            "exceptions, activity_log RESTART IDENTITY CASCADE"
        )
    )

    # 2. Delete everything related to OTHER containers (child rows first,
    # then containers, DOs, WHPOs). IS DISTINCT FROM handles NULL safely.
    # Order matters — every FK-referencing table must be cleared before
    # its parent.
    for sql in (
        "DELETE FROM scans WHERE container_id IS DISTINCT FROM :cid",
        "DELETE FROM pallets WHERE container_id IS DISTINCT FROM :cid",
        "DELETE FROM receipts WHERE container_id IS DISTINCT FROM :cid",
        "DELETE FROM lot_assignments WHERE container_id IS DISTINCT FROM :cid",
        "DELETE FROM container_documents WHERE container_id IS DISTINCT FROM :cid",
        "DELETE FROM container_lines WHERE container_id IS DISTINCT FROM :cid",
        "DELETE FROM containers WHERE id IS DISTINCT FROM :cid",
    ):
        await session.execute(_text(sql), {"cid": target_id})
    if target_do_id:
        await session.execute(
            _text("DELETE FROM dos WHERE id IS DISTINCT FROM :did"),
            {"did": target_do_id},
        )
    if target_whpo_id:
        await session.execute(
            _text("DELETE FROM whpos WHERE id IS DISTINCT FROM :wid"),
            {"wid": target_whpo_id},
        )

    await session.commit()

    # 3. Verify what's left.
    counts: dict[str, int] = {}
    for tbl in (
        "whpos",
        "dos",
        "containers",
        "container_lines",
        "scans",
        "outbound_orders",
        "outbound_containers",
        "outbound_scans",
        "activity_log",
        "exceptions",
    ):
        n = await session.scalar(_text(f"SELECT count(*) FROM {tbl}"))
        counts[tbl] = int(n or 0)

    # 4. OneDrive resync.
    excel_status = "skipped"
    if sheet_sync.is_update_configured():
        try:
            await sheet_sync.clear_inbound_table()
            if target_do_id:
                rows = await fetch_inbound_rows_for_do(session, target_do_id)
                if rows:
                    await sheet_sync.append_rows(rows)
            excel_status = "resynced"
        except Exception as e:
            excel_status = f"inbound_error: {e}"

    # Wipe everything outbound (no kept rows there).
    try:
        from app.services import (
            outbound_sheet_sync as _out_sync,
            outbound_scan_sheet_onedrive as _out_scan_od,
        )
        await _out_sync.clear_outbound_table()
        await _out_sync.clear_container_inventory()
        await _out_scan_od.clear_all_outbound_scan_worksheets()
    except Exception as e:
        excel_status += f"; outbound_error: {e}"

    return {
        "preserved_container_no": container_no,
        "preserved_whpo_id": target_whpo_id,
        "preserved_do_id": target_do_id,
        "postgres_rows_remaining": counts,
        "excel": excel_status,
        "note": (
            "Per-container worksheets in Lime Scan Data.xlsx were left "
            "alone. Delete unwanted ones manually in Excel if needed."
        ),
    }


# ─── SKU master CRUD (admin UI) ────────────────────────────────────────


def _sku_to_read(s: SKU, customer_name: str) -> SKURead:
    return SKURead(
        id=s.id,
        customer_id=s.customer_id,
        customer_name=customer_name,
        sku=s.sku,
        description=s.description,
        product_type=s.product_type,
        sqft_per_unit=s.sqft_per_unit,
        items_per_pallet=s.items_per_pallet,
        pallet_sqft=s.pallet_sqft,
        pallet_mode=s.pallet_mode,
        stackable=s.stackable,
        max_stack_height=s.max_stack_height,
        unit=s.unit,
        source=s.source,
        created_at=s.created_at,
        updated_at=s.updated_at,
    )


# ─── Accounts (billing entities — TQL etc.) ────────────────────────────


async def _account_to_read(session: AsyncSession, a: Account) -> AccountRead:
    customer_count = await session.scalar(
        select(func.count()).select_from(Customer).where(Customer.account_id == a.id)
    )
    return AccountRead(
        id=a.id,
        name=a.name,
        billing_email=a.billing_email,
        billing_address=a.billing_address,
        notes=a.notes,
        customer_count=int(customer_count or 0),
        created_at=a.created_at,
    )


@router.get("/accounts", response_model=list[AccountRead])
async def list_accounts(session: AsyncSession = Depends(get_session)):
    """Billing accounts (TQL, etc.). Each account rolls up many product-
    owner brands (Customer rows) for invoicing."""
    accts = (await session.scalars(select(Account).order_by(Account.name))).all()
    return [await _account_to_read(session, a) for a in accts]


@router.post("/accounts", response_model=AccountRead, status_code=201)
async def create_account(
    payload: AccountCreateRequest,
    session: AsyncSession = Depends(get_session),
):
    existing = await session.scalar(
        select(Account).where(func.lower(Account.name) == payload.name.strip().lower())
    )
    if existing is not None:
        raise HTTPException(
            status_code=409, detail=f"Account '{payload.name}' already exists"
        )
    a = Account(
        name=payload.name.strip(),
        billing_email=payload.billing_email,
        billing_address=payload.billing_address,
        notes=payload.notes,
    )
    session.add(a)
    await session.flush()
    session.add(
        ActivityLog(
            actor="manager",
            kind="account_created",
            ref_type="account",
            ref_id=a.id,
            message=f"Account '{a.name}' created",
        )
    )
    await session.commit()
    return await _account_to_read(session, a)


@router.patch("/accounts/{account_id}", response_model=AccountRead)
async def update_account(
    account_id: int,
    payload: AccountUpdateRequest,
    session: AsyncSession = Depends(get_session),
):
    a = await session.get(Account, account_id)
    if a is None:
        raise HTTPException(status_code=404, detail=f"Account {account_id} not found")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data:
        new_name = data["name"].strip()
        clash = await session.scalar(
            select(Account).where(
                func.lower(Account.name) == new_name.lower(), Account.id != a.id
            )
        )
        if clash is not None:
            raise HTTPException(
                status_code=409, detail=f"Account '{new_name}' already exists"
            )
        a.name = new_name
        data.pop("name")
    for k, v in data.items():
        setattr(a, k, v)
    session.add(
        ActivityLog(
            actor="manager",
            kind="account_updated",
            ref_type="account",
            ref_id=a.id,
            message=f"Account '{a.name}' updated",
            payload={"fields": list(data.keys())},
        )
    )
    await session.commit()
    return await _account_to_read(session, a)


@router.delete("/accounts/{account_id}", status_code=204)
async def delete_account(
    account_id: int,
    session: AsyncSession = Depends(get_session),
):
    a = await session.get(Account, account_id)
    if a is None:
        raise HTTPException(status_code=404, detail=f"Account {account_id} not found")
    in_use = await session.scalar(
        select(func.count()).select_from(Customer).where(Customer.account_id == a.id)
    )
    if (in_use or 0) > 0:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Account has {in_use} brand(s) attached — unlink them first or "
                "reassign them to another account."
            ),
        )
    name = a.name
    await session.delete(a)
    session.add(
        ActivityLog(
            actor="manager",
            kind="account_deleted",
            ref_type="account",
            ref_id=account_id,
            message=f"Account '{name}' deleted",
        )
    )
    await session.commit()


# ─── Customers (product owners — Lime, NP, Pan America, Boviet Solar) ──


def _customer_to_read(c: Customer, account_name: str | None) -> CustomerRead:
    return CustomerRead(
        id=c.id,
        name=c.name,
        account_id=c.account_id,
        account_name=account_name,
        contact_email=c.contact_email,
    )


@router.get("/customers", response_model=list[CustomerRead])
async def list_customers(
    account_id: int | None = None,
    session: AsyncSession = Depends(get_session),
):
    """Product-owner brands. Optional filter by parent account (e.g. show
    just TQL's brands). Each row carries the parent account_name for the
    SKU admin dropdown."""
    stmt = (
        select(Customer, Account.name)
        .outerjoin(Account, Account.id == Customer.account_id)
        .order_by(Customer.name)
    )
    if account_id is not None:
        stmt = stmt.where(Customer.account_id == account_id)
    rows = (await session.execute(stmt)).all()
    return [_customer_to_read(c, account_name) for c, account_name in rows]


@router.post("/customers", response_model=CustomerRead, status_code=201)
async def create_customer(
    payload: CustomerCreateRequest,
    session: AsyncSession = Depends(get_session),
):
    """Create a new product-owner brand. Idempotent — returns the existing
    brand if a normalised name match already exists (account_id and other
    fields are applied as a patch in that case)."""
    name = payload.name.strip()
    existing = await session.scalar(
        select(Customer).where(func.lower(Customer.name) == name.lower())
    )
    if existing is not None:
        # Patch in-place — useful when adding accounts to legacy customers.
        if payload.account_id is not None and existing.account_id != payload.account_id:
            existing.account_id = payload.account_id
        if payload.contact_email is not None:
            existing.contact_email = payload.contact_email
        await session.commit()
        acct = await session.get(Account, existing.account_id) if existing.account_id else None
        return _customer_to_read(existing, acct.name if acct else None)

    if payload.account_id is not None:
        acct = await session.get(Account, payload.account_id)
        if acct is None:
            raise HTTPException(
                status_code=404,
                detail=f"Account {payload.account_id} not found",
            )

    c = Customer(
        name=name,
        account_id=payload.account_id,
        contact_email=payload.contact_email,
    )
    session.add(c)
    await session.flush()
    session.add(
        ActivityLog(
            actor="manager",
            kind="customer_created",
            ref_type="customer",
            ref_id=c.id,
            message=f"Brand '{name}' created",
        )
    )
    await session.commit()
    acct = await session.get(Account, c.account_id) if c.account_id else None
    return _customer_to_read(c, acct.name if acct else None)


@router.patch("/customers/{customer_id}", response_model=CustomerRead)
async def update_customer(
    customer_id: int,
    payload: CustomerUpdateRequest,
    session: AsyncSession = Depends(get_session),
):
    """Update a brand. Send `account_id: null` in the body to detach from
    its current account (legacy direct-bill)."""
    c = await session.get(Customer, customer_id)
    if c is None:
        raise HTTPException(status_code=404, detail=f"Customer {customer_id} not found")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data:
        new_name = data["name"].strip()
        clash = await session.scalar(
            select(Customer).where(
                func.lower(Customer.name) == new_name.lower(), Customer.id != c.id
            )
        )
        if clash is not None:
            raise HTTPException(
                status_code=409, detail=f"Brand '{new_name}' already exists"
            )
        c.name = new_name
        data.pop("name")
    if "account_id" in data:
        new_acct = data["account_id"]
        if new_acct is not None:
            acct = await session.get(Account, new_acct)
            if acct is None:
                raise HTTPException(
                    status_code=404, detail=f"Account {new_acct} not found"
                )
        c.account_id = new_acct
        data.pop("account_id")
    for k, v in data.items():
        setattr(c, k, v)
    session.add(
        ActivityLog(
            actor="manager",
            kind="customer_updated",
            ref_type="customer",
            ref_id=c.id,
            message=f"Brand '{c.name}' updated",
            payload={"fields": list(payload.model_dump(exclude_unset=True).keys())},
        )
    )
    await session.commit()
    acct = await session.get(Account, c.account_id) if c.account_id else None
    return _customer_to_read(c, acct.name if acct else None)


@router.get("/skus", response_model=list[SKURead])
async def list_skus(
    customer_id: int | None = None,
    q: str | None = None,
    limit: int = Query(500, ge=1, le=2000),
    session: AsyncSession = Depends(get_session),
):
    """List SKUs for the admin table. Optional filters by customer or
    free-text match against sku / description / product_type."""
    stmt = (
        select(SKU, Customer.name)
        .join(Customer, Customer.id == SKU.customer_id)
        .order_by(Customer.name, SKU.sku)
        .limit(limit)
    )
    if customer_id is not None:
        stmt = stmt.where(SKU.customer_id == customer_id)
    if q:
        pat = f"%{q.strip()}%"
        stmt = stmt.where(
            (SKU.sku.ilike(pat))
            | (SKU.description.ilike(pat))
            | (SKU.product_type.ilike(pat))
        )
    rows = (await session.execute(stmt)).all()
    return [_sku_to_read(s, cn) for s, cn in rows]


@router.post("/skus", response_model=SKURead, status_code=201)
async def create_sku(
    payload: SKUAdminCreateRequest,
    session: AsyncSession = Depends(get_session),
):
    """Create a new SKU master row. Rejects duplicates within a customer
    (the (customer_id, sku) unique constraint catches them anyway, but
    we surface a friendly 409 here)."""
    customer = await session.get(Customer, payload.customer_id)
    if customer is None:
        raise HTTPException(status_code=404, detail=f"Customer {payload.customer_id} not found")

    existing = await session.scalar(
        select(SKU).where(SKU.customer_id == payload.customer_id, SKU.sku == payload.sku)
    )
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail=f"SKU '{payload.sku}' already exists for {customer.name}",
        )

    s = SKU(
        customer_id=payload.customer_id,
        sku=payload.sku.strip(),
        description=payload.description,
        product_type=(payload.product_type or "").strip() or None,
        sqft_per_unit=payload.sqft_per_unit,
        items_per_pallet=payload.items_per_pallet,
        pallet_sqft=payload.pallet_sqft,
        pallet_mode=payload.pallet_mode,
        stackable=payload.stackable,
        max_stack_height=payload.max_stack_height,
        unit=payload.unit,
        source="manager_admin",
    )
    session.add(s)
    await session.flush()

    # Backfill: attach this SKU to any container_lines that referenced it by
    # raw string and were waiting for master data.
    affected = await session.execute(
        select(ContainerLine).where(
            ContainerLine.sku_raw == s.sku,
            ContainerLine.sku_id.is_(None),
        )
    )
    backfilled = 0
    for ln in affected.scalars():
        # Confirm the line belongs to a container with the same customer.
        # SKU master is customer-scoped; we don't want to cross-link.
        from sqlalchemy import select as _sel

        cust_id = await session.scalar(
            _sel(Customer.id)
            .join(WHPO, WHPO.customer_id == Customer.id)
            .join(DO, DO.whpo_id == WHPO.id)
            .join(Container, Container.do_id == DO.id)
            .where(Container.id == ln.container_id)
        )
        if cust_id == s.customer_id:
            ln.sku_id = s.id
            backfilled += 1

    session.add(
        ActivityLog(
            actor="manager",
            kind="sku_created",
            ref_type="sku",
            ref_id=s.id,
            message=(
                f"SKU '{s.sku}' created for {customer.name}"
                + (f" · backfilled {backfilled} line(s)" if backfilled else "")
            ),
            payload={"backfilled_lines": backfilled},
        )
    )
    await session.commit()
    return _sku_to_read(s, customer.name)


@router.patch("/skus/{sku_id}", response_model=SKURead)
async def update_sku(
    sku_id: int,
    payload: SKUAdminUpdateRequest,
    session: AsyncSession = Depends(get_session),
):
    s = await session.get(SKU, sku_id)
    if s is None:
        raise HTTPException(status_code=404, detail=f"SKU {sku_id} not found")

    data = payload.model_dump(exclude_unset=True)

    # Repointing to a different brand: only allowed when no container_lines
    # or lot_assignments reference this SKU (would break receiving history).
    if "customer_id" in data and data["customer_id"] is not None and data["customer_id"] != s.customer_id:
        new_customer_id = int(data["customer_id"])
        new_customer = await session.get(Customer, new_customer_id)
        if new_customer is None:
            raise HTTPException(
                status_code=404, detail=f"Customer {new_customer_id} not found"
            )
        in_use_lines = await session.scalar(
            select(func.count()).select_from(ContainerLine).where(ContainerLine.sku_id == s.id)
        )
        in_use_la = await session.scalar(
            select(func.count()).select_from(LotAssignment).where(LotAssignment.sku_id == s.id)
        )
        if (in_use_lines or 0) + (in_use_la or 0) > 0:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Cannot move SKU to a different brand — it's already "
                    f"referenced by {in_use_lines or 0} container line(s) and "
                    f"{in_use_la or 0} lot assignment(s). Create a new SKU "
                    "under the correct brand instead."
                ),
            )
        # Also check the destination brand doesn't already have this code.
        clash = await session.scalar(
            select(SKU).where(
                SKU.customer_id == new_customer_id,
                SKU.sku == s.sku,
                SKU.id != s.id,
            )
        )
        if clash is not None:
            raise HTTPException(
                status_code=409,
                detail=f"Brand '{new_customer.name}' already has a SKU '{s.sku}'",
            )
        s.customer_id = new_customer_id
        data.pop("customer_id")
    elif "customer_id" in data:
        # Same brand (or null) — drop without touching.
        data.pop("customer_id")

    if "sku" in data:
        # Renaming — check for clash within the same customer.
        new_sku = data["sku"].strip()
        clash = await session.scalar(
            select(SKU).where(
                SKU.customer_id == s.customer_id,
                SKU.sku == new_sku,
                SKU.id != s.id,
            )
        )
        if clash is not None:
            raise HTTPException(status_code=409, detail=f"SKU '{new_sku}' already exists")
        s.sku = new_sku
        data.pop("sku")

    for k, v in data.items():
        if k == "product_type" and v is not None:
            v = v.strip() or None
        setattr(s, k, v)

    customer = await session.get(Customer, s.customer_id)
    session.add(
        ActivityLog(
            actor="manager",
            kind="sku_updated",
            ref_type="sku",
            ref_id=s.id,
            message=f"SKU '{s.sku}' updated",
            payload={"fields": list(data.keys())},
        )
    )
    await session.commit()
    return _sku_to_read(s, customer.name if customer else "?")


@router.get("/skus/calculator")
async def sku_space_calculator(
    qty: int = Query(..., ge=0),
    items_per_pallet: float = Query(..., gt=0),
    pallet_sqft: float = Query(..., gt=0),
    lot_sqft: float | None = Query(None, gt=0),
):
    """Pure calc preview — no DB. Used by the SKU admin form to render
    'if you receive qty units → X pallets → Y sqft → Z lots' live as the
    user types. Defaults lot_sqft to the Vernon facility size (17×23)."""
    from app.services.space import DEFAULT_LOT_SQFT, compute_pallet_rollup

    lot = lot_sqft if lot_sqft else DEFAULT_LOT_SQFT
    rollup = compute_pallet_rollup(qty, items_per_pallet, pallet_sqft, lot)
    # ceil up lots — partial lots still consume a whole lot's footprint.
    import math

    lots_needed = math.ceil(rollup["lots"]) if rollup["lots"] > 0 else 0
    return {
        **rollup,
        "lots_needed": lots_needed,
        "lot_sqft_used": lot,
    }


@router.delete("/skus/{sku_id}", status_code=204)
async def delete_sku(
    sku_id: int,
    session: AsyncSession = Depends(get_session),
):
    """Delete a SKU master row. Blocked if any container_line or
    lot_assignment still references it — operator would lose receiving
    history. Disable the SKU by renaming or leaving it inactive instead."""
    s = await session.get(SKU, sku_id)
    if s is None:
        raise HTTPException(status_code=404, detail=f"SKU {sku_id} not found")

    in_use = await session.scalar(
        select(func.count()).select_from(ContainerLine).where(ContainerLine.sku_id == sku_id)
    )
    if (in_use or 0) > 0:
        raise HTTPException(
            status_code=409,
            detail=(
                f"SKU is referenced by {in_use} container line(s) — cannot delete. "
                "Edit it instead, or rename it and create a new one."
            ),
        )
    in_use_la = await session.scalar(
        select(func.count()).select_from(LotAssignment).where(LotAssignment.sku_id == sku_id)
    )
    if (in_use_la or 0) > 0:
        raise HTTPException(
            status_code=409,
            detail=f"SKU is referenced by {in_use_la} lot assignment(s).",
        )

    sku_str = s.sku
    customer_id = s.customer_id
    await session.delete(s)
    session.add(
        ActivityLog(
            actor="manager",
            kind="sku_deleted",
            ref_type="customer",
            ref_id=customer_id,
            message=f"SKU '{sku_str}' deleted",
        )
    )
    await session.commit()


@router.get("/calendar")
async def get_manager_calendar(
    days: int = 14,
    session: AsyncSession = Depends(get_session),
):
    """Cross-customer inbound + outbound activity for the next `days` days.
    No customer filter — managers see everything. Window: 1 / 7 / 14 / 30
    (the UI offers those presets but any int 1-60 works)."""
    from app.services.calendar import build_calendar

    days = max(1, min(60, int(days)))
    data = await build_calendar(session, days=days, customer_name=None)
    return data


# ─── ERP drilldowns ────────────────────────────────────────────────────


@router.get("/containers/{container_no}")
async def get_container_erp_detail(
    container_no: str,
    session: AsyncSession = Depends(get_session),
):
    """Comprehensive container detail — order chain, driver, lines, scans,
    lot put-away, documents, downstream outbound TOs, exceptions, activity
    log. Single round-trip; powers the manager ERP detail UI."""
    from app.services.manager_erp import NotFound, get_container_detail

    try:
        return await get_container_detail(session, container_no)
    except NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/outbound-orders")
async def list_outbound_orders(
    limit: int = Query(200, ge=1, le=500),
    session: AsyncSession = Depends(get_session),
):
    """Cross-customer list of every outbound Transfer Order — manager's
    counterpart to the inbound DOs list."""
    from app.services.manager_erp import list_outbound_orders_all

    return await list_outbound_orders_all(session, limit=limit)


@router.get("/outbound-orders/{transfer_order_no}")
async def get_outbound_erp_detail(
    transfer_order_no: str,
    session: AsyncSession = Depends(get_session),
):
    """Comprehensive TO detail — lines (picked vs ordered), attached
    trucks, linked inbound containers (drilldown back to source), timeline,
    activity log."""
    from app.services.manager_erp import NotFound, get_outbound_order_detail

    try:
        return await get_outbound_order_detail(session, transfer_order_no)
    except NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
