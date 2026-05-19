from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import func, select

from app.models import (
    SKU,
    ActivityLog,
    Container,
    ContainerLine,
    Customer,
    DO,
    ExceptionRecord,
    WHPO,
)


def _payload(
    *,
    customer: str = "Lime Mobility",
    whpo_number: str = "10000001",
    expected_arrival: date | None = None,
    containers: list[dict] | None = None,
) -> dict:
    return {
        "customer": customer,
        "whpo_number": whpo_number,
        "submitter_name": "Vendor Bot",
        "submitter_email": "vendor@example.com",
        "expected_arrival_date": (expected_arrival or date.today() + timedelta(days=2)).isoformat(),
        "arrival_window": "Morning",
        "bol_number": "BOL-9999",
        "containers": containers
        or [
            {
                "container_no": "VEND0000001",
                "lines": [{"sku": "LIME-SCOOTER-G4", "qty": 80}],
            }
        ],
        "notes": "Test submission",
    }


# ─── Happy path ────────────────────────────────────────────────────────


async def test_submit_known_skus_creates_full_chain(client, db_session):
    r = await client.post("/vendor/whpo", json=_payload())
    assert r.status_code == 200, r.text
    data = r.json()

    assert data["whpo_number"] == "10000001"
    assert data["do_number"].startswith("DO-")
    assert data["do_status"] == "ready"
    assert data["idempotent_replay"] is False
    assert len(data["containers"]) == 1
    assert data["containers"][0]["container_no"] == "VEND0000001"
    assert data["containers"][0]["unknown_skus"] == []
    assert data["exceptions_opened"] == []

    # Verify DB state through the same session
    whpo = (
        await db_session.scalars(select(WHPO).where(WHPO.whpo_number == "10000001"))
    ).one()
    do = (await db_session.scalars(select(DO).where(DO.whpo_id == whpo.id))).one()
    assert do.status == "ready"
    container = (
        await db_session.scalars(select(Container).where(Container.do_id == do.id))
    ).one()
    line = (
        await db_session.scalars(select(ContainerLine).where(ContainerLine.container_id == container.id))
    ).one()
    assert line.qty == 80
    assert line.sku_id is not None  # resolved against master


# ─── Unknown SKU → opens exception, DO is pending ──────────────────────


async def test_unknown_sku_opens_exception(client, db_session):
    payload = _payload(
        whpo_number="10000002",
        containers=[
            {
                "container_no": "VEND0000002",
                "lines": [
                    {"sku": "LIME-SCOOTER-G4", "qty": 80},
                    {"sku": "LIME-MYSTERY-X9", "qty": 5},
                ],
            }
        ],
    )
    r = await client.post("/vendor/whpo", json=payload)
    assert r.status_code == 200, r.text
    data = r.json()

    assert data["do_status"] == "pending_master_data"
    assert data["containers"][0]["unknown_skus"] == ["LIME-MYSTERY-X9"]
    assert len(data["exceptions_opened"]) == 1
    exc = data["exceptions_opened"][0]
    assert exc["kind"] == "unknown_sku"
    assert exc["payload"]["sku_raw"] == "LIME-MYSTERY-X9"

    # Verify exception was persisted
    db_exc = (
        await db_session.scalars(
            select(ExceptionRecord).where(ExceptionRecord.id == exc["exception_id"])
        )
    ).one()
    assert db_exc.kind == "unknown_sku"
    assert db_exc.status == "open"


# ─── Idempotency ───────────────────────────────────────────────────────


async def test_resubmitting_same_whpo_returns_existing_do(client):
    first = await client.post("/vendor/whpo", json=_payload(whpo_number="10000003"))
    second = await client.post(
        "/vendor/whpo",
        json=_payload(
            whpo_number="10000003",
            containers=[
                # Different payload — should be ignored, original returned
                {
                    "container_no": "DIFF0000001",
                    "lines": [{"sku": "ZZZ-IGNORE-ME", "qty": 1}],
                }
            ],
        ),
    )

    first_data = first.json()
    second_data = second.json()
    assert first_data["do_id"] == second_data["do_id"]
    assert second_data["idempotent_replay"] is True
    # Containers list should reflect the ORIGINAL submission, not the second
    container_nos = [c["container_no"] for c in second_data["containers"]]
    assert "VEND0000001" in container_nos
    assert "DIFF0000001" not in container_nos


# ─── Container collision (with different WHPO) ─────────────────────────


async def test_duplicate_container_across_whpos_rejected(client):
    await client.post("/vendor/whpo", json=_payload(whpo_number="10000004"))
    r = await client.post(
        "/vendor/whpo",
        json=_payload(whpo_number="10000005"),  # same container_no
    )
    assert r.status_code == 409
    assert "already attached" in r.json()["detail"]


# ─── Unknown customer → 400 ────────────────────────────────────────────


async def test_unknown_customer_rejected(client):
    r = await client.post(
        "/vendor/whpo",
        json=_payload(customer="Not A Real Customer", whpo_number="10000006"),
    )
    assert r.status_code == 400
    assert "Unknown customer" in r.json()["detail"]


# ─── Multi-container WHPO ──────────────────────────────────────────────


async def test_multi_container_whpo(client, db_session):
    payload = _payload(
        whpo_number="10000007",
        containers=[
            {"container_no": "MULT0000001", "lines": [{"sku": "LIME-SCOOTER-G4", "qty": 30}]},
            {"container_no": "MULT0000002", "lines": [{"sku": "LIME-SCOOTER-G4", "qty": 50}]},
        ],
    )
    r = await client.post("/vendor/whpo", json=payload)
    assert r.status_code == 200
    data = r.json()
    assert len(data["containers"]) == 2

    do_id = data["do_id"]
    containers_in_db = (
        await db_session.scalars(select(Container).where(Container.do_id == do_id))
    ).all()
    assert len(containers_in_db) == 2


# ─── Activity log written ───────────────────────────────────────────────


async def test_activity_log_recorded(client, db_session):
    r = await client.post("/vendor/whpo", json=_payload(whpo_number="10000008"))
    do_id = r.json()["do_id"]

    log_count = await db_session.scalar(
        select(func.count())
        .select_from(ActivityLog)
        .where(ActivityLog.ref_type == "do", ActivityLog.ref_id == do_id)
    )
    assert log_count == 1
