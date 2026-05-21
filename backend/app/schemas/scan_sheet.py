"""Pydantic schemas for the operator scan-sheet flow + auditor views.

The "sheet" mirrors TEMPLATE.xlsx — one Receipt per container, header
block + scan rows. All scan rows are append-only; the operator FINISH
button locks the Receipt.
"""

from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, Field


# ─── Header block (top of TEMPLATE.xlsx) ────────────────────────────────


class ScanSheetHeader(BaseModel):
    """Read-only top of the operator's sheet — pre-filled from WHPO+Container."""

    receipt_id: int
    container_no: str
    whpo_number: str
    do_number: str
    customer_name: str
    bol_number: str | None = None
    received_date: date
    start_timestamp: datetime
    completed_timestamp: datetime | None = None
    location: str = "Conquer Nation, Vernon, CA."
    is_completed: bool = False
    requires_imei: bool = False        # true when any container line is a scooter


# ─── Scan row (per-item, append-only) ───────────────────────────────────


class ScanRow(BaseModel):
    """One row in the scan-sheet table. Mirrors columns A..G of TEMPLATE.xlsx."""

    id: int
    container_no: str
    sku: str | None
    qty: int = 1                   # always 1 per row per spec
    serial_number: str | None
    imei: str | None = None        # template column E, currently always blank
    box_number: int | None = None  # 1-based, increments every 10 scans (scooters only)
    scanned_by: str
    notes: str | None = None
    scanned_at: datetime


# ─── Open / scan / finish request payloads ──────────────────────────────


class OpenSheetRequest(BaseModel):
    """Operator hits this with EITHER a confirmed container_no (from OCR or
    typed) OR the raw photo bytes for server-side OCR. The photo path goes
    via multipart/form-data on a different endpoint, so this body only
    carries the resolved container_no."""

    container_no: str = Field(min_length=1, max_length=24)


class OpenSheetResponse(BaseModel):
    header: ScanSheetHeader
    rows: list[ScanRow]            # empty on fresh open, existing rows on reopen


class RecordScanRequest(BaseModel):
    """A single barcode/serial event from the BT-A500 (or typed manually)."""

    # Serials: alphanumeric (letters + digits + optional dashes).
    serial_number: str = Field(
        min_length=1, max_length=120, pattern=r"^[A-Za-z0-9-]+$"
    )
    sku: str | None = None
    # IMEI: digits only, length 14–17 (standard is 15; IMEISV is 16).
    # Empty string treated as "not provided" — same as None.
    imei: str | None = Field(
        default=None, max_length=17, pattern=r"^([0-9]{14,17})?$"
    )
    notes: str | None = Field(default=None, max_length=400)


class RecordScanResponse(BaseModel):
    accepted: bool
    row: ScanRow | None = None
    duplicate_of_row_id: int | None = None
    error: str | None = None
    total_scanned: int = 0


class FinishSheetResponse(BaseModel):
    receipt_id: int
    container_no: str
    total_scanned: int
    finished_at: datetime
    download_url: str              # convenience: /operator/sheet/{id}/export.xlsx


# ─── Auditor list / detail / export filter ──────────────────────────────


class AuditSheetListItem(BaseModel):
    """One row on the auditor's filter results table."""

    receipt_id: int
    container_no: str
    whpo_number: str
    customer_name: str
    received_date: date
    scan_count: int
    status: str                    # 'in_progress' | 'completed'
    finished_at: datetime | None = None


class AuditSheetListResponse(BaseModel):
    sheets: list[AuditSheetListItem]
    total: int


class AuditSheetDetail(BaseModel):
    """Full sheet view for the auditor — header + every row."""

    header: ScanSheetHeader
    rows: list[ScanRow]


class AuditFilters(BaseModel):
    """All filters optional. None ↔ "any". Combined with AND."""

    year: int | None = Field(default=None, ge=2024, le=2100)
    month: int | None = Field(default=None, ge=1, le=12)
    container_no: str | None = None
    whpo_number: str | None = None
