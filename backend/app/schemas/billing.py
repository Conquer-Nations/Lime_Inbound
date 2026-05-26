"""Pydantic schemas for the billing endpoints (manager + vendor)."""
from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class InvoiceLineRead(BaseModel):
    id: int
    code: str
    category: str
    description: str
    unit: str
    quantity: float
    unit_rate: float
    line_total: float
    taxable: bool = False
    auto_applied: bool = False
    override_reason: str | None = None
    source_container_id: int | None = None
    source_outbound_container_id: int | None = None


class InvoiceListItem(BaseModel):
    id: int
    invoice_number: str
    status: str
    customer_id: int
    customer_name: str | None = None
    whpo_number: str | None = None
    transfer_order_no: str | None = None
    invoice_date: date
    due_date: date | None = None
    total: float
    generated_at: datetime
    sent_at: datetime | None = None
    paid_at: datetime | None = None
    vendor_marked_paid_at: datetime | None = None


class InvoiceRead(BaseModel):
    id: int
    invoice_number: str
    status: str
    customer_id: int
    customer_name: str | None = None
    whpo_id: int | None = None
    whpo_number: str | None = None
    outbound_order_id: int | None = None
    transfer_order_no: str | None = None
    invoice_date: date
    due_date: date | None = None
    terms: str
    subtotal: float
    fuel_surcharge: float
    advancing: float
    adjustment: float
    adjustment_note: str | None = None
    operational_charge: float
    operational_charge_breakdown: dict[str, Any] | None = None
    tax: float
    total: float
    notes: str | None = None
    generated_at: datetime
    sent_at: datetime | None = None
    paid_at: datetime | None = None
    payment_method: str | None = None
    # Vendor self-pay fields
    vendor_payment_reference: str | None = None
    vendor_marked_paid_at: datetime | None = None
    vendor_marked_paid_by: str | None = None
    lines: list[InvoiceLineRead]


class InvoicePreview(BaseModel):
    """Returned from /invoice-preview endpoints. Shows the proposed
    auto-charge lines + totals before the manager commits."""

    scope: Literal["inbound", "outbound"]
    customer_id: int
    customer_name: str | None = None
    whpo_number: str | None = None
    transfer_order_no: str | None = None
    proposed_lines: list[InvoiceLineRead]
    operational_charge: float
    operational_charge_breakdown: dict[str, Any] | None = None
    subtotal: float
    fuel_surcharge: float
    advancing: float
    tax: float
    total: float


class AddInvoiceLineRequest(BaseModel):
    """Manual charge line entry — manager picks a code from the rate
    card, optionally overrides the rate. Quantity is required."""

    code: str = Field(..., min_length=1, max_length=20)
    quantity: float = Field(..., gt=0)
    unit_rate_override: float | None = None
    override_reason: str | None = None


class InvoiceStatusActionRequest(BaseModel):
    """Used by /send and /paid endpoints when a payment method needs
    to be recorded."""

    payment_method: str | None = None
    notes: str | None = None


class VendorMarkPaidRequest(BaseModel):
    """Body for POST /vendor/invoices/{id}/mark-paid. Vendor self-reports
    that they have submitted payment; manager then verifies."""

    payment_method: str | None = Field(
        None,
        max_length=40,
        description="ACH, Check, Wire, Zelle, etc.",
    )
    payment_reference: str | None = Field(
        None,
        max_length=120,
        description="Check #, ACH reference, Zelle confirmation, etc.",
    )
    notes: str | None = None


class RateCardRow(BaseModel):
    code: str
    category: str
    description: str
    unit: str
    rate: float | None = None
    taxable: bool = False
    is_minimum: bool = False
    is_advance: bool = False
    note: str | None = None
    max_per_request: float | None = None
    min_advance: float | None = None


class RateCardCreate(BaseModel):
    """Developer-only — add a new rate code to the master card."""

    code: str = Field(..., min_length=1, max_length=20)
    category: str = Field(..., min_length=1, max_length=40)
    description: str = Field(..., min_length=1)
    unit: str = Field(..., min_length=1, max_length=80)
    rate: float | None = None
    taxable: bool = False
    is_minimum: bool = False
    is_advance: bool = False
    note: str | None = None
    max_per_request: float | None = None
    min_advance: float | None = None


class RateCardUpdate(BaseModel):
    """Developer-only — patch an existing rate code. All fields optional;
    `code` itself cannot be renamed (it's referenced by existing invoice
    lines as a snapshot)."""

    category: str | None = Field(None, min_length=1, max_length=40)
    description: str | None = Field(None, min_length=1)
    unit: str | None = Field(None, min_length=1, max_length=80)
    rate: float | None = None
    taxable: bool | None = None
    is_minimum: bool | None = None
    is_advance: bool | None = None
    note: str | None = None
    max_per_request: float | None = None
    min_advance: float | None = None
