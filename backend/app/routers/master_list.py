"""Manager-facing read-only mastersheet endpoint.

Auto-computed from `vw_master_list` (see migration d9e0f1a2b3c4). Mirrors
the layout of Lime's manual `Lime-Inventory-Sep 2025.xlsx` so the manager
portal can render a side-by-side view that swaps the spreadsheet out.
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy import bindparam, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.schemas.master_list import MasterListResponse, MasterListRow

router = APIRouter(prefix="/manager", tags=["manager-master-list"])


@router.get("/master-list", response_model=MasterListResponse)
async def get_master_list(
    customer: str | None = Query(None, description="Filter to one brand by exact name"),
    since: date | None = Query(None, description="Earliest received_date OR ship_date"),
    until: date | None = Query(None, description="Latest received_date OR ship_date"),
    scanned: bool | None = Query(None, description="Filter by scanned status"),
    limit: int = Query(500, ge=1, le=2000),
    offset: int = Query(0, ge=0),
    session: AsyncSession = Depends(get_session),
) -> MasterListResponse:
    where: list[str] = []
    params: dict[str, object] = {}
    if customer:
        where.append("customer_name = :customer")
        params["customer"] = customer
    if since:
        where.append("COALESCE(received_date, ship_date) >= :since")
        params["since"] = since
    if until:
        where.append("COALESCE(received_date, ship_date) <= :until")
        params["until"] = until
    if scanned is not None:
        where.append("scanned = :scanned")
        params["scanned"] = scanned

    where_clause = f"WHERE {' AND '.join(where)}" if where else ""

    rows_sql = text(
        f"""
        SELECT * FROM vw_master_list
        {where_clause}
        ORDER BY COALESCE(received_date, ship_date) DESC NULLS LAST,
                 container_no
        LIMIT :limit OFFSET :offset
        """
    )
    count_sql = text(f"SELECT COUNT(*) FROM vw_master_list {where_clause}")

    rows_result = await session.execute(
        rows_sql, {**params, "limit": limit, "offset": offset}
    )
    items = [MasterListRow(**dict(r._mapping)) for r in rows_result]
    total = (await session.execute(count_sql, params)).scalar_one()
    return MasterListResponse(items=items, total=int(total))


@router.post("/master-list/sync-onedrive")
async def trigger_master_sheet_sync(
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Manually fire the OneDrive Excel mirror. Same call the backend
    makes after every scan-finish. Returns full debug info — Logic App
    response code, the Office Script's JSON return value, row counts —
    so we can diagnose when the workbook doesn't update as expected."""
    from app.services import master_sheet_sync
    from sqlalchemy import text
    import httpx

    url = master_sheet_sync.settings.onedrive_master_sheet_webhook_url
    if not url:
        return {"ok": False, "configured": False}

    customers_rows = await session.execute(text("SELECT name FROM customers ORDER BY name"))
    all_brands = [r[0] for r in customers_rows]
    rows_result = await session.execute(text(
        "SELECT * FROM vw_master_list ORDER BY received_date DESC NULLS LAST, container_no"
    ))
    rows = [dict(r._mapping) for r in rows_result]
    brands_grouped: dict[str, list] = {b: [] for b in all_brands}
    flat = []
    for r in rows:
        s = master_sheet_sync._serialize(r)
        flat.append(s)
        brand = (r.get("customer_name") or "").strip() or "_Unassigned"
        brands_grouped.setdefault(brand, []).append(s)

    payload = {"headers": master_sheet_sync.HEADERS, "brands": brands_grouped, "rows": flat}

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            res = await client.post(url, json=payload, headers={"Content-Type": "application/json"})
        return {
            "ok": res.is_success,
            "configured": True,
            "logic_app_status": res.status_code,
            "office_script_response": res.text[:2000],
            "rows_sent": len(flat),
            "brands_sent": {b: len(rs) for b, rs in brands_grouped.items()},
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "configured": True, "error": repr(e)}
