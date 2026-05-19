from __future__ import annotations

import pytest
from sqlalchemy import select

from app.models import SKU, Container, ContainerLine, DO, Lot, LotAssignment, WHPO
from app.services.assignment import (
    AlreadyInProgressError,
    CapacityOverflowError,
    LineInput,
    LotInput,
    UnknownSKUError,
    assign_container_lots,
    plan_assignment,
)


# ─── Pure function tests (sqft-based) ────────────────────────────────────


def test_single_line_fits_in_one_lot():
    # 200 units × 3 sqft/unit = 600 sqft total.
    # Lot has 1610 sqft free → fits easily.
    lines = [
        LineInput(sku_id=1, sku_code="A", qty=200, total_sqft=600.0, sqft_per_pallet=48.0)
    ]
    lots = [LotInput(lot_id=10, lot_code="A-1", free_sqft=1610.0)]

    plan = plan_assignment(lines, lots)

    assert len(plan) == 1
    assert plan[0].lot_id == 10
    assert plan[0].planned_sqft == 600.0
    assert plan[0].planned_pallets == 13  # ceil(600 / 48)
    assert plan[0].assignment_order == 1


def test_single_line_spans_two_lots():
    # Need 2000 sqft, lots have 1610 each → spans 2 lots
    lines = [
        LineInput(sku_id=1, sku_code="A", qty=300, total_sqft=2000.0, sqft_per_pallet=20.0)
    ]
    lots = [
        LotInput(lot_id=10, lot_code="A-1", free_sqft=1610.0),
        LotInput(lot_id=20, lot_code="B-1", free_sqft=1610.0),
    ]

    plan = plan_assignment(lines, lots)

    assert len(plan) == 2
    assert plan[0].planned_sqft == 1610.0
    assert plan[1].planned_sqft == 390.0
    assert plan[0].assignment_order == 1
    assert plan[1].assignment_order == 2


def test_multi_line_each_sku_assigned_separately():
    lines = [
        LineInput(sku_id=1, sku_code="EBIKE", qty=20, total_sqft=160.0, sqft_per_pallet=64.0),
        LineInput(sku_id=2, sku_code="SCOOTER", qty=200, total_sqft=600.0, sqft_per_pallet=48.0),
    ]
    lots = [LotInput(lot_id=10, lot_code="A-1", free_sqft=1610.0)]

    plan = plan_assignment(lines, lots)

    assert len(plan) == 2
    skus_in_plan = {p.sku_id for p in plan}
    assert skus_in_plan == {1, 2}
    assert sum(p.planned_sqft for p in plan) == 760.0


def test_largest_free_first_tie_break_alphabetical():
    lines = [LineInput(sku_id=1, sku_code="A", qty=10, total_sqft=100.0, sqft_per_pallet=50.0)]
    lots = [
        LotInput(lot_id=20, lot_code="B-1", free_sqft=1610.0),
        LotInput(lot_id=10, lot_code="A-1", free_sqft=1610.0),
    ]

    plan = plan_assignment(lines, lots)

    assert plan[0].lot_code == "A-1"


def test_capacity_overflow_raises():
    lines = [
        LineInput(sku_id=1, sku_code="A", qty=10000, total_sqft=50000.0, sqft_per_pallet=10.0)
    ]
    lots = [LotInput(lot_id=10, lot_code="A-1", free_sqft=1610.0)]

    with pytest.raises(CapacityOverflowError) as exc_info:
        plan_assignment(lines, lots)
    assert exc_info.value.sqft_needed > exc_info.value.sqft_available


def test_planned_pallets_derived_from_sqft():
    # 17 items × 1 sqft = 17 sqft. items_per_pallet = 16, so sqft_per_pallet = 16.
    # First chunk fills 16 sqft (pallet 1), second chunk 1 sqft (pallet 2 → ceil = 1)
    lines = [LineInput(sku_id=1, sku_code="A", qty=17, total_sqft=17.0, sqft_per_pallet=16.0)]
    lots = [LotInput(lot_id=10, lot_code="A-1", free_sqft=1610.0)]

    plan = plan_assignment(lines, lots)

    assert plan[0].planned_sqft == 17.0
    # ceil(17 / 16) = 2 pallets
    assert plan[0].planned_pallets == 2


# ─── Integration tests against seeded Postgres ──────────────────────────


async def test_assign_seeded_lime_container(db_session):
    """Seeded HLXU9005263 has 200 LIME-SCOOTER-G4. No vendor packaging on the
    seeded container → falls back to SKU master sqft_per_unit (3.0).
    Total = 200 × 3.0 = 600 sqft. Fits in any single 1610-sqft lot.
    """
    container = (
        await db_session.execute(
            select(Container).where(Container.container_no == "HLXU9005263")
        )
    ).scalar_one()

    plan_rows = await assign_container_lots(db_session, container.id)

    assert len(plan_rows) == 1
    row = plan_rows[0]
    assert row.planned_sqft == 600.0
    assert row.assignment_order == 1
    assert row.status == "planned"
    assert row.actual_sqft == 0.0

    lot = await db_session.get(Lot, row.lot_id)
    assert lot.lot_code == "A-1"  # all lots tied on free space → alphabetical


async def test_replan_clears_planned_rows(db_session):
    container = (
        await db_session.execute(
            select(Container).where(Container.container_no == "HLXU9005263")
        )
    ).scalar_one()

    rows_first = await assign_container_lots(db_session, container.id)
    rows_second = await assign_container_lots(db_session, container.id)

    assert len(rows_first) == 1
    assert len(rows_second) == 1
    assert rows_first[0].id != rows_second[0].id


async def test_active_assignment_blocks_replan(db_session):
    container = (
        await db_session.execute(
            select(Container).where(Container.container_no == "HLXU9005263")
        )
    ).scalar_one()

    rows = await assign_container_lots(db_session, container.id)
    rows[0].status = "active"
    await db_session.flush()

    with pytest.raises(AlreadyInProgressError):
        await assign_container_lots(db_session, container.id)


async def test_unknown_sku_raises(db_session):
    customer_id = (await db_session.scalars(select(SKU.customer_id).limit(1))).one()
    whpo = WHPO(whpo_number="TEST-WHPO-UNK", customer_id=customer_id)
    db_session.add(whpo)
    await db_session.flush()
    do = DO(do_number="TEST-DO-UNK", whpo_id=whpo.id, status="pending_master_data")
    db_session.add(do)
    await db_session.flush()
    cont = Container(container_no="TESTU0000001", do_id=do.id, status="expected")
    db_session.add(cont)
    await db_session.flush()
    db_session.add(
        ContainerLine(container_id=cont.id, sku_id=None, sku_raw="MYSTERY-SKU", qty=10)
    )
    await db_session.flush()

    with pytest.raises(UnknownSKUError) as exc_info:
        await assign_container_lots(db_session, cont.id)
    assert exc_info.value.sku_raw == "MYSTERY-SKU"


async def test_blocked_lots_excluded(db_session):
    container = (
        await db_session.execute(
            select(Container).where(Container.container_no == "HLXU9005263")
        )
    ).scalar_one()

    lots = (await db_session.scalars(select(Lot).where(Lot.lot_code.like("A-%")))).all()
    for lot in lots:
        lot.blocked = True
    await db_session.flush()

    rows = await assign_container_lots(db_session, container.id)
    lot_codes_used = {(await db_session.get(Lot, r.lot_id)).lot_code for r in rows}
    assert all(not code.startswith("A-") for code in lot_codes_used)


async def test_existing_planned_assignment_reduces_capacity(db_session):
    """Block bulk lots, reserve most of A-1's sqft so the seeded container
    has to spill to A-2 (or later)."""
    solar_lots = (
        await db_session.scalars(select(Lot).where(Lot.lot_code.like("SOLAR-%")))
    ).all()
    for lot in solar_lots:
        lot.blocked = True

    a1 = (await db_session.scalars(select(Lot).where(Lot.lot_code == "A-1"))).one()
    customer_id = (await db_session.scalars(select(SKU.customer_id).limit(1))).one()
    other_sku = (await db_session.scalars(select(SKU).limit(1))).one()

    whpo = WHPO(whpo_number="TEST-WHPO-RES", customer_id=customer_id)
    db_session.add(whpo)
    await db_session.flush()
    do = DO(do_number="TEST-DO-RES", whpo_id=whpo.id, status="ready")
    db_session.add(do)
    await db_session.flush()
    other_cont = Container(container_no="TESTU0000003", do_id=do.id, status="expected")
    db_session.add(other_cont)
    await db_session.flush()

    # Reserve 1500 sqft of A-1's 1610 → only 110 sqft free
    db_session.add(
        LotAssignment(
            container_id=other_cont.id,
            sku_id=other_sku.id,
            lot_id=a1.id,
            assignment_order=1,
            planned_sqft=1500.0,
            actual_sqft=0.0,
            planned_pallets=50,
            actual_pallets=0,
            status="planned",
        )
    )
    await db_session.flush()

    seeded = (
        await db_session.execute(
            select(Container).where(Container.container_no == "HLXU9005263")
        )
    ).scalar_one()
    # Seeded container needs 600 sqft (200 × 3 sqft). A-1 has 110 free → spills.
    rows = await assign_container_lots(db_session, seeded.id)

    # Largest-free-first picks A-2 (1610 free, > A-1's 110) → all 600 in A-2
    assert len(rows) == 1
    chosen_code = (await db_session.get(Lot, rows[0].lot_id)).lot_code
    assert chosen_code != "A-1"
