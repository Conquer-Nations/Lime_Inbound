"""ERP-style drilldown schemas for the manager portal.

These power /manager/containers/{container_no} and
/manager/outbound-orders/{transfer_order_no} — the two big "everything about
this shipment" pages that the manager uses as the single pane of glass before
invoicing.

The shape is intentionally denormalised — the page renders sections, the
backend assembles all of them in one round-trip so we never block on N+1
fetches in the browser.
"""

from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel


# ─── Tiny shared bits ───────────────────────────────────────────────────


class StageEvent(BaseModel):
    stage: str
    label: str
    at: datetime | None


# ─── Container detail (inbound drilldown) ──────────────────────────────


class ContainerDocumentSummary(BaseModel):
    kind: str
    label: str
    filename: str
    content_type: str
    file_size: int
    uploaded_at: datetime
    uploaded_by: str | None
    url: str


class ContainerLineSummary(BaseModel):
    line_id: int
    sku: str
    sku_raw: str
    qty: int
    product_type: str | None
    sku_resolved: bool
    description: str | None


class LotAssignmentSummary(BaseModel):
    assignment_order: int
    lot_code: str
    floor_name: str
    sku: str
    planned_pallets: int
    actual_pallets: int
    status: str


class ScanRowSummary(BaseModel):
    id: int
    serial_number: str | None
    imei: str | None
    sku: str | None
    box_number: int | None
    scanned_by: str
    scanned_at: datetime
    notes: str | None
    result: str | None


class OutboundLinkSummary(BaseModel):
    """An outbound TO line that points at this container as its source."""
    outbound_order_id: int
    transfer_order_no: str
    po_number: str | None
    customer_name: str
    order_status: str
    line_id: int
    line_no: int
    sku: str
    order_qty: int
    picked_qty: int
    order_date: date | None


class ExceptionSummary(BaseModel):
    exception_id: int
    kind: str
    status: str
    opened_at: datetime
    opened_by: str | None
    resolved_at: datetime | None
    resolved_by: str | None
    payload: dict | None


class ActivityEntry(BaseModel):
    id: int
    t: datetime
    actor: str | None
    kind: str
    message: str | None


class ContainerDetailResponse(BaseModel):
    # Identity / order context
    container_id: int
    container_no: str
    status: str
    customer_name: str
    whpo_id: int
    whpo_number: str
    do_id: int
    do_number: str
    bol_number: str | None

    # Arrival
    expected_arrival_date: date | None
    expected_arrival_time: str | None  # HH:MM
    actual_arrival_date: date | None
    actual_arrival_time: str | None
    started_at: datetime | None
    finished_at: datetime | None
    started_by: str | None
    finished_by: str | None

    # Driver / truck
    driver_name: str | None
    driver_license: str | None
    driver_phone: str | None
    truck_license_plate: str | None
    carrier: str | None
    insurance: str | None
    driver_info_received_at: datetime | None

    # Packaging / space (lets the manager confirm the put-away plan)
    on_pallet: bool | None
    pallet_length_in: float | None
    pallet_width_in: float | None
    item_length_in: float | None
    item_width_in: float | None
    item_height_in: float | None
    total_sqft_needed: float
    lots_equivalent: float

    # Manifest + put-away
    total_expected_qty: int
    total_received_qty: int
    lines: list[ContainerLineSummary]
    lot_assignments: list[LotAssignmentSummary]

    # Scan sheet
    receipt_id: int | None
    receipt_status: str | None
    total_scanned: int
    last_scan_at: datetime | None
    recent_scans: list[ScanRowSummary]  # top 50

    # Documents (driver license / insurance / BOL etc.)
    documents: list[ContainerDocumentSummary]

    # Outbound links — TOs that consumed (or plan to consume) this container
    outbound_links: list[OutboundLinkSummary]

    # Open / past exceptions on this DO
    exceptions: list[ExceptionSummary]
    open_exceptions: int

    # Recent activity (DO + container scope)
    activity: list[ActivityEntry]

    # Status timeline (mirrors vendor /whpo/{n}/status but per-container)
    timeline: list[StageEvent]
    current_stage: str


# ─── Outbound order detail (TO drilldown) ──────────────────────────────


class OutboundContainerSummary(BaseModel):
    container_id: int
    container_no: str
    container_type: str
    status: str
    driver_name: str | None
    driver_license: str | None
    driver_phone: str | None
    truck_license_plate: str | None
    carrier: str | None
    bol_number: str | None
    scheduled_arrival_at: datetime | None
    started_at: datetime | None
    sealed_at: datetime | None
    total_scanned: int
    receipt_id: int | None
    receipt_status: str | None


class OutboundLineDetail(BaseModel):
    line_id: int
    line_no: int
    sku: str
    description: str | None
    order_qty: int
    picked_qty: int
    unit: str
    serial_specific: bool
    serials_requested: list[str]
    source_container_no: str | None


class OutboundOrderDetailResponse(BaseModel):
    order_id: int
    transfer_order_no: str
    po_number: str | None
    customer_name: str
    status: str
    order_date: date | None
    priority: str
    memo: str | None
    ship_from_name: str | None
    ship_from_address: str | None
    ship_to_name: str | None
    ship_to_address: str | None
    submitted_at: datetime
    submitted_by: str | None
    notes: str | None

    # Lines
    lines: list[OutboundLineDetail]
    total_order_qty: int
    total_picked_qty: int

    # Trucks / containers attached to this TO
    containers: list[OutboundContainerSummary]

    # Linked inbound containers (referenced via source_container_no on lines)
    linked_inbound_containers: list[str]

    # Status timeline (vendor-visible 5-stage outbound progression)
    timeline: list[StageEvent]
    current_stage: str

    # Recent activity
    activity: list[ActivityEntry]
