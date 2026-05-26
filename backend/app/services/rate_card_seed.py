"""Master rate card seed.

Ported verbatim from CN-BILLING's `src/rates.js`. Edits should round-
trip with that source — both apps share Conquer Nation's master
pricing spec.

Categories (used as `rate_card.category` enum values):
    HANDLING, ORDER_PROC, PICKING, PUTAWAY, STORAGE, BOL_SHIP,
    ACCESSORIAL, IT, MDS, LABOR, DRAYAGE.
"""
from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import RateCard

logger = logging.getLogger(__name__)


CATEGORIES: dict[str, str] = {
    "HANDLING": "Handling Services",
    "ORDER_PROC": "Order Processing",
    "PICKING": "Order Picking",
    "PUTAWAY": "Put Away & Sort",
    "STORAGE": "Storage",
    "BOL_SHIP": "BOL & Shipping",
    "ACCESSORIAL": "Accessorial / Special Services",
    "IT": "IT Services",
    "MDS": "MDS / Regulatory",
    "LABOR": "Labor (Hourly)",
    "DRAYAGE": "Drayage",
}


# rate=None → "enter manually at line entry"
# taxable=True on materials only (CA does not tax warehousing labor)
# is_minimum=True → auto-applied floor, hidden from picker
# is_advance=True → vendor pass-through with markup
RATES: list[dict] = [
    # ───── H1 HANDLING ────────────────────────────────────────────
    {"code": "HND-001", "cat": "HANDLING", "desc": "Handling In/Out Floor Loaded — Box 1-24 lbs", "unit": "per carton (each in & each out)", "rate": 0.50},
    {"code": "HND-002", "cat": "HANDLING", "desc": "Handling In/Out Floor Loaded — Box 25-49 lbs", "unit": "per carton", "rate": 0.75},
    {"code": "HND-003", "cat": "HANDLING", "desc": "Handling In/Out Floor Loaded — Box 50-74 lbs", "unit": "per carton", "rate": 1.00},
    {"code": "HND-004", "cat": "HANDLING", "desc": "Handling In/Out Floor Loaded — Box 75-99 lbs", "unit": "per carton", "rate": 1.50},
    {"code": "HND-005", "cat": "HANDLING", "desc": "Handling In/Out Floor Loaded — Container Minimum (up to 600 ctns)", "unit": "per container", "rate": 750.00},
    {"code": "HND-010", "cat": "HANDLING", "desc": "Handling In/Out Oversized — 2 to 4 cube", "unit": "per cube", "rate": 0.50},
    {"code": "HND-011", "cat": "HANDLING", "desc": "Handling In/Out Oversized — 4 to 6 cube", "unit": "per cube", "rate": 0.85},
    {"code": "HND-012", "cat": "HANDLING", "desc": "Handling In/Out Oversized — 6 cube & up", "unit": "per cube", "rate": 1.00},
    {"code": "HND-020", "cat": "HANDLING", "desc": "Handling In/Out Palletized", "unit": "per pallet", "rate": 16.50},
    {"code": "HND-030", "cat": "HANDLING", "desc": "Hazmat Handling Fee — Shipment", "unit": "per shipment", "rate": 250.00},
    {"code": "HND-031", "cat": "HANDLING", "desc": "Hazmat Handling — Palletized", "unit": "per pallet", "rate": 35.00},
    {"code": "HND-032", "cat": "HANDLING", "desc": "Hazmat Handling — Super Sack (floor)", "unit": "per super sack", "rate": 40.00},
    {"code": "HND-033", "cat": "HANDLING", "desc": "Hazmat Handling — Drum (floor)", "unit": "per drum", "rate": 25.00},
    {"code": "HND-034", "cat": "HANDLING", "desc": "Hazmat Handling — Pail (floor)", "unit": "per pail", "rate": 15.00},
    {"code": "HND-035", "cat": "HANDLING", "desc": "Hazmat Handling — Bag/Box (floor)", "unit": "per bag/box", "rate": 5.00},
    {"code": "HND-040", "cat": "HANDLING", "desc": "Transload on Pallets — up to 20 pallets per container (Non-Hazmat)", "unit": "per container minimum", "rate": 350.00},
    {"code": "HND-041", "cat": "HANDLING", "desc": "Transload on Pallets — over 20 pallets per container (Non-Hazmat)", "unit": "per container minimum", "rate": 750.00},
    {"code": "HND-050", "cat": "HANDLING", "desc": "Palletizing", "unit": "per pallet", "rate": 15.00},
    {"code": "HND-060", "cat": "HANDLING", "desc": "Shrink Wrapping", "unit": "per pallet", "rate": 4.00},
    {"code": "HND-061", "cat": "HANDLING", "desc": "Banding/Strapping", "unit": "per pallet", "rate": 7.00},

    # ───── H2 ORDER PROCESSING ───────────────────────────────────
    {"code": "ORD-001", "cat": "ORDER_PROC", "desc": "Order Processing — Email", "unit": "per order", "rate": 4.50},
    {"code": "ORD-002", "cat": "ORDER_PROC", "desc": "Order Processing — EDI", "unit": "per order", "rate": 8.00},
    {"code": "ORD-003", "cat": "ORDER_PROC", "desc": "Order Processing — File Upload", "unit": "per order", "rate": 10.00},
    {"code": "ORD-004", "cat": "ORDER_PROC", "desc": "Order Processing — Manual", "unit": "per order", "rate": 12.00},
    {"code": "ORD-010", "cat": "ORDER_PROC", "desc": "Retail Routing", "unit": "per order", "rate": 4.75},

    # ───── H3 ORDER PICKING ──────────────────────────────────────
    {"code": "PIK-001", "cat": "PICKING", "desc": "Order Pick — Small Items", "unit": "each", "rate": 2.50},
    {"code": "PIK-002", "cat": "PICKING", "desc": "Order Pick — Case/Bag < 40 lbs", "unit": "each", "rate": 3.75},
    {"code": "PIK-003", "cat": "PICKING", "desc": "Order Pick — Case/Bag > 40 lbs", "unit": "each", "rate": 5.00},
    {"code": "PIK-004", "cat": "PICKING", "desc": "Order Pick — Pail", "unit": "each", "rate": 10.00},
    {"code": "PIK-005", "cat": "PICKING", "desc": "Order Pick — Pallet/Tote", "unit": "each", "rate": 10.00},
    {"code": "PIK-006", "cat": "PICKING", "desc": "Order Pick — Drum", "unit": "each", "rate": 20.00},
    {"code": "PIK-MIN", "cat": "PICKING", "desc": "Order Pick Minimum", "unit": "per order", "rate": 10.00, "minimum": True},
    {"code": "PIK-LINE", "cat": "PICKING", "desc": "Line Minimum", "unit": "per line/location", "rate": 4.00},

    # ───── H4 PUT AWAY & SORT ────────────────────────────────────
    {"code": "PUT-001", "cat": "PUTAWAY", "desc": "Product Put Away — Pallet/Tote", "unit": "each", "rate": 5.00},
    {"code": "PUT-002", "cat": "PUTAWAY", "desc": "Product Put Away — Case", "unit": "each", "rate": 1.00},
    {"code": "PUT-MIN", "cat": "PUTAWAY", "desc": "Product Put Away Minimum", "unit": "per SKU/LOT", "rate": 9.00, "minimum": True},
    {"code": "SRT-001", "cat": "PUTAWAY", "desc": "Sort & Seg by SKU — 2-5 SKUs", "unit": "per carton", "rate": 0.55},
    {"code": "SRT-002", "cat": "PUTAWAY", "desc": "Sort & Seg by SKU — 6-11 SKUs", "unit": "per carton", "rate": 0.75},
    {"code": "SRT-003", "cat": "PUTAWAY", "desc": "Sort & Seg by SKU — 11+ SKUs", "unit": "per carton", "rate": 0.95},
    {"code": "SRT-004", "cat": "PUTAWAY", "desc": "Sort & Seg — Multiple SKUs in a Box", "unit": "per piece", "rate": 0.40},

    # ───── H5 STORAGE ────────────────────────────────────────────
    {"code": "STG-D-NH", "cat": "STORAGE", "desc": "Daily Storage — Non-Hazmat", "unit": "per standard pallet per stack", "rate": 3.00},
    {"code": "STG-D-H", "cat": "STORAGE", "desc": "Daily Storage — Hazmat", "unit": "per standard pallet per stack", "rate": 5.00},
    {"code": "STG-W-NH", "cat": "STORAGE", "desc": "Weekly Storage — Non-Hazmat", "unit": "per standard pallet per stack", "rate": 10.00},
    {"code": "STG-W-H", "cat": "STORAGE", "desc": "Weekly Storage — Hazmat", "unit": "per standard pallet per stack", "rate": 18.00},
    {"code": "STG-M-NH", "cat": "STORAGE", "desc": "Monthly Storage — Non-Hazmat", "unit": "per standard pallet per stack", "rate": 48.00},
    {"code": "STG-M-GC", "cat": "STORAGE", "desc": "Monthly Storage — General Commodity", "unit": "per standard pallet per stack", "rate": 26.00},
    {"code": "STG-M-FC", "cat": "STORAGE", "desc": "Monthly Storage — Flammable/Corrosive", "unit": "per standard pallet per stack", "rate": 55.00},
    {"code": "STG-M-TX", "cat": "STORAGE", "desc": "Monthly Storage — Toxic", "unit": "per standard pallet per stack", "rate": 70.00},
    {"code": "STG-D-DRM", "cat": "STORAGE", "desc": "Daily Storage — Drum, General Commodity", "unit": "per standard pallet per stack", "rate": 3.00},
    {"code": "STG-W-DRM", "cat": "STORAGE", "desc": "Weekly Storage — Drum, General Commodity", "unit": "per standard pallet per stack", "rate": 10.00},
    {"code": "STG-M-DRM", "cat": "STORAGE", "desc": "Monthly Storage — Drum, General Commodity", "unit": "per standard pallet per stack", "rate": 48.00},
    {"code": "STG-D-DRM-H", "cat": "STORAGE", "desc": "Daily Storage — Drum, Hazmat", "unit": "per standard pallet per stack", "rate": 5.00},
    {"code": "STG-W-DRM-H", "cat": "STORAGE", "desc": "Weekly Storage — Drum, Hazmat", "unit": "per standard pallet per stack", "rate": 18.00},
    {"code": "STG-M-DRM-FC", "cat": "STORAGE", "desc": "Monthly Storage — Drum, Flammable/Corrosive", "unit": "per standard pallet per stack", "rate": 55.00},
    {"code": "STG-M-DRM-TX", "cat": "STORAGE", "desc": "Monthly Storage — Drum, Toxic", "unit": "per standard pallet per stack", "rate": 70.00},
    {"code": "STG-MIN", "cat": "STORAGE", "desc": "Recurring Storage Minimum", "unit": "per month", "rate": 5000.00, "minimum": True},
    {"code": "STG-SALV", "cat": "STORAGE", "desc": "Salvage Drum Storage", "unit": "per drum/tote", "rate": 150.00},

    # ───── H6 BOL & SHIPPING ─────────────────────────────────────
    {"code": "BOL-001", "cat": "BOL_SHIP", "desc": "Bill of Lading Charge", "unit": "each", "rate": 12.00},
    {"code": "LBL-001", "cat": "BOL_SHIP", "desc": "Label Applied", "unit": "per label", "rate": 0.50, "taxable": True},
    {"code": "LBL-002", "cat": "BOL_SHIP", "desc": "Label Removal", "unit": "per label", "rate": 0.90, "taxable": True},
    {"code": "LBL-003", "cat": "BOL_SHIP", "desc": "Relabel", "unit": "per label", "rate": 0.65, "taxable": True},
    {"code": "PCL-001", "cat": "BOL_SHIP", "desc": "Parcel Shipping — Parcel Label", "unit": "per label", "rate": 0.50, "taxable": True},
    {"code": "PCL-002", "cat": "BOL_SHIP", "desc": "Parcel Shipping — UPS Label", "unit": "per label", "rate": 0.50, "taxable": True},
    {"code": "PCL-003", "cat": "BOL_SHIP", "desc": "Parcel/UPS Processing per Order", "unit": "per order", "rate": 3.50},
    {"code": "BOX-001", "cat": "BOL_SHIP", "desc": "Shipping Box (varies by size, enter actual)", "unit": "per box", "rate": None, "taxable": True},
    {"code": "BOX-010", "cat": "BOL_SHIP", "desc": "Consolidating Pack Fee", "unit": "per box", "rate": 2.50, "taxable": True},
    {"code": "BOX-011", "cat": "BOL_SHIP", "desc": "Retape/Fix Box", "unit": "per box", "rate": 0.50, "taxable": True},

    # ───── H7 ACCESSORIAL ────────────────────────────────────────
    {"code": "ACC-001", "cat": "ACCESSORIAL", "desc": "Same Day Order (placed before noon)", "unit": "per order", "rate": 50.00},
    {"code": "ACC-002", "cat": "ACCESSORIAL", "desc": "Same Day Order (placed after noon)", "unit": "per order", "rate": 125.00},
    {"code": "ACC-010", "cat": "ACCESSORIAL", "desc": "Shipment Notification — Not Provided", "unit": "per shipment", "rate": 75.00},
    {"code": "ACC-020", "cat": "ACCESSORIAL", "desc": "Returned Order Processing", "unit": "per order", "rate": 18.00},
    {"code": "ACC-030", "cat": "ACCESSORIAL", "desc": "Cancelled Order", "unit": "per order", "rate": 10.00},
    {"code": "ACC-031", "cat": "ACCESSORIAL", "desc": "Order Change Fee", "unit": "per order", "rate": 10.00},
    {"code": "ACC-040", "cat": "ACCESSORIAL", "desc": "De-Pick Fee", "unit": "hourly", "rate": 60.00},
    {"code": "ACC-050", "cat": "ACCESSORIAL", "desc": "Restocking Charge (order)", "unit": "per order", "rate": 3.50},
    {"code": "ACC-051", "cat": "ACCESSORIAL", "desc": "Restocking Charge (piece)", "unit": "per piece", "rate": 0.70},
    {"code": "ACC-060", "cat": "ACCESSORIAL", "desc": "Vendor Charge Advancing (invoice + 20%)", "unit": "per vendor invoice", "rate": None, "note": "Enter the vendor invoice $; system applies +20%.", "advance": True},
    {"code": "ACC-070", "cat": "ACCESSORIAL", "desc": "Inventory Count", "unit": "per piece", "rate": 0.30},
    {"code": "ACC-080", "cat": "ACCESSORIAL", "desc": "Serial Number Tracking", "unit": "per scan/item", "rate": 0.80},
    {"code": "ACC-090", "cat": "ACCESSORIAL", "desc": "New Item Validation & Setup", "unit": "per item", "rate": 5.00},
    {"code": "ACC-100", "cat": "ACCESSORIAL", "desc": "Photographs (max $22/request)", "unit": "per photo", "rate": 5.00, "max_per_request": 22.00},
    {"code": "ACC-110", "cat": "ACCESSORIAL", "desc": "Scan Charges", "unit": "per scan", "rate": 5.00},
    {"code": "ACC-120", "cat": "ACCESSORIAL", "desc": "Inbound Delivery without Appointment", "unit": "per inbound", "rate": 150.00},
    {"code": "ACC-130", "cat": "ACCESSORIAL", "desc": "Truck Seals", "unit": "per seal", "rate": 2.75, "taxable": True},

    # ───── H9 IT ─────────────────────────────────────────────────
    {"code": "IT-EDI-1", "cat": "IT", "desc": "EDI Interchange — ≤50 orders/mo", "unit": "monthly", "rate": None},
    {"code": "IT-EDI-2", "cat": "IT", "desc": "EDI Interchange — 50-250 orders/mo", "unit": "monthly", "rate": None},
    {"code": "IT-EDI-3", "cat": "IT", "desc": "EDI Interchange — 250+ orders/mo", "unit": "monthly", "rate": None},
    {"code": "IT-NET", "cat": "IT", "desc": "Shared Internet Data Line Usage", "unit": "monthly", "rate": 125.00},
    {"code": "IT-INT", "cat": "IT", "desc": "Data Integration / EDI Sets / Custom Reporting/Labels", "unit": "monthly", "rate": 180.00},
    {"code": "IT-PROG", "cat": "IT", "desc": "Custom Programming / Reports / Data Extraction", "unit": "hourly", "rate": 180.00},
    {"code": "IT-EDI-DEV", "cat": "IT", "desc": "EDI Transaction Sets Development", "unit": "hourly", "rate": 180.00},
    {"code": "IT-LBL-DEV", "cat": "IT", "desc": "Custom Label Creation/Modification", "unit": "hourly", "rate": 180.00},
    {"code": "IT-SUP", "cat": "IT", "desc": "PC/LAN/WAN Support", "unit": "hourly", "rate": 180.00},

    # ───── H10 MDS ───────────────────────────────────────────────
    {"code": "MDS-001", "cat": "MDS", "desc": "Initial Filing MDS Fee", "unit": "per hour", "rate": 52.00},
    {"code": "MDS-002", "cat": "MDS", "desc": "Rate per MDS", "unit": "per document", "rate": 4.55},
    {"code": "MDS-003", "cat": "MDS", "desc": "Annual MDS Maintenance Fee", "unit": "per document", "rate": 10.00},

    # ───── H11 LABOR ─────────────────────────────────────────────
    {"code": "LBR-WH", "cat": "LABOR", "desc": "Warehouse Labor — Mon-Fri", "unit": "hourly (¼-hour increments)", "rate": 60.00},
    {"code": "LBR-WH-OT", "cat": "LABOR", "desc": "Warehouse Labor — Mon-Sat OT", "unit": "hourly (¼-hour increments)", "rate": 104.00},
    {"code": "LBR-WH-SUN", "cat": "LABOR", "desc": "Warehouse Labor — Sun/Holiday OT", "unit": "hourly (¼-hour increments)", "rate": 120.00},
    {"code": "LBR-FK", "cat": "LABOR", "desc": "Forklift Operator — Mon-Fri", "unit": "hourly (¼-hour increments)", "rate": 65.00},
    {"code": "LBR-FK-OT", "cat": "LABOR", "desc": "Forklift Operator — Mon-Sat OT", "unit": "hourly (¼-hour increments)", "rate": 116.00},
    {"code": "LBR-FK-SUN", "cat": "LABOR", "desc": "Forklift Operator — Sun/Holiday OT", "unit": "hourly (¼-hour increments)", "rate": 130.00},
    {"code": "LBR-AD", "cat": "LABOR", "desc": "Administrative — Mon-Fri", "unit": "hourly (¼-hour increments)", "rate": 75.00},
    {"code": "LBR-AD-OT", "cat": "LABOR", "desc": "Administrative — Mon-Sat OT", "unit": "hourly (¼-hour increments)", "rate": 130.00},
    {"code": "LBR-AD-SUN", "cat": "LABOR", "desc": "Administrative — Sun/Holiday OT", "unit": "hourly (¼-hour increments)", "rate": 150.00},
    {"code": "LBR-SV", "cat": "LABOR", "desc": "Supervisor — Mon-Fri", "unit": "hourly (¼-hour increments)", "rate": 80.00},
    {"code": "LBR-SV-OT", "cat": "LABOR", "desc": "Supervisor — Mon-Sat OT", "unit": "hourly (¼-hour increments)", "rate": 156.00},
    {"code": "LBR-SV-SUN", "cat": "LABOR", "desc": "Supervisor — Sun/Holiday OT", "unit": "hourly (¼-hour increments)", "rate": 160.00},

    # ───── H12 DRAYAGE ───────────────────────────────────────────
    {"code": "DRY-BASE", "cat": "DRAYAGE", "desc": "Dray Base Rate", "unit": "per container", "rate": None, "note": "Enter base rate per quote"},
    {"code": "DRY-FSC", "cat": "DRAYAGE", "desc": "Fuel Surcharge", "unit": "per container", "rate": None, "note": "Per CN fuel schedule when diesel > $3.99/gal"},
    {"code": "DRY-PRE", "cat": "DRAYAGE", "desc": "Pre-Pull", "unit": "per container", "rate": 119.50},
    {"code": "DRY-PCF", "cat": "DRAYAGE", "desc": "Port Congestion Fee", "unit": "per container", "rate": 175.00},
    {"code": "DRY-NGT", "cat": "DRAYAGE", "desc": "Night Gate Charge", "unit": "per container", "rate": 80.00},
    {"code": "DRY-CHS", "cat": "DRAYAGE", "desc": "Steamship Line Chassis Charge (min 3 days)", "unit": "per chassis/day", "rate": 45.00},
    {"code": "DRY-RFR", "cat": "DRAYAGE", "desc": "Reefer Charge & Chassis Split", "unit": "per container", "rate": 172.50},
    {"code": "DRY-OW3", "cat": "DRAYAGE", "desc": "Overweight — Tri-axle Chassis (min 3 days)", "unit": "per chassis/day", "rate": 103.50},
    {"code": "DRY-OW4", "cat": "DRAYAGE", "desc": "Overweight — 4-Axle Tractor (min 3 days)", "unit": "per chassis/day", "rate": 218.25},
    {"code": "DRY-DRY", "cat": "DRAYAGE", "desc": "Dry-Run Charges (75% of base dray)", "unit": "per container", "rate": None, "note": "Auto = 75% × DRY-BASE on same load"},
    {"code": "DRY-BOB", "cat": "DRAYAGE", "desc": "Bobtail Charges (50% of base dray)", "unit": "per container", "rate": None, "note": "Auto = 50% × DRY-BASE on same load"},
    {"code": "DRY-WT", "cat": "DRAYAGE", "desc": "Waiting Time (after 60 min free)", "unit": "per hour", "rate": 95.00},
    {"code": "DRY-LLU", "cat": "DRAYAGE", "desc": "Live Load/Unload (after 120 min free)", "unit": "per hour", "rate": 90.00},
    {"code": "DRY-STG", "cat": "DRAYAGE", "desc": "Container Storage (loaded or empty)", "unit": "per day", "rate": 50.00},
    {"code": "DRY-PPF", "cat": "DRAYAGE", "desc": "PierPass Advance Fee (pass + 20%)", "unit": "per container", "rate": None, "advance": True},
    {"code": "DRY-ADV", "cat": "DRAYAGE", "desc": "Drayage Advancing Charge (min $36.50, actual + 20%)", "unit": "per invoice", "rate": None, "advance": True, "min_advance": 36.50},
    {"code": "DRY-HAZ", "cat": "DRAYAGE", "desc": "Hazardous Materials Drayage (DRY-BASE + 20%)", "unit": "per container", "rate": None, "note": "Auto = DRY-BASE × 1.20"},
]


async def seed_rate_card(session: AsyncSession) -> int:
    """Idempotent seed. Inserts any missing codes, leaves existing rows
    alone (so manager edits to rates survive). Returns count inserted."""
    existing_codes = set(
        (await session.scalars(select(RateCard.code))).all()
    )
    to_insert = [r for r in RATES if r["code"] not in existing_codes]
    for r in to_insert:
        session.add(
            RateCard(
                code=r["code"],
                category=r["cat"],
                description=r["desc"],
                unit=r["unit"],
                rate=r.get("rate"),
                taxable=bool(r.get("taxable")),
                is_minimum=bool(r.get("minimum")),
                is_advance=bool(r.get("advance")),
                note=r.get("note"),
                max_per_request=r.get("max_per_request"),
                min_advance=r.get("min_advance"),
            )
        )
    if to_insert:
        await session.commit()
        logger.info("rate_card seed: inserted %d codes", len(to_insert))
    return len(to_insert)
