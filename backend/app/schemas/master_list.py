"""Schemas for the master-list endpoint and OneDrive Excel mirror.

Shape mirrors `Lime-Inventory-Sep 2025.xlsx`: one row per inbound
container with the outbound columns joined in. Outbound fields are
NULL until something has shipped from the container."""
from __future__ import annotations

from datetime import date

from pydantic import BaseModel


class MasterListRow(BaseModel):
    """Mirrors `vw_master_list` (24 columns). 22 of them match the
    xlsx column order verbatim; the leading container_id +
    customer_name are application-side helpers (for drilldown links +
    brand filtering)."""

    container_id: int
    container_no: str
    customer_name: str | None = None

    # Inbound (cols 1-13 in the xlsx)
    invoice: str | None = None
    commodity: str | None = None
    whpo_load_no: str | None = None
    carrier_broker: str | None = None
    driver_name: str | None = None
    drop_container: date | None = None
    received_date: date | None = None
    pickup_container: date | None = None
    pallets: int = 0
    units: int = 0
    sqft: float | None = None
    total_sqft: float | None = None

    # Outbound (cols 14-20 in the xlsx)
    to_no: str | None = None
    ship_date: date | None = None
    ship_to: str | None = None
    pallets_out: int | None = None
    units_out: int | None = None
    sqft_out: float | None = None
    total_sqft_out: float | None = None

    # Status (cols 21-22)
    scanned: bool = False
    lpn: str | None = None


class MasterListResponse(BaseModel):
    items: list[MasterListRow]
    total: int
