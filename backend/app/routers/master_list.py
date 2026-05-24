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
