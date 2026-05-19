from __future__ import annotations

from datetime import date, timedelta

import pytest_asyncio
from sqlalchemy import select

from app.models import SKU, Container, ContainerLine, Customer, DO, ExceptionRecord, WHPO


# ─── Helper: submit a WHPO with unknown SKU to create an exception ─────


@pytest_asyncio.fixture
async def whpo_with_unknown_sku(client):
    """Vendor submits a WHPO with one unknown SKU → DO ends up
    pending_master_data with an open `unknown_sku` exception."""
    r = await client.post(
        "/vendor/whpo",
        json={
            "customer": "Lime Mobility",
            "whpo_number": "10000009",
            "submitter_name": "Vendor Bot",
            "submitter_email": "vendor@example.com",
            "expected_arrival_date": (date.today() + timedelta(days=3)).isoformat(),
            "arrival_window": "Morning",
            "containers": [
                {
                    "container_no": "MGRU0000001",
                    "lines": [{"sku": "LIME-NEW-MODEL-Q9", "qty": 24}],
                }
            ],
        },
    )
    assert r.status_code == 200, r.text
    return r.json()


# ─── DOs ────────────────────────────────────────────────────────────────


async def test_list_dos_returns_seeded(client):
    r = await client.get("/manager/dos")
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)
    # At minimum the seeded DO should be present
    do_numbers = {d["do_number"] for d in data}
    assert "DO-2026-0001" in do_numbers


async def test_list_dos_status_filter(client, whpo_with_unknown_sku):
    r = await client.get("/manager/dos?status=pending_master_data")
    assert r.status_code == 200
    data = r.json()
    do_num = whpo_with_unknown_sku["do_number"]
    assert any(d["do_number"] == do_num for d in data)
    # Every returned DO must have the filtered status
    assert all(d["status"] == "pending_master_data" for d in data)


async def test_get_do_detail(client, db_session):
    seeded_do = (
        await db_session.scalars(select(DO).where(DO.do_number == "DO-2026-0001"))
    ).one()
    r = await client.get(f"/manager/dos/{seeded_do.id}")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["do_number"] == "DO-2026-0001"
    assert data["customer_name"] == "Lime Mobility"
    assert len(data["containers"]) == 1
    assert data["containers"][0]["container_no"] == "HLXU9005263"
    assert data["containers"][0]["total_expected"] == 200


async def test_get_do_detail_404(client):
    r = await client.get("/manager/dos/999999")
    assert r.status_code == 404


# ─── Lots ───────────────────────────────────────────────────────────────


async def test_list_lots(client):
    r = await client.get("/manager/lots")
    assert r.status_code == 200
    data = r.json()
    codes = {lot["lot_code"] for lot in data}
    assert "A-1" in codes
    assert "SOLAR-1" in codes
    # Every lot has the required fields populated
    a1 = next(lot for lot in data if lot["lot_code"] == "A-1")
    assert a1["pallet_capacity"] == 60  # 23×70 sqft lot, ~60 pallets after aisle allowance
    assert a1["pallets_free"] >= 0
    assert 0.0 <= a1["occupancy_pct"] <= 100.0


async def test_get_lot_detail(client, db_session):
    from app.models import Lot

    a1 = (await db_session.scalars(select(Lot).where(Lot.lot_code == "A-1"))).one()
    r = await client.get(f"/manager/lots/{a1.id}")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["lot_code"] == "A-1"
    assert data["pallet_capacity"] == 60
    assert data["pallets_used"] >= 0
    assert isinstance(data["pallets"], list)


async def test_get_lot_detail_404(client):
    r = await client.get("/manager/lots/999999")
    assert r.status_code == 404


# ─── Exceptions ─────────────────────────────────────────────────────────


async def test_list_open_exceptions(client, whpo_with_unknown_sku):
    r = await client.get("/manager/exceptions")
    assert r.status_code == 200
    data = r.json()
    # At least one exception (the one our fixture just created)
    kinds = {e["kind"] for e in data}
    assert "unknown_sku" in kinds
    assert all(e["status"] == "open" for e in data)


async def test_resolve_unknown_sku_creates_master_and_flips_do(
    client, db_session, whpo_with_unknown_sku
):
    # Find the exception that was opened
    exc_list = (await client.get("/manager/exceptions?kind=unknown_sku")).json()
    target = next(e for e in exc_list if e["payload"]["sku_raw"] == "LIME-NEW-MODEL-Q9")
    exc_id = target["exception_id"]

    # Resolve it: provide the SKU master data
    r = await client.post(
        f"/manager/exceptions/{exc_id}/resolve",
        json={
            "sku_data": {
                "description": "Lime Q9 prototype",
                "sqft_per_unit": 4.0,
                "items_per_pallet": 8,
                "pallet_mode": "logical",
                "stackable": False,
                "unit": "each",
            },
            "resolved_by": "ken",
            "notes": "Confirmed with vendor",
        },
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["status"] == "resolved"
    assert data["sku_id"] is not None
    assert data["do_status_changed"] is True
    assert data["do_status"] == "ready"

    # Verify the SKU was actually created and linked to the ContainerLine
    new_sku = await db_session.get(SKU, data["sku_id"])
    assert new_sku.sku == "LIME-NEW-MODEL-Q9"
    assert new_sku.items_per_pallet == 8

    linked_lines = (
        await db_session.scalars(
            select(ContainerLine).where(ContainerLine.sku_id == data["sku_id"])
        )
    ).all()
    assert len(linked_lines) == 1
    assert linked_lines[0].sku_raw == "LIME-NEW-MODEL-Q9"


async def test_resolve_requires_payload(client, whpo_with_unknown_sku):
    exc_list = (await client.get("/manager/exceptions?kind=unknown_sku")).json()
    exc_id = next(
        e["exception_id"]
        for e in exc_list
        if e["payload"]["sku_raw"] == "LIME-NEW-MODEL-Q9"
    )

    r = await client.post(
        f"/manager/exceptions/{exc_id}/resolve",
        json={"resolved_by": "ken"},  # no sku_data
    )
    assert r.status_code == 400
    assert "sku_data" in r.json()["detail"]


async def test_resolve_404(client):
    r = await client.post(
        "/manager/exceptions/999999/resolve",
        json={
            "sku_data": {"items_per_pallet": 8},
            "resolved_by": "ken",
        },
    )
    assert r.status_code == 404


async def test_resolve_already_resolved_rejected(client, db_session, whpo_with_unknown_sku):
    # Find and pre-mark the exception as resolved
    exc = (
        await db_session.scalars(
            select(ExceptionRecord)
            .where(ExceptionRecord.kind == "unknown_sku", ExceptionRecord.status == "open")
        )
    ).first()
    exc.status = "resolved"
    await db_session.flush()

    r = await client.post(
        f"/manager/exceptions/{exc.id}/resolve",
        json={
            "sku_data": {"items_per_pallet": 8},
            "resolved_by": "ken",
        },
    )
    assert r.status_code == 400
    assert "not open" in r.json()["detail"]
