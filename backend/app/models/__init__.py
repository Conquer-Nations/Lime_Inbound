from __future__ import annotations

from datetime import date, datetime, time

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    Time,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


# ─── Master data ────────────────────────────────────────────────────────────


class Account(Base):
    """Billing account — the legal entity we have a service contract with
    and invoice. e.g. TQL. Each account has many product-owner brands
    (Customer rows) whose stuff we warehouse on their behalf.

    Conquer Nation bills TQL for warehouse activity across all of TQL's
    brands (Lime, National Plastic, Pan America, Boviet Solar, …). At
    invoicing time we group usage by Account so one TQL invoice
    aggregates every brand's storage / handling charges."""

    __tablename__ = "accounts"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    billing_email: Mapped[str | None] = mapped_column(String(255))
    billing_address: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    # Dynamics 365 Business Central dual-write state (see
    # app/services/bc_client.py). Null until first successful sync.
    # bc_sync_error holds the last failure message; clears on success.
    bc_customer_no: Mapped[str | None] = mapped_column(String(40), index=True)
    bc_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    bc_sync_error: Mapped[str | None] = mapped_column(Text)

    customers: Mapped[list[Customer]] = relationship(back_populates="account")


class Customer(Base):
    """Product-owner brand — the company whose physical inventory lives on
    our floor. e.g. Lime, National Plastic, Pan America, Boviet Solar.

    Most operational data (SKUs, WHPOs, scans) is scoped here. Billing
    rolls up through `account_id` to the Account row, which is who we
    actually invoice. account_id is nullable so legacy direct-bill
    customers (no intermediary) still fit the schema."""

    __tablename__ = "customers"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    account_id: Mapped[int | None] = mapped_column(
        ForeignKey("accounts.id"), index=True
    )
    contact_email: Mapped[str | None] = mapped_column(String(255))
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    account: Mapped[Account | None] = relationship(back_populates="customers")
    skus: Mapped[list[SKU]] = relationship(back_populates="customer", cascade="all, delete-orphan")
    whpos: Mapped[list[WHPO]] = relationship(back_populates="customer")


class SKU(Base):
    __tablename__ = "skus"
    __table_args__ = (UniqueConstraint("customer_id", "sku", name="uq_skus_customer_sku"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"), index=True)
    sku: Mapped[str] = mapped_column(String(120), index=True)
    description: Mapped[str | None] = mapped_column(Text)
    # Canonical product category for this SKU (Scooters / eBikes / Gliders /
    # Batteries / Helmets / Solar Panels / etc.). Drives IMEI + box-number
    # logic on the scan sheet when the vendor doesn't set product_type at
    # the line level. Free-text — the UI offers common picks but isn't
    # restricted, so vendors can introduce new categories.
    product_type: Mapped[str | None] = mapped_column(String(120), index=True)
    sqft_per_unit: Mapped[float | None] = mapped_column(Float)
    # Items per pallet. Float (not int) because gliders pack at 1.9655 /
    # pallet — a vendor-supplied conversion factor, not a count.
    items_per_pallet: Mapped[float | None] = mapped_column(Float)
    # Floor footprint of one fully-loaded pallet, in sqft. Fixed per SKU
    # (e.g. Lime gliders = 20 sqft / pallet). When set, the receiving
    # space calculator rounds qty up to whole pallets, then multiplies by
    # this — matching how the warehouse actually stages product.
    pallet_sqft: Mapped[float | None] = mapped_column(Float)
    pallet_mode: Mapped[str] = mapped_column(String(16), default="logical")
    stackable: Mapped[bool] = mapped_column(Boolean, default=False)
    max_stack_height: Mapped[int | None] = mapped_column(Integer)
    unit: Mapped[str] = mapped_column(String(16), default="each")
    source: Mapped[str | None] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    customer: Mapped[Customer] = relationship(back_populates="skus")


class Floor(Base):
    __tablename__ = "floors"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    layout: Mapped[str] = mapped_column(String(16), default="GRID")
    notes: Mapped[str | None] = mapped_column(Text)

    lots: Mapped[list[Lot]] = relationship(back_populates="floor", cascade="all, delete-orphan")


class Lot(Base):
    __tablename__ = "lots"
    __table_args__ = (UniqueConstraint("floor_id", "lot_code", name="uq_lots_floor_code"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    floor_id: Mapped[int] = mapped_column(ForeignKey("floors.id"), index=True)
    lot_code: Mapped[str] = mapped_column(String(40), index=True)
    type: Mapped[str] = mapped_column(String(16), default="rack")
    sqft_capacity: Mapped[float] = mapped_column(Float)
    pallet_capacity: Mapped[int] = mapped_column(Integer)
    max_stack_levels: Mapped[int] = mapped_column(Integer, default=2)
    blocked: Mapped[bool] = mapped_column(Boolean, default=False)
    notes: Mapped[str | None] = mapped_column(Text)
    grid_row: Mapped[int | None] = mapped_column(Integer)
    grid_col: Mapped[int | None] = mapped_column(Integer)

    floor: Mapped[Floor] = relationship(back_populates="lots")


# ─── Orders ─────────────────────────────────────────────────────────────────


class WHPO(Base):
    """Vendor's Warehouse Purchase Order — billing reference."""

    __tablename__ = "whpos"

    id: Mapped[int] = mapped_column(primary_key=True)
    whpo_number: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"), index=True)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    raw_payload: Mapped[dict | None] = mapped_column(JSONB)
    notes: Mapped[str | None] = mapped_column(Text)

    # Truck / driver info, submitted by the vendor closer to the delivery date.
    driver_name: Mapped[str | None] = mapped_column(String(120))
    driver_license: Mapped[str | None] = mapped_column(String(60))
    truck_license_plate: Mapped[str | None] = mapped_column(String(20))
    insurance: Mapped[str | None] = mapped_column(Text)
    driver_info_received_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Bill of Lading reference number — vendor enters via the Update
    # Shipment screen before truck arrival. The matching BOL PDF lives
    # in ContainerDocument with kind='bol'. Scan-sheet export reads this
    # value into TEMPLATE.xlsx cell F5.
    bol_number: Mapped[str | None] = mapped_column(String(80))

    customer: Mapped[Customer] = relationship(back_populates="whpos")
    do: Mapped[DO | None] = relationship(back_populates="whpo", uselist=False)


class DO(Base):
    """Our internal Delivery Order — one issued per WHPO."""

    __tablename__ = "dos"

    id: Mapped[int] = mapped_column(primary_key=True)
    do_number: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    whpo_id: Mapped[int] = mapped_column(ForeignKey("whpos.id"), unique=True, index=True)
    status: Mapped[str] = mapped_column(String(32), default="pending_master_data", index=True)
    expected_arrival_date: Mapped[date | None] = mapped_column(Date)
    expected_arrival_time: Mapped[time | None] = mapped_column(Time)
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    issued_by: Mapped[str | None] = mapped_column(String(80), default="system")
    notes: Mapped[str | None] = mapped_column(Text)

    whpo: Mapped[WHPO] = relationship(back_populates="do")
    containers: Mapped[list[Container]] = relationship(
        back_populates="do", cascade="all, delete-orphan"
    )


class Container(Base):
    __tablename__ = "containers"

    id: Mapped[int] = mapped_column(primary_key=True)
    container_no: Mapped[str] = mapped_column(String(20), unique=True, index=True)
    do_id: Mapped[int] = mapped_column(ForeignKey("dos.id"), index=True)
    expected_arrival_date: Mapped[date | None] = mapped_column(Date)
    expected_arrival_time: Mapped[time | None] = mapped_column(Time)
    actual_arrival_date: Mapped[date | None] = mapped_column(Date)
    actual_arrival_time: Mapped[time | None] = mapped_column(Time)
    status: Mapped[str] = mapped_column(String(32), default="expected", index=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_by: Mapped[str | None] = mapped_column(String(80))
    finished_by: Mapped[str | None] = mapped_column(String(80))

    # Packaging declared by the vendor on intake. Used to compute sqft footprint.
    on_pallet: Mapped[bool | None] = mapped_column(Boolean)
    pallet_length_in: Mapped[float | None] = mapped_column(Float)
    pallet_width_in: Mapped[float | None] = mapped_column(Float)
    item_length_in: Mapped[float | None] = mapped_column(Float)
    item_width_in: Mapped[float | None] = mapped_column(Float)
    item_height_in: Mapped[float | None] = mapped_column(Float)

    # Driver/truck info — submitted closer to the delivery date. One driver per
    # container (irrespective of how many SKUs the container holds).
    driver_name: Mapped[str | None] = mapped_column(String(120))
    driver_license: Mapped[str | None] = mapped_column(String(60))
    driver_phone: Mapped[str | None] = mapped_column(String(40))
    truck_license_plate: Mapped[str | None] = mapped_column(String(20))
    insurance: Mapped[str | None] = mapped_column(Text)
    carrier: Mapped[str | None] = mapped_column(String(120))
    driver_info_received_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    do: Mapped[DO] = relationship(back_populates="containers")
    lines: Mapped[list[ContainerLine]] = relationship(
        back_populates="container", cascade="all, delete-orphan"
    )
    lot_assignments: Mapped[list[LotAssignment]] = relationship(
        back_populates="container", cascade="all, delete-orphan"
    )
    documents: Mapped[list[ContainerDocument]] = relationship(
        back_populates="container", cascade="all, delete-orphan"
    )


class ContainerDocument(Base):
    """Vendor-uploaded photo/scan attached to a container — driver's license,
    insurance, registration, plate photos, dispatch order, etc.

    One row per (container, kind). Re-uploading the same kind overwrites the
    existing file and updates this row in place.
    """

    __tablename__ = "container_documents"
    __table_args__ = (
        UniqueConstraint("container_id", "kind", name="uq_container_doc_kind"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    container_id: Mapped[int] = mapped_column(ForeignKey("containers.id"), index=True)
    kind: Mapped[str] = mapped_column(String(64), index=True)
    filename: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(120))
    file_size: Mapped[int] = mapped_column(Integer)
    storage_path: Mapped[str] = mapped_column(String(400))
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    uploaded_by: Mapped[str | None] = mapped_column(String(255))

    container: Mapped[Container] = relationship(back_populates="documents")


class TallySheet(Base):
    """Manager-created POD record for an arriving container — billing-grade.

    Workflow: driver arrives with the physical POD → manager uploads it
    here → backend OCRs from/to + snapshots driver/truck/carrier off the
    Container row → row is locked-in. Operator's scan-sheet open is gated
    on this row existing (no tally = no scan). Vendors see the tally
    status for tracking.

    Snapshots are intentional — billing rows must not change when the
    container's driver_name etc. is later edited. One tally per container
    (UNIQUE on container_id)."""

    __tablename__ = "tally_sheets"
    __table_args__ = (
        UniqueConstraint("container_id", name="uq_tally_container"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    container_id: Mapped[int] = mapped_column(
        ForeignKey("containers.id", ondelete="CASCADE")
    )

    # POD file (same on-disk pattern as ContainerDocument)
    pod_filename: Mapped[str] = mapped_column(String(255))
    pod_content_type: Mapped[str] = mapped_column(String(120))
    pod_file_size: Mapped[int] = mapped_column(Integer)
    pod_storage_path: Mapped[str] = mapped_column(String(500))

    # Path to the auto-generated tally-sheet PDF (one per tally row).
    # Nullable so legacy rows pre-PDF-feature aren't broken.
    tally_pdf_storage_path: Mapped[str | None] = mapped_column(String(500))

    # OCR results — nullable so manager can still file the tally when OCR
    # fails or returns garbage. They can correct via PUT later.
    ocr_from_location: Mapped[str | None] = mapped_column(String(500))
    ocr_to_location: Mapped[str | None] = mapped_column(String(500))
    ocr_extracted_json: Mapped[dict | None] = mapped_column(JSONB)
    ocr_engine: Mapped[str | None] = mapped_column(String(32))

    # Snapshot from Container at tally time
    matched_container_no: Mapped[str] = mapped_column(String(20))
    matched_driver_name: Mapped[str | None] = mapped_column(String(200))
    matched_driver_license: Mapped[str | None] = mapped_column(String(120))
    matched_driver_phone: Mapped[str | None] = mapped_column(String(40))
    matched_carrier: Mapped[str | None] = mapped_column(String(200))
    matched_truck_plate: Mapped[str | None] = mapped_column(String(60))

    # Manager-entered overrides / additions not captured by Container.
    manual_seal_no: Mapped[str | None] = mapped_column(String(120))
    manual_chassis_no: Mapped[str | None] = mapped_column(String(120))

    tallied_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    tallied_by: Mapped[str] = mapped_column(String(255))

    billing_status: Mapped[str] = mapped_column(
        String(20), server_default="pending", index=True
    )
    billing_notes: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    container: Mapped[Container] = relationship()


class ContainerLine(Base):
    __tablename__ = "container_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    container_id: Mapped[int] = mapped_column(ForeignKey("containers.id"), index=True)
    sku_id: Mapped[int | None] = mapped_column(ForeignKey("skus.id"), index=True)
    sku_raw: Mapped[str] = mapped_column(String(120))
    qty: Mapped[int] = mapped_column(Integer)
    line_index: Mapped[int] = mapped_column(Integer, default=1)
    # Free-text product category from the vendor (e.g. "Scooters", "Solar Panels")
    product_type: Mapped[str | None] = mapped_column(String(120))

    container: Mapped[Container] = relationship(back_populates="lines")
    sku: Mapped[SKU | None] = relationship()


class LotAssignment(Base):
    """Result of the just-in-time put-away algorithm."""

    __tablename__ = "lot_assignments"
    __table_args__ = (
        UniqueConstraint("container_id", "assignment_order", name="uq_lot_assignment_order"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    container_id: Mapped[int] = mapped_column(ForeignKey("containers.id"), index=True)
    sku_id: Mapped[int] = mapped_column(ForeignKey("skus.id"), index=True)
    lot_id: Mapped[int] = mapped_column(ForeignKey("lots.id"), index=True)
    assignment_order: Mapped[int] = mapped_column(Integer)
    # Sqft is the algorithm's actual packing unit. Pallet counts are derived
    # for operator UI continuity.
    planned_sqft: Mapped[float] = mapped_column(Float, default=0.0)
    actual_sqft: Mapped[float] = mapped_column(Float, default=0.0)
    planned_pallets: Mapped[int] = mapped_column(Integer)
    actual_pallets: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(16), default="planned")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    container: Mapped[Container] = relationship(back_populates="lot_assignments")
    sku: Mapped[SKU] = relationship()
    lot: Mapped[Lot] = relationship()


# ─── Receiving ──────────────────────────────────────────────────────────────


class Receipt(Base):
    __tablename__ = "receipts"

    id: Mapped[int] = mapped_column(primary_key=True)
    # 'inbound' → container_id set, scans go into the `scans` table.
    # 'outbound' → outbound_container_id set, scans go into outbound_scans
    #              and each links to the matching inbound Scan by serial.
    kind: Mapped[str] = mapped_column(String(16), default="inbound")
    container_id: Mapped[int | None] = mapped_column(
        ForeignKey("containers.id"), index=True
    )
    outbound_container_id: Mapped[int | None] = mapped_column(
        ForeignKey("outbound_containers.id"), index=True
    )
    status: Mapped[str] = mapped_column(String(16), default="in_progress", index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_by: Mapped[str] = mapped_column(String(80))
    finished_by: Mapped[str | None] = mapped_column(String(80))
    notes: Mapped[str | None] = mapped_column(Text)

    container: Mapped[Container | None] = relationship()
    outbound_container: Mapped["OutboundContainer | None"] = relationship()


class Pallet(Base):
    __tablename__ = "pallets"

    id: Mapped[int] = mapped_column(primary_key=True)
    receipt_id: Mapped[int] = mapped_column(ForeignKey("receipts.id"), index=True)
    container_id: Mapped[int] = mapped_column(ForeignKey("containers.id"), index=True)
    sku_id: Mapped[int] = mapped_column(ForeignKey("skus.id"), index=True)
    lot_id: Mapped[int] = mapped_column(ForeignKey("lots.id"), index=True)
    qty: Mapped[int] = mapped_column(Integer)
    level: Mapped[int] = mapped_column(Integer, default=1)
    pallet_mode_at_receipt: Mapped[str] = mapped_column(String(16))
    # Floor footprint this pallet occupies. Set at creation, used for lot
    # capacity accounting.
    sqft: Mapped[float] = mapped_column(Float, default=0.0)
    palletized_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    palletized_by: Mapped[str] = mapped_column(String(80))


class Scan(Base):
    """Append-only audit log of every barcode event.

    The scan-sheet flow uses `serial_number` (with a partial unique index
    on receipt_id+serial_number for per-container dedup) and `row_notes`.
    Legacy scans (pre-scan-sheet) have both NULL — still valid.
    """

    __tablename__ = "scans"

    id: Mapped[int] = mapped_column(primary_key=True)
    receipt_id: Mapped[int | None] = mapped_column(ForeignKey("receipts.id"), index=True)
    pallet_id: Mapped[int | None] = mapped_column(ForeignKey("pallets.id"), index=True)
    container_id: Mapped[int | None] = mapped_column(ForeignKey("containers.id"), index=True)
    sku_id: Mapped[int | None] = mapped_column(ForeignKey("skus.id"))
    item_barcode: Mapped[str] = mapped_column(String(120), index=True)
    serial_number: Mapped[str | None] = mapped_column(String(120))
    imei: Mapped[str | None] = mapped_column(String(40))
    row_notes: Mapped[str | None] = mapped_column(Text)
    scanned_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    scanned_by: Mapped[str] = mapped_column(String(80))
    result: Mapped[str] = mapped_column(String(32))
    error_reason: Mapped[str | None] = mapped_column(Text)

    container: Mapped[Container | None] = relationship()


# ─── Audit / exceptions ─────────────────────────────────────────────────────


class ExceptionRecord(Base):
    """Unknown SKU, missing sqft, date mismatch, damage hold, capacity overflow, etc."""

    __tablename__ = "exceptions"

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(64), index=True)
    ref_type: Mapped[str | None] = mapped_column(String(32))
    ref_id: Mapped[int | None] = mapped_column(Integer)
    payload: Mapped[dict | None] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(16), default="open", index=True)
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    opened_by: Mapped[str | None] = mapped_column(String(80))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_by: Mapped[str | None] = mapped_column(String(80))
    resolution_notes: Mapped[str | None] = mapped_column(Text)


class ActivityLog(Base):
    __tablename__ = "activity_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    t: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    actor: Mapped[str | None] = mapped_column(String(80))
    kind: Mapped[str] = mapped_column(String(64), index=True)
    ref_type: Mapped[str | None] = mapped_column(String(32))
    ref_id: Mapped[int | None] = mapped_column(Integer)
    message: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict | None] = mapped_column(JSONB)


# ─── Outbound (Phase 2) ─────────────────────────────────────────────────


class OutboundOrder(Base):
    """A customer Transfer Order / Picking Ticket. One per outbound shipment."""

    __tablename__ = "outbound_orders"

    id: Mapped[int] = mapped_column(primary_key=True)
    transfer_order_no: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    # Internal Pickup Order # — auto-issued PO-YYYY-NNNN on submit. Stable
    # across updates (mirrors how DO# is stable across WHPO amendments).
    po_number: Mapped[str | None] = mapped_column(String(20), unique=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"), index=True)
    order_date: Mapped[date | None] = mapped_column(Date)
    priority: Mapped[str] = mapped_column(String(32), default="normal")  # urgent / normal
    memo: Mapped[str | None] = mapped_column(Text)
    ship_from_name: Mapped[str | None] = mapped_column(String(120))
    ship_from_address: Mapped[str | None] = mapped_column(Text)
    ship_to_name: Mapped[str | None] = mapped_column(String(255))
    ship_to_address: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default="open", index=True)
    # open → picking → shipped → cancelled
    submitted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    submitted_by: Mapped[str | None] = mapped_column(String(255))
    notes: Mapped[str | None] = mapped_column(Text)

    customer: Mapped[Customer] = relationship()
    lines: Mapped[list[OutboundLine]] = relationship(
        back_populates="order", cascade="all, delete-orphan"
    )
    containers: Mapped[list[OutboundContainer]] = relationship(
        back_populates="order", cascade="all, delete-orphan"
    )


class OutboundLine(Base):
    """One line on a Transfer Order — SKU + qty."""

    __tablename__ = "outbound_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    outbound_order_id: Mapped[int] = mapped_column(
        ForeignKey("outbound_orders.id"), index=True
    )
    line_no: Mapped[int] = mapped_column(Integer, default=1)
    sku_id: Mapped[int | None] = mapped_column(ForeignKey("skus.id"), index=True)
    sku_raw: Mapped[str] = mapped_column(String(120))
    description: Mapped[str | None] = mapped_column(Text)
    order_qty: Mapped[int] = mapped_column(Integer)
    unit: Mapped[str] = mapped_column(String(16), default="EA")
    # When true, customer specified exact serials (see OutboundLineSerial).
    # When false, operator picks any matching SKU from inventory (FIFO).
    serial_specific: Mapped[bool] = mapped_column(Boolean, default=False)
    # Which inbound container the vendor wants this line drawn from.
    # Free-text string — references containers.container_no but no FK so
    # outbound stays decoupled from physical container lifecycle. Used
    # to compute per-container pending totals on the inventory dashboard.
    source_container_no: Mapped[str | None] = mapped_column(String(40), index=True)

    order: Mapped[OutboundOrder] = relationship(back_populates="lines")
    sku: Mapped[SKU | None] = relationship()
    serials: Mapped[list[OutboundLineSerial]] = relationship(
        back_populates="line", cascade="all, delete-orphan"
    )


class OutboundLineSerial(Base):
    """An exact serial the customer requested on an outbound line.
    Only populated when OutboundLine.serial_specific is true."""

    __tablename__ = "outbound_line_serials"
    __table_args__ = (
        UniqueConstraint(
            "outbound_line_id", "serial_number", name="uq_outbound_line_serial"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    outbound_line_id: Mapped[int] = mapped_column(
        ForeignKey("outbound_lines.id"), index=True
    )
    serial_number: Mapped[str] = mapped_column(String(120), index=True)
    status: Mapped[str] = mapped_column(String(16), default="requested")
    # requested → picked → shipped → not_found

    line: Mapped[OutboundLine] = relationship(back_populates="serials")


class OutboundContainer(Base):
    """A truck or BIC container being loaded for outbound shipment."""

    __tablename__ = "outbound_containers"

    id: Mapped[int] = mapped_column(primary_key=True)
    outbound_order_id: Mapped[int] = mapped_column(
        ForeignKey("outbound_orders.id"), index=True
    )
    container_no: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    # type='bic' → ISO 6346 11-char code. type='truck' → license plate / trailer #.
    container_type: Mapped[str] = mapped_column(String(16), default="bic")
    status: Mapped[str] = mapped_column(String(32), default="open", index=True)
    # open → loading → sealed → shipped
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_by: Mapped[str | None] = mapped_column(String(80))
    sealed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sealed_by: Mapped[str | None] = mapped_column(String(80))

    # Driver / truck (parallel to inbound Container's driver fields)
    driver_name: Mapped[str | None] = mapped_column(String(120))
    driver_license: Mapped[str | None] = mapped_column(String(60))
    driver_phone: Mapped[str | None] = mapped_column(String(40))
    truck_license_plate: Mapped[str | None] = mapped_column(String(20))
    insurance: Mapped[str | None] = mapped_column(Text)
    carrier: Mapped[str | None] = mapped_column(String(120))
    bol_number: Mapped[str | None] = mapped_column(String(80))
    # When the truck is scheduled to arrive at the dock. Comes either from
    # the driver info sheet (OCR'd at upload) or from manual entry on the
    # Driver & truck info form. Nullable.
    scheduled_arrival_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )

    order: Mapped[OutboundOrder] = relationship(back_populates="containers")
    scans: Mapped[list[OutboundScan]] = relationship(
        back_populates="container", cascade="all, delete-orphan"
    )


class OutboundScan(Base):
    """One item scanned OUT into an outbound container.
    Holds a reference back to the inbound Scan for full traceability —
    that's how we know which specific unit (and which inbound container)
    each outbound item came from, and how the inventory query computes
    'available stock' = inbound scans minus outbound scans."""

    __tablename__ = "outbound_scans"
    __table_args__ = (
        UniqueConstraint(
            "outbound_container_id",
            "serial_number",
            name="uq_outbound_container_serial",
        ),
        # A single inbound scan can only be shipped out once.
        UniqueConstraint(
            "inbound_scan_id", name="uq_outbound_scan_per_inbound"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    outbound_container_id: Mapped[int] = mapped_column(
        ForeignKey("outbound_containers.id"), index=True
    )
    outbound_line_id: Mapped[int | None] = mapped_column(
        ForeignKey("outbound_lines.id"), index=True
    )
    inbound_scan_id: Mapped[int | None] = mapped_column(
        ForeignKey("scans.id"), index=True
    )
    sku_id: Mapped[int | None] = mapped_column(ForeignKey("skus.id"))
    serial_number: Mapped[str] = mapped_column(String(120), index=True)
    imei: Mapped[str | None] = mapped_column(String(40))
    picked_location: Mapped[str | None] = mapped_column(String(120))
    scanned_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    scanned_by: Mapped[str] = mapped_column(String(80))
    notes: Mapped[str | None] = mapped_column(Text)

    container: Mapped[OutboundContainer] = relationship(back_populates="scans")
    line: Mapped[OutboundLine | None] = relationship()
    inbound_scan: Mapped[Scan | None] = relationship()


__all__ = [
    "Account",
    "Customer",
    "SKU",
    "Floor",
    "Lot",
    "WHPO",
    "DO",
    "Container",
    "ContainerDocument",
    "ContainerLine",
    "LotAssignment",
    "Receipt",
    "Pallet",
    "Scan",
    "ExceptionRecord",
    "ActivityLog",
    # Outbound (Phase 2)
    "OutboundOrder",
    "OutboundLine",
    "OutboundLineSerial",
    "OutboundContainer",
    "OutboundScan",
]
