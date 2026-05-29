from __future__ import annotations

import csv
import io
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
import logging

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
from app.services import bc_client, sheet_sync
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
    from_date: date | None = Query(None, description="ISO YYYY-MM-DD — filter by expected_arrival_date >= from_date"),
    to_date: date | None = Query(None, description="ISO YYYY-MM-DD — filter by expected_arrival_date <= to_date"),
    limit: int = Query(500, ge=1, le=2000),
):
    return await list_dos(
        session,
        status_filter=status_filter,
        customer_id=customer_id,
        from_date=from_date,
        to_date=to_date,
        limit=limit,
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


@router.delete("/containers/{container_no}", status_code=204)
async def delete_container_fully(
    container_no: str,
    session: AsyncSession = Depends(get_session),
):
    """Hard-delete a container and everything attached to it.

    Cascades through tally_sheets, scans, receipts, lot_assignments,
    container_documents, container_lines, then the container itself.
    If the parent DO and WHPO are left orphaned (no other containers),
    they're deleted too — keeps the system clean after a test reset.

    Outbound side is NOT touched (different lifecycle). On-disk files
    under containers/{id}/ are best-effort deleted via vendor_uploads.

    Intended for dev cleanup and one-off corrections (e.g. test
    container that needs to be re-created from scratch). For full
    transactional wipe use /database/wipe-transactional."""
    from sqlalchemy import delete as sql_delete
    from app.models import (
        ContainerDocument,
        ContainerLine,
        LotAssignment,
        Pallet,
        Receipt,
        Scan,
        TallySheet,
    )
    from app.services import vendor_uploads

    container = await session.scalar(
        select(Container).where(Container.container_no == container_no.upper())
    )
    if container is None:
        raise HTTPException(404, f"Container {container_no} not found")

    container_id = container.id
    do_id = container.do_id

    # Snapshot file paths to clean up after DB delete commits.
    doc_paths = [
        d.storage_path
        for d in (
            await session.scalars(
                select(ContainerDocument).where(ContainerDocument.container_id == container_id)
            )
        ).all()
    ]
    tally_paths = [
        t.pod_storage_path
        for t in (
            await session.scalars(
                select(TallySheet).where(TallySheet.container_id == container_id)
            )
        ).all()
    ]

    # Order matters where FKs lack ON DELETE CASCADE. Children first.
    await session.execute(sql_delete(TallySheet).where(TallySheet.container_id == container_id))
    await session.execute(sql_delete(Scan).where(Scan.container_id == container_id))
    await session.execute(sql_delete(Pallet).where(Pallet.container_id == container_id))
    await session.execute(sql_delete(Receipt).where(Receipt.container_id == container_id))
    await session.execute(sql_delete(LotAssignment).where(LotAssignment.container_id == container_id))
    await session.execute(sql_delete(ContainerLine).where(ContainerLine.container_id == container_id))
    await session.execute(sql_delete(ContainerDocument).where(ContainerDocument.container_id == container_id))
    await session.execute(sql_delete(Container).where(Container.id == container_id))

    # Orphan check: drop DO + WHPO if no other containers reference them.
    if do_id is not None:
        sibling = await session.scalar(
            select(Container.id).where(Container.do_id == do_id).limit(1)
        )
        if sibling is None:
            do_row = await session.get(DO, do_id)
            whpo_id = do_row.whpo_id if do_row else None
            await session.execute(sql_delete(DO).where(DO.id == do_id))
            if whpo_id is not None:
                await session.execute(sql_delete(WHPO).where(WHPO.id == whpo_id))

    await session.commit()

    # Best-effort filesystem cleanup. Errors logged but don't roll back the DB.
    for p in [*doc_paths, *tally_paths]:
        if not p:
            continue
        try:
            vendor_uploads.delete_storage_file(p)
        except Exception:
            pass


@router.post("/database/wipe-transactional")
async def wipe_transactional_data(
    session: AsyncSession = Depends(get_session),
):
    """Destructive: wipe all transactional Postgres data (WHPOs, DOs,
    containers, lines, lot assignments, receipts, pallets, scans, exceptions,
    activity log) AND clear every row from the OneDrive Excel InboundTable.

    Preserves master data: customers, SKUs (source IN ('seed',
    'manager_admin') — anything seeded OR intentionally created via the
    Manager > SKU admin), floors, lots. Also preserves the VendorUsers
    Excel sheet (real accounts). Exception-resolved SKUs
    (source='manager_resolve') ARE wiped — those are auto-generated from
    the unknown-SKU exception flow and tied to specific shipments that
    are now gone.

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
        _text("DELETE FROM skus WHERE source NOT IN ('seed', 'manager_admin')")
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

    # Step 4: refresh the per-brand Master Inventory workbook. Without
    # this, every brand sheet shows stale rows from before the wipe —
    # the InboundTable + outbound mirrors got cleared above but the
    # Master workbook is a separate OneDrive file driven by its own
    # webhook. Best-effort: a Logic App outage shouldn't fail the wipe.
    master_sheet_pushed = False
    try:
        from app.services import master_sheet_sync as _master_sheet_sync
        if _master_sheet_sync.is_configured():
            master_sheet_pushed = await _master_sheet_sync.push_full_replace(session)
    except Exception as e:  # noqa: BLE001
        logging.getLogger(__name__).warning(
            "master_sheet_sync.push_full_replace failed during wipe-transactional: %s", e
        )

    return {
        "excel_rows_deleted": excel_deleted,
        "outbound_excel_rows_deleted": outbound_rows_deleted,
        "container_inventory_rows_deleted": inventory_rows_deleted,
        "scan_worksheets_deleted": scan_sheets_deleted,
        "outbound_scan_worksheets_deleted": outbound_scan_sheets_deleted,
        "master_sheet_pushed": master_sheet_pushed,
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
        bc_customer_no=a.bc_customer_no,
        bc_synced_at=a.bc_synced_at,
        bc_sync_error=a.bc_sync_error,
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
    # Best-effort dual-write to BC. Failure is recorded on the row but
    # the in-house create has already committed and is the source of truth.
    await bc_client.upsert_customer(session, a)
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
    # Best-effort BC mirror.
    await bc_client.upsert_customer(session, a)
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


# ─── Business Central dual-write (Phase 1: Accounts → Customers) ────────


@router.post("/bc/reconcile-accounts")
async def bc_reconcile_accounts(
    only_unsynced: bool = True,
    session: AsyncSession = Depends(get_session),
):
    """Backfill: push every existing Account to BC as a Customer. Useful
    once after wiring BC credentials, then on-demand when sync errors
    accumulate. `only_unsynced=true` skips accounts that already have a
    bc_customer_no without a current bc_sync_error.

    Returns a per-account result so the manager can see what happened."""
    if not bc_client.is_configured():
        raise HTTPException(
            status_code=503,
            detail=(
                "BC integration not configured — set BC_TENANT_ID, "
                "BC_CLIENT_ID, BC_CLIENT_SECRET, BC_ENVIRONMENT, "
                "BC_COMPANY_NAME in App Service settings, then restart."
            ),
        )
    accounts = (await session.scalars(select(Account))).all()
    results: list[dict[str, object]] = []
    synced = 0
    skipped = 0
    failed = 0
    for a in accounts:
        if only_unsynced and a.bc_customer_no and not a.bc_sync_error:
            skipped += 1
            results.append(
                {"id": a.id, "name": a.name, "status": "skipped",
                 "bc_customer_no": a.bc_customer_no}
            )
            continue
        ok = await bc_client.upsert_customer(session, a)
        if ok:
            synced += 1
            results.append(
                {"id": a.id, "name": a.name, "status": "synced",
                 "bc_customer_no": a.bc_customer_no}
            )
        else:
            failed += 1
            results.append(
                {"id": a.id, "name": a.name, "status": "failed",
                 "error": a.bc_sync_error}
            )
    return {
        "synced": synced, "skipped": skipped, "failed": failed,
        "results": results,
    }


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


@router.delete("/customers/{customer_id}", status_code=204)
async def delete_customer(
    customer_id: int,
    session: AsyncSession = Depends(get_session),
):
    """Delete a brand. Refuses (409) if anything still references the
    brand — WHPOs, Transfer Orders, or SKUs. Manager has to clean those
    up first OR re-assign them to a different brand. Account-level rows
    (Account, Floor, Lot) are not affected."""
    from sqlalchemy import delete as sql_delete
    from app.models import OutboundOrder

    c = await session.get(Customer, customer_id)
    if c is None:
        raise HTTPException(404, f"Brand {customer_id} not found")

    # Block delete when dependents exist. Surfaces a clear message so the
    # manager can fix the data instead of breaking joins.
    whpo_count = await session.scalar(
        select(func.count(WHPO.id)).where(WHPO.customer_id == customer_id)
    ) or 0
    to_count = await session.scalar(
        select(func.count(OutboundOrder.id)).where(OutboundOrder.customer_id == customer_id)
    ) or 0
    sku_count = await session.scalar(
        select(func.count(SKU.id)).where(SKU.customer_id == customer_id)
    ) or 0

    if whpo_count + to_count + sku_count > 0:
        parts = []
        if whpo_count:
            parts.append(f"{whpo_count} WHPO{'s' if whpo_count > 1 else ''}")
        if to_count:
            parts.append(f"{to_count} Transfer Order{'s' if to_count > 1 else ''}")
        if sku_count:
            parts.append(f"{sku_count} SKU{'s' if sku_count > 1 else ''}")
        raise HTTPException(
            409,
            detail=(
                f"Can't delete '{c.name}' — still referenced by "
                f"{', '.join(parts)}. Reassign or delete those first."
            ),
        )

    name = c.name
    await session.execute(sql_delete(Customer).where(Customer.id == customer_id))
    session.add(
        ActivityLog(
            actor="manager",
            kind="customer_deleted",
            ref_type="customer",
            ref_id=customer_id,
            message=f"Brand '{name}' deleted",
        )
    )
    await session.commit()


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


@router.get("/outbound-orders/{transfer_order_no}/lines/{line_id}/container-candidates")
async def list_source_container_candidates(
    transfer_order_no: str,
    line_id: int,
    session: AsyncSession = Depends(get_session),
):
    """Return inbound containers that could fulfill the given outbound
    line — same customer (or any customer under the same account), same
    SKU, with remaining qty > 0.

    "Remaining" = inbound ContainerLine.qty MINUS already-allocated
    outbound_lines.order_qty for that same source_container_no + SKU
    across non-cancelled TOs. Picks-the-line itself is excluded so we
    don't double-count.

    Sorted oldest-received-first (FIFO hint) so the manager can match the
    on-paper aging logic when picking manually.
    """
    from sqlalchemy import select as _select, func as _func
    from app.models import (
        Container as _Container,
        ContainerLine as _ContainerLine,
        DO as _DO,
        OutboundLine as _OutboundLine,
        OutboundOrder as _OutboundOrder,
        WHPO as _WHPO,
    )

    order = (
        await session.execute(
            _select(_OutboundOrder).where(
                _OutboundOrder.transfer_order_no == transfer_order_no
            )
        )
    ).scalar_one_or_none()
    if order is None:
        raise HTTPException(404, f"TO {transfer_order_no} not found")

    line = (
        await session.execute(
            _select(_OutboundLine).where(
                _OutboundLine.id == line_id,
                _OutboundLine.outbound_order_id == order.id,
            )
        )
    ).scalar_one_or_none()
    if line is None:
        raise HTTPException(404, f"Line {line_id} not found on TO {transfer_order_no}")

    sku_raw = (line.sku_raw or "").strip()
    if not sku_raw:
        return {"candidates": []}

    # Step 1: find every (container, sku) inbound row matching this SKU
    # for the TO's customer (and any sibling customers under the same
    # account, so account-level orders can draw cross-brand if needed).
    customer_ids: list[int] = [order.customer_id]
    if order.customer and order.customer.account_id:
        sibling_ids = (
            await session.scalars(
                _select(Customer.id).where(Customer.account_id == order.customer.account_id)
            )
        ).all()
        customer_ids = list(set(customer_ids + list(sibling_ids)))

    inbound_q = (
        _select(
            _Container.container_no,
            _func.sum(_ContainerLine.qty),
            _func.max(_DO.expected_arrival_date),
        )
        .join(_DO, _Container.do_id == _DO.id)
        .join(_WHPO, _DO.whpo_id == _WHPO.id)
        .join(_ContainerLine, _ContainerLine.container_id == _Container.id)
        .where(_WHPO.customer_id.in_(customer_ids))
        .where(_ContainerLine.sku_raw == sku_raw)
        .group_by(_Container.container_no)
        .order_by(_func.max(_DO.expected_arrival_date).asc().nullsfirst())
    )
    inbound_rows = (await session.execute(inbound_q)).all()

    # Step 2: how much is already allocated to other (non-cancelled) TOs
    # per (source_container_no, sku_raw)?
    allocations_q = (
        _select(
            _OutboundLine.source_container_no,
            _func.sum(_OutboundLine.order_qty),
        )
        .join(_OutboundOrder, _OutboundLine.outbound_order_id == _OutboundOrder.id)
        .where(_OutboundLine.sku_raw == sku_raw)
        .where(_OutboundLine.source_container_no.isnot(None))
        .where(_OutboundLine.id != line.id)            # exclude this line
        .where(_OutboundOrder.status != "cancelled")
        .group_by(_OutboundLine.source_container_no)
    )
    allocations = {
        r[0]: int(r[1] or 0) for r in (await session.execute(allocations_q)).all()
    }

    candidates = []
    for container_no, inbound_qty, received_date in inbound_rows:
        inbound = int(inbound_qty or 0)
        allocated = allocations.get(container_no, 0)
        remaining = inbound - allocated
        if remaining <= 0 and container_no != line.source_container_no:
            # Container is fully allocated to other TOs and not currently
            # assigned to this line — skip.
            continue
        candidates.append(
            {
                "container_no": container_no,
                "inbound_qty": inbound,
                "already_allocated_qty": allocated,
                "remaining_qty": remaining,
                "received_date": received_date.isoformat() if received_date else None,
                "is_current": container_no == line.source_container_no,
            }
        )

    return {
        "transfer_order_no": transfer_order_no,
        "line_id": line.id,
        "sku": sku_raw,
        "order_qty": line.order_qty,
        "current_source_container_no": line.source_container_no,
        "candidates": candidates,
    }


@router.patch("/outbound-orders/{transfer_order_no}/lines/{line_id}/source-container")
async def assign_source_container(
    transfer_order_no: str,
    line_id: int,
    payload: dict,
    session: AsyncSession = Depends(get_session),
):
    """Manually assign (or clear) the source inbound container for an
    outbound line.

    Body: `{"source_container_no": "TESU1234567"}` to assign, or
    `{"source_container_no": null}` to clear. Pass an empty string also
    interpreted as clear.

    Validates that the container exists and has matching SKU stock when
    a non-null value is given — refuses to silently link to a bogus
    container number.

    Writes an ActivityLog row + refreshes the master sheet so the new
    linkage shows in every downstream view.
    """
    from sqlalchemy import select as _select
    from app.models import (
        Container as _Container,
        ContainerLine as _ContainerLine,
        OutboundLine as _OutboundLine,
        OutboundOrder as _OutboundOrder,
    )

    order = (
        await session.execute(
            _select(_OutboundOrder).where(
                _OutboundOrder.transfer_order_no == transfer_order_no
            )
        )
    ).scalar_one_or_none()
    if order is None:
        raise HTTPException(404, f"TO {transfer_order_no} not found")

    line = (
        await session.execute(
            _select(_OutboundLine).where(
                _OutboundLine.id == line_id,
                _OutboundLine.outbound_order_id == order.id,
            )
        )
    ).scalar_one_or_none()
    if line is None:
        raise HTTPException(404, f"Line {line_id} not found on TO {transfer_order_no}")

    raw = payload.get("source_container_no")
    new_val: str | None = None
    if raw is not None:
        s = str(raw).strip().upper()
        if s:
            new_val = s

    if new_val is not None:
        # Validate container exists and has stock of this line's SKU.
        container = (
            await session.execute(
                _select(_Container).where(_Container.container_no == new_val)
            )
        ).scalar_one_or_none()
        if container is None:
            raise HTTPException(
                400, f"Container {new_val} not on file. Check the number or wait for the inbound receipt."
            )
        has_sku = await session.scalar(
            _select(_ContainerLine.id)
            .where(_ContainerLine.container_id == container.id)
            .where(_ContainerLine.sku_raw == (line.sku_raw or ""))
            .limit(1)
        )
        if has_sku is None:
            raise HTTPException(
                400,
                f"Container {new_val} doesn't carry SKU {line.sku_raw}. Pick a container that has this SKU.",
            )

    old_val = line.source_container_no
    line.source_container_no = new_val

    session.add(
        ActivityLog(
            actor="manager",
            kind="outbound_line_source_assigned",
            ref_type="outbound_order",
            ref_id=order.id,
            message=(
                f"TO {transfer_order_no} line {line.line_no} ({line.sku_raw}): "
                f"source container {old_val or '∅'} → {new_val or '∅'}"
            ),
            payload={
                "transfer_order_no": transfer_order_no,
                "line_id": line.id,
                "line_no": line.line_no,
                "sku": line.sku_raw,
                "before": old_val,
                "after": new_val,
            },
        )
    )
    await session.commit()

    # Best-effort master sheet refresh — the linkage shows up in the
    # outbound aggregates of the inbound container's row.
    try:
        from app.services import master_sheet_sync
        if master_sheet_sync.is_configured():
            await master_sheet_sync.push_full_replace(session)
    except Exception as e:  # noqa: BLE001
        logging.getLogger(__name__).warning(
            "master_sheet_sync.push_full_replace failed after source-container assign: %s", e
        )

    return {
        "ok": True,
        "transfer_order_no": transfer_order_no,
        "line_id": line.id,
        "source_container_no": new_val,
    }


@router.delete("/outbound-orders/{transfer_order_no}", status_code=200)
async def delete_outbound_order(
    transfer_order_no: str,
    session: AsyncSession = Depends(get_session),
):
    """Destructive: delete a Transfer Order and every child row
    (outbound_scans, outbound_line_serials, outbound_lines,
    outbound_containers, the order itself), then clear its rows from the
    OneDrive Excel mirror and refresh the per-brand Master Inventory.

    Refuses (HTTP 409) if an Invoice is linked to this TO — bill state
    must be cleaned up first. Manager voids the invoice → retries delete.

    Front-end gates this to developer / manager roles. Backend leaves the
    endpoint open for now (matches the rest of /manager/*) but writes an
    ActivityLog row so the audit trail captures who initiated the delete
    when staff SSO lands.
    """
    from sqlalchemy import select as _select, delete as _delete
    from app.models import (
        Invoice as _Invoice,
        OutboundContainer as _OutboundContainer,
        OutboundLine as _OutboundLine,
        OutboundLineSerial as _OutboundLineSerial,
        OutboundOrder as _OutboundOrder,
        OutboundScan as _OutboundScan,
    )
    from app.services import master_sheet_sync, outbound_sheet_sync

    to_no = (transfer_order_no or "").strip()
    if not to_no:
        raise HTTPException(status_code=400, detail="transfer_order_no required")

    order = (
        await session.execute(
            _select(_OutboundOrder).where(_OutboundOrder.transfer_order_no == to_no)
        )
    ).scalar_one_or_none()
    if order is None:
        raise HTTPException(status_code=404, detail=f"TO {to_no} not found")

    # Block delete if an Invoice references this TO — protects the
    # billing audit trail. Manager must void the invoice first.
    invoice_count = await session.scalar(
        _select(func.count(_Invoice.id)).where(_Invoice.outbound_order_id == order.id)
    )
    if invoice_count:
        raise HTTPException(
            status_code=409,
            detail=(
                f"TO {to_no} has {invoice_count} invoice(s) attached. Void the "
                f"invoice(s) under Manager > Invoicing before deleting the TO."
            ),
        )

    # Snapshot for the audit log before the cascade.
    snapshot = {
        "transfer_order_no": order.transfer_order_no,
        "customer_id": order.customer_id,
        "po_number": getattr(order, "po_number", None),
        "status": order.status,
        "order_date": str(order.order_date) if order.order_date else None,
        "ship_to_name": order.ship_to_name,
    }

    # Cascade: scans (via container) → line_serials (via line) → lines →
    # containers → order. Doing each as a single DELETE keeps the round-
    # trip count low even on big TOs.
    container_ids_q = _select(_OutboundContainer.id).where(
        _OutboundContainer.outbound_order_id == order.id
    )
    line_ids_q = _select(_OutboundLine.id).where(
        _OutboundLine.outbound_order_id == order.id
    )

    scans_deleted = (
        await session.execute(
            _delete(_OutboundScan).where(
                _OutboundScan.outbound_container_id.in_(container_ids_q)
            )
        )
    ).rowcount or 0
    serials_deleted = (
        await session.execute(
            _delete(_OutboundLineSerial).where(
                _OutboundLineSerial.outbound_line_id.in_(line_ids_q)
            )
        )
    ).rowcount or 0
    lines_deleted = (
        await session.execute(
            _delete(_OutboundLine).where(_OutboundLine.outbound_order_id == order.id)
        )
    ).rowcount or 0
    containers_deleted = (
        await session.execute(
            _delete(_OutboundContainer).where(
                _OutboundContainer.outbound_order_id == order.id
            )
        )
    ).rowcount or 0
    await session.delete(order)

    session.add(
        ActivityLog(
            actor="manager",
            kind="outbound_order_deleted",
            ref_type="outbound_order",
            ref_id=order.id,
            message=f"TO {to_no} deleted (cascade: {containers_deleted} container(s), "
                    f"{lines_deleted} line(s), {scans_deleted} scan(s))",
            payload={
                "snapshot": snapshot,
                "cascade": {
                    "scans": scans_deleted,
                    "line_serials": serials_deleted,
                    "lines": lines_deleted,
                    "containers": containers_deleted,
                },
            },
        )
    )
    await session.commit()

    # Best-effort Excel cleanup — never blocks the response.
    excel_outbound_deleted = 0
    try:
        excel_outbound_deleted = await outbound_sheet_sync.delete_outbound_rows_for_to(to_no)
    except Exception as e:  # noqa: BLE001
        logging.getLogger(__name__).warning(
            "outbound_sheet_sync.delete_outbound_rows_for_to failed: %s", e
        )

    # Refresh the per-brand Master Inventory so the deleted TO drops out
    # of every brand sheet that referenced it.
    try:
        if master_sheet_sync.is_configured():
            await master_sheet_sync.push_full_replace(session)
    except Exception as e:  # noqa: BLE001
        logging.getLogger(__name__).warning(
            "master_sheet_sync.push_full_replace failed after TO delete: %s", e
        )

    return {
        "ok": True,
        "transfer_order_no": to_no,
        "cascade": {
            "scans": scans_deleted,
            "line_serials": serials_deleted,
            "lines": lines_deleted,
            "containers": containers_deleted,
        },
        "excel_outbound_rows_deleted": excel_outbound_deleted,
    }


@router.post("/backfill/scan-receipt")
async def backfill_scan_receipt(
    payload: dict,
    session: AsyncSession = Depends(get_session),
):
    """Manually backfill a completed receipt for a container whose operator
    didn't use the portal at the dock — happens when the scan was done on
    paper / a separate scanner and the data lands later.

    Idempotent-ish: refuses to insert if the container already has a
    'completed' receipt (any prior receipt's scans would have been re-
    created on a retry which would silently duplicate). Wipe the existing
    receipt first if you actually want to overwrite.

    Body:
      {
        "container_no": "TCNU2190245",
        "operator":     "thomas",
        "started_at":   "2026-05-28T20:45:00Z",   ISO UTC
        "finished_at":  "2026-05-28T22:45:00Z",
        "scans": [
          {"serial": "LELHE5XD162603250788", "imei": "864852081687344"},
          ...
        ]
      }

    Does:
      - Creates a Receipt(status='completed', started/finished_at, by=operator)
      - Creates one Pallet to hold the scans (single-pallet — caller can
        re-split later if needed)
      - Creates Scan rows (one per item) linked to receipt + pallet + container
      - Resolves sku_id from the container's first ContainerLine
      - Updates Container.status='received' and Container.finished_at
      - Triggers scan_sheet_onedrive push + master_sheet refresh
      - Writes an ActivityLog row for audit
    """
    from datetime import datetime as _dt
    from sqlalchemy import select as _select
    from app.models import (
        Container as _Container,
        ContainerLine as _ContainerLine,
        Receipt as _Receipt,
        Scan as _Scan,
    )

    container_no = (payload.get("container_no") or "").strip().upper()
    operator = (payload.get("operator") or "").strip() or "manager-backfill"
    if not container_no:
        raise HTTPException(400, "container_no required")
    scans_in = payload.get("scans") or []
    if not isinstance(scans_in, list) or not scans_in:
        raise HTTPException(400, "scans must be a non-empty array")
    try:
        started_at = _dt.fromisoformat(payload["started_at"].replace("Z", "+00:00"))
        finished_at = _dt.fromisoformat(payload["finished_at"].replace("Z", "+00:00"))
    except (KeyError, ValueError) as e:
        raise HTTPException(400, f"started_at/finished_at must be ISO datetimes: {e}")
    if finished_at <= started_at:
        raise HTTPException(400, "finished_at must be after started_at")

    container = (
        await session.execute(
            _select(_Container).where(_Container.container_no == container_no)
        )
    ).scalar_one_or_none()
    if container is None:
        raise HTTPException(
            404,
            f"Container {container_no} not on file. Submit the WHPO first via the vendor portal.",
        )

    existing_completed = await session.scalar(
        _select(_Receipt.id)
        .where(_Receipt.container_id == container.id)
        .where(_Receipt.status == "completed")
        .limit(1)
    )
    if existing_completed is not None:
        raise HTTPException(
            409,
            f"Container {container_no} already has a completed receipt "
            f"(id={existing_completed}). Delete it first if you want to "
            "rebuild from scratch.",
        )

    # Resolve a default SKU + sku_id from the manifest.
    first_line = await session.scalar(
        _select(_ContainerLine)
        .where(_ContainerLine.container_id == container.id)
        .limit(1)
    )
    default_sku_id = first_line.sku_id if first_line else None
    default_sku_raw = (first_line.sku_raw if first_line else None) or ""

    # 1. Receipt
    receipt = _Receipt(
        container_id=container.id,
        status="completed",
        started_at=started_at,
        finished_at=finished_at,
        started_by=operator,
        finished_by=operator,
    )
    session.add(receipt)
    await session.flush()  # populate receipt.id

    # 2. Scans — no Pallet wrapper since (a) backfill data doesn't carry
    # box/pallet structure and (b) Pallet has non-nullable FKs (lot_id,
    # sku_id, pallet_mode_at_receipt) that don't make sense to fabricate.
    # Scan.pallet_id is nullable. Scooter box-numbering (which IS pallet-
    # backed) doesn't apply to this SKU class — N-E-BIKE etc. ship without
    # box grouping.
    accepted = 0
    skipped: list[dict] = []
    seen_serials: set[str] = set()
    for entry in scans_in:
        serial = (entry.get("serial") or "").strip()
        imei = (entry.get("imei") or "").strip() or None
        if not serial:
            skipped.append({"reason": "empty serial", "entry": entry})
            continue
        if serial in seen_serials:
            # Per-receipt serial uniqueness constraint would blow up the
            # whole transaction on commit. Quietly skip the dup.
            skipped.append({"reason": "duplicate serial within payload", "serial": serial})
            continue
        seen_serials.add(serial)
        session.add(
            _Scan(
                receipt_id=receipt.id,
                pallet_id=None,
                container_id=container.id,
                sku_id=default_sku_id,
                item_barcode=serial,
                serial_number=serial,
                imei=imei,
                scanned_at=started_at,         # exact per-scan time not provided
                scanned_by=operator,
                result="ok",
                error_reason=None,
            )
        )
        accepted += 1

    # 4. Container status
    container.status = "received"
    container.finished_at = finished_at
    if not container.actual_arrival_date:
        container.actual_arrival_date = started_at.date()

    # 5. Audit log
    session.add(
        ActivityLog(
            actor=operator,
            kind="container_backfilled",
            ref_type="container",
            ref_id=container.id,
            message=(
                f"Manual scan-data backfill on {container_no} — "
                f"{accepted} scans, started {started_at.isoformat()}, "
                f"finished {finished_at.isoformat()} by {operator}"
            ),
            payload={
                "container_no": container_no,
                "receipt_id": receipt.id,
                "scan_count": accepted,
                "skipped": skipped,
            },
        )
    )
    await session.commit()

    # 6. Push scan sheet to OneDrive (creates a new worksheet in the
    # configured scan-sheets workbook). Best-effort.
    onedrive_pushed = False
    try:
        from app.services import scan_sheet_onedrive
        from app.routers.scan_sheet import _build_header, _scan_to_row, _container_sku, _container_uses_box_numbers
        # Reload container + relationships for the header build
        await session.refresh(container, attribute_names=["do"])
        whpo = container.do.whpo if container.do else None
        do = container.do
        header = _build_header(receipt, container, whpo, do)
        scans = (
            await session.scalars(
                _select(_Scan)
                .where(_Scan.receipt_id == receipt.id)
                .order_by(_Scan.scanned_at.asc())
            )
        ).all()
        is_scooter = _container_uses_box_numbers(container)
        sku_default = _container_sku(container)
        from app.schemas.scan_sheet import AuditSheetDetail
        rows = [
            _scan_to_row(s, container.container_no, sku_default, idx + 1 if is_scooter else None)
            for idx, s in enumerate(scans)
        ]
        detail = AuditSheetDetail(header=header, rows=rows)
        if scan_sheet_onedrive.is_configured():
            await scan_sheet_onedrive.push_scan_sheet(detail)
            onedrive_pushed = True
    except Exception as e:  # noqa: BLE001
        logging.getLogger(__name__).warning(
            "scan-sheet OneDrive push failed during backfill: %s", e
        )

    # 7. Master sheet refresh
    master_pushed = False
    try:
        from app.services import master_sheet_sync
        if master_sheet_sync.is_configured():
            master_pushed = await master_sheet_sync.push_full_replace(session)
    except Exception as e:  # noqa: BLE001
        logging.getLogger(__name__).warning(
            "master_sheet_sync refresh failed during backfill: %s", e
        )

    return {
        "ok": True,
        "container_no": container_no,
        "receipt_id": receipt.id,
        "scans_accepted": accepted,
        "scans_skipped": len(skipped),
        "skipped_details": skipped,
        "onedrive_scan_sheet_pushed": onedrive_pushed,
        "master_sheet_pushed": master_pushed,
    }


@router.post("/receipts/{receipt_id}/push-scan-sheet")
async def push_scan_sheet_to_onedrive(
    receipt_id: int,
    session: AsyncSession = Depends(get_session),
):
    """Re-push a receipt's scan sheet to the OneDrive scan-sheets workbook.

    Use cases:
      - The original push at receipt-finish time failed silently because
        the scan-sheets Logic App was broken (workbook rename, OneDrive
        auth expired, etc).
      - You just fixed the Logic App and want yesterday's receipts to
        catch up.
      - The scan-sheets workbook was rebuilt from scratch and needs the
        backfill.

    Reads the receipt + scans straight out of Postgres, builds the
    AuditSheetDetail payload, fires the Logic App. Returns the upstream
    HTTP status so the caller can confirm.
    """
    from sqlalchemy import select as _select
    from app.models import (
        Container as _Container,
        Receipt as _Receipt,
        Scan as _Scan,
        DO as _DO,
        WHPO as _WHPO,
    )
    from sqlalchemy.orm import selectinload as _selectinload

    receipt = await session.scalar(
        _select(_Receipt).where(_Receipt.id == receipt_id)
    )
    if receipt is None:
        raise HTTPException(404, f"Receipt {receipt_id} not found")
    if receipt.kind != "inbound" or receipt.container_id is None:
        raise HTTPException(
            400,
            f"Receipt {receipt_id} is {receipt.kind} — push-scan-sheet is "
            "for inbound receipts. Outbound has its own push endpoint.",
        )

    # Re-load container with every relationship the header builder + line
    # helpers touch. _container_requires_imei walks line.sku.product_type
    # when line.product_type is null → preload that too or boom
    # MissingGreenlet under the async session.
    from app.models import ContainerLine as _ContainerLine
    container = await session.scalar(
        _select(_Container)
        .where(_Container.id == receipt.container_id)
        .options(
            _selectinload(_Container.do).selectinload(_DO.whpo).selectinload(_WHPO.customer),
            _selectinload(_Container.lines).selectinload(_ContainerLine.sku),
        )
    )
    if container is None:
        raise HTTPException(
            500, f"Receipt {receipt_id} references missing container_id {receipt.container_id}"
        )

    scans = (
        await session.scalars(
            _select(_Scan)
            .where(_Scan.receipt_id == receipt.id)
            .where(_Scan.serial_number.isnot(None))
            .order_by(_Scan.scanned_at.asc())
        )
    ).all()

    from app.services import scan_sheet_onedrive
    if not scan_sheet_onedrive.is_configured():
        raise HTTPException(
            400,
            "ONEDRIVE_SCAN_SHEET_URL is not configured. Set the env var first.",
        )

    from app.routers.scan_sheet import (
        _build_header,
        _scan_to_row,
        _container_sku,
        _container_uses_box_numbers,
        _box_for_index,
    )
    from app.schemas.scan_sheet import AuditSheetDetail

    header = _build_header(receipt, container, container.do.whpo, container.do)
    is_scooter = _container_uses_box_numbers(container)
    sku_default = _container_sku(container)
    rows = [
        _scan_to_row(
            s,
            container.container_no,
            sku_default,
            _box_for_index(idx) if is_scooter else None,
        )
        for idx, s in enumerate(scans)
    ]
    detail = AuditSheetDetail(header=header, rows=rows)

    try:
        await scan_sheet_onedrive.push_scan_sheet(detail)
        pushed = True
        error = None
    except Exception as e:  # noqa: BLE001
        pushed = False
        error = str(e)

    return {
        "ok": pushed,
        "receipt_id": receipt.id,
        "container_no": container.container_no,
        "scans_in_payload": len(rows),
        "error": error,
    }


@router.delete("/containers/{container_no}", status_code=200)
async def delete_container_full(
    container_no: str,
    session: AsyncSession = Depends(get_session),
):
    """Destructive: remove an inbound container fully from the system —
    container + all child rows (scans, receipts, lot_assignments,
    container_lines), the Excel InboundTable rows for its WHPO, and
    refresh the per-brand Master Inventory.

    If the container's parent DO has no other containers, the DO + WHPO
    are removed too (matches the "the whole shipment is gone" mental
    model — vendor would resubmit cleanly).

    Refuses (409) if any invoice references this container's WHPO —
    void the invoice first.

    Outbound references: OutboundLine.source_container_no pointing at
    this container_no is *cleared*, not deleted (the TO itself stays
    valid, just falls back to FIFO-pick-at-dock for that line).
    """
    from sqlalchemy import select as _select, delete as _delete, update as _update
    from app.models import (
        Container as _Container,
        ContainerLine as _ContainerLine,
        DO as _DO,
        Invoice as _Invoice,
        LotAssignment as _LotAssignment,
        OutboundLine as _OutboundLine,
        Pallet as _Pallet,
        Receipt as _Receipt,
        Scan as _Scan,
        WHPO as _WHPO,
    )

    cno = (container_no or "").strip().upper()
    if not cno:
        raise HTTPException(400, "container_no required")

    container = (
        await session.execute(
            _select(_Container).where(_Container.container_no == cno)
        )
    ).scalar_one_or_none()
    if container is None:
        raise HTTPException(404, f"Container {cno} not found")

    # Block if there's an invoice tied to the parent WHPO (or to any TO
    # that draws from this container). Caller voids/voids invoice first.
    do_row = await session.get(_DO, container.do_id) if container.do_id else None
    whpo_id = do_row.whpo_id if do_row else None
    invoice_block = await session.scalar(
        _select(func.count(_Invoice.id)).where(
            (_Invoice.whpo_id == whpo_id)
            if whpo_id else (_Invoice.id == -1)
        )
    )
    if invoice_block:
        raise HTTPException(
            409,
            f"Container {cno}'s WHPO has {invoice_block} invoice(s) attached. "
            "Void the invoice(s) under Manager > Invoicing before deleting.",
        )

    # WHPO number captured for Excel cleanup (delete_inbound_rows_for_whpo)
    whpo = await session.get(_WHPO, whpo_id) if whpo_id else None
    whpo_number = whpo.whpo_number if whpo else None

    snapshot = {
        "container_no": cno,
        "container_id": container.id,
        "do_id": container.do_id,
        "do_number": do_row.do_number if do_row else None,
        "whpo_id": whpo_id,
        "whpo_number": whpo_number,
        "status": container.status,
    }

    # Cascade: scans → pallets → lot_assignments → container_lines →
    # receipts (after their child scans/pallets are gone) → container.
    scans_deleted = (
        await session.execute(
            _delete(_Scan).where(_Scan.container_id == container.id)
        )
    ).rowcount or 0
    pallets_deleted = (
        await session.execute(
            _delete(_Pallet).where(_Pallet.container_id == container.id)
        )
    ).rowcount or 0
    lot_assignments_deleted = (
        await session.execute(
            _delete(_LotAssignment).where(_LotAssignment.container_id == container.id)
        )
    ).rowcount or 0
    lines_deleted = (
        await session.execute(
            _delete(_ContainerLine).where(_ContainerLine.container_id == container.id)
        )
    ).rowcount or 0
    receipts_deleted = (
        await session.execute(
            _delete(_Receipt).where(_Receipt.container_id == container.id)
        )
    ).rowcount or 0

    # Outbound TO lines that referenced this container_no: NULL the
    # source pointer, don't delete the line. The TO stays valid and the
    # operator will FIFO-pick a replacement source at the dock.
    sources_cleared = (
        await session.execute(
            _update(_OutboundLine)
            .where(_OutboundLine.source_container_no == cno)
            .values(source_container_no=None)
        )
    ).rowcount or 0

    await session.delete(container)

    # If the DO has no other containers, remove DO + WHPO too. Mirrors
    # what a vendor would see after a fresh resubmit.
    do_and_whpo_removed = False
    if container.do_id is not None:
        remaining = await session.scalar(
            _select(func.count(_Container.id)).where(_Container.do_id == container.do_id)
        )
        if not remaining:
            if do_row is not None:
                await session.delete(do_row)
            if whpo is not None:
                await session.delete(whpo)
            do_and_whpo_removed = True

    session.add(
        ActivityLog(
            actor="manager",
            kind="container_deleted",
            ref_type="container",
            ref_id=snapshot["container_id"],
            message=(
                f"Container {cno} fully removed "
                f"(scans={scans_deleted}, lines={lines_deleted}, "
                f"receipts={receipts_deleted}"
                + (f", DO+WHPO {snapshot['do_number']}/{whpo_number} dropped" if do_and_whpo_removed else "")
                + (f", {sources_cleared} outbound source ref(s) cleared" if sources_cleared else "")
                + ")"
            ),
            payload={"snapshot": snapshot, "cascade": {
                "scans": scans_deleted,
                "pallets": pallets_deleted,
                "lot_assignments": lot_assignments_deleted,
                "container_lines": lines_deleted,
                "receipts": receipts_deleted,
                "outbound_source_refs_cleared": sources_cleared,
                "do_and_whpo_removed": do_and_whpo_removed,
            }},
        )
    )
    await session.commit()

    # Excel cleanup (best-effort, no rollback if these fail).
    excel_inbound_deleted = 0
    if whpo_number:
        try:
            excel_inbound_deleted = await sheet_sync.delete_inbound_rows_for_whpo(whpo_number)
        except Exception as e:  # noqa: BLE001
            logging.getLogger(__name__).warning(
                "delete_inbound_rows_for_whpo failed during container delete: %s", e
            )

    master_pushed = False
    try:
        from app.services import master_sheet_sync
        if master_sheet_sync.is_configured():
            master_pushed = await master_sheet_sync.push_full_replace(session)
    except Exception as e:  # noqa: BLE001
        logging.getLogger(__name__).warning(
            "master_sheet_sync push failed during container delete: %s", e
        )

    return {
        "ok": True,
        "container_no": cno,
        "cascade": {
            "scans": scans_deleted,
            "pallets": pallets_deleted,
            "lot_assignments": lot_assignments_deleted,
            "container_lines": lines_deleted,
            "receipts": receipts_deleted,
            "outbound_source_refs_cleared": sources_cleared,
            "do_and_whpo_removed": do_and_whpo_removed,
        },
        "excel_inbound_rows_deleted": excel_inbound_deleted,
        "master_sheet_pushed": master_pushed,
    }
