"""Operator scan-sheet endpoints.

Mounted at /operator/sheet/*. All endpoints are gated by the
`SCAN_SHEETS_ENABLED` config flag — when off, every route returns 503 so
the flag flip is the single switch that releases the feature.

This is additive on top of the existing /operator/* endpoints. The
legacy scan flow (lookup_container + record_scan + finish_container)
continues to work unchanged — operators can use either path until we
fully migrate.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import settings
from app.db import get_session
from app.models import DO, WHPO, Container, ContainerLine, Receipt, Scan
from app.schemas.scan_sheet import (
    AuditSheetDetail,
    FinishSheetResponse,
    OpenSheetRequest,
    OpenSheetResponse,
    RecordScanRequest,
    RecordScanResponse,
    ScanRow,
    ScanSheetHeader,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/operator/sheet", tags=["scan-sheet"])


def _ensure_enabled() -> None:
    if not settings.scan_sheets_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Scan-sheet feature is not enabled on this environment.",
        )


# ─── Helpers ────────────────────────────────────────────────────────────


def _container_requires_imei(container: Container) -> bool:
    """A container requires IMEI capture if any of its lines is a scooter.
    Match is case-insensitive substring on `product_type`, so 'Scooter',
    'Scooters', 'E-Scooter', etc. all qualify."""
    for line in (container.lines or []):
        pt = (line.product_type or "").lower()
        if "scoot" in pt:
            return True
    return False


def _build_header(receipt: Receipt, container: Container, whpo: WHPO, do: DO) -> ScanSheetHeader:
    return ScanSheetHeader(
        receipt_id=receipt.id,
        container_no=container.container_no,
        whpo_number=whpo.whpo_number,
        do_number=do.do_number,
        customer_name=whpo.customer.name if whpo.customer else "",
        bol_number=whpo.bol_number,
        received_date=receipt.started_at.date(),
        start_timestamp=receipt.started_at,
        completed_timestamp=receipt.finished_at,
        is_completed=receipt.status == "completed",
        requires_imei=_container_requires_imei(container),
    )


def _scan_to_row(
    s: Scan,
    container_no: str,
    line_sku: str | None,
    box_number: int | None = None,
) -> ScanRow:
    return ScanRow(
        id=s.id,
        container_no=container_no,
        sku=line_sku,
        qty=1,
        serial_number=s.serial_number,
        imei=s.imei,
        box_number=box_number,
        scanned_by=s.scanned_by,
        notes=s.row_notes,
        scanned_at=s.scanned_at,
    )


def _box_for_index(index_zero_based: int) -> int:
    """Box number = scan index // 10 + 1. So first 10 = box 1, next 10 = box 2…"""
    return (index_zero_based // 10) + 1


async def _load_receipt_context(
    session: AsyncSession, receipt_id: int
) -> tuple[Receipt, Container, WHPO, DO]:
    """Pull the Receipt + the joined Container/DO/WHPO chain we need to
    render the sheet header. 404 if the receipt doesn't exist."""
    stmt = (
        select(Receipt)
        .where(Receipt.id == receipt_id)
        .options(
            selectinload(Receipt.container)
            .selectinload(Container.do)
            .selectinload(DO.whpo)
            .selectinload(WHPO.customer),
            selectinload(Receipt.container).selectinload(Container.lines),
        )
    )
    receipt = await session.scalar(stmt)
    if receipt is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Receipt {receipt_id} not found.",
        )
    container = receipt.container
    do = container.do
    whpo = do.whpo
    return receipt, container, whpo, do


# ─── Endpoints ──────────────────────────────────────────────────────────


@router.post("/open", response_model=OpenSheetResponse)
async def open_sheet(
    body: OpenSheetRequest,
    operator: str = "unknown",
    session: AsyncSession = Depends(get_session),
):
    """Open (or re-open) the scan sheet for a container.

    Looks up the container by ISO-6346 number, creates a Receipt if one
    doesn't exist yet for this operator's session, and returns the header
    block + any existing scan rows. Idempotent — re-opening loads the
    in-progress receipt rather than creating a duplicate.

    `operator` is taken from a query param for now (the existing operator
    flow stores it in the request body; we mirror that here without an
    auth dependency). When operator JWTs land this becomes a Depends().
    """
    _ensure_enabled()
    container_no = body.container_no.strip().upper()

    container = await session.scalar(
        select(Container)
        .where(Container.container_no == container_no)
        .options(
            selectinload(Container.do)
            .selectinload(DO.whpo)
            .selectinload(WHPO.customer),
            selectinload(Container.lines).selectinload(ContainerLine.sku),
        )
    )
    if container is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Container {container_no} isn't on any open shipment yet.",
        )

    # Reuse an in-progress receipt if one exists; otherwise create.
    receipt = await session.scalar(
        select(Receipt)
        .where(Receipt.container_id == container.id)
        .where(Receipt.status == "in_progress")
        .order_by(Receipt.started_at.desc())
    )
    if receipt is None:
        receipt = Receipt(
            container_id=container.id,
            status="in_progress",
            started_by=operator,
        )
        session.add(receipt)
        await session.flush()       # populate receipt.id and started_at

    # Load any existing scans on this receipt (re-open case).
    existing = await session.scalars(
        select(Scan)
        .where(Scan.receipt_id == receipt.id)
        .where(Scan.serial_number.isnot(None))
        .order_by(Scan.scanned_at.asc())
    )
    rows: list[ScanRow] = []
    # Map sku_id → sku string for display. Most receipts have a single
    # ContainerLine; lookup-per-scan is fine at this volume.
    sku_by_id: dict[int, str] = {}
    for line in container.lines:
        if line.sku is not None:
            sku_by_id[line.sku_id] = line.sku.sku if line.sku else None  # noqa
    # Fallback if relationship not loaded — fetch SKUs lazily by id
    is_scooter = _container_requires_imei(container)
    for idx, s in enumerate(existing.all()):
        box = _box_for_index(idx) if is_scooter else None
        rows.append(_scan_to_row(s, container.container_no, None, box))

    await session.commit()

    header = _build_header(receipt, container, container.do.whpo, container.do)
    return OpenSheetResponse(header=header, rows=rows)


@router.post("/{receipt_id}/scan", response_model=RecordScanResponse)
async def record_scan_row(
    receipt_id: int,
    body: RecordScanRequest,
    operator: str = "unknown",
    session: AsyncSession = Depends(get_session),
):
    """Append a single scan row. Returns the persisted row OR a dup error
    pointing at the existing row. Frontend uses the dup info to flash the
    row red without throwing the operator's session away."""
    _ensure_enabled()
    receipt, container, _, _ = await _load_receipt_context(session, receipt_id)
    if receipt.status != "in_progress":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This receipt is finished — no more scans accepted.",
        )

    serial = body.serial_number.strip()
    imei = (body.imei or "").strip() or None

    # IMEI required for scooter containers — enforced server-side too so a
    # rogue client can't bypass the rule.
    if _container_requires_imei(container) and not imei:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="IMEI is required for scooter SKUs.",
        )

    # Pre-check for in-receipt duplicate so we can return a helpful row id
    # instead of relying on the IntegrityError path (which gives less info).
    dup = await session.scalar(
        select(Scan)
        .where(Scan.receipt_id == receipt_id)
        .where(Scan.serial_number == serial)
    )
    if dup is not None:
        return RecordScanResponse(
            accepted=False,
            duplicate_of_row_id=dup.id,
            error=f"Serial {serial} was already scanned in this container.",
            total_scanned=await _count_scans(session, receipt_id),
        )

    scan = Scan(
        receipt_id=receipt_id,
        container_id=container.id,
        item_barcode=serial,            # keep filled for cross-table consistency
        serial_number=serial,
        imei=imei,
        row_notes=body.notes,
        scanned_by=operator,
        result="ok",
    )
    session.add(scan)
    try:
        await session.flush()
    except IntegrityError:
        # Race condition: two scans of the same serial landed simultaneously.
        # The partial unique index catches it; respond same as the pre-check.
        await session.rollback()
        receipt, container, _, _ = await _load_receipt_context(session, receipt_id)
        dup = await session.scalar(
            select(Scan)
            .where(Scan.receipt_id == receipt_id)
            .where(Scan.serial_number == serial)
        )
        return RecordScanResponse(
            accepted=False,
            duplicate_of_row_id=dup.id if dup else None,
            error=f"Serial {serial} was already scanned (race condition).",
            total_scanned=await _count_scans(session, receipt_id),
        )

    await session.commit()
    total = await _count_scans(session, receipt_id)
    is_scooter = _container_requires_imei(container)
    # This new scan is at zero-based index (total - 1)
    box = _box_for_index(total - 1) if is_scooter else None
    row = _scan_to_row(scan, container.container_no, body.sku, box)

    # Fire-and-forget: push the full updated sheet to OneDrive so the
    # manager's workbook reflects each scan as it happens. We don't await —
    # OneDrive latency must NOT slow the operator's scan loop.
    try:
        import asyncio
        from app.services import scan_sheet_onedrive

        if scan_sheet_onedrive.is_configured():
            asyncio.create_task(_push_live_to_onedrive(receipt_id))
    except Exception as e:
        logger.warning("scan-sheet live OneDrive task spawn failed: %s", e)

    return RecordScanResponse(
        accepted=True,
        row=row,
        total_scanned=total,
    )


async def _push_live_to_onedrive(receipt_id: int) -> None:
    """Best-effort live push: opens its own DB session, builds the detail,
    POSTs to the Logic App. Never raises — errors are logged."""
    from app.db import SessionLocal
    from app.services import scan_sheet_onedrive

    try:
        async with SessionLocal() as s:
            r, c, w, d = await _load_receipt_context(s, receipt_id)
            rows_q = await s.scalars(
                select(Scan)
                .where(Scan.receipt_id == receipt_id)
                .where(Scan.serial_number.isnot(None))
                .order_by(Scan.scanned_at.asc())
            )
            is_scooter = _container_requires_imei(c)
            rows = [
                _scan_to_row(
                    scan, c.container_no, None,
                    _box_for_index(idx) if is_scooter else None,
                )
                for idx, scan in enumerate(rows_q.all())
            ]
            detail = AuditSheetDetail(
                header=_build_header(r, c, w, d),
                rows=rows,
            )
            await scan_sheet_onedrive.push_scan_sheet(detail)
    except Exception as e:
        logger.warning("live OneDrive push failed for receipt %s: %s", receipt_id, e)


@router.post("/{receipt_id}/finish", response_model=FinishSheetResponse)
async def finish_sheet(
    receipt_id: int,
    operator: str = "unknown",
    session: AsyncSession = Depends(get_session),
):
    """Lock the receipt. After this the sheet is read-only and downloadable
    as Excel."""
    _ensure_enabled()
    receipt, container, _, _ = await _load_receipt_context(session, receipt_id)
    if receipt.status == "completed":
        # Idempotent — return the existing finished state.
        return FinishSheetResponse(
            receipt_id=receipt.id,
            container_no=container.container_no,
            total_scanned=await _count_scans(session, receipt_id),
            finished_at=receipt.finished_at or receipt.started_at,
            download_url=f"/operator/sheet/{receipt.id}/export.xlsx",
        )
    receipt.status = "completed"
    receipt.finished_at = datetime.now(timezone.utc)
    receipt.finished_by = operator
    await session.commit()

    # Best-effort: push the finished receipt to OneDrive as a new sheet.
    # Errors are swallowed; the operator's finish flow never blocks on this.
    try:
        from app.services import scan_sheet_onedrive

        rows_q = await session.scalars(
            select(Scan)
            .where(Scan.receipt_id == receipt_id)
            .where(Scan.serial_number.isnot(None))
            .order_by(Scan.scanned_at.asc())
        )
        receipt, container, whpo, do = await _load_receipt_context(session, receipt_id)
        is_scooter_f = _container_requires_imei(container)
        rows = [
            _scan_to_row(
                s, container.container_no, None,
                _box_for_index(idx) if is_scooter_f else None,
            )
            for idx, s in enumerate(rows_q.all())
        ]
        detail = AuditSheetDetail(
            header=_build_header(receipt, container, whpo, do),
            rows=rows,
        )
        await scan_sheet_onedrive.push_scan_sheet(detail)
    except Exception as e:
        logger.warning("scan-sheet OneDrive push errored on finish: %s", e)

    return FinishSheetResponse(
        receipt_id=receipt.id,
        container_no=container.container_no,
        total_scanned=await _count_scans(session, receipt_id),
        finished_at=receipt.finished_at,
        download_url=f"/operator/sheet/{receipt.id}/export.xlsx",
    )


@router.get("/{receipt_id}", response_model=OpenSheetResponse)
async def view_sheet(receipt_id: int, session: AsyncSession = Depends(get_session)):
    """Read-only view of an already-open sheet — used by the operator's
    live grid for polling and by the audit detail page."""
    _ensure_enabled()
    receipt, container, whpo, do = await _load_receipt_context(session, receipt_id)
    rows_q = await session.scalars(
        select(Scan)
        .where(Scan.receipt_id == receipt_id)
        .where(Scan.serial_number.isnot(None))
        .order_by(Scan.scanned_at.asc())
    )
    is_scooter_v = _container_requires_imei(container)
    rows = [
        _scan_to_row(
            s, container.container_no, None,
            _box_for_index(idx) if is_scooter_v else None,
        )
        for idx, s in enumerate(rows_q.all())
    ]
    return OpenSheetResponse(
        header=_build_header(receipt, container, whpo, do),
        rows=rows,
    )


# ─── Internal helpers ───────────────────────────────────────────────────


async def _count_scans(session: AsyncSession, receipt_id: int) -> int:
    """Count scan-sheet rows on this receipt (serial_number IS NOT NULL).
    Legacy scans (NULL serial) excluded."""
    from sqlalchemy import func as sa_func

    return await session.scalar(
        select(sa_func.count())
        .select_from(Scan)
        .where(Scan.receipt_id == receipt_id)
        .where(Scan.serial_number.isnot(None))
    ) or 0
