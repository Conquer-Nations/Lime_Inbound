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
    # Optional — vendor picks which inbound container this line draws from.
    source_container_no: str | None = Field(default=None, max_length=40)
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
    source_container_no: str | None = None


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
    scheduled_arrival_at: datetime | None
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
    """Vendor attaches a truck (or, rarely, a BIC container) to a Transfer
    Order and fills in driver / carrier info. For outbound we don't
    receive a container number — the backend auto-generates one if the
    payload omits it and there's no plate to use as a natural key."""

    # Optional: vendor doesn't get a container # for outbound. Backend
    # auto-derives from truck plate / generates a placeholder when blank.
    container_no: str | None = Field(default=None, max_length=40)
    # Default "truck" because the vast majority of outbound shipments
    # leave on a smaller truck, not a BIC container.
    container_type: str = Field(default="truck", max_length=16)
    driver_name: str | None = Field(default=None, max_length=120)
    driver_license: str | None = Field(default=None, max_length=60)
    driver_phone: str | None = Field(default=None, max_length=40)
    truck_license_plate: str | None = Field(default=None, max_length=20)
    insurance: str | None = Field(default=None, max_length=400)
    carrier: str | None = Field(default=None, max_length=120)
    bol_number: str | None = Field(default=None, max_length=80)
    # When the driver is scheduled to arrive at the dock. Optional.
    scheduled_arrival_at: datetime | None = None


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


# ─── Per-container inventory dashboard ─────────────────────────────────


class ContainerInventoryItem(BaseModel):
    """One row of the vendor's inventory dashboard. Aggregates per-
    (container, sku) so a multi-SKU container shows multiple rows."""

    container_no: str
    sku: str
    description: str | None = None
    inbound_qty: int
    outbound_qty: int  # sum of OutboundLine.order_qty allocated to this container
    pending_qty: int  # inbound_qty - outbound_qty
    received_date: date | None = None
    # TOs that have already drawn from this container — shown as a small
    # list so the vendor can trace outbound allocations.
    allocated_to: list[str] = []  # transfer_order_no values


class ContainerInventoryResponse(BaseModel):
    containers: list[ContainerInventoryItem]
    # Top-level totals for the dashboard header.
    total_inbound: int
    total_outbound: int
    total_pending: int


# ─── Status timeline (vendor visibility) ──────────────────────────────


class OutboundStatusEvent(BaseModel):
    stage: str  # 'order_placed' | 'truck_attached' | 'truck_arrived' | 'loading' | 'sealed'
    label: str
    at: datetime | None = None


class OutboundContainerStatus(BaseModel):
    container_no: str  # truck plate
    current_stage: str
    timeline: list[OutboundStatusEvent]


class OutboundOrderStatusResponse(BaseModel):
    transfer_order_no: str
    po_number: str | None
    customer_name: str
    order_placed_at: datetime
    containers: list[OutboundContainerStatus]
