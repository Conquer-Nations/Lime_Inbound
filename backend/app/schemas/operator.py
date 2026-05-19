from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, Field


# ─── Shared building blocks ─────────────────────────────────────────────


class LineRow(BaseModel):
    sku: str
    description: str | None
    qty: int
    items_per_pallet: int | None
    pallet_mode: str
    scanned: int = 0


class AssignmentRow(BaseModel):
    assignment_order: int
    lot_id: int
    lot_code: str
    floor_name: str
    sku: str
    planned_pallets: int
    actual_pallets: int
    items_placed: int
    items_expected: int
    status: str


class Alert(BaseModel):
    kind: str
    message: str
    payload: dict | None = None


# ─── /container/lookup ──────────────────────────────────────────────────


class ContainerLookupRequest(BaseModel):
    container_no: str = Field(min_length=11, max_length=11, pattern=r"^[A-Z]{4}\d{7}$")
    operator: str


class ContainerLookupResponse(BaseModel):
    container_no: str
    do_number: str
    whpo_number: str
    customer_name: str
    expected_arrival_date: date | None
    container_status: str
    receipt_id: int
    lines: list[LineRow]
    assignments: list[AssignmentRow]
    alerts: list[Alert]
    total_scanned: int
    total_expected: int


# ─── /scan ──────────────────────────────────────────────────────────────


class ScanRequest(BaseModel):
    receipt_id: int
    item_barcode: str = Field(min_length=1, max_length=120)
    operator: str


class ScanResponse(BaseModel):
    receipt_id: int
    accepted: bool
    result: str  # ok | duplicate | unknown | no_active_assignment | container_complete
    error_reason: str | None = None
    current_assignment: AssignmentRow | None
    next_assignment: AssignmentRow | None
    auto_cut: bool  # current assignment just hit capacity
    auto_finish: bool  # whole container is done
    total_scanned: int
    total_expected: int


# ─── /container/finish ──────────────────────────────────────────────────


class FinishRequest(BaseModel):
    receipt_id: int
    operator: str


class FinishResponse(BaseModel):
    receipt_id: int
    container_no: str
    container_status: str
    receipt_status: str
    finished_at: datetime
    total_scanned: int
    total_expected: int
    pallets_created: int
