"""Schemas for the auto-computed inbound + outbound mastersheet."""
from __future__ import annotations

from datetime import date

from pydantic import BaseModel


class MasterListRow(BaseModel):
    """Mirrors `vw_master_list`. One row per inbound container reception
    OR per outbound container shipment. Container # links the two halves
    in the UI (no FK enforcement — outbound containers can be truck
    plates not present on the inbound side)."""

    row_kind: str  # 'inbound' | 'outbound'
    source_id: int
    container_no: str
    customer_name: str | None = None

    # Inbound-only fields
    invoice_no: str | None = None
    whpo_number: str | None = None
    expected_arrival_date: date | None = None
    received_date: date | None = None
    units: int | None = None
    pallets: int | None = None

    # Both
    carrier_or_broker: str | None = None
    driver_name: str | None = None

    # Outbound-only fields
    transfer_order_no: str | None = None
    ship_date: date | None = None
    ship_to: str | None = None
    outbound_units: int | None = None
    outbound_pallets: int | None = None

    # Status pill
    scanned: bool = False
    status: str | None = None


class MasterListResponse(BaseModel):
    items: list[MasterListRow]
    total: int
