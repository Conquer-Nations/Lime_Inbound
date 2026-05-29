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
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import settings
from app.db import get_session
from app.models import (
    DO,
    WHPO,
    Container,
    ContainerLine,
    Customer,
    OutboundContainer,
    OutboundLine,
    OutboundOrder,
    OutboundScan,
    Receipt,
    Scan,
    TallySheet,
)
from app.schemas.scan_sheet import (  # noqa: E501 — keep imports tidy
    OutboundLineProgress,
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


def _line_product_type(line) -> str:
    """Resolve product type for a single line. Line-level value wins; if
    the vendor didn't fill it in, fall back to the SKU master's
    product_type so the IMEI / box-number heuristics still fire."""
    pt = (line.product_type or "").strip()
    if pt:
        return pt.lower()
    if line.sku is not None and getattr(line.sku, "product_type", None):
        return (line.sku.product_type or "").strip().lower()
    return ""


def _container_requires_imei(container: Container) -> bool:
    """IMEI capture is required for eBikes and Gliders (NOT scooters).
    Case-insensitive substring match on product_type: anything containing
    'bike' or 'glider' qualifies; everything else (scooters, batteries,
    helmets, solar panels, …) skips the IMEI input.

    Falls back to the SKU master's product_type when the line doesn't
    declare one — so feeding master data via the manager admin UI is
    enough to enable IMEI capture without re-submitting old WHPOs."""
    for line in (container.lines or []):
        pt = _line_product_type(line)
        if "bike" in pt or "glider" in pt:
            return True
    return False


def _container_uses_box_numbers(container: Container) -> bool:
    """Scooters are packed 10 per box at our dock — the scan-sheet shows
    a 'Box #' column that auto-increments every 10 scans. Other product
    types ship without box hierarchy."""
    for line in (container.lines or []):
        pt = _line_product_type(line)
        if "scoot" in pt:
            return True
    return False


def _container_sku(container: Container) -> str | None:
    """Pick the SKU to display on every scan row for this container. Uses the
    matched SKU.sku if available, else the raw vendor-provided string from
    the first ContainerLine. Returns None if the container has no lines."""
    for line in (container.lines or []):
        if line.sku is not None and line.sku.sku:
            return line.sku.sku
        if line.sku_raw:
            return line.sku_raw
    return None


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
        uses_box_numbers=_container_uses_box_numbers(container),
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
    """Pull the INBOUND Receipt + the joined Container/DO/WHPO chain we
    need to render the sheet header. 404 if the receipt doesn't exist
    or is an outbound receipt (caller should use the outbound loader
    instead). Backward-compatible signature."""
    stmt = (
        select(Receipt)
        .where(Receipt.id == receipt_id)
        .options(
            selectinload(Receipt.container)
            .selectinload(Container.do)
            .selectinload(DO.whpo)
            .selectinload(WHPO.customer),
            selectinload(Receipt.container)
            .selectinload(Container.lines)
            .selectinload(ContainerLine.sku),
        )
    )
    receipt = await session.scalar(stmt)
    if receipt is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Receipt {receipt_id} not found.",
        )
    if receipt.kind != "inbound" or receipt.container is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Receipt {receipt_id} is not an inbound receipt.",
        )
    container = receipt.container
    do = container.do
    whpo = do.whpo
    return receipt, container, whpo, do


async def _load_outbound_receipt_context(
    session: AsyncSession, receipt_id: int
) -> tuple[Receipt, OutboundContainer, OutboundOrder]:
    """Pull an outbound Receipt + its OutboundContainer + parent
    OutboundOrder + customer. 404 if missing or wrong kind."""
    stmt = (
        select(Receipt)
        .where(Receipt.id == receipt_id)
        .options(
            selectinload(Receipt.outbound_container)
            .selectinload(OutboundContainer.order)
            .selectinload(OutboundOrder.customer),
            selectinload(Receipt.outbound_container)
            .selectinload(OutboundContainer.order)
            .selectinload(OutboundOrder.lines)
            .selectinload(OutboundLine.sku),
        )
    )
    receipt = await session.scalar(stmt)
    if receipt is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Receipt {receipt_id} not found.",
        )
    if receipt.kind != "outbound" or receipt.outbound_container is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Receipt {receipt_id} is not an outbound receipt.",
        )
    oc = receipt.outbound_container
    if oc.order is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Container {oc.container_no} is not attached to a Transfer "
                "Order yet — vendor must attach driver / truck info first."
            ),
        )
    return receipt, oc, oc.order


def _outbound_header(
    receipt: Receipt, oc: OutboundContainer, order: OutboundOrder
) -> ScanSheetHeader:
    """Build a ScanSheetHeader for the outbound flow. Reuses the inbound
    shape — whpo_number = transfer_order_no, do_number = po_number — so
    the existing operator UI renders without changes."""
    return ScanSheetHeader(
        receipt_id=receipt.id,
        container_no=oc.container_no,
        whpo_number=order.transfer_order_no,
        do_number=order.po_number or "",
        customer_name=order.customer.name if order.customer else "",
        bol_number=oc.bol_number,
        received_date=receipt.started_at.date(),
        start_timestamp=receipt.started_at,
        completed_timestamp=receipt.finished_at,
        is_completed=receipt.status == "completed",
        requires_imei=False,
        kind="outbound",
    )


async def _outbound_rows(
    session: AsyncSession, receipt: Receipt, oc: OutboundContainer
) -> list[ScanRow]:
    """Materialise existing OutboundScan rows for this loading session
    into ScanRow form so the operator UI can render them just like
    inbound rows. SKU comes from the linked OutboundLine.sku_raw."""
    out_scans_q = await session.scalars(
        select(OutboundScan)
        .where(OutboundScan.outbound_container_id == oc.id)
        .order_by(OutboundScan.scanned_at.asc())
    )
    out_scans = list(out_scans_q.all())

    # Resolve sku per scan via outbound_line_id → OutboundLine.sku_raw
    line_ids = sorted({s.outbound_line_id for s in out_scans if s.outbound_line_id})
    sku_by_line: dict[int, str] = {}
    if line_ids:
        lines_q = await session.scalars(
            select(OutboundLine).where(OutboundLine.id.in_(line_ids))
        )
        for ln in lines_q.all():
            sku_by_line[ln.id] = ln.sku_raw or ""

    rows: list[ScanRow] = []
    for s in out_scans:
        rows.append(
            ScanRow(
                id=s.id,
                container_no=oc.container_no,
                sku=sku_by_line.get(s.outbound_line_id) if s.outbound_line_id else None,
                qty=1,
                serial_number=s.serial_number,
                imei=s.imei,
                box_number=None,
                scanned_by=s.scanned_by or "",
                notes=s.notes,
                scanned_at=s.scanned_at,
            )
        )
    return rows


async def _outbound_progress(
    session: AsyncSession, oc: OutboundContainer
) -> list[OutboundLineProgress]:
    """Per-line scan progress for the outbound operator UI panel. One
    entry per OutboundLine on the TO, sorted by line_no, with the live
    scanned count for each line."""
    if oc.outbound_order_id is None:
        return []
    lines_q = await session.scalars(
        select(OutboundLine)
        .where(OutboundLine.outbound_order_id == oc.outbound_order_id)
        .order_by(OutboundLine.line_no, OutboundLine.id)
    )
    lines = list(lines_q.all())
    if not lines:
        return []
    counts_q = await session.execute(
        select(OutboundScan.outbound_line_id, func.count())
        .where(OutboundScan.outbound_line_id.in_([ln.id for ln in lines]))
        .where(OutboundScan.outbound_container_id == oc.id)
        .group_by(OutboundScan.outbound_line_id)
    )
    counts = {row[0]: row[1] for row in counts_q.all()}
    return [
        OutboundLineProgress(
            line_id=ln.id,
            line_no=ln.line_no,
            sku_raw=ln.sku_raw or "",
            description=ln.description,
            order_qty=ln.order_qty,
            scanned_qty=counts.get(ln.id, 0),
            source_container_no=ln.source_container_no,
        )
        for ln in lines
    ]


async def _open_outbound_sheet(
    session: AsyncSession,
    oc: OutboundContainer,
    operator: str,
) -> OpenSheetResponse:
    """Open (or re-open) an outbound scan-out session for a truck/container
    being loaded. Re-uses Receipt with kind='outbound'."""
    if oc.outbound_order_id is None or oc.order is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Container {oc.container_no} is not attached to a Transfer "
                "Order yet — vendor must add Driver & truck info first."
            ),
        )

    # Reuse an in-progress receipt for this OutboundContainer if one exists.
    receipt = await session.scalar(
        select(Receipt)
        .where(Receipt.outbound_container_id == oc.id)
        .where(Receipt.status == "in_progress")
        .order_by(Receipt.started_at.desc())
    )
    if receipt is None:
        receipt = Receipt(
            kind="outbound",
            outbound_container_id=oc.id,
            container_id=None,
            status="in_progress",
            started_by=operator,
        )
        session.add(receipt)
        await session.flush()
    # First time the operator opens the sheet, flip the container to
    # 'loading' so the dashboard reflects state.
    if oc.status in ("open", "attached"):
        oc.status = "loading"
        if oc.started_at is None:
            oc.started_at = datetime.now(timezone.utc)
        if not oc.started_by:
            oc.started_by = operator

    rows = await _outbound_rows(session, receipt, oc)
    progress = await _outbound_progress(session, oc)
    await session.commit()

    header = _outbound_header(receipt, oc, oc.order)
    return OpenSheetResponse(header=header, rows=rows, outbound_progress=progress)


async def _record_outbound_scan(
    session: AsyncSession,
    receipt_id: int,
    body: RecordScanRequest,
    operator: str,
) -> RecordScanResponse:
    """Outbound scan path. Each scanned serial must:
      1. Already exist as an inbound Scan for THIS vendor's company
      2. Not have been previously shipped (no existing OutboundScan
         pointing at that inbound Scan)
      3. Match a SKU on one of the Transfer Order's lines
    On success we create an OutboundScan linking the truck, the TO line,
    and the inbound Scan being shipped out."""
    receipt, oc, order = await _load_outbound_receipt_context(session, receipt_id)
    if receipt.status != "in_progress":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This loading session is finished — no more scans accepted.",
        )

    serial = body.serial_number.strip()

    # Reject same-container dup early with a helpful row id.
    dup = await session.scalar(
        select(OutboundScan)
        .where(OutboundScan.outbound_container_id == oc.id)
        .where(OutboundScan.serial_number == serial)
    )
    if dup is not None:
        return RecordScanResponse(
            accepted=False,
            duplicate_of_row_id=dup.id,
            error=f"Serial {serial} was already loaded onto this truck.",
            total_scanned=await _count_outbound_scans(session, oc.id),
        )

    # Find the matching inbound Scan, scoped to this vendor's company.
    company_name = order.customer.name if order.customer else ""
    inbound_scan = await session.scalar(
        select(Scan)
        .join(Container, Scan.container_id == Container.id)
        .join(DO, Container.do_id == DO.id)
        .join(WHPO, DO.whpo_id == WHPO.id)
        .join(Customer, WHPO.customer_id == Customer.id)
        .where(Scan.serial_number == serial)
        .where(func.lower(Customer.name) == (company_name or "").strip().lower())
        .options(
            selectinload(Scan.container).selectinload(Container.lines)
        )
        .order_by(Scan.scanned_at.asc())
        .limit(1)
    )
    if inbound_scan is None:
        return RecordScanResponse(
            accepted=False,
            error=(
                f"Serial {serial} isn't on file for {company_name}. "
                "Make sure the unit came in through inbound."
            ),
            total_scanned=await _count_outbound_scans(session, oc.id),
        )

    # Already shipped on another TO?
    already_shipped = await session.scalar(
        select(OutboundScan.id).where(OutboundScan.inbound_scan_id == inbound_scan.id)
    )
    if already_shipped is not None:
        return RecordScanResponse(
            accepted=False,
            error=f"Serial {serial} was already shipped out previously.",
            total_scanned=await _count_outbound_scans(session, oc.id),
        )

    # Resolve SKU of this unit (from the inbound container's lines).
    inbound_sku = ""
    if inbound_scan.container and inbound_scan.container.lines:
        inbound_sku = inbound_scan.container.lines[0].sku_raw or ""

    # Pick the matching outbound line by sku_raw. Prefer the line with
    # the most remaining capacity (order_qty - already-scanned-on-line).
    candidate_lines = [
        ln for ln in (order.lines or []) if (ln.sku_raw or "") == inbound_sku
    ]
    if not candidate_lines:
        return RecordScanResponse(
            accepted=False,
            error=(
                f"Serial {serial} is SKU '{inbound_sku}' — there's no matching "
                f"line on TO {order.transfer_order_no}."
            ),
            total_scanned=await _count_outbound_scans(session, oc.id),
        )

    counts_q = await session.execute(
        select(OutboundScan.outbound_line_id, func.count())
        .where(OutboundScan.outbound_line_id.in_([l.id for l in candidate_lines]))
        .group_by(OutboundScan.outbound_line_id)
    )
    scanned_per_line = {row[0]: row[1] for row in counts_q.all()}

    target_line = None
    for ln in candidate_lines:
        scanned = scanned_per_line.get(ln.id, 0)
        if scanned < ln.order_qty:
            target_line = ln
            break
    if target_line is None:
        return RecordScanResponse(
            accepted=False,
            error=(
                f"All {sum(l.order_qty for l in candidate_lines)} units of "
                f"SKU '{inbound_sku}' on TO {order.transfer_order_no} are "
                "already scanned. Refusing to over-ship."
            ),
            total_scanned=await _count_outbound_scans(session, oc.id),
        )

    out_scan = OutboundScan(
        outbound_container_id=oc.id,
        outbound_line_id=target_line.id,
        inbound_scan_id=inbound_scan.id,
        sku_id=target_line.sku_id,
        serial_number=serial,
        imei=inbound_scan.imei,
        scanned_by=operator,
        notes=body.notes,
    )
    session.add(out_scan)
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        return RecordScanResponse(
            accepted=False,
            error=f"Serial {serial} hit a race condition — try again.",
            total_scanned=await _count_outbound_scans(session, oc.id),
        )
    await session.commit()

    total = await _count_outbound_scans(session, oc.id)
    row = ScanRow(
        id=out_scan.id,
        container_no=oc.container_no,
        sku=inbound_sku or None,
        qty=1,
        serial_number=out_scan.serial_number,
        imei=out_scan.imei,
        box_number=None,
        scanned_by=out_scan.scanned_by or "",
        notes=out_scan.notes,
        scanned_at=out_scan.scanned_at,
    )
    # Refresh per-LPN progress for the operator UI panel. Computed here
    # so the frontend doesn't need a separate refetch round-trip after
    # every accepted scan.
    progress = await _outbound_progress(session, oc)
    return RecordScanResponse(
        accepted=True,
        row=row,
        total_scanned=total,
        outbound_progress=progress,
    )


async def _count_outbound_scans(session: AsyncSession, outbound_container_id: int) -> int:
    n = await session.scalar(
        select(func.count())
        .select_from(OutboundScan)
        .where(OutboundScan.outbound_container_id == outbound_container_id)
    )
    return int(n or 0)


async def _finish_outbound_sheet(
    session: AsyncSession, receipt_id: int, operator: str
) -> FinishSheetResponse:
    """Outbound finish: mark Receipt completed + OutboundContainer sealed,
    push to OneDrive (Lime Outbound Scan Data.xlsx)."""
    receipt, oc, order = await _load_outbound_receipt_context(session, receipt_id)
    total = await _count_outbound_scans(session, oc.id)
    if receipt.status == "completed":
        return FinishSheetResponse(
            receipt_id=receipt.id,
            container_no=oc.container_no,
            total_scanned=total,
            finished_at=receipt.finished_at or receipt.started_at,
            download_url=f"/operator/sheet/{receipt.id}/export.xlsx",
        )
    now = datetime.now(timezone.utc)
    receipt.status = "completed"
    receipt.finished_at = now
    receipt.finished_by = operator
    oc.status = "sealed"
    if oc.sealed_at is None:
        oc.sealed_at = now
    if not oc.sealed_by:
        oc.sealed_by = operator
    await session.commit()

    # OneDrive push — best effort.
    try:
        from app.services import outbound_scan_sheet_onedrive

        rows = await _outbound_rows_for_export(session, oc)
        await outbound_scan_sheet_onedrive.push_outbound_scan_sheet(
            container_no=oc.container_no,
            transfer_order_no=order.transfer_order_no,
            po_number=order.po_number,
            customer_name=order.customer.name if order.customer else "",
            bol_number=oc.bol_number,
            scheduled_arrival_at=(
                oc.scheduled_arrival_at.isoformat() if oc.scheduled_arrival_at else None
            ),
            sealed_at=oc.sealed_at.isoformat() if oc.sealed_at else None,
            rows=rows,
        )
    except Exception as e:
        logger.warning("outbound scan-sheet OneDrive push errored on finish: %s", e)

    # Mirror the master sheet — outbound scans on this container changed
    # units_out / pallets_out / to_no for the rows in the master view
    # that reference the inbound containers whose serials shipped here.
    try:
        from app.services import master_sheet_sync
        await master_sheet_sync.push_full_replace(session)
    except Exception as e:
        logger.warning("master sheet sync errored on outbound finish: %s", e)

    return FinishSheetResponse(
        receipt_id=receipt.id,
        container_no=oc.container_no,
        total_scanned=total,
        finished_at=receipt.finished_at,
        download_url=f"/operator/sheet/{receipt.id}/export.xlsx",
    )


async def _outbound_rows_for_export(
    session: AsyncSession, oc: OutboundContainer
) -> list[dict]:
    """Build the row payload that outbound_scan_sheet_onedrive expects.
    One dict per scan: sku, serial_number, imei, inbound_container_no,
    scanned_at, scanned_by, notes."""
    scans_q = await session.scalars(
        select(OutboundScan)
        .where(OutboundScan.outbound_container_id == oc.id)
        .options(
            selectinload(OutboundScan.inbound_scan).selectinload(Scan.container)
        )
        .order_by(OutboundScan.scanned_at.asc())
    )
    scans = list(scans_q.all())

    # Per-line SKU lookup so each row shows the OutboundLine's SKU.
    line_ids = sorted({s.outbound_line_id for s in scans if s.outbound_line_id})
    sku_by_line: dict[int, str] = {}
    if line_ids:
        lines_q = await session.scalars(
            select(OutboundLine).where(OutboundLine.id.in_(line_ids))
        )
        for ln in lines_q.all():
            sku_by_line[ln.id] = ln.sku_raw or ""

    rows: list[dict] = []
    for s in scans:
        inbound_container_no = ""
        if s.inbound_scan is not None and s.inbound_scan.container is not None:
            inbound_container_no = s.inbound_scan.container.container_no or ""
        rows.append(
            {
                "sku": sku_by_line.get(s.outbound_line_id) or "",
                "serial_number": s.serial_number or "",
                "imei": s.imei or "",
                "inbound_container_no": inbound_container_no,
                "scanned_at": s.scanned_at.isoformat() if s.scanned_at else "",
                "scanned_by": s.scanned_by or "",
                "notes": s.notes or "",
            }
        )
    return rows


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
    # If it's not an inbound container, try outbound — same operator UI
    # but the system auto-routes based on which table the container_no
    # lives in. Outbound containers are typically truck plates.
    if container is None:
        outbound_container = await session.scalar(
            select(OutboundContainer)
            .where(OutboundContainer.container_no == container_no)
            .options(
                selectinload(OutboundContainer.order)
                .selectinload(OutboundOrder.customer),
                selectinload(OutboundContainer.order)
                .selectinload(OutboundOrder.lines)
                .selectinload(OutboundLine.sku),
            )
        )
        if outbound_container is not None:
            return await _open_outbound_sheet(session, outbound_container, operator)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Container {container_no} isn't on any open shipment yet.",
        )

    # Tally guard — POD must be on file before the operator can scan.
    # Inbound only (outbound takes a different path above and was already
    # returned). The manager files the tally via /manager/tally/.../pod.
    tally_exists = await session.scalar(
        select(TallySheet.id).where(TallySheet.container_id == container.id)
    )
    if tally_exists is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": (
                    f"Container {container_no} has no tally on file. "
                    "Manager must upload the POD before offloading can start."
                ),
                "tally_required": True,
                "container_no": container_no,
            },
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
    is_scooter = _container_uses_box_numbers(container)
    sku_default = _container_sku(container)
    for idx, s in enumerate(existing.all()):
        box = _box_for_index(idx) if is_scooter else None
        rows.append(_scan_to_row(s, container.container_no, sku_default, box))

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
    row red without throwing the operator's session away.

    Auto-routes by Receipt.kind: inbound scans land in `scans`; outbound
    scans land in `outbound_scans` and link to the matching inbound Scan."""
    _ensure_enabled()
    # Quick peek at kind so we can route. Done as its own query to avoid
    # eager-loading the inbound-only joins on outbound receipts.
    receipt_kind = await session.scalar(
        select(Receipt.kind).where(Receipt.id == receipt_id)
    )
    if receipt_kind is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Receipt {receipt_id} not found.",
        )
    if receipt_kind == "outbound":
        return await _record_outbound_scan(session, receipt_id, body, operator)

    receipt, container, _, _ = await _load_receipt_context(session, receipt_id)
    if receipt.status != "in_progress":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This receipt is finished — no more scans accepted.",
        )

    serial = body.serial_number.strip()
    imei = (body.imei or "").strip() or None

    # IMEI required for eBike / Glider containers — enforced server-side
    # too so a rogue client can't bypass the rule.
    if _container_requires_imei(container) and not imei:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="IMEI is required for eBike and Glider SKUs.",
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
    is_scooter = _container_uses_box_numbers(container)
    # This new scan is at zero-based index (total - 1)
    box = _box_for_index(total - 1) if is_scooter else None
    # Prefer the vendor-provided SKU from container_lines over body.sku
    sku_default = _container_sku(container) or body.sku
    row = _scan_to_row(scan, container.container_no, sku_default, box)

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
            is_scooter = _container_uses_box_numbers(c)
            sku_default = _container_sku(c)
            rows = [
                _scan_to_row(
                    scan, c.container_no, sku_default,
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
    as Excel. Auto-routes by Receipt.kind."""
    _ensure_enabled()
    receipt_kind = await session.scalar(
        select(Receipt.kind).where(Receipt.id == receipt_id)
    )
    if receipt_kind is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Receipt {receipt_id} not found.",
        )
    if receipt_kind == "outbound":
        return await _finish_outbound_sheet(session, receipt_id, operator)

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
    now = datetime.now(timezone.utc)
    receipt.status = "completed"
    receipt.finished_at = now
    receipt.finished_by = operator
    # CRITICAL: also stamp the container itself. Without this, dashboards
    # + Inventory & Aging miss the container — both filter on
    # Container.status='received' / finished_at NOT NULL. Used to bypass
    # the proper finish_container() service and only updated the Receipt.
    container.status = "received"
    container.finished_at = now
    container.finished_by = operator
    if not container.actual_arrival_date:
        container.actual_arrival_date = now.date()
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
        is_scooter_f = _container_uses_box_numbers(container)
        sku_default_f = _container_sku(container)
        rows = [
            _scan_to_row(
                s, container.container_no, sku_default_f,
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

    # Mirror the master sheet (inbound + outbound view) to OneDrive.
    # Inbound finish changes units_in / pallets / scanned for this
    # container, which is one row in the master view.
    try:
        from app.services import master_sheet_sync
        await master_sheet_sync.push_full_replace(session)
    except Exception as e:
        logger.warning("master sheet sync errored on inbound finish: %s", e)

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
    live grid for polling and by the audit detail page. Auto-routes by
    Receipt.kind."""
    _ensure_enabled()
    receipt_kind = await session.scalar(
        select(Receipt.kind).where(Receipt.id == receipt_id)
    )
    if receipt_kind is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Receipt {receipt_id} not found.",
        )
    if receipt_kind == "outbound":
        receipt, oc, order = await _load_outbound_receipt_context(session, receipt_id)
        rows = await _outbound_rows(session, receipt, oc)
        progress = await _outbound_progress(session, oc)
        return OpenSheetResponse(
            header=_outbound_header(receipt, oc, order),
            rows=rows,
            outbound_progress=progress,
        )

    receipt, container, whpo, do = await _load_receipt_context(session, receipt_id)
    rows_q = await session.scalars(
        select(Scan)
        .where(Scan.receipt_id == receipt_id)
        .where(Scan.serial_number.isnot(None))
        .order_by(Scan.scanned_at.asc())
    )
    is_scooter_v = _container_uses_box_numbers(container)
    sku_default_v = _container_sku(container)
    rows = [
        _scan_to_row(
            s, container.container_no, sku_default_v,
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
