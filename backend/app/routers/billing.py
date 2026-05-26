"""Billing endpoints — manager full ERP + vendor read-only.

Manager surface (no auth gate — same as the rest of /manager/*):
  GET    /manager/rate-card                       — list all codes
  GET    /manager/invoices                        — list, filter
  GET    /manager/invoices/{id}                   — detail
  GET    /manager/invoices/{id}/pdf?type=...      — download PDF
  POST   /manager/whpos/{whpo}/invoice-preview    — proposed inbound charges
  POST   /manager/whpos/{whpo}/invoice            — generate inbound invoice
  POST   /manager/outbound-orders/{to}/invoice-preview   — proposed outbound
  POST   /manager/outbound-orders/{to}/invoice    — generate outbound invoice
  POST   /manager/invoices/{id}/lines             — add manual line
  DELETE /manager/invoices/{id}/lines/{line_id}   — remove line
  POST   /manager/invoices/{id}/send              — status → sent
  POST   /manager/invoices/{id}/paid              — status → paid
  POST   /manager/invoices/{id}/void              — status → void

Vendor surface (JWT-scoped to their customer.account_id, hides
billing internals):
  GET    /vendor/invoices                         — list THEIR invoices
  GET    /vendor/invoices/{id}/pdf                — customer PDF only
"""
from __future__ import annotations

import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import Response
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db import get_session
from app.models import (
    Customer,
    DO,
    Invoice,
    InvoiceLine,
    OutboundOrder,
    RateCard,
    WHPO,
)
from app.schemas.billing import (
    AddInvoiceLineRequest,
    InvoiceListItem,
    InvoiceLineRead,
    InvoicePreview,
    InvoiceRead,
    InvoiceStatusActionRequest,
    RateCardRow,
)
from app.services import billing_auto_charges, invoice_pdf, invoice_pricing
from app.services import operational_charge as op_charge
from app.services.vendor_auth_service import current_vendor_required
from app.services.vendor_scoping import vendor_customer_ids

logger = logging.getLogger(__name__)

# ─── Helpers ────────────────────────────────────────────────────────


def _line_to_read(line: InvoiceLine) -> InvoiceLineRead:
    return InvoiceLineRead(
        id=line.id,
        code=line.code,
        category=line.category,
        description=line.description,
        unit=line.unit,
        quantity=line.quantity,
        unit_rate=line.unit_rate,
        line_total=line.line_total,
        taxable=line.taxable,
        auto_applied=line.auto_applied,
        override_reason=line.override_reason,
        source_container_id=line.source_container_id,
        source_outbound_container_id=line.source_outbound_container_id,
    )


def _list_item_to_read(inv: Invoice, customer_name: str | None,
                       whpo_number: str | None, transfer_order_no: str | None) -> InvoiceListItem:
    return InvoiceListItem(
        id=inv.id,
        invoice_number=inv.invoice_number,
        status=inv.status,
        customer_id=inv.customer_id,
        customer_name=customer_name,
        whpo_number=whpo_number,
        transfer_order_no=transfer_order_no,
        invoice_date=inv.invoice_date,
        due_date=inv.due_date,
        total=inv.total,
        generated_at=inv.generated_at,
        sent_at=inv.sent_at,
        paid_at=inv.paid_at,
    )


def _to_read(inv: Invoice, customer_name: str | None,
             whpo_number: str | None, transfer_order_no: str | None) -> InvoiceRead:
    return InvoiceRead(
        id=inv.id,
        invoice_number=inv.invoice_number,
        status=inv.status,
        customer_id=inv.customer_id,
        customer_name=customer_name,
        whpo_id=inv.whpo_id,
        whpo_number=whpo_number,
        outbound_order_id=inv.outbound_order_id,
        transfer_order_no=transfer_order_no,
        invoice_date=inv.invoice_date,
        due_date=inv.due_date,
        terms=inv.terms,
        subtotal=inv.subtotal,
        fuel_surcharge=inv.fuel_surcharge,
        advancing=inv.advancing,
        adjustment=inv.adjustment,
        adjustment_note=inv.adjustment_note,
        operational_charge=inv.operational_charge,
        operational_charge_breakdown=inv.operational_charge_breakdown,
        tax=inv.tax,
        total=inv.total,
        notes=inv.notes,
        generated_at=inv.generated_at,
        sent_at=inv.sent_at,
        paid_at=inv.paid_at,
        payment_method=inv.payment_method,
        lines=[_line_to_read(line) for line in (inv.lines or [])],
    )


async def _next_invoice_number(session: AsyncSession) -> str:
    """Atomic counter via Postgres sequence. Format CN-YYYYMMDD-####."""
    seq_n = await session.scalar(select(func.nextval("invoice_number_seq")))
    today_yyyymmdd = datetime.utcnow().strftime("%Y%m%d")
    return f"CN-{today_yyyymmdd}-{int(seq_n):04d}"


async def _refresh_totals(session: AsyncSession, invoice: Invoice) -> None:
    """Recompute + persist totals after lines change. Honors the stored
    operational_charge / adjustment / op-breakdown (those don't change
    automatically). Tax rate hardcoded to CA 9.5% for Phase 1; Phase 2
    reads from settings."""
    await session.refresh(invoice)
    res = await session.execute(
        select(InvoiceLine).where(InvoiceLine.invoice_id == invoice.id)
    )
    lines = list(res.scalars())
    totals = invoice_pricing.invoice_totals_from_lines(
        lines,
        tax_rate=0.095,
        adjustment=invoice.adjustment or 0,
        operational_charge=invoice.operational_charge or 0,
    )
    invoice.subtotal = totals["subtotal"]
    invoice.fuel_surcharge = totals["fuel"]
    invoice.advancing = totals["advancing"]
    invoice.tax = totals["tax"]
    invoice.total = totals["total"]
    await session.commit()


# ─── Manager router ─────────────────────────────────────────────────


manager_router = APIRouter(prefix="/manager", tags=["manager-billing"])


@manager_router.get("/rate-card", response_model=list[RateCardRow])
async def list_rate_card(session: AsyncSession = Depends(get_session)):
    rows = await session.scalars(select(RateCard).order_by(RateCard.category, RateCard.code))
    return [
        RateCardRow(
            code=r.code,
            category=r.category,
            description=r.description,
            unit=r.unit,
            rate=r.rate,
            taxable=r.taxable,
            is_minimum=r.is_minimum,
            is_advance=r.is_advance,
            note=r.note,
            max_per_request=r.max_per_request,
            min_advance=r.min_advance,
        )
        for r in rows
    ]


@manager_router.get("/invoices", response_model=list[InvoiceListItem])
async def list_invoices(
    status_filter: str | None = Query(None, alias="status"),
    customer_id: int | None = None,
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    session: AsyncSession = Depends(get_session),
):
    q = (
        select(Invoice, Customer.name, WHPO.whpo_number, OutboundOrder.transfer_order_no)
        .join(Customer, Customer.id == Invoice.customer_id)
        .outerjoin(WHPO, WHPO.id == Invoice.whpo_id)
        .outerjoin(OutboundOrder, OutboundOrder.id == Invoice.outbound_order_id)
        .order_by(desc(Invoice.generated_at))
    )
    if status_filter:
        q = q.where(Invoice.status == status_filter)
    if customer_id:
        q = q.where(Invoice.customer_id == customer_id)
    q = q.limit(limit).offset(offset)
    rows = (await session.execute(q)).all()
    return [_list_item_to_read(inv, name, whpo_no, to_no) for (inv, name, whpo_no, to_no) in rows]


@manager_router.get("/invoices/{invoice_id}", response_model=InvoiceRead)
async def get_invoice(invoice_id: int, session: AsyncSession = Depends(get_session)):
    return await _load_invoice_read(session, invoice_id)


async def _load_invoice_read(session: AsyncSession, invoice_id: int) -> InvoiceRead:
    row = (
        await session.execute(
            select(Invoice, Customer.name, WHPO.whpo_number, OutboundOrder.transfer_order_no)
            .join(Customer, Customer.id == Invoice.customer_id)
            .outerjoin(WHPO, WHPO.id == Invoice.whpo_id)
            .outerjoin(OutboundOrder, OutboundOrder.id == Invoice.outbound_order_id)
            .where(Invoice.id == invoice_id)
        )
    ).first()
    if row is None:
        raise HTTPException(404, f"Invoice {invoice_id} not found")
    inv, customer_name, whpo_no, to_no = row
    # Load lines eagerly for the response.
    lines = (
        await session.scalars(
            select(InvoiceLine)
            .where(InvoiceLine.invoice_id == invoice_id)
            .order_by(InvoiceLine.id)
        )
    ).all()
    inv.lines = list(lines)
    return _to_read(inv, customer_name, whpo_no, to_no)


@manager_router.get("/invoices/{invoice_id}/pdf")
async def get_invoice_pdf(
    invoice_id: int,
    pdf_type: str = Query("customer", alias="type", pattern="^(customer|servicelog)$"),
    session: AsyncSession = Depends(get_session),
):
    """Stream the customer-facing PDF (default) or the service-log
    backup. Generated on the fly so manager edits to lines flow through
    immediately — Phase 2 we can cache to disk if performance bites."""
    inv = await session.get(Invoice, invoice_id)
    if inv is None:
        raise HTTPException(404, f"Invoice {invoice_id} not found")
    customer = await session.get(Customer, inv.customer_id)
    lines = (
        await session.scalars(
            select(InvoiceLine)
            .where(InvoiceLine.invoice_id == invoice_id)
            .order_by(InvoiceLine.id)
        )
    ).all()
    if pdf_type == "servicelog":
        pdf = invoice_pdf.generate_service_log_pdf(inv, customer, list(lines))
        filename = f"{inv.invoice_number}-servicelog.pdf"
    else:
        pdf = invoice_pdf.generate_customer_invoice_pdf(inv, customer, list(lines))
        filename = f"{inv.invoice_number}.pdf"
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


# ─── Invoice generation (preview + commit) ───────────────────────────


async def _preview_inbound(session: AsyncSession, whpo_number: str) -> InvoicePreview:
    whpo = await session.scalar(
        select(WHPO)
        .where(WHPO.whpo_number == whpo_number)
        .options(selectinload(WHPO.customer))
    )
    if whpo is None:
        raise HTTPException(404, f"WHPO {whpo_number} not found")
    customer = whpo.customer
    proposed = await billing_auto_charges.propose_inbound_charges(session, whpo.id)

    # Operational charge: pull from customer.profile_json + calculator
    op = op_charge.calculate(customer.profile_json if customer else None)
    op_snapshot = op_charge.snapshot_for_invoice(
        customer.profile_json if customer else None, op["monthly"]
    )

    # Mimic invoice_pricing.invoice_totals_from_lines using dicts.
    totals = invoice_pricing.invoice_totals_from_lines(
        proposed, tax_rate=0.095, operational_charge=op["monthly"]
    )
    return InvoicePreview(
        scope="inbound",
        customer_id=customer.id if customer else 0,
        customer_name=customer.name if customer else None,
        whpo_number=whpo_number,
        proposed_lines=[
            InvoiceLineRead(
                id=0,  # not yet persisted
                code=p["code"],
                category=p["category"],
                description=p["description"],
                unit=p["unit"],
                quantity=p["quantity"],
                unit_rate=p["unit_rate"],
                line_total=p["line_total"],
                taxable=p["taxable"],
                auto_applied=True,
                source_container_id=p.get("source_container_id"),
                source_outbound_container_id=p.get("source_outbound_container_id"),
            )
            for p in proposed
        ],
        operational_charge=op["monthly"],
        operational_charge_breakdown=op_snapshot,
        subtotal=totals["subtotal"],
        fuel_surcharge=totals["fuel"],
        advancing=totals["advancing"],
        tax=totals["tax"],
        total=totals["total"],
    )


async def _preview_outbound(session: AsyncSession, transfer_order_no: str) -> InvoicePreview:
    order = await session.scalar(
        select(OutboundOrder)
        .where(OutboundOrder.transfer_order_no == transfer_order_no)
        .options(selectinload(OutboundOrder.customer))
    )
    if order is None:
        raise HTTPException(404, f"Transfer Order {transfer_order_no} not found")
    customer = order.customer
    proposed = await billing_auto_charges.propose_outbound_charges(session, order.id)
    op = op_charge.calculate(customer.profile_json if customer else None)
    op_snapshot = op_charge.snapshot_for_invoice(
        customer.profile_json if customer else None, op["monthly"]
    )
    totals = invoice_pricing.invoice_totals_from_lines(
        proposed, tax_rate=0.095, operational_charge=op["monthly"]
    )
    return InvoicePreview(
        scope="outbound",
        customer_id=customer.id if customer else 0,
        customer_name=customer.name if customer else None,
        transfer_order_no=transfer_order_no,
        proposed_lines=[
            InvoiceLineRead(
                id=0,
                code=p["code"],
                category=p["category"],
                description=p["description"],
                unit=p["unit"],
                quantity=p["quantity"],
                unit_rate=p["unit_rate"],
                line_total=p["line_total"],
                taxable=p["taxable"],
                auto_applied=True,
                source_container_id=p.get("source_container_id"),
                source_outbound_container_id=p.get("source_outbound_container_id"),
            )
            for p in proposed
        ],
        operational_charge=op["monthly"],
        operational_charge_breakdown=op_snapshot,
        subtotal=totals["subtotal"],
        fuel_surcharge=totals["fuel"],
        advancing=totals["advancing"],
        tax=totals["tax"],
        total=totals["total"],
    )


@manager_router.post("/whpos/{whpo_number}/invoice-preview", response_model=InvoicePreview)
async def preview_inbound_invoice(
    whpo_number: str,
    session: AsyncSession = Depends(get_session),
):
    return await _preview_inbound(session, whpo_number)


@manager_router.post(
    "/whpos/{whpo_number}/invoice",
    response_model=InvoiceRead,
    status_code=status.HTTP_201_CREATED,
)
async def generate_inbound_invoice(
    whpo_number: str,
    session: AsyncSession = Depends(get_session),
):
    whpo = await session.scalar(
        select(WHPO)
        .where(WHPO.whpo_number == whpo_number)
        .options(selectinload(WHPO.customer))
    )
    if whpo is None:
        raise HTTPException(404, f"WHPO {whpo_number} not found")
    # One invoice per WHPO — block duplicate generation.
    existing = await session.scalar(
        select(Invoice).where(Invoice.whpo_id == whpo.id)
    )
    if existing is not None:
        raise HTTPException(
            409,
            f"WHPO {whpo_number} already has invoice {existing.invoice_number}. "
            "Edit lines on that invoice instead.",
        )
    return await _commit_invoice(
        session,
        scope="inbound",
        whpo_id=whpo.id,
        outbound_order_id=None,
        customer=whpo.customer,
    )


@manager_router.post(
    "/outbound-orders/{transfer_order_no}/invoice-preview",
    response_model=InvoicePreview,
)
async def preview_outbound_invoice(
    transfer_order_no: str,
    session: AsyncSession = Depends(get_session),
):
    return await _preview_outbound(session, transfer_order_no)


@manager_router.post(
    "/outbound-orders/{transfer_order_no}/invoice",
    response_model=InvoiceRead,
    status_code=status.HTTP_201_CREATED,
)
async def generate_outbound_invoice(
    transfer_order_no: str,
    session: AsyncSession = Depends(get_session),
):
    order = await session.scalar(
        select(OutboundOrder)
        .where(OutboundOrder.transfer_order_no == transfer_order_no)
        .options(selectinload(OutboundOrder.customer))
    )
    if order is None:
        raise HTTPException(404, f"Transfer Order {transfer_order_no} not found")
    existing = await session.scalar(
        select(Invoice).where(Invoice.outbound_order_id == order.id)
    )
    if existing is not None:
        raise HTTPException(
            409,
            f"TO {transfer_order_no} already has invoice {existing.invoice_number}. "
            "Edit lines on that invoice instead.",
        )
    return await _commit_invoice(
        session,
        scope="outbound",
        whpo_id=None,
        outbound_order_id=order.id,
        customer=order.customer,
    )


async def _commit_invoice(
    session: AsyncSession,
    *,
    scope: str,
    whpo_id: int | None,
    outbound_order_id: int | None,
    customer: Customer,
) -> InvoiceRead:
    """Create an Invoice row + auto-proposed lines + totals."""
    if scope == "inbound":
        proposed = await billing_auto_charges.propose_inbound_charges(session, whpo_id)
    else:
        proposed = await billing_auto_charges.propose_outbound_charges(session, outbound_order_id)

    op = op_charge.calculate(customer.profile_json if customer else None)
    op_snapshot = op_charge.snapshot_for_invoice(
        customer.profile_json if customer else None, op["monthly"]
    )

    inv_number = await _next_invoice_number(session)
    invoice_date = datetime.utcnow().date()
    due_date = invoice_pricing.compute_due_date(invoice_date, "Net 30")

    invoice = Invoice(
        invoice_number=inv_number,
        customer_id=customer.id,
        whpo_id=whpo_id,
        outbound_order_id=outbound_order_id,
        status="draft",
        invoice_date=invoice_date,
        due_date=due_date,
        terms="Net 30",
        subtotal=0,
        operational_charge=op["monthly"],
        operational_charge_breakdown=op_snapshot,
        total=0,
    )
    session.add(invoice)
    await session.flush()

    for p in proposed:
        session.add(
            InvoiceLine(
                invoice_id=invoice.id,
                code=p["code"],
                category=p["category"],
                description=p["description"],
                unit=p["unit"],
                quantity=p["quantity"],
                unit_rate=p["unit_rate"],
                line_total=p["line_total"],
                taxable=p["taxable"],
                auto_applied=True,
                source_container_id=p.get("source_container_id"),
                source_outbound_container_id=p.get("source_outbound_container_id"),
            )
        )
    await session.flush()
    await invoice_pricing.recompute_picking_minimum(session, invoice.id)
    await _refresh_totals(session, invoice)
    return await _load_invoice_read(session, invoice.id)


# ─── Line CRUD ─────────────────────────────────────────────────────


@manager_router.post(
    "/invoices/{invoice_id}/lines",
    response_model=InvoiceRead,
    status_code=status.HTTP_201_CREATED,
)
async def add_invoice_line(
    invoice_id: int,
    payload: AddInvoiceLineRequest,
    session: AsyncSession = Depends(get_session),
):
    invoice = await session.get(Invoice, invoice_id)
    if invoice is None:
        raise HTTPException(404, f"Invoice {invoice_id} not found")
    if invoice.status not in ("draft", "ready"):
        raise HTTPException(
            409, f"Invoice {invoice.invoice_number} is {invoice.status} — no more edits"
        )
    rate = await session.get(RateCard, payload.code)
    if rate is None:
        raise HTTPException(404, f"Rate card code {payload.code} not found")
    unit_rate = payload.unit_rate_override if payload.unit_rate_override is not None else (rate.rate or 0)
    line_total = round(payload.quantity * unit_rate * 100) / 100
    session.add(
        InvoiceLine(
            invoice_id=invoice.id,
            code=rate.code,
            category=rate.category,
            description=rate.description,
            unit=rate.unit,
            quantity=payload.quantity,
            unit_rate=unit_rate,
            line_total=line_total,
            taxable=rate.taxable,
            auto_applied=False,
            override_reason=payload.override_reason,
        )
    )
    await session.flush()
    await invoice_pricing.recompute_picking_minimum(session, invoice.id)
    await _refresh_totals(session, invoice)
    return await _load_invoice_read(session, invoice.id)


@manager_router.delete(
    "/invoices/{invoice_id}/lines/{line_id}",
    response_model=InvoiceRead,
)
async def remove_invoice_line(
    invoice_id: int,
    line_id: int,
    session: AsyncSession = Depends(get_session),
):
    invoice = await session.get(Invoice, invoice_id)
    if invoice is None:
        raise HTTPException(404, f"Invoice {invoice_id} not found")
    if invoice.status not in ("draft", "ready"):
        raise HTTPException(
            409, f"Invoice {invoice.invoice_number} is {invoice.status} — no more edits"
        )
    line = await session.get(InvoiceLine, line_id)
    if line is None or line.invoice_id != invoice_id:
        raise HTTPException(404, f"Line {line_id} not on invoice {invoice.invoice_number}")
    await session.delete(line)
    await session.flush()
    await invoice_pricing.recompute_picking_minimum(session, invoice.id)
    await _refresh_totals(session, invoice)
    return await _load_invoice_read(session, invoice.id)


# ─── Status transitions ────────────────────────────────────────────


@manager_router.post("/invoices/{invoice_id}/send", response_model=InvoiceRead)
async def mark_invoice_sent(
    invoice_id: int,
    payload: InvoiceStatusActionRequest | None = None,
    session: AsyncSession = Depends(get_session),
):
    invoice = await session.get(Invoice, invoice_id)
    if invoice is None:
        raise HTTPException(404, f"Invoice {invoice_id} not found")
    if invoice.status in ("paid", "void"):
        raise HTTPException(
            409, f"Invoice {invoice.invoice_number} is {invoice.status}"
        )
    invoice.status = "sent"
    invoice.sent_at = datetime.utcnow()
    if payload and payload.notes:
        invoice.notes = payload.notes
    await session.commit()
    return await _load_invoice_read(session, invoice.id)


@manager_router.post("/invoices/{invoice_id}/paid", response_model=InvoiceRead)
async def mark_invoice_paid(
    invoice_id: int,
    payload: InvoiceStatusActionRequest | None = None,
    session: AsyncSession = Depends(get_session),
):
    invoice = await session.get(Invoice, invoice_id)
    if invoice is None:
        raise HTTPException(404, f"Invoice {invoice_id} not found")
    if invoice.status == "void":
        raise HTTPException(409, f"Invoice {invoice.invoice_number} is void")
    invoice.status = "paid"
    invoice.paid_at = datetime.utcnow()
    if payload and payload.payment_method:
        invoice.payment_method = payload.payment_method
    if payload and payload.notes:
        invoice.notes = payload.notes
    await session.commit()
    return await _load_invoice_read(session, invoice.id)


@manager_router.post("/invoices/{invoice_id}/void", response_model=InvoiceRead)
async def void_invoice(
    invoice_id: int,
    payload: InvoiceStatusActionRequest | None = None,
    session: AsyncSession = Depends(get_session),
):
    invoice = await session.get(Invoice, invoice_id)
    if invoice is None:
        raise HTTPException(404, f"Invoice {invoice_id} not found")
    invoice.status = "void"
    if payload and payload.notes:
        invoice.notes = payload.notes
    await session.commit()
    return await _load_invoice_read(session, invoice.id)


# ─── Vendor router ─────────────────────────────────────────────────


vendor_router = APIRouter(prefix="/vendor", tags=["vendor-billing"])


@vendor_router.get("/invoices", response_model=list[InvoiceListItem])
async def list_my_invoices(
    vendor: dict = Depends(current_vendor_required),
    session: AsyncSession = Depends(get_session),
):
    """Vendor's invoices. Scoped server-side to the brands they can
    access (direct-brand match OR all brands under their Account)."""
    customer_ids = await vendor_customer_ids(session, vendor)
    if not customer_ids:
        return []
    q = (
        select(Invoice, Customer.name, WHPO.whpo_number, OutboundOrder.transfer_order_no)
        .join(Customer, Customer.id == Invoice.customer_id)
        .outerjoin(WHPO, WHPO.id == Invoice.whpo_id)
        .outerjoin(OutboundOrder, OutboundOrder.id == Invoice.outbound_order_id)
        .where(Invoice.customer_id.in_(customer_ids))
        # Don't expose drafts — vendor sees an invoice once it's at least 'sent'.
        .where(Invoice.status.in_(("sent", "paid")))
        .order_by(desc(Invoice.generated_at))
    )
    rows = (await session.execute(q)).all()
    return [_list_item_to_read(inv, name, whpo_no, to_no) for (inv, name, whpo_no, to_no) in rows]


@vendor_router.get("/invoices/{invoice_id}/pdf")
async def get_my_invoice_pdf(
    invoice_id: int,
    vendor: dict = Depends(current_vendor_required),
    session: AsyncSession = Depends(get_session),
):
    """Vendor downloads the customer-facing PDF for one of their own
    invoices. Service-log download is manager-only (AP detail isn't
    something the vendor needs)."""
    customer_ids = await vendor_customer_ids(session, vendor)
    inv = await session.get(Invoice, invoice_id)
    if inv is None or inv.customer_id not in customer_ids:
        raise HTTPException(404, "Invoice not found")
    if inv.status not in ("sent", "paid"):
        raise HTTPException(404, "Invoice not found")
    customer = await session.get(Customer, inv.customer_id)
    lines = (
        await session.scalars(
            select(InvoiceLine)
            .where(InvoiceLine.invoice_id == invoice_id)
            .order_by(InvoiceLine.id)
        )
    ).all()
    pdf = invoice_pdf.generate_customer_invoice_pdf(inv, customer, list(lines))
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="{inv.invoice_number}.pdf"'
        },
    )
