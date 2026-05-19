from __future__ import annotations

from datetime import date, datetime, time

from pydantic import BaseModel, Field


class VendorLineItem(BaseModel):
    sku: str = Field(min_length=1, max_length=120)
    qty: int = Field(gt=0)
    product_type: str | None = Field(default=None, max_length=120)


class VendorContainerSubmission(BaseModel):
    container_no: str = Field(min_length=11, max_length=11, pattern=r"^[A-Z]{4}\d{7}$")
    expected_arrival_date: date | None = None
    expected_arrival_time: time | None = None
    lines: list[VendorLineItem] = Field(min_length=1)


class VendorPackaging(BaseModel):
    """Vendor-declared packaging on a shipment.

    Either on_pallet=True with pallet_length_in/pallet_width_in OR
    on_pallet=False with item_length_in/item_width_in/(optional)item_height_in.
    """

    on_pallet: bool
    pallet_length_in: float | None = Field(default=None, gt=0)
    pallet_width_in: float | None = Field(default=None, gt=0)
    item_length_in: float | None = Field(default=None, gt=0)
    item_width_in: float | None = Field(default=None, gt=0)
    item_height_in: float | None = Field(default=None, gt=0)


class VendorDriverInfo(BaseModel):
    """Driver/truck info for an EXISTING container. Vendor submits closer to delivery.
    Every field is optional — vendor sends whatever they have, blanks for the rest."""

    carrier: str = Field(default="", max_length=120)
    driver_name: str = Field(default="", max_length=120)
    driver_license: str = Field(default="", max_length=60)
    driver_phone: str = Field(default="", max_length=40)
    truck_license_plate: str = Field(default="", max_length=20)
    insurance: str = Field(default="", max_length=400)


class DriverInfoResponse(BaseModel):
    container_no: str
    whpo_number: str
    do_number: str
    rows_affected: int  # container_line rows for this container


class ContainerListItem(BaseModel):
    container_no: str
    has_driver_info: bool
    driver_name: str | None


class WHPOContainersResponse(BaseModel):
    whpo_number: str
    do_number: str
    customer_name: str
    containers: list[ContainerListItem]


class VendorWHPOSubmission(BaseModel):
    customer: str
    # WHPO is always exactly 8 digits — vendor's billing reference
    whpo_number: str = Field(pattern=r"^\d{8}$")
    submitter_name: str
    submitter_email: str
    # Date is required (may be derived from container-level arrival in form)
    expected_arrival_date: date
    arrival_window: str | None = None
    bol_number: str | None = None
    containers: list[VendorContainerSubmission] = Field(min_length=1)
    packaging: VendorPackaging | None = None
    notes: str | None = None


# ─── Response shape ─────────────────────────────────────────────────────


class ExceptionOpened(BaseModel):
    exception_id: int
    kind: str
    ref_type: str
    ref_id: int
    payload: dict | None = None


class ContainerCreated(BaseModel):
    container_id: int
    container_no: str
    lines_total: int
    unknown_skus: list[str]


class WHPOIntakeResponse(BaseModel):
    whpo_id: int
    whpo_number: str
    do_id: int
    do_number: str
    do_status: str
    containers: list[ContainerCreated]
    exceptions_opened: list[ExceptionOpened]
    idempotent_replay: bool


# ─── Update existing WHPO ────────────────────────────────────────────────


class WHPOCurrentLine(BaseModel):
    sku: str
    qty: int
    product_type: str | None = None


class WHPOCurrentContainer(BaseModel):
    container_no: str
    expected_arrival_date: date | None = None
    expected_arrival_time: time | None = None
    status: str  # 'expected' / 'receiving' / 'received'
    is_locked: bool  # status != 'expected' → vendor can't update
    has_driver_info: bool
    # All driver/truck fields — pre-fill the Update form so vendor sees current state.
    driver_name: str | None = None
    driver_license: str | None = None
    driver_phone: str | None = None
    truck_license_plate: str | None = None
    insurance: str | None = None
    carrier: str | None = None
    lines: list[WHPOCurrentLine]


class WHPOCurrentState(BaseModel):
    """Full current state of a WHPO — what the vendor sees before editing."""

    whpo_number: str
    do_number: str
    customer_name: str
    expected_arrival_date: date | None = None
    containers: list[WHPOCurrentContainer]
    any_locked: bool  # at least one container is receiving/received → can't update


class WHPOUpdateContainer(BaseModel):
    """One container in an update request. `original_container_no` is the
    key used to find the existing container; `container_no` is the (possibly
    new) value to set.

    Driver/truck fields are all optional — if a value differs from the
    existing one (including an empty string vs. a populated value), it's
    treated as a change. Submit the current value to leave a field alone.
    """

    original_container_no: str = Field(min_length=11, max_length=11, pattern=r"^[A-Z]{4}\d{7}$")
    container_no: str = Field(min_length=11, max_length=11, pattern=r"^[A-Z]{4}\d{7}$")
    expected_arrival_date: date | None = None
    expected_arrival_time: time | None = None
    # Driver/truck — optional. None = "don't touch", "" = "clear".
    driver_name: str | None = Field(default=None, max_length=120)
    driver_license: str | None = Field(default=None, max_length=60)
    driver_phone: str | None = Field(default=None, max_length=40)
    truck_license_plate: str | None = Field(default=None, max_length=20)
    insurance: str | None = Field(default=None, max_length=400)
    carrier: str | None = Field(default=None, max_length=120)
    lines: list[VendorLineItem] = Field(min_length=1)


class WHPOUpdateRequest(BaseModel):
    expected_arrival_date: date | None = None
    containers: list[WHPOUpdateContainer] = Field(min_length=1)


class WHPOChange(BaseModel):
    scope: str       # 'whpo' | 'container' | 'line'
    container_no: str | None = None  # container key for container/line scopes
    field: str       # e.g., 'container_no', 'expected_arrival_date', 'line_added', 'line_removed', 'line_qty'
    before: str | None = None
    after: str | None = None
    sku: str | None = None  # for line-scoped changes


class WHPOUpdateResponse(BaseModel):
    whpo_number: str
    do_number: str
    changes: list[WHPOChange]
    summary: str  # human-readable one-liner
    excel_resynced: bool


# ─── Container documents (driver/truck photo uploads) ────────────────────


class ContainerDocumentItem(BaseModel):
    id: int
    kind: str
    label: str           # human label (resolved server-side from DOCUMENT_KINDS)
    filename: str
    content_type: str
    file_size: int
    uploaded_at: datetime
    uploaded_by: str | None = None
    url: str             # GET this to fetch the file


class ContainerDocumentsResponse(BaseModel):
    container_no: str
    documents: list[ContainerDocumentItem]


class DocumentKindOption(BaseModel):
    kind: str
    label: str


class DocumentKindsResponse(BaseModel):
    kinds: list[DocumentKindOption]
