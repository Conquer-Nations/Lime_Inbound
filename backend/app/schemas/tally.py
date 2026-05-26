"""Pydantic schemas for the POD / tally-sheet endpoints."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class TallyOCRBlock(BaseModel):
    """OCR-extracted fields + debug. Mirrors what `run_pod_ocr` returns."""

    from_location: str = ""
    to_location: str = ""
    confidence: dict[str, str] = Field(default_factory=dict)
    engine: str | None = None


class TallySheetRead(BaseModel):
    """One row in the tally list / detail."""

    id: int
    container_id: int
    container_no: str

    pod_filename: str
    pod_content_type: str
    pod_file_size: int
    # True when a generated PDF is on disk; frontend uses this to show
    # the Download button.
    has_pdf: bool = False

    # OCR results
    ocr_from_location: str | None = None
    ocr_to_location: str | None = None
    ocr_engine: str | None = None

    # Snapshotted at tally time (audit-grade)
    matched_driver_name: str | None = None
    matched_driver_license: str | None = None
    matched_driver_phone: str | None = None
    matched_carrier: str | None = None
    matched_truck_plate: str | None = None

    # Manager-entered
    manual_seal_no: str | None = None
    manual_chassis_no: str | None = None

    tallied_at: datetime
    tallied_by: str

    billing_status: str  # pending / billed / disputed / waived
    billing_notes: str | None = None
    updated_at: datetime

    class Config:
        from_attributes = True


class TallySheetList(BaseModel):
    items: list[TallySheetRead]
    total: int


class TallySheetUpdateRequest(BaseModel):
    """Manager edits: correct OCR misreads, fill missing seal/chassis,
    flip billing status, add notes. All fields optional — only set keys
    are applied."""

    ocr_from_location: str | None = None
    ocr_to_location: str | None = None
    manual_seal_no: str | None = None
    manual_chassis_no: str | None = None
    billing_status: str | None = Field(
        default=None, pattern=r"^(pending|billed|disputed|waived)$"
    )
    billing_notes: str | None = None


class VendorTallyView(BaseModel):
    """Pared-down read endpoint for vendors: shipment-flow tracking only.
    Excludes billing fields (vendors don't see billing status / notes)."""

    container_no: str
    tallied: bool
    tallied_at: datetime | None = None
    ocr_from_location: str | None = None
    ocr_to_location: str | None = None
    matched_carrier: str | None = None
    matched_truck_plate: str | None = None


class TallyOCRDebug(BaseModel):
    """Returned alongside TallySheetRead on POST, so the manager can see
    what the OCR actually extracted before flipping billing_status."""

    raw: dict[str, Any] = Field(default_factory=dict)
