"""Read-only schemas for the warehouse-inventory reports.

Both endpoints compute everything from source-of-truth tables at query
time — no caching, no daily snapshot. The data sizes (a few hundred
containers max) make this trivially cheap."""
from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel


class ContainerAgingRow(BaseModel):
    container_no: str
    brand: str | None = None
    invoice_no: str | None = None     # DO number
    whpo_number: str | None = None
    received_date: date | None = None
    days_since_received: int | None = None
    units_in: int = 0
    units_out: int = 0
    units_remaining: int = 0
    aging_bucket: str  # active / aging / stale / fully_shipped
    fully_shipped: bool = False


class ContainerAgingResponse(BaseModel):
    items: list[ContainerAgingRow]
    total: int
    # Convenience: roll-ups for the dashboard tiles.
    counts: dict[str, int]  # {"active": N, "aging": N, "stale": N, "fully_shipped": N}


class RemainingSerialRow(BaseModel):
    serial_number: str
    sku_raw: str | None = None
    scanned_at: datetime
    status: str  # 'in_warehouse' | 'shipped'
    shipped_to: str | None = None  # transfer_order_no when status='shipped'
    shipped_at: datetime | None = None


class RemainingInventorySkuRow(BaseModel):
    sku_raw: str
    qty_received: int = 0
    qty_scanned_in: int = 0
    qty_shipped_out: int = 0
    qty_remaining: int = 0


class RemainingInventoryResponse(BaseModel):
    container_no: str
    brand: str | None = None
    received_date: date | None = None
    days_since_received: int | None = None
    per_sku: list[RemainingInventorySkuRow]
    serials: list[RemainingSerialRow]
