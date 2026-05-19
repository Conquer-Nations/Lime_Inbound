from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, Field


# ─── DO list / detail ───────────────────────────────────────────────────


class DOListItem(BaseModel):
    do_id: int
    do_number: str
    whpo_number: str
    customer_name: str
    status: str
    expected_arrival_date: date | None
    issued_at: datetime
    container_count: int
    open_exceptions: int


class ContainerInDO(BaseModel):
    container_id: int
    container_no: str
    status: str
    expected_arrival_date: date | None
    actual_arrival_date: date | None
    total_expected: int
    total_received: int
    lines: list[ContainerLineRow]
    assignments: list[AssignmentRow]
    # Container-level packaging declared by vendor
    on_pallet: bool | None
    pallet_length_in: float | None
    pallet_width_in: float | None
    item_length_in: float | None
    item_width_in: float | None
    item_height_in: float | None
    # Aggregate space rollup
    total_sqft_needed: float
    lots_equivalent: float


class ContainerLineRow(BaseModel):
    line_id: int
    sku: str
    qty: int
    items_per_pallet: int | None
    sqft_per_unit: float | None
    sku_resolved: bool
    # Computed footprint using vendor packaging + SKU master fallback
    computed_sqft_per_unit: float
    computed_total_sqft: float
    space_basis: str


class AssignmentRow(BaseModel):
    assignment_order: int
    lot_code: str
    floor_name: str
    sku: str
    planned_pallets: int
    actual_pallets: int
    status: str


class DODetail(BaseModel):
    do_id: int
    do_number: str
    whpo_id: int
    whpo_number: str
    customer_name: str
    status: str
    expected_arrival_date: date | None
    issued_at: datetime
    containers: list[ContainerInDO]
    open_exceptions: int


# ─── Lots ───────────────────────────────────────────────────────────────


class LotMapItem(BaseModel):
    lot_id: int
    lot_code: str
    floor_id: int
    floor_name: str
    type: str
    pallet_capacity: int
    pallets_used: int
    pallets_reserved: int
    pallets_free: int
    occupancy_pct: float
    blocked: bool
    grid_row: int | None
    grid_col: int | None


class PalletInLot(BaseModel):
    pallet_id: int
    sku: str
    container_no: str
    qty: int
    level: int
    palletized_at: datetime
    palletized_by: str


class LotDetail(BaseModel):
    lot_id: int
    lot_code: str
    floor_id: int
    floor_name: str
    type: str
    pallet_capacity: int
    sqft_capacity: float
    pallets_used: int
    pallets_reserved: int
    pallets_free: int
    blocked: bool
    pallets: list[PalletInLot]


# ─── Exceptions ─────────────────────────────────────────────────────────


class ExceptionItem(BaseModel):
    exception_id: int
    kind: str
    ref_type: str | None
    ref_id: int | None
    payload: dict | None
    status: str
    opened_at: datetime
    opened_by: str | None
    resolved_at: datetime | None
    resolved_by: str | None
    resolution_notes: str | None


class ResolveExceptionRequest(BaseModel):
    """For `unknown_sku`: provide full SKU master data to create.
    For `missing_master_data`: provide patch fields to update.
    For `dismiss`: leave both blank, include notes.
    """
    sku_data: SKUCreatePayload | None = None
    patch: SKUPatchPayload | None = None
    notes: str | None = None
    resolved_by: str = "manager"


class SKUCreatePayload(BaseModel):
    description: str | None = None
    sqft_per_unit: float | None = None
    items_per_pallet: int = Field(gt=0)
    pallet_mode: str = "logical"
    stackable: bool = False
    max_stack_height: int | None = None
    unit: str = "each"


class SKUPatchPayload(BaseModel):
    description: str | None = None
    sqft_per_unit: float | None = None
    items_per_pallet: int | None = None
    pallet_mode: str | None = None
    stackable: bool | None = None
    max_stack_height: int | None = None


class ResolveExceptionResponse(BaseModel):
    exception_id: int
    status: str
    sku_id: int | None
    do_id: int | None
    do_status: str | None
    do_status_changed: bool


# ─── Dashboard ──────────────────────────────────────────────────────────


class DashboardKPIs(BaseModel):
    containers_expected_today: int
    receipts_in_progress: int
    containers_finished_today: int
    open_exceptions: int
    total_pallets_stored: int
    pallets_received_today: int
    lot_occupancy_pct: float
    lots_blocked: int
    lots_total: int


class ActivityFeedItem(BaseModel):
    id: int
    t: datetime
    kind: str
    actor: str | None
    ref_type: str | None
    ref_id: int | None
    message: str | None


class DashboardResponse(BaseModel):
    today: date
    kpis: DashboardKPIs
    activity: list[ActivityFeedItem]


# Forward references
ContainerInDO.model_rebuild()
DODetail.model_rebuild()
ResolveExceptionRequest.model_rebuild()
