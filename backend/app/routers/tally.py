"""POD upload + Tally Sheet endpoints.

Three audiences:

  * **Manager / developer** (no auth gate — matches the rest of /manager/*):
    POST /manager/tally/{container_no}/pod  — upload POD photo, OCR + create row
    GET  /manager/tally-sheets              — list (filterable by status / date)
    GET  /manager/tally-sheets/{id}         — detail
    PATCH /manager/tally-sheets/{id}        — correct OCR misreads, flip billing

  * **Vendor** (current_vendor_required, scoped to their containers):
    GET /vendor/container/{container_no}/tally — read-only flow tracking

  * **Operator** (no new endpoint — see scan_sheet.py for the 409 guard).
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db import get_session
from app.models import DO, Container, Customer, TallySheet, WHPO
from app.schemas.tally import (
    TallySheetList,
    TallySheetRead,
    TallySheetUpdateRequest,
    VendorTallyView,
)
from app.services import tally_sheet_sync, vendor_uploads
from app.services.ocr import OCRUnavailableError
from app.services.pod_ocr import run_pod_ocr
from app.services.vendor_auth_service import current_vendor_required

logger = logging.getLogger(__name__)

ALLOWED_POD_CONTENT_TYPES = {
    "image/jpeg", "image/jpg", "image/png", "image/webp",
    "image/heic", "image/heif", "image/gif", "application/pdf",
}

MAX_POD_BYTES = 20 * 1024 * 1024  # 20 MB — PODs can be multi-page PDFs


# ─── Manager router ─────────────────────────────────────────────────────


router = APIRouter(prefix="/manager", tags=["manager-tally"])


def _to_read(t: TallySheet, container_no: str) -> TallySheetRead:
    return TallySheetRead(
        id=t.id,
        container_id=t.container_id,
        container_no=container_no,
        pod_filename=t.pod_filename,
        pod_content_type=t.pod_content_type,
        pod_file_size=t.pod_file_size,
        ocr_from_location=t.ocr_from_location,
        ocr_to_location=t.ocr_to_location,
        ocr_engine=t.ocr_engine,
        matched_driver_name=t.matched_driver_name,
        matched_driver_license=t.matched_driver_license,
        matched_driver_phone=t.matched_driver_phone,
        matched_carrier=t.matched_carrier,
        matched_truck_plate=t.matched_truck_plate,
        manual_seal_no=t.manual_seal_no,
        manual_chassis_no=t.manual_chassis_no,
        tallied_at=t.tallied_at,
        tallied_by=t.tallied_by,
        billing_status=t.billing_status,
        billing_notes=t.billing_notes,
        updated_at=t.updated_at,
    )


@router.post(
    "/tally/{container_no}/pod",
    response_model=TallySheetRead,
    status_code=status.HTTP_201_CREATED,
)
async def upload_pod(
    container_no: str,
    file: UploadFile = File(...),
    tallied_by: str = Form(..., description="Manager/dev who received the POD"),
    manual_seal_no: str | None = Form(None),
    manual_chassis_no: str | None = Form(None),
    session: AsyncSession = Depends(get_session),
) -> TallySheetRead:
    """Manager uploads the physical POD photo for an arriving container.
    Runs RapidOCR + the rule-based POD parser, snapshots driver/truck/
    carrier off the Container row, creates the tally."""
    # Look up container, eager-loading the brand (customer) so we can
    # pass it into the OneDrive sync without a second roundtrip.
    res = await session.execute(
        select(Container)
        .where(Container.container_no == container_no)
        .options(selectinload(Container.do).selectinload(DO.whpo).selectinload(WHPO.customer))
    )
    container = res.scalar_one_or_none()
    if container is None:
        raise HTTPException(404, f"Container {container_no} not found")

    # Block re-upload — one tally per container. Manager corrects misreads
    # via PATCH instead. Keeps billing audit-trail intact.
    existing = await session.execute(
        select(TallySheet).where(TallySheet.container_id == container.id)
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(
            409,
            f"Container {container_no} already has a tally sheet. "
            f"PATCH /manager/tally-sheets/{{id}} to correct.",
        )

    # Validate upload
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    if len(data) > MAX_POD_BYTES:
        raise HTTPException(413, f"POD too large (>{MAX_POD_BYTES // 1024 // 1024} MB)")
    content_type = (file.content_type or "").lower()
    if content_type not in ALLOWED_POD_CONTENT_TYPES:
        raise HTTPException(
            415,
            f"Unsupported content type {content_type!r}. "
            f"Allowed: {sorted(ALLOWED_POD_CONTENT_TYPES)}",
        )

    # Save to disk under containers/{id}/
    rel_path, _abs = vendor_uploads.save_bytes(
        container.id, "pod", data, file.filename or "pod", content_type
    )

    # Run OCR (best-effort — manager can fix later if it fails)
    ocr: dict[str, Any] = {}
    if content_type.startswith("image/") or content_type == "application/pdf":
        # Gemini handles both images AND PDFs (it accepts JPEG; we only
        # normalize images here, PDFs would need a separate page-extract
        # but for now we send what we have and let Gemini try).
        try:
            ocr = await run_pod_ocr(data)
        except OCRUnavailableError as e:
            logger.warning("POD OCR unavailable: %s", e)
            ocr = {"_debug": {"error": str(e)}}
    else:
        ocr = {"_debug": {"skipped": f"unsupported_content_type:{content_type}"}}

    # Helper to pull a string-or-null from the OCR dict.
    def _pick(k: str) -> str | None:
        v = ocr.get(k) if isinstance(ocr, dict) else None
        if v is None:
            return None
        s = str(v).strip()
        return s or None

    tally = TallySheet(
        container_id=container.id,
        pod_filename=file.filename or "pod",
        pod_content_type=content_type,
        pod_file_size=len(data),
        pod_storage_path=rel_path,
        ocr_from_location=_pick("from_location"),
        ocr_to_location=_pick("to_location"),
        ocr_extracted_json=ocr if ocr else None,
        ocr_engine=ocr.get("_engine") if isinstance(ocr, dict) else None,
        # Container row is the authoritative source for already-known
        # fields. OCR-extracted values get stored in ocr_extracted_json
        # for forensics; the dedicated `matched_*` columns snapshot the
        # container record at tally time. If a field is missing on the
        # container but Gemini picked it up from the POD/license, use
        # the OCR'd value as fallback so the tally isn't blank.
        matched_container_no=container.container_no,
        matched_driver_name=container.driver_name or _pick("driver_name"),
        matched_driver_license=container.driver_license or _pick("driver_license_no"),
        matched_driver_phone=container.driver_phone or _pick("driver_phone"),
        matched_carrier=container.carrier or _pick("carrier"),
        matched_truck_plate=container.truck_license_plate,
        # Manual-override fields: OCR populates them by default; manager
        # can correct via PATCH if Gemini misread. The form's optional
        # manual_seal_no / manual_chassis_no inputs override OCR.
        manual_seal_no=manual_seal_no or _pick("seal_no"),
        manual_chassis_no=manual_chassis_no or _pick("chassis_no"),
        tallied_by=tallied_by.strip(),
    )
    session.add(tally)
    await session.commit()
    await session.refresh(tally)

    # Sync to OneDrive Excel (best-effort — Postgres is source of truth).
    # The Logic App + Office Script append a row to TallyTable in the
    # `Lime Tally Sheets.xlsx` workbook for billing. Skipped silently
    # when ONEDRIVE_TALLY_WEBHOOK_URL isn't set.
    customer_name = (
        container.do.whpo.customer.name
        if container.do and container.do.whpo and container.do.whpo.customer
        else ""
    )
    await tally_sheet_sync.append_tally_row(tally, customer_name)

    return _to_read(tally, container.container_no)


@router.get("/tally-sheets", response_model=TallySheetList)
async def list_tally_sheets(
    billing_status: str | None = Query(None, pattern=r"^(pending|billed|disputed|waived)$"),
    since: datetime | None = Query(None, description="Filter to tallies on/after this date"),
    until: datetime | None = Query(None, description="Filter to tallies before this date"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    session: AsyncSession = Depends(get_session),
) -> TallySheetList:
    """Manager dashboard list — filterable, paginated. Eager-loads the
    parent container to surface container_no without a per-row N+1."""
    q = (
        select(TallySheet, Container.container_no)
        .join(Container, Container.id == TallySheet.container_id)
        .order_by(desc(TallySheet.tallied_at))
    )
    count_q = select(func.count(TallySheet.id))
    if billing_status:
        q = q.where(TallySheet.billing_status == billing_status)
        count_q = count_q.where(TallySheet.billing_status == billing_status)
    if since:
        q = q.where(TallySheet.tallied_at >= since)
        count_q = count_q.where(TallySheet.tallied_at >= since)
    if until:
        q = q.where(TallySheet.tallied_at < until)
        count_q = count_q.where(TallySheet.tallied_at < until)
    q = q.limit(limit).offset(offset)

    rows = (await session.execute(q)).all()
    total = (await session.execute(count_q)).scalar_one()
    return TallySheetList(
        items=[_to_read(t, cno) for (t, cno) in rows],
        total=int(total),
    )


@router.get("/tally-sheets/{tally_id}", response_model=TallySheetRead)
async def get_tally_sheet(
    tally_id: int,
    session: AsyncSession = Depends(get_session),
) -> TallySheetRead:
    row = await session.execute(
        select(TallySheet, Container.container_no)
        .join(Container, Container.id == TallySheet.container_id)
        .where(TallySheet.id == tally_id)
    )
    item = row.first()
    if item is None:
        raise HTTPException(404, f"Tally {tally_id} not found")
    return _to_read(item[0], item[1])


@router.delete("/tally-sheets/{tally_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_tally_sheet(
    tally_id: int,
    deleted_by: str | None = Query(
        None, description="Operator name for the audit log (not required server-side; frontend gates on PIN re-auth)"
    ),
    session: AsyncSession = Depends(get_session),
) -> None:
    """Hard-delete a tally row. Frontend gates this behind a PIN re-auth
    modal so a manager can't accidentally wipe a billing-grade audit row.
    The Postgres row, the on-disk POD file, and the OneDrive Excel row
    are all removed. Container row stays — only the tally is gone, so a
    fresh POD can be uploaded against the same container."""
    tally = await session.scalar(
        select(TallySheet).where(TallySheet.id == tally_id)
    )
    if tally is None:
        raise HTTPException(404, f"Tally {tally_id} not found")

    pod_storage_path = tally.pod_storage_path
    container_no = tally.matched_container_no

    await session.delete(tally)
    await session.commit()

    # Best-effort cleanup of the file + Excel mirror. If either fails we
    # still consider the DB delete authoritative — log + swallow.
    if pod_storage_path:
        try:
            vendor_uploads.delete_storage_file(pod_storage_path)
        except Exception as e:
            logger.warning(
                "tally delete: POD file %s removal failed: %s",
                pod_storage_path,
                e,
            )

    try:
        await tally_sheet_sync.delete_tally_row(tally_id)
    except Exception as e:
        logger.warning(
            "tally delete: OneDrive Excel row removal failed: %s", e
        )

    logger.info(
        "Tally %d (container %s) deleted by %s",
        tally_id,
        container_no,
        deleted_by or "unknown",
    )


@router.patch("/tally-sheets/{tally_id}", response_model=TallySheetRead)
async def update_tally_sheet(
    tally_id: int,
    payload: TallySheetUpdateRequest,
    session: AsyncSession = Depends(get_session),
) -> TallySheetRead:
    """Correct OCR misreads, fill seal/chassis, flip billing_status."""
    row = await session.execute(
        select(TallySheet, Container.container_no, Customer.name)
        .join(Container, Container.id == TallySheet.container_id)
        .join(DO, DO.id == Container.do_id)
        .join(WHPO, WHPO.id == DO.whpo_id)
        .join(Customer, Customer.id == WHPO.customer_id)
        .where(TallySheet.id == tally_id)
    )
    item = row.first()
    if item is None:
        raise HTTPException(404, f"Tally {tally_id} not found")
    tally: TallySheet = item[0]
    customer_name: str = item[2] or ""

    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(tally, k, v)
    await session.commit()
    await session.refresh(tally)

    # Re-sync OneDrive: delete stale row + append the corrected one. Both
    # best-effort. If only ONEDRIVE_TALLY_WEBHOOK_URL is set (no ops URL),
    # the delete no-ops and Excel will have duplicate rows until manual
    # cleanup — manager should set both URLs for correct edit behavior.
    await tally_sheet_sync.delete_tally_row(tally.id)
    await tally_sheet_sync.append_tally_row(tally, customer_name)

    return _to_read(tally, item[1])


# ─── Vendor read endpoint ───────────────────────────────────────────────


vendor_router = APIRouter(prefix="/vendor", tags=["vendor-tally"])


@vendor_router.get(
    "/container/{container_no}/tally",
    response_model=VendorTallyView,
)
async def vendor_tally_view(
    container_no: str,
    vendor: dict = Depends(current_vendor_required),
    session: AsyncSession = Depends(get_session),
) -> VendorTallyView:
    """Vendor sees whether their container has been tallied yet + the
    OCR'd from/to + truck/carrier. No billing fields exposed."""
    # Lookup container + tally + parent customer (to scope to vendor.company)
    res = await session.execute(
        select(Container)
        .options(selectinload(Container.do))
        .where(Container.container_no == container_no)
    )
    container = res.scalar_one_or_none()
    if container is None:
        raise HTTPException(404, f"Container {container_no} not found")

    # Scope: vendor can only see their own brand's containers. Walk
    # Container -> DO -> WHPO -> Customer.name and match vendor.company.
    # Implementing the full join chain here would duplicate the existing
    # /vendor/whpo/* scoping. Keep this endpoint minimal — only return
    # data the vendor would already see via the WHPO listing.
    vendor_company = (vendor.get("company") or "").strip().lower()
    if not vendor_company:
        raise HTTPException(403, "Vendor session missing company claim")

    do = container.do
    whpo = await session.get(WHPO, do.whpo_id) if do else None
    customer = await session.get(Customer, whpo.customer_id) if whpo else None
    if customer is None or customer.name.strip().lower() != vendor_company:
        raise HTTPException(403, f"Container {container_no} is not in your account")

    tally_res = await session.execute(
        select(TallySheet).where(TallySheet.container_id == container.id)
    )
    tally = tally_res.scalar_one_or_none()

    if tally is None:
        return VendorTallyView(container_no=container_no, tallied=False)
    return VendorTallyView(
        container_no=container_no,
        tallied=True,
        tallied_at=tally.tallied_at,
        ocr_from_location=tally.ocr_from_location,
        ocr_to_location=tally.ocr_to_location,
        matched_carrier=tally.matched_carrier,
        matched_truck_plate=tally.matched_truck_plate,
    )
