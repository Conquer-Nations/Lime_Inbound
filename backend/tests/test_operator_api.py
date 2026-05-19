from __future__ import annotations

from datetime import date, timedelta

import pytest_asyncio
from sqlalchemy import select

from app.models import SKU, Container, ContainerLine, Customer, DO, WHPO


# ─── Fixture: a fresh test container the test owns end-to-end ─────────


@pytest_asyncio.fixture
async def fresh_container(db_session):
    """Lime scooter container, 50 units, ETA today. 4 logical pallets needed."""
    lime = (
        await db_session.scalars(select(Customer).where(Customer.name == "Lime Mobility"))
    ).one()
    scooter_sku = (
        await db_session.scalars(select(SKU).where(SKU.sku == "LIME-SCOOTER-G4"))
    ).one()

    whpo = WHPO(whpo_number="TEST-WHPO-OPS", customer_id=lime.id)
    db_session.add(whpo)
    await db_session.flush()
    do = DO(
        do_number="TEST-DO-OPS",
        whpo_id=whpo.id,
        status="ready",
        expected_arrival_date=date.today(),
    )
    db_session.add(do)
    await db_session.flush()
    container = Container(
        container_no="TESU0000050",
        do_id=do.id,
        status="expected",
        expected_arrival_date=date.today(),
    )
    db_session.add(container)
    await db_session.flush()
    db_session.add(
        ContainerLine(
            container_id=container.id,
            sku_id=scooter_sku.id,
            sku_raw="LIME-SCOOTER-G4",
            qty=50,
            line_index=1,
        )
    )
    await db_session.flush()
    return container


# ─── Lookup ───────────────────────────────────────────────────────────


async def test_lookup_happy_path(client, fresh_container):
    r = await client.post(
        "/operator/container/lookup",
        json={"container_no": "TESU0000050", "operator": "lisa"},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["container_no"] == "TESU0000050"
    assert data["do_number"] == "TEST-DO-OPS"
    assert data["customer_name"] == "Lime Mobility"
    assert data["container_status"] == "receiving"
    assert data["receipt_id"] > 0
    assert data["total_expected"] == 50
    assert data["total_scanned"] == 0
    assert len(data["lines"]) == 1
    assert data["lines"][0]["qty"] == 50
    assert data["lines"][0]["items_per_pallet"] == 16
    assert len(data["assignments"]) >= 1
    # 50/16 = 4 pallets, fits in one lot
    plan = data["assignments"][0]
    assert plan["planned_pallets"] == 4
    assert plan["items_expected"] == 64  # 4 pallets × 16
    assert plan["status"] == "planned"
    assert data["alerts"] == []


async def test_lookup_not_found(client):
    r = await client.post(
        "/operator/container/lookup",
        json={"container_no": "ZZZU9999999", "operator": "lisa"},
    )
    assert r.status_code == 404


async def test_lookup_rejects_bad_container_format(client):
    r = await client.post(
        "/operator/container/lookup",
        json={"container_no": "not-iso-6346", "operator": "lisa"},
    )
    assert r.status_code == 422  # FastAPI validation


async def test_lookup_date_mismatch_alert(client, db_session, fresh_container):
    # Push the expected date a week into the future
    fresh_container.expected_arrival_date = date.today() + timedelta(days=7)
    await db_session.flush()

    r = await client.post(
        "/operator/container/lookup",
        json={"container_no": "TESU0000050", "operator": "lisa"},
    )
    assert r.status_code == 200
    data = r.json()
    kinds = [a["kind"] for a in data["alerts"]]
    assert "date_mismatch" in kinds


# ─── Scan ─────────────────────────────────────────────────────────────


async def test_scan_happy_path(client, fresh_container):
    lookup = (
        await client.post(
            "/operator/container/lookup",
            json={"container_no": "TESU0000050", "operator": "lisa"},
        )
    ).json()
    receipt_id = lookup["receipt_id"]

    r = await client.post(
        "/operator/scan",
        json={"receipt_id": receipt_id, "item_barcode": "ITEM-001", "operator": "lisa"},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["accepted"] is True
    assert data["result"] == "ok"
    assert data["total_scanned"] == 1
    assert data["total_expected"] == 50
    assert data["auto_cut"] is False
    assert data["auto_finish"] is False
    assert data["current_assignment"] is not None


async def test_scan_duplicate_rejected(client, fresh_container):
    lookup = (
        await client.post(
            "/operator/container/lookup",
            json={"container_no": "TESU0000050", "operator": "lisa"},
        )
    ).json()
    receipt_id = lookup["receipt_id"]

    await client.post(
        "/operator/scan",
        json={"receipt_id": receipt_id, "item_barcode": "ITEM-007", "operator": "lisa"},
    )
    r = await client.post(
        "/operator/scan",
        json={"receipt_id": receipt_id, "item_barcode": "ITEM-007", "operator": "lisa"},
    )
    data = r.json()
    assert data["accepted"] is False
    assert data["result"] == "duplicate"
    assert data["total_scanned"] == 1  # Only the first scan counted


async def test_scan_to_completion_triggers_auto_finish(client, fresh_container):
    """Scan all 50 items. The 50th scan should set auto_finish=True."""
    lookup = (
        await client.post(
            "/operator/container/lookup",
            json={"container_no": "TESU0000050", "operator": "lisa"},
        )
    ).json()
    receipt_id = lookup["receipt_id"]

    last_data = None
    for i in range(50):
        r = await client.post(
            "/operator/scan",
            json={
                "receipt_id": receipt_id,
                "item_barcode": f"BC-{i:05d}",
                "operator": "lisa",
            },
        )
        assert r.status_code == 200, r.text
        last_data = r.json()
        assert last_data["accepted"]

    assert last_data["total_scanned"] == 50
    assert last_data["auto_finish"] is True


async def test_full_flow_lookup_scan_finish(client, fresh_container):
    lookup = (
        await client.post(
            "/operator/container/lookup",
            json={"container_no": "TESU0000050", "operator": "lisa"},
        )
    ).json()
    receipt_id = lookup["receipt_id"]

    for i in range(50):
        await client.post(
            "/operator/scan",
            json={"receipt_id": receipt_id, "item_barcode": f"BC-{i}", "operator": "lisa"},
        )

    r = await client.post(
        "/operator/container/finish",
        json={"receipt_id": receipt_id, "operator": "lisa"},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["container_status"] == "received"
    assert data["receipt_status"] == "completed"
    assert data["total_scanned"] == 50
    assert data["total_expected"] == 50
    # 50 items / 16 per logical pallet = 4 pallets (3 full + 1 partial of 2)
    assert data["pallets_created"] == 4
