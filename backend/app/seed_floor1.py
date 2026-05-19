"""Backfill the full 196-cell Floor 1 layout from the original WMS spec.

Layout (cols A=1 .. P=16):
  Rows 1–8:    all cols A-P            (128 cells)
  Row 9:       A-G + M-P  (gap H-L)    (11 cells)
  Rows 10–16:  A-G                     (49 cells)
  Row 17:      B-G                     (6  cells)
  Row 18:      F-G                     (2  cells)
  ────────────────────────────────────────────
  total                                 196 cells

Idempotent. Run with:    uv run python -m app.seed_floor1
"""

from __future__ import annotations

import asyncio

from sqlalchemy import select

from app.db import SessionLocal
from app.models import Floor, Lot


# (row_start, row_end_inclusive, allowed_cols)
LAYOUT = [
    (1, 8,  range(1, 17)),                          # rows 1-8: A..P
    (9, 9,  list(range(1, 8)) + list(range(13, 17))),  # row 9: A..G + M..P
    (10, 16, range(1, 8)),                          # rows 10-16: A..G
    (17, 17, range(2, 8)),                          # row 17: B..G
    (18, 18, range(6, 8)),                          # row 18: F..G
]


def cells():
    out: list[tuple[str, int, int]] = []  # (lot_code, row, col)
    for r0, r1, cols in LAYOUT:
        for r in range(r0, r1 + 1):
            for c in cols:
                letter = chr(ord("A") + c - 1)
                out.append((f"{letter}-{r}", r, c))
    return out


async def main() -> None:
    async with SessionLocal() as s:
        floor1 = await s.scalar(select(Floor).where(Floor.name == "Floor 1 — Warehouse"))
        if floor1 is None:
            print("Floor 1 not found. Run `uv run python -m app.seed` first.")
            return

        existing = {
            l.lot_code: l
            for l in (
                await s.scalars(select(Lot).where(Lot.floor_id == floor1.id))
            ).all()
        }

        created = 0
        backfilled = 0
        for code, row, col in cells():
            if code in existing:
                lot = existing[code]
                if lot.grid_row is None or lot.grid_col is None:
                    lot.grid_row = row
                    lot.grid_col = col
                    backfilled += 1
            else:
                s.add(
                    Lot(
                        floor_id=floor1.id,
                        lot_code=code,
                        type="rack",
                        sqft_capacity=1610.0,
                        pallet_capacity=60,
                        max_stack_levels=2,
                        grid_row=row,
                        grid_col=col,
                    )
                )
                created += 1

        await s.commit()
        total_after = await s.scalar(
            select(Lot).where(Lot.floor_id == floor1.id)
            .with_only_columns(Lot.id)
            .order_by(None)
        )
        # simpler tally
        rows = await s.scalars(select(Lot).where(Lot.floor_id == floor1.id))
        count = len(rows.all())
        print(f"Created: {created}   Backfilled: {backfilled}   Floor 1 lots now: {count}")


if __name__ == "__main__":
    asyncio.run(main())
