from __future__ import annotations

import logging

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from datetime import date, datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.config import settings
from app.db import get_session
from app.models import (
    Account,
    ActivityLog,
    Container,
    ContainerDocument,
    ContainerLine,
    Customer,
    DO,
    Receipt,
    WHPO,
)
from app.schemas.vendor import (
    ContainerDocumentItem,
    ContainerDocumentsResponse,
    ContainerListItem,
    ContainerStatus,
    DocumentKindOption,
    DocumentKindsResponse,
    DriverInfoResponse,
    StatusEvent,
    VendorDriverInfo,
    VendorWHPOSubmission,
    WHPOChange,
    WHPOContainersResponse,
    WHPOCurrentContainer,
    WHPOCurrentLine,
    WHPOCurrentState,
    WHPOIntakeResponse,
    WHPOStatusResponse,
    WHPOUpdateRequest,
    WHPOUpdateResponse,
)
from app.schemas.calendar import (
    CalendarDay,
    CalendarResponse,
)
from app.services import (
    onedrive_files,
    onedrive_graph,
    onedrive_local_sync,
    onedrive_rclone,
    sheet_sync,
    vendor_uploads,
)
from app.services.intake import (
    DuplicateContainerError,
    DuplicateWHPOError,
    UnknownCustomerError,
    fetch_inbound_rows_for_do,
    submit_whpo,
)
from app.services.vendor_auth_service import current_vendor_required

router = APIRouter(prefix="/vendor", tags=["vendor"])


# ─── Company-level access control ───────────────────────────────────────
#
# Vendor↔customer scoping lives in app.services.vendor_scoping. The
# helper there resolves both direct-brand matches (vendor.company ==
# customer.name) AND account-level matches (vendor.company is an
# Account name; customer rolls up to it via account_id).
from app.services.vendor_scoping import (
    enforce_company_match as _enforce_company_match,
    vendor_customer_ids,
)


async def _whpo_for_vendor(
    session: AsyncSession, whpo_number: str, claims: dict, *, load_lines: bool = False
) -> WHPO:
    """Fetch a WHPO, 404 if missing, 403 if the caller's company doesn't own
    it. Loads `customer`, `do`, `do.containers`, and optionally container
    lines."""
    container_load = (
        selectinload(WHPO.do)
        .selectinload(DO.containers)
        .selectinload(Container.lines)
        if load_lines
        else selectinload(WHPO.do).selectinload(DO.containers)
    )
    whpo = await session.scalar(
        select(WHPO)
        .where(WHPO.whpo_number == whpo_number)
        .options(selectinload(WHPO.customer), container_load)
    )
    if whpo is None or whpo.do is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"WHPO {whpo_number} not found.",
        )
    await _enforce_company_match(session, claims, whpo.customer.name)
    return whpo


async def _container_for_vendor(
    session: AsyncSession, container_no: str, claims: dict
) -> Container:
    """Fetch a Container, 404 if missing, 403 if caller's company doesn't own
    the parent WHPO. Loads `do.whpo.customer`, `documents`, and `lines`."""
    container = await session.scalar(
        select(Container)
        .where(Container.container_no == container_no)
        .options(
            selectinload(Container.do)
            .selectinload(DO.whpo)
            .selectinload(WHPO.customer),
            selectinload(Container.documents),
            selectinload(Container.lines),
        )
    )
    if container is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Container {container_no} not found.",
        )
    await _enforce_company_match(session, claims, container.do.whpo.customer.name)
    return container


@router.post("/whpo", response_model=WHPOIntakeResponse)
async def submit(
    payload: VendorWHPOSubmission,
    session: AsyncSession = Depends(get_session),
    vendor: dict = Depends(current_vendor_required),
):
    await _enforce_company_match(session, vendor, payload.customer)
    try:
        result = await submit_whpo(session, payload)
    except UnknownCustomerError as e:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Unknown customer '{e.customer_name}'. "
                "Manager must add this customer before vendor submissions are accepted."
            ),
        )
    except DuplicateContainerError as e:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Container {e.container_no} is already attached to another DO. "
                "Duplicate container number rejected."
            ),
        )
    except DuplicateWHPOError as e:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"WHPO/Load No {e.whpo_number} is already on file (registered to "
                f"{e.existing_customer} as {e.existing_do_number}). WHPO/Load No "
                "must be unique — use the Update flow to amend an existing one."
            ),
        )

    await session.commit()

    print(
        f"DIAG vendor: replay={result.idempotent_replay} "
        f"configured={sheet_sync.is_configured()} "
        f"do_id={result.do_id}",
        flush=True,
    )

    # Best-effort append to the configured Excel/OneDrive sync — never block
    # the vendor response on it. Idempotent replays skip the push (those rows
    # were already sent the first time).
    if not result.idempotent_replay and sheet_sync.is_configured():
        rows = await fetch_inbound_rows_for_do(session, result.do_id)
        print(f"DIAG vendor: fetched {len(rows)} rows", flush=True)
        await sheet_sync.append_rows(rows)

    # Also push the per-brand Master Inventory mirror so this shipment
    # appears in its brand’s sheet immediately. Same best-effort pattern
    # as the InboundTable append above — never blocks the vendor.
    if not result.idempotent_replay:
        from app.services import master_sheet_sync
        if master_sheet_sync.is_configured():
            await master_sheet_sync.push_full_replace(session)

    return result


@router.get("/whpo/{whpo_number}/containers", response_model=WHPOContainersResponse)
async def list_whpo_containers(
    whpo_number: str,
    session: AsyncSession = Depends(get_session),
    vendor: dict = Depends(current_vendor_required),
):
    """List the containers attached to a WHPO so the vendor form can resolve
    them automatically when entering driver info."""
    whpo = await _whpo_for_vendor(session, whpo_number, vendor)
    containers = [
        ContainerListItem(
            container_no=c.container_no,
            has_driver_info=bool(c.driver_name),
            driver_name=c.driver_name,
        )
        for c in sorted(whpo.do.containers, key=lambda x: x.container_no)
    ]
    return WHPOContainersResponse(
        whpo_number=whpo.whpo_number,
        do_number=whpo.do.do_number,
        customer_name=whpo.customer.name,
        containers=containers,
    )


@router.patch("/container/{container_no}/driver-info", response_model=DriverInfoResponse)
async def update_container_driver_info(
    container_no: str,
    payload: VendorDriverInfo,
    session: AsyncSession = Depends(get_session),
    vendor: dict = Depends(current_vendor_required),
):
    """Vendor submits driver/truck info for an existing CONTAINER. One driver
    per container — regardless of how many SKUs are inside.
    """
    container = await _container_for_vendor(session, container_no, vendor)

    container.driver_name = payload.driver_name
    container.driver_license = payload.driver_license
    container.driver_phone = payload.driver_phone
    container.truck_license_plate = payload.truck_license_plate
    container.insurance = payload.insurance
    container.carrier = payload.carrier
    container.driver_info_received_at = datetime.now(timezone.utc)

    whpo_number = container.do.whpo.whpo_number
    do_number = container.do.do_number

    # Build a friendly summary that gracefully skips fields the vendor left blank.
    parts: list[str] = []
    if payload.driver_name:
        parts.append(payload.driver_name)
    if payload.driver_license:
        parts.append(f"license {payload.driver_license}")
    if payload.truck_license_plate:
        parts.append(f"truck {payload.truck_license_plate}")
    summary = ", ".join(parts) if parts else "no details provided"
    session.add(
        ActivityLog(
            actor="vendor",
            kind="driver_info_submitted",
            ref_type="container",
            ref_id=container.id,
            message=(
                f"Driver info submitted for container {container.container_no}: "
                f"{summary}"
            ),
            payload={
                "container_no": container.container_no,
                "whpo_number": whpo_number,
                "do_number": do_number,
            },
        )
    )

    await session.flush()
    rows_affected = len(container.lines)
    await session.commit()

    if sheet_sync.is_update_configured():
        await sheet_sync.update_driver_for_container(
            container_no=container.container_no,
            driver_name=payload.driver_name,
            driver_license=payload.driver_license,
            driver_phone=payload.driver_phone,
            truck_license_plate=payload.truck_license_plate,
            insurance=payload.insurance,
            carrier=payload.carrier,
        )

    return DriverInfoResponse(
        container_no=container.container_no,
        whpo_number=whpo_number,
        do_number=do_number,
        rows_affected=rows_affected,
    )


# ─── Update existing WHPO ────────────────────────────────────────────────


@router.get("/whpo/{whpo_number}/current", response_model=WHPOCurrentState)
async def get_whpo_current_state(
    whpo_number: str,
    session: AsyncSession = Depends(get_session),
    vendor: dict = Depends(current_vendor_required),
):
    """Returns the full current state of a WHPO — containers, lines, statuses.
    Used by the update flow to pre-fill the edit form with what's on file."""
    whpo = await _whpo_for_vendor(session, whpo_number, vendor, load_lines=True)

    containers_out: list[WHPOCurrentContainer] = []
    any_locked = False
    for c in sorted(whpo.do.containers, key=lambda x: x.container_no):
        is_locked = c.status in ("receiving", "received")
        if is_locked:
            any_locked = True
        lines_out = [
            WHPOCurrentLine(
                sku=ln.sku_raw, qty=ln.qty, product_type=ln.product_type
            )
            for ln in sorted(c.lines, key=lambda x: x.line_index)
        ]
        containers_out.append(
            WHPOCurrentContainer(
                container_no=c.container_no,
                expected_arrival_date=c.expected_arrival_date,
                expected_arrival_time=c.expected_arrival_time,
                status=c.status,
                is_locked=is_locked,
                has_driver_info=bool(c.driver_name),
                driver_name=c.driver_name,
                driver_license=c.driver_license,
                driver_phone=c.driver_phone,
                truck_license_plate=c.truck_license_plate,
                insurance=c.insurance,
                carrier=c.carrier,
                lines=lines_out,
            )
        )

    return WHPOCurrentState(
        whpo_number=whpo.whpo_number,
        do_number=whpo.do.do_number,
        customer_name=whpo.customer.name,
        expected_arrival_date=whpo.do.expected_arrival_date,
        bol_number=whpo.bol_number,
        containers=containers_out,
        any_locked=any_locked,
    )


@router.get("/whpo/{whpo_number}/status", response_model=WHPOStatusResponse)
async def get_whpo_status(
    whpo_number: str,
    session: AsyncSession = Depends(get_session),
    vendor: dict = Depends(current_vendor_required),
):
    """Status timeline for each container on a WHPO. Vendor-visible
    inbound progress: order placed → driver assigned → scanning → complete."""
    whpo = await _whpo_for_vendor(session, whpo_number, vendor)
    order_placed_at = whpo.received_at

    # Pull every inbound Receipt for these containers in one shot.
    container_ids = [c.id for c in whpo.do.containers]
    receipts_by_container: dict[int, Receipt] = {}
    if container_ids:
        from sqlalchemy import select as _sel
        rs = await session.scalars(
            _sel(Receipt)
            .where(Receipt.kind == "inbound")
            .where(Receipt.container_id.in_(container_ids))
            .order_by(Receipt.started_at.desc())
        )
        for r in rs.all():
            # Keep the most recent receipt per container.
            receipts_by_container.setdefault(r.container_id, r)

    containers_out: list[ContainerStatus] = []
    for c in sorted(whpo.do.containers, key=lambda x: x.container_no):
        receipt = receipts_by_container.get(c.id)
        timeline = [
            StatusEvent(stage="order_placed", label="Order placed", at=order_placed_at),
            StatusEvent(
                stage="driver_assigned",
                label="Driver / truck info added",
                at=c.driver_info_received_at,
            ),
            StatusEvent(
                stage="scanning",
                label="Scanning in progress",
                at=receipt.started_at if receipt else None,
            ),
            StatusEvent(
                stage="complete",
                label="Scanning complete",
                at=(receipt.finished_at if (receipt and receipt.status == "completed") else None),
            ),
        ]
        current_stage = "order_placed"
        for ev in timeline:
            if ev.at is not None:
                current_stage = ev.stage
        containers_out.append(
            ContainerStatus(
                container_no=c.container_no,
                current_stage=current_stage,
                timeline=timeline,
            )
        )

    return WHPOStatusResponse(
        whpo_number=whpo.whpo_number,
        do_number=whpo.do.do_number,
        customer_name=whpo.customer.name,
        order_placed_at=order_placed_at,
        containers=containers_out,
    )


@router.put("/whpo/{whpo_number}/update", response_model=WHPOUpdateResponse)
async def update_whpo(
    whpo_number: str,
    payload: WHPOUpdateRequest,
    session: AsyncSession = Depends(get_session),
    vendor: dict = Depends(current_vendor_required),
):
    """Vendor-driven update of an existing WHPO. Lets the vendor change any
    field except the WHPO number itself — container numbers, expected arrival,
    SKU lines. Driver info has its own dedicated PATCH endpoint and is not
    touched here.

    Blocks updates when any container is already `receiving` or `received`
    (operator started scanning — can't change the manifest on them).

    Writes a `whpo_updated` ActivityLog entry with a structured before/after
    diff so the manager dashboard sees what changed.

    After applying, re-syncs the relevant rows in OneDrive InboundTable by
    deleting all rows for this WHPO and appending the fresh set.
    """
    whpo = await _whpo_for_vendor(session, whpo_number, vendor, load_lines=True)

    do = whpo.do
    existing_containers = {c.container_no: c for c in do.containers}

    # Reject if any container is already receiving/received.
    locked = [
        c.container_no
        for c in do.containers
        if c.status in ("receiving", "received")
    ]
    if locked:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Cannot update — these containers are already being received "
                f"or have been received: {', '.join(locked)}. "
                "Contact developer@conquernation.com if you really need a change."
            ),
        )

    changes: list[WHPOChange] = []

    # WHPO-level: expected_arrival_date
    if (
        payload.expected_arrival_date is not None
        and payload.expected_arrival_date != do.expected_arrival_date
    ):
        changes.append(
            WHPOChange(
                scope="whpo",
                field="expected_arrival_date",
                before=str(do.expected_arrival_date) if do.expected_arrival_date else None,
                after=str(payload.expected_arrival_date),
            )
        )
        do.expected_arrival_date = payload.expected_arrival_date

    # WHPO-level: bol_number. None ⇒ leave unchanged. Empty string ⇒
    # explicit clear (vendor wiped the field). Anything else ⇒ set/replace.
    if payload.bol_number is not None:
        new_bol = payload.bol_number.strip() or None
        if new_bol != whpo.bol_number:
            changes.append(
                WHPOChange(
                    scope="whpo",
                    field="bol_number",
                    before=whpo.bol_number,
                    after=new_bol,
                )
            )
            whpo.bol_number = new_bol

    # Per-container: container_no, expected arrival, lines
    incoming_keys = {c.original_container_no for c in payload.containers}
    for inc in payload.containers:
        existing = existing_containers.get(inc.original_container_no)
        if existing is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Container {inc.original_container_no} not found on WHPO/Load No "
                    f"{whpo_number}. Use a value from /vendor/whpo/{whpo_number}/current."
                ),
            )

        # Container number change
        if inc.container_no != existing.container_no:
            # Make sure new container_no isn't already taken on another DO
            conflict = await session.scalar(
                select(Container).where(Container.container_no == inc.container_no)
            )
            if conflict is not None and conflict.id != existing.id:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=(
                        f"Container {inc.container_no} is already used on another "
                        "Delivery Order — can't reassign."
                    ),
                )
            changes.append(
                WHPOChange(
                    scope="container",
                    container_no=existing.container_no,
                    field="container_no",
                    before=existing.container_no,
                    after=inc.container_no,
                )
            )
            existing.container_no = inc.container_no

        # Date / time
        if (
            inc.expected_arrival_date is not None
            and inc.expected_arrival_date != existing.expected_arrival_date
        ):
            changes.append(
                WHPOChange(
                    scope="container",
                    container_no=existing.container_no,
                    field="expected_arrival_date",
                    before=str(existing.expected_arrival_date) if existing.expected_arrival_date else None,
                    after=str(inc.expected_arrival_date),
                )
            )
            existing.expected_arrival_date = inc.expected_arrival_date
        if (
            inc.expected_arrival_time is not None
            and inc.expected_arrival_time != existing.expected_arrival_time
        ):
            changes.append(
                WHPOChange(
                    scope="container",
                    container_no=existing.container_no,
                    field="expected_arrival_time",
                    before=str(existing.expected_arrival_time) if existing.expected_arrival_time else None,
                    after=str(inc.expected_arrival_time),
                )
            )
            existing.expected_arrival_time = inc.expected_arrival_time

        # Driver / truck fields — diff against existing. None in payload means
        # "no opinion, don't touch". Empty string means "clear it".
        driver_fields = (
            "driver_name",
            "driver_license",
            "driver_phone",
            "truck_license_plate",
            "insurance",
            "carrier",
        )
        any_driver_changed = False
        for field_name in driver_fields:
            inc_val = getattr(inc, field_name)
            if inc_val is None:
                continue  # not in this update
            normalized = (inc_val.strip() or None) if isinstance(inc_val, str) else inc_val
            ex_val = getattr(existing, field_name)
            if normalized != ex_val:
                changes.append(
                    WHPOChange(
                        scope="container",
                        container_no=existing.container_no,
                        field=field_name,
                        before=ex_val,
                        after=normalized,
                    )
                )
                setattr(existing, field_name, normalized)
                any_driver_changed = True
        if any_driver_changed:
            existing.driver_info_received_at = datetime.now(timezone.utc)

        # Lines — diff against existing
        existing_lines_by_sku = {ln.sku_raw: ln for ln in existing.lines}
        incoming_lines_by_sku = {ln.sku: ln for ln in inc.lines}

        for sku, ex_line in existing_lines_by_sku.items():
            inc_line = incoming_lines_by_sku.get(sku)
            if inc_line is None:
                changes.append(
                    WHPOChange(
                        scope="line",
                        container_no=existing.container_no,
                        field="removed",
                        sku=sku,
                        before=f"qty {ex_line.qty}",
                        after=None,
                    )
                )
            else:
                if inc_line.qty != ex_line.qty:
                    changes.append(
                        WHPOChange(
                            scope="line",
                            container_no=existing.container_no,
                            field="qty",
                            sku=sku,
                            before=str(ex_line.qty),
                            after=str(inc_line.qty),
                        )
                    )
                if (inc_line.product_type or None) != (ex_line.product_type or None):
                    changes.append(
                        WHPOChange(
                            scope="line",
                            container_no=existing.container_no,
                            field="product_type",
                            sku=sku,
                            before=ex_line.product_type,
                            after=inc_line.product_type,
                        )
                    )
        for sku in incoming_lines_by_sku:
            if sku not in existing_lines_by_sku:
                inc_line = incoming_lines_by_sku[sku]
                changes.append(
                    WHPOChange(
                        scope="line",
                        container_no=existing.container_no,
                        field="added",
                        sku=sku,
                        before=None,
                        after=f"qty {inc_line.qty}",
                    )
                )

        # Replace lines (delete + insert)
        for ln in list(existing.lines):
            await session.delete(ln)
        for idx, inc_line in enumerate(inc.lines):
            session.add(
                ContainerLine(
                    container_id=existing.id,
                    sku_raw=inc_line.sku,
                    qty=inc_line.qty,
                    product_type=inc_line.product_type,
                    line_index=idx,
                )
            )

    # Detect containers that weren't included in the update (vendor removed them)
    for ex_cn, ex_c in existing_containers.items():
        if ex_cn not in incoming_keys:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Container {ex_cn} is on this WHPO/Load No but missing from your update. "
                    "Submit it explicitly (with its current data if unchanged) — "
                    "removing containers via update isn't supported. Email "
                    "developer@conquernation.com to drop a container."
                ),
            )

    if not changes:
        # No-op update — nothing to log or sync
        return WHPOUpdateResponse(
            whpo_number=whpo.whpo_number,
            do_number=do.do_number,
            changes=[],
            summary="No changes detected — nothing to update.",
            excel_resynced=False,
        )

    # Generate a human summary
    summary = _summarize_changes(whpo_number, changes)

    # Activity log entry
    session.add(
        ActivityLog(
            actor="vendor",
            kind="whpo_updated",
            ref_type="do",
            ref_id=do.id,
            message=summary,
            payload={"changes": [c.model_dump() for c in changes]},
        )
    )

    await session.flush()
    await session.commit()

    # Excel resync: delete old rows for this WHPO, then append fresh.
    # Failures here are non-fatal — Postgres is already committed — but we
    # log the full traceback so the manager / ops can debug. The frontend
    # gets `excel_resynced=False` and surfaces a "retry from Inbound tab"
    # hint to the vendor.
    excel_ok = False
    try:
        if sheet_sync.is_update_configured():
            logger.info(
                "update_whpo: deleting OneDrive InboundTable rows for WHPO %s",
                whpo_number,
            )
            await sheet_sync.delete_inbound_rows_for_whpo(whpo_number)
        else:
            logger.info(
                "update_whpo: skip delete — sheet_sync.is_update_configured() == False"
            )

        rows = await fetch_inbound_rows_for_do(session, do.id)
        logger.info(
            "update_whpo: appending %d fresh rows for WHPO %s",
            len(rows),
            whpo_number,
        )
        if rows and sheet_sync.is_configured():
            await sheet_sync.append_rows(rows)
        elif not sheet_sync.is_configured():
            logger.info(
                "update_whpo: skip append — sheet_sync.is_configured() == False"
            )
        excel_ok = True
    except Exception as e:  # noqa: BLE001
        logger.exception(
            "update_whpo: Excel re-sync failed for WHPO %s — %r",
            whpo_number,
            e,
        )
        excel_ok = False

    return WHPOUpdateResponse(
        whpo_number=whpo.whpo_number,
        do_number=do.do_number,
        changes=changes,
        summary=summary,
        excel_resynced=excel_ok,
    )


# ─── Container document uploads ─────────────────────────────────────────


@router.get("/document-kinds", response_model=DocumentKindsResponse)
async def list_document_kinds():
    """Static list of the document kinds the vendor can attach to a container.
    Source-of-truth lives in `vendor_uploads.DOCUMENT_KINDS`."""
    return DocumentKindsResponse(
        kinds=[
            DocumentKindOption(kind=k, label=v)
            for k, v in vendor_uploads.DOCUMENT_KINDS.items()
        ]
    )


def _doc_item(container_no: str, doc: ContainerDocument) -> ContainerDocumentItem:
    return ContainerDocumentItem(
        id=doc.id,
        kind=doc.kind,
        label=vendor_uploads.DOCUMENT_KINDS.get(doc.kind, doc.kind),
        filename=doc.filename,
        content_type=doc.content_type,
        file_size=doc.file_size,
        uploaded_at=doc.uploaded_at,
        uploaded_by=doc.uploaded_by,
        url=vendor_uploads.public_url(container_no, doc.kind),
    )


@router.get(
    "/container/{container_no}/documents",
    response_model=ContainerDocumentsResponse,
)
async def list_container_documents(
    container_no: str,
    session: AsyncSession = Depends(get_session),
    vendor: dict = Depends(current_vendor_required),
):
    """All documents attached to a container — what the vendor has uploaded so
    far. The frontend uses this to render filled vs. empty upload slots and
    pre-fill thumbnails on the update flow."""
    container = await _container_for_vendor(session, container_no, vendor)
    docs = sorted(container.documents, key=lambda d: d.kind)
    return ContainerDocumentsResponse(
        container_no=container.container_no,
        documents=[_doc_item(container.container_no, d) for d in docs],
    )


@router.put(
    "/container/{container_no}/documents/{kind}",
    response_model=ContainerDocumentItem,
)
async def upload_container_document(
    container_no: str,
    kind: str,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    session: AsyncSession = Depends(get_session),
    vendor: dict = Depends(current_vendor_required),
):
    """Upload (or replace) a single document on a container. Idempotent on the
    (container, kind) pair — re-uploads overwrite the prior file."""
    if not vendor_uploads.is_valid_kind(kind):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Unknown document kind '{kind}'. Allowed: "
                f"{', '.join(vendor_uploads.DOCUMENT_KINDS.keys())}."
            ),
        )

    content_type = (file.content_type or "").lower()
    if content_type not in vendor_uploads.ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=(
                f"Unsupported file type '{content_type}'. Upload an image "
                "(JPEG/PNG/HEIC/WebP) or a PDF."
            ),
        )

    # Streamed read up to the size cap.
    data = await file.read(settings.upload_max_bytes + 1)
    if not data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Empty upload — pick a file and try again.",
        )
    if len(data) > settings.upload_max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=(
                f"File is larger than {settings.upload_max_bytes // (1024 * 1024)} MB. "
                "Compress or split it and try again."
            ),
        )

    container = await _container_for_vendor(session, container_no, vendor)

    rel_path, _abs = vendor_uploads.save_bytes(
        container_id=container.id,
        kind=kind,
        data=data,
        original_filename=file.filename or f"{kind}",
        content_type=content_type,
    )

    uploaded_by = vendor.get("sub")

    existing = next((d for d in container.documents if d.kind == kind), None)
    old_storage_path: str | None = None
    if existing is not None:
        old_storage_path = existing.storage_path
        existing.filename = file.filename or f"{kind}"
        existing.content_type = content_type
        existing.file_size = len(data)
        existing.storage_path = rel_path
        existing.uploaded_at = datetime.now(timezone.utc)
        existing.uploaded_by = uploaded_by
        doc = existing
    else:
        doc = ContainerDocument(
            container_id=container.id,
            kind=kind,
            filename=file.filename or f"{kind}",
            content_type=content_type,
            file_size=len(data),
            storage_path=rel_path,
            uploaded_by=uploaded_by,
        )
        session.add(doc)

    session.add(
        ActivityLog(
            actor=uploaded_by or "vendor",
            kind="vendor_document_uploaded",
            ref_type="container",
            ref_id=container.id,
            message=(
                f"Document '{vendor_uploads.DOCUMENT_KINDS.get(kind, kind)}' "
                f"uploaded for container {container.container_no} "
                f"({file.filename or '—'}, {len(data)} bytes)"
            ),
            payload={
                "container_no": container.container_no,
                "kind": kind,
                "filename": file.filename,
                "size": len(data),
                "replaced": existing is not None,
            },
        )
    )

    await session.flush()
    await session.refresh(doc)
    await session.commit()

    # Commit succeeded — safe to remove the prior file from disk.
    if old_storage_path:
        vendor_uploads.delete_storage_file(old_storage_path)

    # Best-effort OneDrive mirror. Three paths — any / all can be wired up:
    #   - onedrive_graph: direct upload to OneDrive via Microsoft Graph API
    #     using a stored refresh token. Cloud-only, no desktop client needed.
    #     Set ONEDRIVE_GRAPH_ENABLED=true and run the login script once.
    #   - onedrive_local_sync: write into the OneDrive desktop sync folder,
    #     let the OS-level OneDrive client push it to the cloud.
    #   - onedrive_files: legacy Logic App webhook path. Disabled by default.
    # All run as background tasks so the vendor response returns immediately.
    if onedrive_graph.is_configured():
        background_tasks.add_task(
            onedrive_graph.upload_document,
            company=container.do.whpo.customer.name,
            arrival_date=container.expected_arrival_date,
            whpo_number=container.do.whpo.whpo_number,
            container_no=container.container_no,
            kind=kind,
            storage_path=doc.storage_path,
            original_filename=doc.filename,
            content_type=doc.content_type,
        )
    if onedrive_local_sync.is_configured():
        background_tasks.add_task(
            onedrive_local_sync.save_copy,
            company=container.do.whpo.customer.name,
            arrival_date=container.expected_arrival_date,
            whpo_number=container.do.whpo.whpo_number,
            container_no=container.container_no,
            kind=kind,
            local_storage_path=doc.storage_path,
            original_filename=doc.filename,
            content_type=doc.content_type,
        )
    if onedrive_files.is_configured():
        background_tasks.add_task(
            onedrive_files.upload_document,
            company=container.do.whpo.customer.name,
            arrival_date=container.expected_arrival_date,
            whpo_number=container.do.whpo.whpo_number,
            container_no=container.container_no,
            kind=kind,
            storage_path=doc.storage_path,
            original_filename=doc.filename,
            content_type=doc.content_type,
        )
        # Also mirror to the new Account/Brand/Quarter/Month/Container/
        # hierarchy so all docs for a container live in one folder
        # alongside the POD + tally PDF (per Tiana's spec).
        brand = container.do.whpo.customer
        account_name: str | None = None
        if brand.account_id is not None:
            acct = await session.get(Account, brand.account_id)
            if acct is not None:
                account_name = acct.name
        background_tasks.add_task(
            _mirror_doc_to_container_folder,
            account=account_name,
            brand=brand.name,
            arrival_date=container.actual_arrival_date or container.expected_arrival_date,
            container_no=container.container_no,
            local_storage_path=doc.storage_path,
            filename=f"{kind}{Path(doc.filename).suffix or ''}",
            content_type=doc.content_type,
        )

    return _doc_item(container.container_no, doc)


async def _mirror_doc_to_container_folder(
    *,
    account: str | None,
    brand: str,
    arrival_date,
    container_no: str,
    local_storage_path: str,
    filename: str,
    content_type: str,
) -> None:
    """Background-task helper: read the saved file from disk and push it
    to OneDrive under the Account/Brand/Quarter/Month/Container path."""
    try:
        abs_path = vendor_uploads.absolute_path(local_storage_path)
        data = abs_path.read_bytes()
    except Exception as e:
        logger.warning(
            "container-folder mirror: read %s failed: %s", local_storage_path, e
        )
        return
    await onedrive_files.upload_to_container_folder(
        account=account,
        brand=brand,
        arrival_date=arrival_date,
        container_no=container_no,
        data=data,
        filename=filename,
        content_type=content_type,
    )


@router.delete(
    "/container/{container_no}/documents/{kind}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_container_document(
    container_no: str,
    kind: str,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_session),
    vendor: dict = Depends(current_vendor_required),
):
    if not vendor_uploads.is_valid_kind(kind):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown document kind '{kind}'.",
        )
    container = await _container_for_vendor(session, container_no, vendor)
    existing = next((d for d in container.documents if d.kind == kind), None)
    if existing is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No '{kind}' document on file for container {container_no}.",
        )

    storage_path = existing.storage_path
    # Snapshot fields before delete — Postgres row goes away after the commit
    # but we still need them for the OneDrive cleanup task.
    od_filename = existing.filename
    od_content_type = existing.content_type
    od_arrival_date = container.expected_arrival_date
    od_company = container.do.whpo.customer.name
    od_whpo = container.do.whpo.whpo_number
    await session.delete(existing)

    session.add(
        ActivityLog(
            actor=vendor.get("sub") or "vendor",
            kind="vendor_document_deleted",
            ref_type="container",
            ref_id=container.id,
            message=(
                f"Document '{vendor_uploads.DOCUMENT_KINDS.get(kind, kind)}' "
                f"removed from container {container.container_no}"
            ),
            payload={"container_no": container.container_no, "kind": kind},
        )
    )

    await session.commit()
    vendor_uploads.delete_storage_file(storage_path)

    if onedrive_graph.is_configured():
        background_tasks.add_task(
            onedrive_graph.delete_document,
            company=od_company,
            arrival_date=od_arrival_date,
            whpo_number=od_whpo,
            container_no=container.container_no,
            kind=kind,
            original_filename=od_filename,
            content_type=od_content_type,
        )
    if onedrive_local_sync.is_configured():
        background_tasks.add_task(
            onedrive_local_sync.delete_copy,
            company=od_company,
            arrival_date=od_arrival_date,
            whpo_number=od_whpo,
            container_no=container.container_no,
            kind=kind,
            original_filename=od_filename,
            content_type=od_content_type,
        )
    if onedrive_files.is_configured():
        background_tasks.add_task(
            onedrive_files.delete_document,
            company=od_company,
            arrival_date=od_arrival_date,
            whpo_number=od_whpo,
            container_no=container.container_no,
            kind=kind,
            original_filename=od_filename,
            content_type=od_content_type,
        )

    return None


@router.get("/container/{container_no}/documents/{kind}/file")
async def fetch_container_document_file(
    container_no: str,
    kind: str,
    session: AsyncSession = Depends(get_session),
    vendor: dict = Depends(current_vendor_required),
):
    """Serve a previously uploaded document. Auth-gated by the owning
    company — the frontend fetches with a Bearer JWT and builds a blob URL
    for `<img>` rendering."""
    if not vendor_uploads.is_valid_kind(kind):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown document kind '{kind}'.",
        )
    container = await _container_for_vendor(session, container_no, vendor)
    doc = next((d for d in container.documents if d.kind == kind), None)
    if doc is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No '{kind}' document on file for container {container_no}.",
        )
    try:
        abs_path = vendor_uploads.absolute_path(doc.storage_path)
    except vendor_uploads.UploadError:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Stored path failed validation.",
        )
    if not abs_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="File missing on disk — please re-upload.",
        )
    return FileResponse(
        path=str(abs_path),
        media_type=doc.content_type,
        filename=doc.filename,
    )


def _summarize_changes(whpo_number: str, changes: list[WHPOChange]) -> str:
    """One-line human summary of a WHPO update for the activity feed."""
    n_whpo = sum(1 for c in changes if c.scope == "whpo")
    n_ctnr = sum(1 for c in changes if c.scope == "container")
    n_lines = sum(1 for c in changes if c.scope == "line")
    bits: list[str] = []
    if n_whpo:
        bits.append(f"{n_whpo} WHPO/Load No field")
    if n_ctnr:
        bits.append(f"{n_ctnr} container field{'s' if n_ctnr != 1 else ''}")
    if n_lines:
        bits.append(f"{n_lines} SKU line change{'s' if n_lines != 1 else ''}")
    detail = ", ".join(bits) if bits else "no changes"
    return f"WHPO/Load No {whpo_number} updated by vendor — {detail}."


@router.get("/calendar", response_model=CalendarResponse)
async def get_vendor_calendar(
    days: int = 14,
    session: AsyncSession = Depends(get_session),
    vendor: dict = Depends(current_vendor_required),
):
    """Inbound + outbound activity for the next `days` days, scoped to
    the vendor's own company. Default 14 days (per Tiana's spec)."""
    from app.services.calendar import build_calendar

    days = max(1, min(60, int(days)))
    company = (vendor.get("company") or "").strip()
    data = await build_calendar(session, days=days, customer_name=company)
    return CalendarResponse(
        window_start=data["window_start"],
        window_end=data["window_end"],
        days=[CalendarDay(**d) for d in data["days"]],
    )


@router.get("/master-list")
async def vendor_master_list(
    customer: str | None = None,
    customer_id: int | None = None,
    since: date | None = None,
    until: date | None = None,
    from_date: date | None = None,
    to_date: date | None = None,
    scanned: bool | None = None,
    limit: int = 500,
    offset: int = 0,
    session: AsyncSession = Depends(get_session),
    vendor: dict = Depends(current_vendor_required),
):
    """Vendor-facing mastersheet. Same shape as /manager/master-list but
    automatically scoped to the brands the JWT can see.

    Scoping pattern (see services/vendor_scoping.py):
      - A direct-brand login (vendor.company == 'Lime') sees only Lime rows.
      - An account-level login (vendor.company == 'TQL Trading Inc.') sees
        every brand rolling up to that Account — e.g. Lime + Pan American
        Wire + Boviet Solar + National Plastic for TQL.

    The optional `customer` query param further narrows the result (used
    by the dropdown to focus on one brand at a time). Anything outside
    the scope is silently dropped — the vendor never sees other tenants'
    customer names even via the dropdown.
    """
    from sqlalchemy import select as _select, bindparam, text as _text
    from app.models import Customer as _Customer
    from app.schemas.master_list import (
        MasterListResponse as _MasterListResponse,
        MasterListRow as _MasterListRow,
    )

    allowed_customer_ids = await vendor_customer_ids(session, vendor)
    if not allowed_customer_ids:
        return _MasterListResponse(items=[], total=0)

    allowed_names_q = await session.scalars(
        _select(_Customer.name).where(_Customer.id.in_(allowed_customer_ids))
    )
    allowed_names = [n for n in allowed_names_q.all() if n]
    if not allowed_names:
        return _MasterListResponse(items=[], total=0)

    # If the caller passed `customer` (name) or `customer_id`, it must
    # be one of the allowed brands. Otherwise we silently ignore it —
    # never trust the client to broaden scope.
    effective_names: list[str]
    if customer_id is not None:
        if customer_id not in allowed_customer_ids:
            return _MasterListResponse(items=[], total=0)
        # Map the id to its name (used by vw_master_list.customer_name).
        name_q = await session.scalar(
            _select(_Customer.name).where(_Customer.id == customer_id)
        )
        if not name_q:
            return _MasterListResponse(items=[], total=0)
        effective_names = [name_q]
    elif customer:
        match = next(
            (n for n in allowed_names if n.casefold() == customer.casefold()),
            None,
        )
        if match is None:
            return _MasterListResponse(items=[], total=0)
        effective_names = [match]
    else:
        effective_names = allowed_names

    # Date aliases: from_date / to_date carry the same meaning as
    # since / until — the FilterBar component uses the first pair.
    effective_since = from_date if since is None else since
    effective_until = to_date if until is None else until

    where: list[str] = ["customer_name IN :brand_list"]
    params: dict[str, object] = {"brand_list": tuple(effective_names)}
    if effective_since:
        where.append("COALESCE(received_date, ship_date) >= :since")
        params["since"] = effective_since
    if effective_until:
        where.append("COALESCE(received_date, ship_date) <= :until")
        params["until"] = effective_until
    if scanned is not None:
        where.append("scanned = :scanned")
        params["scanned"] = scanned
    where_clause = "WHERE " + " AND ".join(where)

    rows_sql = _text(
        f"""
        SELECT * FROM vw_master_list
        {where_clause}
        ORDER BY COALESCE(received_date, ship_date) DESC NULLS LAST,
                 container_no
        LIMIT :limit OFFSET :offset
        """
    ).bindparams(bindparam("brand_list", expanding=True))
    count_sql = _text(
        f"SELECT COUNT(*) FROM vw_master_list {where_clause}"
    ).bindparams(bindparam("brand_list", expanding=True))

    rows_result = await session.execute(
        rows_sql, {**params, "limit": limit, "offset": offset}
    )
    items = [_MasterListRow(**dict(r._mapping)) for r in rows_result]
    total = (await session.execute(count_sql, params)).scalar_one()
    return _MasterListResponse(items=items, total=int(total))


@router.get("/master-list/brands")
async def vendor_master_list_brands(
    session: AsyncSession = Depends(get_session),
    vendor: dict = Depends(current_vendor_required),
) -> list[str]:
    """List of brand names this vendor can filter by — drives the dropdown
    on the vendor mastersheet page. Same scoping rule as /master-list."""
    from sqlalchemy import select as _select
    from app.models import Customer as _Customer

    allowed_customer_ids = await vendor_customer_ids(session, vendor)
    if not allowed_customer_ids:
        return []
    names_q = await session.scalars(
        _select(_Customer.name)
        .where(_Customer.id.in_(allowed_customer_ids))
        .order_by(_Customer.name)
    )
    return [n for n in names_q.all() if n]


@router.get("/brands")
async def vendor_brands(
    session: AsyncSession = Depends(get_session),
    vendor: dict = Depends(current_vendor_required),
) -> list[dict]:
    """Brand id + name list for any vendor list view's FilterBar — the
    FilterBar is keyed on numeric brand IDs. Direct-brand logins see
    one row; account-level logins see every brand under their Account."""
    from sqlalchemy import select as _select
    from app.models import Customer as _Customer

    allowed_customer_ids = await vendor_customer_ids(session, vendor)
    if not allowed_customer_ids:
        return []
    rows = await session.execute(
        _select(_Customer.id, _Customer.name)
        .where(_Customer.id.in_(allowed_customer_ids))
        .order_by(_Customer.name)
    )
    return [{"id": r[0], "name": r[1]} for r in rows]
