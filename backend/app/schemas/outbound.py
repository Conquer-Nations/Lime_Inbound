"""Pydantic schemas for the outbound flow.

Mirrors the inbound vendor schemas. The customer submits a Transfer Order
(picking ticket) — header + line items. Each line can optionally pin
specific serials the customer needs; otherwise the operator picks any
matching SKU from inventory.
"""

from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, Field


# ─── Submit / update an outbound order ─────────────────────────────────


class OutboundLineInput(BaseModel):
    """One line on a Transfer Order at submission time."""

    line_no: int = Field(ge=1)
    sku: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    order_qty: int = Field(ge=1)
    unit: str = Field(default="EA", max_length=16)
    serial_specific: bool = False
    # Only used when serial_specific = True. Caller validates length matches qty.
    serials: list[str] | None = None
    notes: str | None = Field(default=None, max_length=400)


class OutboundOrderSubmission(BaseModel):
    """Picking-ticket payload from the vendor portal."""

    transfer_order_no: str = Field(min_length=1, max_length=80)
    customer: str = Field(min_length=1, max_length=120)
    order_date: date | None = None
    priority: str = Field(default="normal", max_length=32)
    memo: str | None = Field(default=None, max_length=2000)
    ship_from_name: str | None = Field(default=None, max_length=120)
    ship_from_address: str | None = Field(default=None, max_length=2000)
    ship_to_name: str | None = Field(default=None, max_length=255)
    ship_to_address: str | None = Field(default=None, max_length=2000)
    lines: list[OutboundLineInput]
    notes: str | None = Field(default=None, max_length=2000)


class OutboundOrderUpdateRequest(BaseModel):
    """Edit an open Transfer Order — same shape as the submission minus
    transfer_order_no (taken from the path)."""

    customer: str = Field(min_length=1, max_length=120)
    order_date: date | None = None
    priority: str = Field(default="normal", max_length=32)
    memo: str | None = Field(default=None, max_length=2000)
    ship_from_name: str | None = Field(default=None, max_length=120)
    ship_from_address: str | None = Field(default=None, max_length=2000)
    ship_to_name: str | None = Field(default=None, max_length=255)
    ship_to_address: str | None = Field(default=None, max_length=2000)
    lines: list[OutboundLineInput]
    notes: str | None = Field(default=None, max_length=2000)


class OutboundIntakeResponse(BaseModel):
    order_id: int
    transfer_order_no: str
    po_number: str | None
    status: str
    submitted_at: datetime


class OutboundUpdateResponse(BaseModel):
    order_id: int
    transfer_order_no: str
    po_number: str | None
    status: str


# ─── Read views (view shipment / list) ─────────────────────────────────


class OutboundLineRead(BaseModel):
    id: int
    line_no: int
    sku: str
    description: str | None
    order_qty: int
    picked_qty: int = 0
    unit: str
    serial_specific: bool
    serials_requested: list[str] = []


class OutboundContainerRead(BaseModel):
    id: int
    container_no: str
    container_type: str
    status: str
    driver_name: str | None
    driver_license: str | None
    driver_phone: str | None
    truck_license_plate: str | None
    carrier: str | None
    insurance: str | None
    bol_number: str | None
    started_at: datetime | None
    sealed_at: datetime | None


class OutboundOrderRead(BaseModel):
    id: int
    transfer_order_no: str
    po_number: str | None
    customer_name: str
    order_date: date | None
    priority: str
    memo: str | None
    ship_from_name: str | None
    ship_from_address: str | None
    ship_to_name: str | None
    ship_to_address: str | None
    status: str
    submitted_at: datetime
    submitted_by: str | None
    notes: str | None
    lines: list[OutboundLineRead]
    containers: list[OutboundContainerRead] = []


class OutboundOrderListItem(BaseModel):
    """Compact row for the vendor's order-list table."""

    id: int
    transfer_order_no: str
    po_number: str | None
    customer_name: str
    order_date: date | None
    priority: str
    status: str
    line_count: int
    submitted_at: datetime


class OutboundOrderListResponse(BaseModel):
    orders: list[OutboundOrderListItem]


# ─── Driver / container attach ─────────────────────────────────────────


class OutboundContainerAttachRequest(BaseModel):
    """Vendor attaches an outbound container (BIC or truck) to a Transfer
    Order and fills in driver/truck info — exact mirror of the inbound
    driver-info screen."""

    container_no: str = Field(min_length=1, max_length=40)
    container_type: str = Field(default="bic", max_length=16)  # "bic" or "truck"
    driver_name: str | None = Field(default=None, max_length=120)
    driver_license: str | None = Field(default=None, max_length=60)
    driver_phone: str | None = Field(default=None, max_length=40)
    truck_license_plate: str | None = Field(default=None, max_length=20)
    insurance: str | None = Field(default=None, max_length=400)
    carrier: str | None = Field(default=None, max_length=120)
    bol_number: str | None = Field(default=None, max_length=80)


class OutboundContainerAttachResponse(BaseModel):
    container_id: int
    container_no: str
    status: str


# ─── Inventory query (available stock) ─────────────────────────────────


class InventoryItem(BaseModel):
    sku: str
    available_qty: int


class InventoryResponse(BaseModel):
    items: list[InventoryItem]
