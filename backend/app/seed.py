"""Seed local Postgres with demo data so the operator flow can be tested end-to-end.

Run:    uv run python -m app.seed
"""

from __future__ import annotations

import asyncio
from datetime import date, time

from sqlalchemy import func, select

from app.db import SessionLocal
from app.models import (
    DO,
    SKU,
    WHPO,
    Container,
    ContainerLine,
    Customer,
    Floor,
    Lot,
)


async def main() -> None:
    async with SessionLocal() as s:
        existing = await s.scalar(select(func.count()).select_from(Customer))
        if existing:
            print(f"Database already contains {existing} customer(s). Skipping seed.")
            print("To re-seed: drop the database (dropdb cn_warehouse) and re-migrate.")
            return

        # ── Customers ──────────────────────────────────────────────────
        lime = Customer(name="Lime Mobility", contact_email="logistics@li.me")
        boviet = Customer(name="Boviet Solar", contact_email="ops@bovietsolar.com")
        pa_wire = Customer(name="Pan American Wire MFG", contact_email="ship@pamwire.com")
        nat_plastic = Customer(name="National Plastic", contact_email="logistics@natplas.com")
        tql = Customer(name="TQL Trading Inc.", contact_email="ops@tqltrading.com")
        s.add_all([lime, boviet, pa_wire, nat_plastic, tql])
        await s.flush()

        # ── SKUs (sqft + pallet master data) ───────────────────────────
        s.add_all(
            [
                SKU(
                    customer_id=lime.id,
                    sku="LIME-EBIKE-CITRA",
                    description="Lime E-Bike, Citra series",
                    sqft_per_unit=8.0,
                    items_per_pallet=4,
                    pallet_mode="logical",
                    unit="each",
                    source="seed",
                ),
                SKU(
                    customer_id=lime.id,
                    sku="LIME-SCOOTER-G4",
                    description="Lime Scooter, Gen 4",
                    sqft_per_unit=3.0,
                    items_per_pallet=16,
                    pallet_mode="logical",
                    unit="each",
                    source="seed",
                ),
                SKU(
                    customer_id=boviet.id,
                    sku="BOVIET-PANEL-540W",
                    description="Boviet 540W solar panel",
                    sqft_per_unit=10.0,
                    items_per_pallet=24,
                    pallet_mode="physical",
                    stackable=True,
                    max_stack_height=4,
                    unit="each",
                    source="seed",
                ),
                SKU(
                    customer_id=boviet.id,
                    sku="BOVIET-PANEL-545W",
                    description="Boviet 545W solar panel",
                    sqft_per_unit=10.0,
                    items_per_pallet=24,
                    pallet_mode="physical",
                    stackable=True,
                    max_stack_height=4,
                    unit="each",
                    source="seed",
                ),
                SKU(
                    customer_id=pa_wire.id,
                    sku="PAN-WIRE-100M",
                    description="100m wire spool",
                    sqft_per_unit=20.0,
                    items_per_pallet=4,
                    pallet_mode="physical",
                    unit="spool",
                    source="seed",
                ),
                SKU(
                    customer_id=nat_plastic.id,
                    sku="NAT-PALLET-A",
                    description="Plastic pallet, Type A",
                    sqft_per_unit=4.0,
                    items_per_pallet=60,
                    pallet_mode="logical",
                    stackable=True,
                    max_stack_height=10,
                    unit="each",
                    source="seed",
                ),
            ]
        )

        # ── Floors + Lots ──────────────────────────────────────────────
        f1 = Floor(name="Floor 1 — Warehouse", layout="GRID")
        f2 = Floor(name="Floor 2 — Picking & Pack-out", layout="R")
        f3 = Floor(name="Floor 3 — Bulk Storage", layout="R")
        s.add_all([f1, f2, f3])
        await s.flush()

        # Floor 1: 8 rack lots seeded here, each 23×70 = 1610 sqft.
        # Remaining 188 cells of the full Floor-1 grid get loaded by
        # `app.seed_floor1`. Pallet capacity ≈ 60 assumes standard 16 sqft
        # pallet footprint and ~60% effective area after aisle allowance.
        floor1_lots = [
            Lot(
                floor_id=f1.id,
                lot_code=f"{row}-{col}",
                type="rack",
                sqft_capacity=1610.0,
                pallet_capacity=60,
                max_stack_levels=2,
            )
            for row in ("A", "B")
            for col in range(1, 5)
        ]

        # Floor 3: 2 bulk lots, ~1000 sqft each, 60 pallet capacity
        floor3_lots = [
            Lot(
                floor_id=f3.id,
                lot_code=f"SOLAR-{i}",
                type="bulk",
                sqft_capacity=1000.0,
                pallet_capacity=60,
                max_stack_levels=4,
                notes="Solar panel bulk storage",
            )
            for i in (1, 2)
        ]

        s.add_all(floor1_lots + floor3_lots)

        # ── Sample WHPO + DO + Container + Lines (Lime scooter shipment) ──
        whpo = WHPO(
            whpo_number="WHPO-LIME-2026-0001",
            customer_id=lime.id,
            notes="Seed demo shipment",
        )
        s.add(whpo)
        await s.flush()

        do = DO(
            do_number="DO-2026-0001",
            whpo_id=whpo.id,
            status="ready",
            expected_arrival_date=date(2026, 5, 16),
            expected_arrival_time=time(10, 30),
            issued_by="system",
        )
        s.add(do)
        await s.flush()

        container = Container(
            container_no="HLXU9005263",
            do_id=do.id,
            expected_arrival_date=date(2026, 5, 16),
            status="expected",
        )
        s.add(container)
        await s.flush()

        scooter_sku = await s.scalar(select(SKU).where(SKU.sku == "LIME-SCOOTER-G4"))
        s.add(
            ContainerLine(
                container_id=container.id,
                sku_id=scooter_sku.id,
                sku_raw="LIME-SCOOTER-G4",
                qty=200,
                line_index=1,
            )
        )

        await s.commit()

        # ── Summary ────────────────────────────────────────────────────
        print("Seed complete.")
        print(f"  Customers:   4 ({lime.name}, {boviet.name}, ...)")
        print(f"  SKUs:        6")
        print(f"  Floors:      3")
        print(f"  Lots:        {len(floor1_lots) + len(floor3_lots)}")
        print(f"  Sample WHPO: {whpo.whpo_number} -> {do.do_number} -> {container.container_no}")
        print(f"               200 × LIME-SCOOTER-G4 (600 sqft, ~13 logical pallets)")


if __name__ == "__main__":
    asyncio.run(main())
