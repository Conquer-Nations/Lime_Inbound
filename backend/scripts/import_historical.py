#!/usr/bin/env python3
"""Phase 1 historical-data import: WHPOs, DOs, Containers, OutboundOrders,
OutboundContainers.

Reads a master-list-shaped Excel file (the same 22-column shape as
vw_master_list and the existing Lime-Inventory xlsx export) and stages
inserts against the live Postgres.

Default mode is DRY-RUN — prints a diff vs the current DB and exits
without writing. Re-run with --commit to actually insert. All inserts
happen inside a single transaction; one bad row rolls back everything.

Idempotent: re-running skips rows whose whpo_number / container_no /
transfer_order_no already exist. Use --force to overwrite (Phase 2 only).

Usage:
    # Inspect what would happen
    python scripts/import_historical.py /path/to/HISTORICAL\\ DATA.xlsx

    # Actually commit
    python scripts/import_historical.py /path/to/HISTORICAL\\ DATA.xlsx --commit

    # Pin to a specific customer if commodity-to-brand mapping isn't 1:1
    # (default: every row → Lime Mobility, which fits this dataset)
    python scripts/import_historical.py file.xlsx --customer "Lime Mobility"

Skipped rows are logged with the reason; supply --report-skips path.csv to
export them for manual fix-up.
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import re
import sys
import time as _time
from collections import Counter
from datetime import date, datetime, time, timezone
from pathlib import Path
from typing import Any

import pandas as pd
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

# Make the backend package importable when running from /backend.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import settings  # noqa: E402
from app.models import (  # noqa: E402
    Account,
    Container,
    ContainerLine,
    Customer,
    DO,
    OutboundContainer,
    OutboundLine,
    OutboundOrder,
    SKU,
    WHPO,
)

ISO6346 = re.compile(r"^[A-Z]{4}\d{7}$")

# Source-data normalization tables. Derived from analysis of the Jan-2026
# Lime mastersheet — see HANDOFF.md "Historical import" notes.
LPN_ALIAS = {
    3473: 3743,   # Typo: 3473 was supposed to be 3743 (per Tiana, 2026-05-26)
}
COMMODITY_ALIAS = {
    "GLIDER": "GLIDERS",
    "GLIDERS ": "GLIDERS",
}
# When we encounter an LPN not yet in the SKU table, we auto-seed it with
# these defaults inferred from sibling rows in the same commodity.
# Format: LPN (int) → (description, product_type, units_per_pallet, sqft/unit)
# These come from observed averages in HISTORICAL DATA.xlsx.
LPN_AUTOSEED_TEMPLATE = {
    "N-E-BIKE":  {"items_per_pallet": 3,  "sqft_per_unit": 7.8,  "description_fmt": "Lime N-E-Bike (LPN-{lpn})"},
    "GLIDERS":   {"items_per_pallet": 2,  "sqft_per_unit": 10.2, "description_fmt": "Lime Glider (LPN-{lpn})"},
    "SCOOTERS":  {"items_per_pallet": 10, "sqft_per_unit": 2.0,  "description_fmt": "Lime Scooter (LPN-{lpn})"},
}


def lpn_to_sku_code(lpn_value: Any) -> str | None:
    """Source data has 4-digit LPN integers. Platform's SKU master uses
    LPN-NNNNNN (6 digits, zero-padded). Returns None if unparseable
    (e.g. 'BROGHT BACK', 'EMPTY P/U', '3742/3743')."""
    if lpn_value is None:
        return None
    try:
        n = int(float(str(lpn_value).strip()))
    except (TypeError, ValueError):
        return None
    n = LPN_ALIAS.get(n, n)
    return f"LPN-{n:06d}"


# ─── Helpers ────────────────────────────────────────────────────────


def _norm(v: Any) -> str | None:
    """Trim + collapse whitespace; return None for empty / NaN."""
    if v is None:
        return None
    if isinstance(v, float) and pd.isna(v):
        return None
    s = str(v).strip()
    if not s:
        return None
    # Collapse internal multi-space (cleans up "HIGHT  ELECTRIC " style)
    return re.sub(r"\s+", " ", s)


def _to_date(v: Any) -> date | None:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    try:
        return pd.to_datetime(v).date()
    except Exception:
        return None


def _to_int(v: Any) -> int | None:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _valid_iso(container_no: str | None) -> bool:
    return bool(container_no) and bool(ISO6346.match(container_no))


# ─── Row preparation ────────────────────────────────────────────────


def load_rows(xlsx_path: Path) -> list[dict[str, Any]]:
    """Read the xlsx and normalize each row to a clean dict. Skips
    structurally-broken rows up front; downstream stages still do
    further validation."""
    df = pd.read_excel(xlsx_path, sheet_name=0)
    df.columns = [c.strip() for c in df.columns]

    rows: list[dict[str, Any]] = []
    for raw in df.to_dict(orient="records"):
        container = _norm(raw.get("CONTAINER"))
        if container:
            container = container.upper().replace(" ", "")
        commodity = _norm(raw.get("COMMODITY"))
        # Normalize commodity typos ("GLIDER" → "GLIDERS", trailing space)
        if commodity:
            commodity = COMMODITY_ALIAS.get(commodity, commodity).upper()
        # Normalize SCANNED ("YES " → "YES", " " → None, "PENDING" → None)
        scanned_raw = _norm(raw.get("SCANNED"))
        scanned = scanned_raw.upper() if scanned_raw else None
        scanned_bool = scanned == "YES"

        rows.append(
            {
                "_excel_row": len(rows) + 2,  # +1 header, +1 zero-index
                "invoice": _norm(raw.get("invoice")),
                "commodity": commodity,
                "container_no": container,
                "whpo_number": _norm(raw.get("WHPO / LOAD #")),
                "carrier": _norm(raw.get("CARRIER / BROKER")),
                "driver_name": _norm(raw.get("DRIVER NAME")),
                "received_date": _to_date(raw.get("RECEIVED DATE")),
                "pallets_in": _to_int(raw.get("PALLETS")),
                "units_in": _to_int(raw.get("UNITS")),
                "sqft_in": _to_int(raw.get("SQ FT")),
                "total_sqft_in": _to_int(raw.get("TOTAL SQ FT")),
                "to_number": _norm(raw.get("TO No.")),
                "ship_date": _to_date(raw.get("SHIP DATE")),
                "ship_to": _norm(raw.get("SHIP TO")),
                "pallets_out": _to_int(raw.get("PALLETS.1")),
                "units_out": _to_int(raw.get("UNITS.1")),
                "sqft_out": _to_int(raw.get("SQ FT.1")),
                "total_sqft_out": _to_int(raw.get("TOTAL SQ FT.1")),
                "scanned": scanned_bool,
                "sku_code": lpn_to_sku_code(raw.get("LPN")),
                "lpn_raw": _norm(raw.get("LPN")),
            }
        )
    return rows


def backfill_sku_by_container(rows: list[dict[str, Any]]) -> int:
    """In the source data, LPN is only stamped on the inbound leg of a
    container. Outbound legs (same container_no, different TO row) share
    the same physical contents but have a blank LPN. Walk rows once,
    build a {container_no → sku_code} index from inbound legs, then
    back-fill sku_code on every row missing one for the same container.
    Returns count of rows that received an inherited SKU."""
    inbound_sku: dict[str, str] = {}
    for r in rows:
        if r["sku_code"] and r["received_date"]:
            inbound_sku.setdefault(r["container_no"], r["sku_code"])
    filled = 0
    for r in rows:
        if not r["sku_code"] and r["container_no"] in inbound_sku:
            r["sku_code"] = inbound_sku[r["container_no"]]
            r["_sku_inherited"] = True
            filled += 1
    return filled


# When neither the row nor any sibling row for the same container has an
# LPN, fall back to the primary SKU for the commodity. Loses model-year
# variant info (e.g. could be LPN-003176 OR LPN-004003 for N-E-BIKE) but
# preserves qty info for billing accuracy. Per Tiana 2026-05-26.
COMMODITY_PRIMARY_SKU = {
    "GLIDERS":  "LPN-003176",
    "N-E-BIKE": "LPN-003174",
    "SCOOTERS": "LPN-003743",
}


def backfill_sku_by_commodity(rows: list[dict[str, Any]]) -> int:
    """Last-resort fallback: rows whose commodity is known but for which
    no row in the entire dataset ever recorded an LPN for the container.
    Maps each commodity to its primary SKU. Returns count of rows that
    received a commodity-default SKU."""
    filled = 0
    for r in rows:
        if not r["sku_code"] and r["commodity"]:
            default = COMMODITY_PRIMARY_SKU.get(r["commodity"])
            if default:
                r["sku_code"] = default
                r["_sku_commodity_default"] = True
                filled += 1
    return filled


def validate(rows: list[dict[str, Any]]) -> tuple[list[dict], list[dict]]:
    """Split rows into (importable, skipped). Reasons recorded on the
    skipped dicts under `_skip_reason`."""
    ok: list[dict] = []
    skipped: list[dict] = []
    for r in rows:
        if not r["container_no"]:
            r["_skip_reason"] = "no container number"
            skipped.append(r)
            continue
        if not _valid_iso(r["container_no"]):
            r["_skip_reason"] = f"invalid ISO 6346 container_no: {r['container_no']!r}"
            skipped.append(r)
            continue
        if not r["whpo_number"]:
            r["_skip_reason"] = "no WHPO number"
            skipped.append(r)
            continue
        # WHPO must be 8-digit numeric (platform business rule). Strings
        # like "NEED PO" are unmappable.
        if not r["whpo_number"].isdigit():
            r["_skip_reason"] = f"non-numeric WHPO: {r['whpo_number']!r}"
            skipped.append(r)
            continue
        if not r["commodity"]:
            r["_skip_reason"] = "no commodity (cannot infer brand)"
            skipped.append(r)
            continue
        ok.append(r)
    return ok, skipped


def resolve_or_create_skus(
    session: Session, rows: list[dict[str, Any]], customer_id: int, commit: bool
) -> dict[str, int]:
    """Look up each distinct sku_code in the SKU table. Auto-seed any
    that don't exist using the LPN_AUTOSEED_TEMPLATE shape for the row's
    commodity. Returns a {sku_code: sku_id} map. When commit=False, new
    SKUs are added to the session but the caller's transaction handles
    rollback."""
    needed: dict[str, str] = {}  # sku_code → commodity hint
    for r in rows:
        if r["sku_code"] and r["sku_code"] not in needed:
            needed[r["sku_code"]] = r["commodity"] or "UNKNOWN"

    existing = {
        s.sku: s.id
        for s in session.execute(
            select(SKU).where(SKU.customer_id == customer_id, SKU.sku.in_(needed.keys()))
        ).scalars()
    }

    auto_seeded: list[str] = []
    for sku_code, commodity in needed.items():
        if sku_code in existing:
            continue
        template = LPN_AUTOSEED_TEMPLATE.get(commodity, {
            "items_per_pallet": 1,
            "sqft_per_unit": 20.0,
            "description_fmt": f"Lime {commodity} ({{lpn}})",
        })
        lpn_digits = sku_code.split("-")[-1]
        s = SKU(
            customer_id=customer_id,
            sku=sku_code,
            description=template["description_fmt"].format(lpn=lpn_digits),
            product_type=commodity,
            sqft_per_unit=template["sqft_per_unit"],
            items_per_pallet=template["items_per_pallet"],
            pallet_sqft=20.0,
            pallet_mode="logical",
            stackable=False,
            unit="each",
            source="manager_admin",
        )
        session.add(s)
        session.flush()
        existing[sku_code] = s.id
        auto_seeded.append(sku_code)

    if auto_seeded:
        print(f"  ↪ auto-seeded {len(auto_seeded)} new SKU(s): {', '.join(sorted(auto_seeded))}")
    return existing


# ─── DB stage builders (don't actually insert in dry-run) ───────────


def stage_inserts(
    session: Session, rows: list[dict[str, Any]], customer_name: str
) -> dict[str, Any]:
    """Compare each row to current DB state. Returns a stats dict
    describing what would be inserted vs what already exists."""
    customer = session.scalar(select(Customer).where(Customer.name == customer_name))
    if customer is None:
        raise RuntimeError(
            f"Customer {customer_name!r} not found in DB. "
            "Create it first via the manager UI or pass --customer to pick a different brand."
        )

    # Snapshot existing keys so duplicate-check is one DB round-trip per kind.
    existing_whpos = {
        w for (w,) in session.execute(select(WHPO.whpo_number)).all()
    }
    existing_containers = {
        c for (c,) in session.execute(select(Container.container_no)).all()
    }
    existing_tos = {
        t for (t,) in session.execute(select(OutboundOrder.transfer_order_no)).all()
    }
    existing_out_containers = {
        c for (c,) in session.execute(select(OutboundContainer.container_no)).all()
    }

    existing_sku_codes = {
        s for (s,) in session.execute(
            select(SKU.sku).where(SKU.customer_id == customer.id)
        ).all()
    }

    plan = {
        "customer_id": customer.id,
        "customer_name": customer.name,
        "new_whpos": [],
        "existing_whpos": [],
        "new_containers": [],
        "existing_containers": [],
        "new_outbound_orders": [],
        "existing_outbound_orders": [],
        "new_outbound_containers": [],
        "existing_outbound_containers": [],
        "new_skus": set(),
        "existing_skus": set(),
        "container_lines_to_insert": 0,
        "outbound_lines_to_insert": 0,
        "rows_missing_sku": 0,
        "carrier_counts": Counter(),
    }
    seen_to_sku: set[tuple[str, str]] = set()
    for r in rows:
        plan["carrier_counts"][r["carrier"] or "(blank)"] += 1
        if r["whpo_number"] in existing_whpos:
            plan["existing_whpos"].append(r["whpo_number"])
        else:
            plan["new_whpos"].append(r["whpo_number"])
        if r["container_no"] in existing_containers:
            plan["existing_containers"].append(r["container_no"])
        else:
            plan["new_containers"].append(r["container_no"])
        if r["to_number"]:
            if r["to_number"] in existing_tos:
                plan["existing_outbound_orders"].append(r["to_number"])
            else:
                plan["new_outbound_orders"].append(r["to_number"])
            if r["container_no"] in existing_out_containers:
                plan["existing_outbound_containers"].append(r["container_no"])
            else:
                plan["new_outbound_containers"].append(r["container_no"])
        # SKU + line accounting
        if r["sku_code"]:
            if r["sku_code"] in existing_sku_codes:
                plan["existing_skus"].add(r["sku_code"])
            else:
                plan["new_skus"].add(r["sku_code"])
            if r["received_date"] and r["units_in"]:
                plan["container_lines_to_insert"] += 1
            if r["to_number"] and r["units_out"]:
                key = (r["to_number"], r["sku_code"])
                if key not in seen_to_sku:
                    plan["outbound_lines_to_insert"] += 1
                    seen_to_sku.add(key)
        else:
            plan["rows_missing_sku"] += 1

    # Dedupe — WHPOs and TOs can appear on multiple rows (multi-container
    # loads). We only want one row in the table.
    plan["new_whpos"] = sorted(set(plan["new_whpos"]))
    plan["existing_whpos"] = sorted(set(plan["existing_whpos"]))
    plan["new_outbound_orders"] = sorted(set(plan["new_outbound_orders"]))
    plan["existing_outbound_orders"] = sorted(set(plan["existing_outbound_orders"]))
    return plan


def apply_inserts(
    session: Session, rows: list[dict[str, Any]], customer_name: str
) -> None:
    """Actually insert. Caller is responsible for the surrounding
    transaction (we don't commit here)."""
    customer = session.scalar(select(Customer).where(Customer.name == customer_name))
    assert customer is not None  # validated upstream

    # Resolve LPN→SKU mapping (auto-seeds new SKUs as a side effect).
    sku_map = resolve_or_create_skus(session, rows, customer.id, commit=True)

    # Containers map for outbound line `source_container_no` (FIFO hint).
    container_no_to_id: dict[str, int] = {}

    # Track container_id per container_no for line insertion later.
    new_container_ids: dict[str, int] = {}

    # Pre-load existing key sets so each row is O(1).
    existing_whpos: dict[str, int] = {
        w: i for (i, w) in session.execute(select(WHPO.id, WHPO.whpo_number)).all()
    }
    existing_dos: dict[int, int] = {
        w: i for (i, w) in session.execute(select(DO.id, DO.whpo_id)).all()
    }
    existing_containers: dict[str, int] = {
        c: i for (i, c) in session.execute(select(Container.id, Container.container_no)).all()
    }
    existing_tos: dict[str, int] = {
        t: i
        for (i, t) in session.execute(
            select(OutboundOrder.id, OutboundOrder.transfer_order_no)
        ).all()
    }
    existing_out_containers = {
        c for (c,) in session.execute(select(OutboundContainer.container_no)).all()
    }
    # Track which (outbound_order_id, sku_id) combos already have a line
    # in this import run — avoids duplicates if the same TO appears on
    # multiple rows.
    seen_outbound_lines: set[tuple[int, int]] = set()
    # DO# generator — internal "DO-HIST-####" prefix so we never collide
    # with the production "DO-2026-####" sequence the runtime uses.
    do_seq = 1

    for r in rows:
        # 1. WHPO
        whpo_id = existing_whpos.get(r["whpo_number"])
        if whpo_id is None:
            received_at = (
                datetime.combine(r["received_date"], time(0, 0)).replace(
                    tzinfo=timezone.utc
                )
                if r["received_date"]
                else datetime.now(timezone.utc)
            )
            whpo = WHPO(
                whpo_number=r["whpo_number"],
                customer_id=customer.id,
                received_at=received_at,
                notes=f"[imported from historical xlsx] commodity={r['commodity']}",
            )
            session.add(whpo)
            session.flush()
            whpo_id = whpo.id
            existing_whpos[r["whpo_number"]] = whpo_id

        # 2. DO (one per WHPO)
        if whpo_id not in existing_dos:
            do_number = f"DO-HIST-{do_seq:06d}"
            while do_number in {  # ultra-cautious dedupe
                d for (d,) in session.execute(select(DO.do_number)).all()
            }:
                do_seq += 1
                do_number = f"DO-HIST-{do_seq:06d}"
            do_row = DO(
                do_number=do_number,
                whpo_id=whpo_id,
                status="received" if r["scanned"] == "YES" else "pending_master_data",
                expected_arrival_date=r["received_date"],
                issued_by="historical-import",
                notes="historical backfill",
            )
            session.add(do_row)
            session.flush()
            existing_dos[whpo_id] = do_row.id
            do_seq += 1
        do_id = existing_dos[whpo_id]

        # 3. Container (skip if exists)
        container_id = existing_containers.get(r["container_no"])
        if container_id is None:
            received_dt = (
                datetime.combine(r["received_date"], time(0, 0)).replace(
                    tzinfo=timezone.utc
                )
                if r["received_date"]
                else None
            )
            container = Container(
                container_no=r["container_no"],
                do_id=do_id,
                actual_arrival_date=r["received_date"],
                status="finished" if r["scanned"] else "expected",
                finished_at=received_dt if r["scanned"] else None,
                driver_name=r["driver_name"],
                carrier=r["carrier"],
            )
            session.add(container)
            session.flush()
            container_id = container.id
            existing_containers[r["container_no"]] = container_id

        # 3b. ContainerLine (one per row that has inbound qty + SKU).
        # Only the inbound leg of a row (RECEIVED DATE + UNITS populated)
        # represents stock arriving. Outbound legs share the same container
        # number but are recorded via OutboundLine below.
        if r["received_date"] and r["units_in"] and r["sku_code"]:
            sku_id = sku_map.get(r["sku_code"])
            session.add(
                ContainerLine(
                    container_id=container_id,
                    sku_id=sku_id,
                    sku_raw=r["sku_code"],
                    qty=r["units_in"],
                    line_index=1,
                    product_type=r["commodity"],
                )
            )

        # 4. OutboundOrder (skip if exists)
        to_id = existing_tos.get(r["to_number"]) if r["to_number"] else None
        if r["to_number"] and to_id is None:
            order_dt = r["ship_date"] or r["received_date"]
            order = OutboundOrder(
                transfer_order_no=r["to_number"],
                customer_id=customer.id,
                order_date=order_dt,
                priority="normal",
                ship_to_address=r["ship_to"],
                ship_to_name=r["ship_to"],
                status="shipped" if r["ship_date"] else "open",
                submitted_by="historical-import",
                notes="historical backfill",
            )
            session.add(order)
            session.flush()
            to_id = order.id
            existing_tos[r["to_number"]] = to_id

        # 4b. OutboundLine (SKU + qty shipped). One per (TO, SKU) combo
        # per row. The historical data has 1 row = 1 outbound shipment, so
        # we don't need to aggregate across rows.
        if r["to_number"] and to_id is not None and r["units_out"] and r["sku_code"]:
            sku_id = sku_map.get(r["sku_code"])
            key = (to_id, sku_id) if sku_id else (to_id, hash(r["sku_code"]))
            if key not in seen_outbound_lines:
                session.add(
                    OutboundLine(
                        outbound_order_id=to_id,
                        line_no=1,
                        sku_id=sku_id,
                        sku_raw=r["sku_code"],
                        description=r["commodity"],
                        order_qty=r["units_out"],
                        unit="EA",
                        serial_specific=False,
                        source_container_no=r["container_no"],
                    )
                )
                seen_outbound_lines.add(key)

        # 5. OutboundContainer (one per BIC shipped, links inbound→outbound)
        if (
            r["to_number"]
            and to_id is not None
            and r["container_no"] not in existing_out_containers
        ):
            sealed_dt = (
                datetime.combine(r["ship_date"], time(0, 0)).replace(
                    tzinfo=timezone.utc
                )
                if r["ship_date"]
                else None
            )
            session.add(
                OutboundContainer(
                    outbound_order_id=to_id,
                    container_no=r["container_no"],
                    container_type="bic",
                    status="shipped" if r["ship_date"] else "open",
                    sealed_at=sealed_dt,
                    sealed_by="historical-import" if r["ship_date"] else None,
                )
            )
            existing_out_containers.add(r["container_no"])


# ─── Reporting ──────────────────────────────────────────────────────


def print_report(rows_ok: list[dict], rows_skipped: list[dict], plan: dict) -> None:
    print("=" * 72)
    print("HISTORICAL DATA IMPORT — DRY RUN PLAN")
    print("=" * 72)
    print(f"\nTarget customer/brand: {plan['customer_name']} (id={plan['customer_id']})")
    print(f"\nRows in source: {len(rows_ok) + len(rows_skipped)}")
    print(f"  importable:   {len(rows_ok)}")
    print(f"  skipped:      {len(rows_skipped)}")
    if rows_skipped:
        print("\nSKIPPED ROWS:")
        for r in rows_skipped:
            print(
                f"  Excel row {r['_excel_row']:4d}  "
                f"WHPO={r['whpo_number'] or '?':<12s} "
                f"CONT={r['container_no'] or '?':<14s} "
                f"reason: {r['_skip_reason']}"
            )

    print("\n── WHPOs ──")
    print(f"  will insert: {len(plan['new_whpos'])}")
    print(f"  already in DB: {len(plan['existing_whpos'])}")

    print("\n── Containers (inbound) ──")
    print(f"  will insert: {len(plan['new_containers'])}")
    print(f"  already in DB: {len(plan['existing_containers'])}")

    print("\n── Outbound Orders (TOs) ──")
    print(f"  will insert: {len(plan['new_outbound_orders'])}")
    print(f"  already in DB: {len(plan['existing_outbound_orders'])}")

    print("\n── Outbound Containers (BIC→TO links) ──")
    print(f"  will insert: {len(plan['new_outbound_containers'])}")
    print(f"  already in DB: {len(plan['existing_outbound_containers'])}")

    print("\n── SKU master ──")
    print(f"  will auto-seed: {len(plan['new_skus'])} {sorted(plan['new_skus']) if plan['new_skus'] else ''}")
    print(f"  already in DB: {len(plan['existing_skus'])} {sorted(plan['existing_skus']) if plan['existing_skus'] else ''}")

    print("\n── Container lines (inbound SKU+qty) ──")
    print(f"  will insert: {plan['container_lines_to_insert']}")
    print(f"  rows skipped (no parseable LPN): {plan['rows_missing_sku']}")

    print("\n── Outbound lines (TO SKU+qty shipped) ──")
    print(f"  will insert: {plan['outbound_lines_to_insert']}")

    print("\n── Drayage carriers used (top 10) ──")
    for c, n in plan["carrier_counts"].most_common(10):
        print(f"  {c:<40s} {n}")

    print("\n" + "=" * 72)


# ─── OneDrive folder seeding ────────────────────────────────────────


async def _seed_onedrive_folders_async(
    rows: list[dict[str, Any]],
    *,
    brand: str,
    account: str | None,
    pause_seconds: float = 1.0,
) -> tuple[int, int]:
    """For each historical container, drop a placeholder README into its
    OneDrive folder. The README creates the folder hierarchy as a side
    effect (Logic App auto-creates intermediate folders on upload).

    Returns (success_count, failure_count). Best-effort — never raises.
    Pace = pause_seconds between calls so the Logic App rate limit
    (~2/s on Consumption tier) isn't tripped."""
    from app.services.onedrive_files import (  # noqa: E402
        upload_to_container_folder,
    )

    if not (
        settings.onedrive_container_files_url
        or settings.onedrive_vendor_files_url
    ):
        print("⚠ OneDrive Logic App URL not configured; skipping folder seed.")
        return 0, 0

    today = date.today().isoformat()
    succ = fail = 0
    total = len(rows)
    for i, r in enumerate(rows, start=1):
        readme = (
            f"This folder was created during historical-data backfill on {today}.\n"
            f"\n"
            f"Container:  {r['container_no']}\n"
            f"WHPO:       {r['whpo_number']}\n"
            f"Commodity:  {r['commodity']}\n"
            f"Carrier:    {r['carrier'] or '?'}\n"
            f"Received:   {r['received_date'] or '?'}\n"
            f"\n"
            "Drop the supporting docs (BOL, POD, driver photos, picking "
            "ticket) into this folder when you find them.\n"
        ).encode("utf-8")
        try:
            await upload_to_container_folder(
                account=account,
                brand=brand,
                arrival_date=r["received_date"],
                container_no=r["container_no"],
                data=readme,
                filename="_README_historical_backfill.txt",
                content_type="text/plain",
            )
            succ += 1
        except Exception as e:  # noqa: BLE001
            fail += 1
            print(f"   ! {r['container_no']}: {e!r}")
        if i % 25 == 0 or i == total:
            print(f"   … seeded {i}/{total} folders ({succ} ok, {fail} failed)")
        await asyncio.sleep(pause_seconds)
    return succ, fail


def seed_onedrive_folders(
    rows: list[dict[str, Any]], customer: Customer, account_name: str | None
) -> None:
    """Sync wrapper. Pulls the asyncio event loop just for the upload phase."""
    print(
        f"\n>>> Seeding OneDrive folders for {len(rows)} containers "
        f"(brand={customer.name!r}, account={account_name!r}) …"
    )
    t0 = _time.monotonic()
    succ, fail = asyncio.run(
        _seed_onedrive_folders_async(rows, brand=customer.name, account=account_name)
    )
    print(
        f"✓ OneDrive seed done: {succ} ok, {fail} failed, "
        f"{_time.monotonic() - t0:.0f}s elapsed"
    )


# ─── CLI ────────────────────────────────────────────────────────────


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("xlsx", type=Path, help="Path to the historical xlsx")
    parser.add_argument(
        "--customer",
        default="Lime",
        help="Customer/brand name to attach every row to (default: Lime)",
    )
    parser.add_argument(
        "--commit",
        action="store_true",
        help="Actually insert. Without this flag, script is dry-run-only.",
    )
    parser.add_argument(
        "--report-skips",
        type=Path,
        default=None,
        help="Path to write a CSV of skipped rows + reasons (manual fix-up).",
    )
    parser.add_argument(
        "--seed-onedrive-folders",
        action="store_true",
        help=(
            "After --commit, fire one upload per container so OneDrive folder "
            "hierarchies are pre-created (placeholder README.txt per folder). "
            "Adds ~10 min for ~400 containers. Best-effort."
        ),
    )
    args = parser.parse_args()

    if not args.xlsx.exists():
        print(f"ERROR: file not found: {args.xlsx}", file=sys.stderr)
        return 2

    print(f"Loading {args.xlsx} …")
    rows = load_rows(args.xlsx)
    inherited = backfill_sku_by_container(rows)
    if inherited:
        print(f"Back-filled SKU on {inherited} rows from their container's inbound peer.")
    commodity_default = backfill_sku_by_commodity(rows)
    if commodity_default:
        print(f"Back-filled SKU on {commodity_default} rows from commodity primary mapping (GLIDERS→003176, N-E-BIKE→003174, SCOOTERS→003743).")
    rows_ok, rows_skipped = validate(rows)
    print(f"Parsed {len(rows)} rows ({len(rows_ok)} importable, {len(rows_skipped)} skipped).")

    if args.report_skips:
        with args.report_skips.open("w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["excel_row", "container_no", "whpo_number", "skip_reason"])
            for r in rows_skipped:
                w.writerow(
                    [r["_excel_row"], r["container_no"], r["whpo_number"], r["_skip_reason"]]
                )
        print(f"Skipped rows written to {args.report_skips}")

    print(f"\nConnecting to DB: {settings.database_url.split('@')[-1]}")
    # Use sync engine for the import — async session is overkill here.
    # URL translation: asyncpg uses `ssl=require`, psycopg2 wants
    # `sslmode=require`. Same conceptually, different param name.
    sync_url = settings.database_url.replace("+asyncpg", "")
    sync_url = sync_url.replace("ssl=require", "sslmode=require")
    engine = create_engine(sync_url)

    with Session(engine) as session:
        plan = stage_inserts(session, rows_ok, args.customer)
        print_report(rows_ok, rows_skipped, plan)

        if not args.commit:
            print("\nDRY RUN — no rows inserted. Re-run with --commit to apply.")
            return 0

        print("\n>>> COMMIT MODE — beginning transaction …")
        try:
            apply_inserts(session, rows_ok, args.customer)
            session.commit()
        except Exception as e:
            session.rollback()
            print(f"\nERROR during insert (transaction rolled back): {e}", file=sys.stderr)
            raise
        print("✓ Transaction committed. All rows imported.")

        if args.seed_onedrive_folders:
            # Re-fetch customer so we have the account relationship loaded.
            customer = session.scalar(
                select(Customer).where(Customer.name == args.customer)
            )
            account_name: str | None = None
            if customer and customer.account_id:
                account_row = session.get(Account, customer.account_id)
                if account_row is not None:
                    account_name = account_row.name
            seed_onedrive_folders(rows_ok, customer, account_name)

        return 0


if __name__ == "__main__":
    raise SystemExit(main())
