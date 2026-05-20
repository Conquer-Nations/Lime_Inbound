"""Vendor intake: take a structured WHPO submission, materialize the whole
WHPO → DO → Containers → ContainerLines chain, and surface exceptions for any
SKU master data the warehouse is missing.

Idempotent on whpo_number: re-submitting the same WHPO returns the existing DO
without creating duplicates.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import (
    SKU,
    ActivityLog,
    Container,
    ContainerLine,
    Customer,
    DO,
    ExceptionRecord,
    WHPO,
)
from app.schemas.vendor import (
    ContainerCreated,
    ExceptionOpened,
    VendorWHPOSubmission,
    WHPOIntakeResponse,
)


# ─── Errors ─────────────────────────────────────────────────────────────


class IntakeError(Exception):
    """Base for vendor-intake failures."""


class UnknownCustomerError(IntakeError):
    def __init__(self, name: str) -> None:
        super().__init__(f"Customer '{name}' is not in master data.")
        self.customer_name = name


class DuplicateContainerError(IntakeError):
    def __init__(self, container_no: str) -> None:
        super().__init__(
            f"Container {container_no} is already attached to a different DO. "
            "Cannot accept duplicate container."
        )
        self.container_no = container_no


class DuplicateWHPOError(IntakeError):
    """WHPO number is already on file. Billing requires uniqueness — duplicates
    are rejected outright. To amend an existing WHPO, use the Update flow."""

    def __init__(
        self,
        *,
        whpo_number: str,
        existing_customer: str,
        existing_do_number: str,
    ) -> None:
        super().__init__(
            f"WHPO {whpo_number} already exists (registered to "
            f"{existing_customer} as {existing_do_number}). WHPO numbers must "
            "be unique for billing — use the Update flow to amend it."
        )
        self.whpo_number = whpo_number
        self.existing_customer = existing_customer
        self.existing_do_number = existing_do_number


# ─── Main entry ─────────────────────────────────────────────────────────


async def submit_whpo(
    session: AsyncSession, payload: VendorWHPOSubmission
) -> WHPOIntakeResponse:
    # 1. Resolve customer
    customer = await _find_customer(session, payload.customer)
    if customer is None:
        raise UnknownCustomerError(payload.customer)

    # 2. WHPO uniqueness check — billing requires each WHPO# be unique per
    # order. Reject duplicates outright; if the vendor needs to amend a
    # shipment they already submitted, they use the Update flow.
    existing = await session.scalar(
        select(WHPO)
        .where(WHPO.whpo_number == payload.whpo_number)
        .options(selectinload(WHPO.do), selectinload(WHPO.customer))
    )
    if existing is not None:
        raise DuplicateWHPOError(
            whpo_number=payload.whpo_number,
            existing_customer=(existing.customer.name if existing.customer else "unknown"),
            existing_do_number=(existing.do.do_number if existing.do else "—"),
        )

    # 3. Verify no container collision
    incoming_container_nos = [c.container_no for c in payload.containers]
    collision = await session.scalar(
        select(Container.container_no).where(Container.container_no.in_(incoming_container_nos))
    )
    if collision is not None:
        raise DuplicateContainerError(collision)

    # 4. Create WHPO
    whpo = WHPO(
        whpo_number=payload.whpo_number,
        customer_id=customer.id,
        notes=payload.notes,
        bol_number=(payload.bol_number or None),
        raw_payload=payload.model_dump(mode="json"),
    )
    session.add(whpo)
    await session.flush()

    # 5. Create DO (auto-generated do_number)
    do_number = await _next_do_number(session, payload.expected_arrival_date.year)
    do = DO(
        do_number=do_number,
        whpo_id=whpo.id,
        status="pending_master_data",  # finalized below after SKU lookups
        expected_arrival_date=payload.expected_arrival_date,
        issued_by="vendor_intake",
    )
    session.add(do)
    await session.flush()

    # 6. Create Containers + Lines, resolving SKUs against master
    containers_summary: list[ContainerCreated] = []
    exceptions_opened: list[ExceptionOpened] = []
    any_unknown_sku = False
    any_missing_master = False

    for c in payload.containers:
        container = Container(
            container_no=c.container_no,
            do_id=do.id,
            expected_arrival_date=c.expected_arrival_date or payload.expected_arrival_date,
            expected_arrival_time=c.expected_arrival_time,
            status="expected",
            on_pallet=payload.packaging.on_pallet if payload.packaging else None,
            pallet_length_in=payload.packaging.pallet_length_in if payload.packaging else None,
            pallet_width_in=payload.packaging.pallet_width_in if payload.packaging else None,
            item_length_in=payload.packaging.item_length_in if payload.packaging else None,
            item_width_in=payload.packaging.item_width_in if payload.packaging else None,
            item_height_in=payload.packaging.item_height_in if payload.packaging else None,
        )
        session.add(container)
        await session.flush()

        unknown_for_this_container: list[str] = []

        for idx, line in enumerate(c.lines, start=1):
            sku = await _find_sku(session, customer.id, line.sku)
            sku_id = sku.id if sku else None

            if sku is None:
                any_unknown_sku = True
                unknown_for_this_container.append(line.sku)
            elif not sku.items_per_pallet:
                any_missing_master = True

            session.add(
                ContainerLine(
                    container_id=container.id,
                    sku_id=sku_id,
                    sku_raw=line.sku,
                    qty=line.qty,
                    line_index=idx,
                    product_type=line.product_type,
                )
            )

        await session.flush()

        containers_summary.append(
            ContainerCreated(
                container_id=container.id,
                container_no=container.container_no,
                lines_total=len(c.lines),
                unknown_skus=unknown_for_this_container,
            )
        )

    # 7. Open exceptions: one per distinct unknown SKU, one per SKU missing master
    distinct_unknown_skus: set[str] = set()
    for cs in containers_summary:
        distinct_unknown_skus.update(cs.unknown_skus)

    for sku_raw in distinct_unknown_skus:
        exc = ExceptionRecord(
            kind="unknown_sku",
            ref_type="do",
            ref_id=do.id,
            payload={
                "sku_raw": sku_raw,
                "customer": customer.name,
                "do_number": do.do_number,
                "whpo_number": whpo.whpo_number,
            },
            opened_by="vendor_intake",
        )
        session.add(exc)
        await session.flush()
        exceptions_opened.append(
            ExceptionOpened(
                exception_id=exc.id,
                kind=exc.kind,
                ref_type=exc.ref_type,
                ref_id=exc.ref_id,
                payload=exc.payload,
            )
        )

    # Missing-master-data exceptions (SKUs that exist but lack items_per_pallet)
    if any_missing_master:
        incomplete_skus = await _incomplete_skus_for_do(session, do.id)
        for sku_code in incomplete_skus:
            exc = ExceptionRecord(
                kind="missing_master_data",
                ref_type="do",
                ref_id=do.id,
                payload={
                    "sku": sku_code,
                    "missing": "items_per_pallet",
                    "customer": customer.name,
                    "do_number": do.do_number,
                },
                opened_by="vendor_intake",
            )
            session.add(exc)
            await session.flush()
            exceptions_opened.append(
                ExceptionOpened(
                    exception_id=exc.id,
                    kind=exc.kind,
                    ref_type=exc.ref_type,
                    ref_id=exc.ref_id,
                    payload=exc.payload,
                )
            )

    # 8. Finalize DO status
    do.status = "ready" if not (any_unknown_sku or any_missing_master) else "pending_master_data"

    # 9. Activity log
    session.add(
        ActivityLog(
            actor=payload.submitter_email,
            kind="whpo_submitted",
            ref_type="do",
            ref_id=do.id,
            message=f"WHPO {whpo.whpo_number} submitted → {do.do_number} ({do.status})",
            payload={
                "whpo_number": whpo.whpo_number,
                "do_number": do.do_number,
                "container_count": len(payload.containers),
                "exceptions_count": len(exceptions_opened),
            },
        )
    )

    await session.flush()

    return WHPOIntakeResponse(
        whpo_id=whpo.id,
        whpo_number=whpo.whpo_number,
        do_id=do.id,
        do_number=do.do_number,
        do_status=do.status,
        containers=containers_summary,
        exceptions_opened=exceptions_opened,
        idempotent_replay=False,
    )


# ─── Helpers ────────────────────────────────────────────────────────────


async def _find_customer(session: AsyncSession, name: str) -> Customer | None:
    # Case-insensitive exact match
    return await session.scalar(select(Customer).where(func.lower(Customer.name) == name.lower()))


async def _find_sku(session: AsyncSession, customer_id: int, code: str) -> SKU | None:
    return await session.scalar(
        select(SKU).where(SKU.customer_id == customer_id, SKU.sku == code)
    )


async def _next_do_number(session: AsyncSession, year: int) -> str:
    prefix = f"DO-{year}-"
    latest = await session.scalar(
        select(func.max(DO.do_number)).where(DO.do_number.like(f"{prefix}%"))
    )
    if latest is None:
        seq = 1
    else:
        m = re.search(r"(\d+)$", latest)
        seq = (int(m.group(1)) + 1) if m else 1
    return f"{prefix}{seq:04d}"


async def _incomplete_skus_for_do(session: AsyncSession, do_id: int) -> list[str]:
    rows = await session.execute(
        select(SKU.sku)
        .join(ContainerLine, ContainerLine.sku_id == SKU.id)
        .join(Container, Container.id == ContainerLine.container_id)
        .where(Container.do_id == do_id, SKU.items_per_pallet.is_(None))
        .distinct()
    )
    return [r[0] for r in rows]


async def fetch_inbound_rows_for_do(session: AsyncSession, do_id: int) -> list[dict]:
    """Flat per-line rows for a single DO — matches the Inbound view shape.

    Used by the vendor router to push freshly-submitted rows to Google Sheets
    after commit. Shape is intentionally identical to the manager's
    `_fetch_inbound` so the same headers apply everywhere.
    """
    from sqlalchemy import func as _func

    from app.models import ActivityLog

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
        .where(DO.id == do_id)
        .order_by(Container.container_no, ContainerLine.line_index)
    )
    rows = (await session.execute(q)).all()

    # Latest vendor amendment timestamp for this DO. Empty when only a
    # submission has happened (no updates yet).
    last_updated_iso: str = ""
    last_t = await session.scalar(
        select(_func.max(ActivityLog.t))
        .where(ActivityLog.ref_type == "do")
        .where(ActivityLog.ref_id == do_id)
        .where(ActivityLog.kind == "whpo_updated")
    )
    if last_t:
        last_updated_iso = last_t.isoformat()

    out: list[dict] = []
    for r in rows:
        payload = r.raw_payload or {}
        # Key order matters — Logic App's "Add a row into a table" uses
        # items('For_each')[N] positional indexing. Keep the original 19
        # columns first; bol_number is the new 20th column.
        out.append(
            {
                "container_no": r.container_no,
                "whpo_number": r.whpo_number,
                "expected_arrival_date": r.expected_arrival_date.isoformat() if r.expected_arrival_date else None,
                "expected_arrival_time": r.expected_arrival_time.isoformat() if r.expected_arrival_time else None,
                "qty": r.qty,
                "product_type": r.product_type,
                "sku": r.sku,
                "customer": r.customer,
                "do_number": r.do_number,
                "submitter_name": payload.get("submitter_name"),
                "submitter_email": payload.get("submitter_email"),
                "submitted_at": r.received_at.isoformat() if r.received_at else None,
                "driver_name": r.driver_name,
                "driver_license": r.driver_license,
                "driver_phone": r.driver_phone,
                "truck_license_plate": r.truck_license_plate,
                "insurance": r.insurance,
                "carrier": r.carrier,
                "last_updated_at": last_updated_iso,
                "bol_number": r.bol_number,
            }
        )
    return out


async def _build_replay_response(session: AsyncSession, whpo: WHPO) -> WHPOIntakeResponse:
    do = whpo.do
    container_summaries: list[ContainerCreated] = []
    for c in do.containers:
        unknown = [line.sku_raw for line in c.lines if line.sku_id is None]
        container_summaries.append(
            ContainerCreated(
                container_id=c.id,
                container_no=c.container_no,
                lines_total=len(c.lines),
                unknown_skus=unknown,
            )
        )

    exceptions_q = await session.scalars(
        select(ExceptionRecord).where(
            ExceptionRecord.ref_type == "do",
            ExceptionRecord.ref_id == do.id,
            ExceptionRecord.status == "open",
        )
    )
    exceptions_opened = [
        ExceptionOpened(
            exception_id=e.id,
            kind=e.kind,
            ref_type=e.ref_type,
            ref_id=e.ref_id,
            payload=e.payload,
        )
        for e in exceptions_q.all()
    ]

    return WHPOIntakeResponse(
        whpo_id=whpo.id,
        whpo_number=whpo.whpo_number,
        do_id=do.id,
        do_number=do.do_number,
        do_status=do.status,
        containers=container_summaries,
        exceptions_opened=exceptions_opened,
        idempotent_replay=True,
    )
