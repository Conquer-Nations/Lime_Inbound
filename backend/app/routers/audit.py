"""Auditor endpoints — read-only sheet listing + Excel export.

Mounted at /audit/*. Gated by:
  1. `SCAN_SHEETS_ENABLED` feature flag (503 when off).
  2. `current_auditor_required` — JWT email must be in
     `settings.auditor_emails` (403 otherwise).

Auditor can:
  - GET /audit/sheets?year=&month=&container_no=&whpo_number=
  - GET /audit/sheets/{id}
  - GET /audit/sheets/{id}/export.xlsx       (one container, TEMPLATE clone)
  - GET /audit/sheets/export.xlsx?<filters>  (bulk — one sheet per container)
"""

from __future__ import annotations

import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import func as sa_func
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import settings
from app.db import get_session
from app.models import DO, WHPO, Container, Receipt, Scan
from app.routers.scan_sheet import _build_header, _scan_to_row
from app.schemas.scan_sheet import (
    AuditSheetDetail,
    AuditSheetListItem,
    AuditSheetListResponse,
)
from app.services.scan_sheet_export import (
    build_single_container_workbook,
    build_bulk_workbook,
)
from app.services.vendor_auth_service import current_auditor_required

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/audit", tags=["audit"])


def _ensure_enabled() -> None:
    if not settings.scan_sheets_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Scan-sheet feature is not enabled on this environment.",
        )


# ─── Filter resolution ──────────────────────────────────────────────────


def _apply_filters(
    stmt,
    *,
    year: int | None,
    month: int | None,
    container_no: str | None,
    whpo_number: str | None,
):
    """Apply optional filters to a Receipt query. Combined with AND."""
    if year is not None:
        stmt = stmt.where(sa_func.extract("year", Receipt.started_at) == year)
    if month is not None:
        stmt = stmt.where(sa_func.extract("month", Receipt.started_at) == month)
    if container_no:
        stmt = stmt.where(Container.container_no.ilike(f"%{container_no.strip()}%"))
    if whpo_number:
        stmt = stmt.where(WHPO.whpo_number.ilike(f"%{whpo_number.strip()}%"))
    return stmt


# ─── List + detail ──────────────────────────────────────────────────────


@router.get("/sheets", response_model=AuditSheetListResponse)
async def list_sheets(
    year: int | None = Query(default=None, ge=2024, le=2100),
    month: int | None = Query(default=None, ge=1, le=12),
    container_no: str | None = Query(default=None),
    whpo_number: str | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
    _: dict = Depends(current_auditor_required),
):
    _ensure_enabled()
    stmt = (
        select(Receipt)
        .join(Container, Receipt.container_id == Container.id)
        .join(DO, Container.do_id == DO.id)
        .join(WHPO, DO.whpo_id == WHPO.id)
        .options(
            selectinload(Receipt.container)
            .selectinload(Container.do)
            .selectinload(DO.whpo)
            .selectinload(WHPO.customer)
        )
        .order_by(Receipt.started_at.desc())
    )
    stmt = _apply_filters(
        stmt,
        year=year,
        month=month,
        container_no=container_no,
        whpo_number=whpo_number,
    )
    receipts = (await session.scalars(stmt)).all()

    # Single COUNT query per receipt is fine at expected volume (10s/day);
    # batch if this ever gets slow.
    items: list[AuditSheetListItem] = []
    for r in receipts:
        c = r.container
        whpo = c.do.whpo
        count = await session.scalar(
            select(sa_func.count())
            .select_from(Scan)
            .where(Scan.receipt_id == r.id)
            .where(Scan.serial_number.isnot(None))
        ) or 0
        items.append(
            AuditSheetListItem(
                receipt_id=r.id,
                container_no=c.container_no,
                whpo_number=whpo.whpo_number,
                customer_name=whpo.customer.name if whpo.customer else "",
                received_date=r.started_at.date(),
                scan_count=int(count),
                status=r.status,
                finished_at=r.finished_at,
            )
        )

    return AuditSheetListResponse(sheets=items, total=len(items))


@router.get("/sheets/{receipt_id}", response_model=AuditSheetDetail)
async def get_sheet(
    receipt_id: int,
    session: AsyncSession = Depends(get_session),
    _: dict = Depends(current_auditor_required),
):
    _ensure_enabled()
    receipt = await session.scalar(
        select(Receipt)
        .where(Receipt.id == receipt_id)
        .options(
            selectinload(Receipt.container)
            .selectinload(Container.do)
            .selectinload(DO.whpo)
            .selectinload(WHPO.customer)
        )
    )
    if receipt is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Receipt {receipt_id} not found.",
        )
    container = receipt.container
    do = container.do
    whpo = do.whpo
    rows_q = await session.scalars(
        select(Scan)
        .where(Scan.receipt_id == receipt_id)
        .where(Scan.serial_number.isnot(None))
        .order_by(Scan.scanned_at.asc())
    )
    rows = [_scan_to_row(s, container.container_no, None) for s in rows_q.all()]
    return AuditSheetDetail(
        header=_build_header(receipt, container, whpo, do),
        rows=rows,
    )


# ─── Excel exports ──────────────────────────────────────────────────────


@router.get("/sheets/{receipt_id}/export.xlsx")
async def export_single(
    receipt_id: int,
    session: AsyncSession = Depends(get_session),
    _: dict = Depends(current_auditor_required),
):
    """Download one container's sheet as a TEMPLATE.xlsx clone."""
    _ensure_enabled()
    detail = await get_sheet(receipt_id, session=session, _=_)
    buf = build_single_container_workbook(detail)
    fname = f"{detail.header.container_no}_{detail.header.received_date.isoformat()}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.get("/sheets/export.xlsx")
async def export_bulk(
    year: int | None = Query(default=None, ge=2024, le=2100),
    month: int | None = Query(default=None, ge=1, le=12),
    container_no: str | None = Query(default=None),
    whpo_number: str | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
    _: dict = Depends(current_auditor_required),
):
    """Download a workbook with one sheet per matching container.
    Sheet names = container_no (truncated to Excel's 31-char limit)."""
    _ensure_enabled()
    listing = await list_sheets(
        year=year,
        month=month,
        container_no=container_no,
        whpo_number=whpo_number,
        session=session,
        _=_,
    )
    if not listing.sheets:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No sheets matched these filters.",
        )

    details: list[AuditSheetDetail] = []
    for item in listing.sheets:
        details.append(await get_sheet(item.receipt_id, session=session, _=_))

    buf = build_bulk_workbook(details)
    parts: list[str] = []
    if year:
        parts.append(str(year))
    if month:
        parts.append(f"{month:02d}")
    if container_no:
        parts.append(container_no)
    if whpo_number:
        parts.append(whpo_number)
    stamp = "-".join(parts) if parts else datetime.utcnow().strftime("%Y%m%d")
    fname = f"scan_sheets_{stamp}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )
