"""Lot-assignment algorithm: pack a container's lines into available lots by
*floor footprint* (sqft).

Two layers:
  - plan_assignment()           pure function, no DB, trivially unit-testable
  - assign_container_lots()     async DB wrapper that gathers inputs,
                                calls plan_assignment, and persists the result

Sqft is the primary packing unit because lots have a fixed physical area
(23 × 70 = 1610 sqft) and SKUs have a derived per-unit footprint from
vendor-declared packaging or SKU master data. Pallet counts are still
tracked alongside for operator UI continuity ("13 pallets in lot A-1").
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import (
    SKU,
    Container,
    ContainerLine,
    Lot,
    LotAssignment,
    Pallet,
)
from app.services.space import DEFAULT_PALLET_SQFT, compute_line_space


# ─── Custom errors ─────────────────────────────────────────────────────────


class AssignmentError(Exception):
    """Base class for assignment failures."""


class UnknownSKUError(AssignmentError):
    def __init__(self, sku_raw: str) -> None:
        super().__init__(f"Unknown SKU: {sku_raw}")
        self.sku_raw = sku_raw


class MissingMasterDataError(AssignmentError):
    def __init__(self, sku: str, field: str) -> None:
        super().__init__(f"SKU '{sku}' is missing master data: {field}")
        self.sku = sku
        self.field = field


class CapacityOverflowError(AssignmentError):
    def __init__(self, sqft_needed: float, sqft_available: float) -> None:
        super().__init__(
            f"Not enough warehouse space: need {sqft_needed:.0f} sqft, "
            f"only {sqft_available:.0f} sqft free."
        )
        self.sqft_needed = sqft_needed
        self.sqft_available = sqft_available


class AlreadyInProgressError(AssignmentError):
    def __init__(self, container_id: int) -> None:
        super().__init__(
            f"Container {container_id} has active or completed lot assignments. "
            "Cannot re-plan."
        )
        self.container_id = container_id


# ─── Pure planning data shapes ─────────────────────────────────────────────


@dataclass
class LineInput:
    sku_id: int
    sku_code: str
    qty: int
    total_sqft: float
    sqft_per_pallet: float  # for deriving pallet count per allocation


@dataclass
class LotInput:
    lot_id: int
    lot_code: str
    free_sqft: float


@dataclass
class PlannedAssignment:
    sku_id: int
    lot_id: int
    lot_code: str
    planned_sqft: float
    planned_pallets: int
    assignment_order: int


# ─── Pure function ─────────────────────────────────────────────────────────


def plan_assignment(
    lines: list[LineInput],
    lots: list[LotInput],
) -> list[PlannedAssignment]:
    """Pack the floor-space requirements of `lines` into `lots`.

    Strategy: process lines in manifest order. For each line, allocate its
    sqft into lots sorted largest-free-first (tie-break alphabetical).
    Each PlannedAssignment carries both planned_sqft (the truth) and
    planned_pallets (derived for UI display).

    Locality / type preferences are TODO v2.
    """
    plan: list[PlannedAssignment] = []
    free = {lot.lot_id: lot.free_sqft for lot in lots}
    lots_by_id = {lot.lot_id: lot for lot in lots}

    order = 1
    for line in lines:
        remaining = line.total_sqft
        # Avoid infinite loops on tiny rounding remainders
        EPS = 0.001

        while remaining > EPS:
            candidates = [
                (free[lid], lots_by_id[lid].lot_code, lid)
                for lid in free
                if free[lid] > EPS
            ]
            if not candidates:
                placed = sum(p.planned_sqft for p in plan)
                raise CapacityOverflowError(
                    sqft_needed=placed + remaining,
                    sqft_available=placed,
                )
            candidates.sort(key=lambda c: (-c[0], c[1]))
            top_free, top_code, top_id = candidates[0]

            take = min(top_free, remaining)
            # Derive pallet count from sqft (line carries its sqft_per_pallet)
            per_pallet = line.sqft_per_pallet if line.sqft_per_pallet > 0 else DEFAULT_PALLET_SQFT
            pallets_here = max(1, math.ceil(take / per_pallet))

            plan.append(
                PlannedAssignment(
                    sku_id=line.sku_id,
                    lot_id=top_id,
                    lot_code=top_code,
                    planned_sqft=round(take, 2),
                    planned_pallets=pallets_here,
                    assignment_order=order,
                )
            )
            free[top_id] -= take
            remaining -= take
            order += 1

    return plan


# ─── DB-aware wrapper ──────────────────────────────────────────────────────


async def assign_container_lots(
    session: AsyncSession,
    container_id: int,
) -> list[LotAssignment]:
    """Compute and persist a put-away plan for `container_id`.

    Uses vendor-declared packaging on the Container if present, falls back to
    SKU master sqft_per_unit, then to a default pallet footprint.

    Raises:
      UnknownSKUError       — a container line is missing a resolved SKU master row
      MissingMasterDataError — needed master data unavailable
      CapacityOverflowError  — warehouse doesn't have free sqft for this container
      AlreadyInProgressError — container has active/completed assignments
    """

    # 1. Reject if anything past 'planned' exists
    existing = (
        await session.scalars(
            select(LotAssignment.status).where(LotAssignment.container_id == container_id)
        )
    ).all()
    if any(st not in ("planned",) for st in existing):
        raise AlreadyInProgressError(container_id)

    if existing:
        await session.execute(
            delete(LotAssignment).where(
                LotAssignment.container_id == container_id,
                LotAssignment.status == "planned",
            )
        )

    # 2. Load container with lines + their SKU master
    container = await session.scalar(
        select(Container)
        .where(Container.id == container_id)
        .options(selectinload(Container.lines).selectinload(ContainerLine.sku))
    )
    if container is None:
        raise ValueError(f"Container {container_id} not found")

    # 3. Build LineInputs using the space service
    line_inputs: list[LineInput] = []
    for line in container.lines:
        if line.sku is None:
            raise UnknownSKUError(line.sku_raw)

        space = compute_line_space(
            qty=line.qty,
            on_pallet=container.on_pallet,
            pallet_length_in=container.pallet_length_in,
            pallet_width_in=container.pallet_width_in,
            item_length_in=container.item_length_in,
            item_width_in=container.item_width_in,
            items_per_pallet=line.sku.items_per_pallet,
            sku_sqft_per_unit=line.sku.sqft_per_unit,
            stackable=line.sku.stackable,
            max_stack_height=line.sku.max_stack_height,
        )

        # Compute sqft_per_pallet for deriving pallet counts in each allocation
        ipp = line.sku.items_per_pallet
        if ipp and ipp > 0:
            sqft_per_pallet = space.sqft_per_unit * ipp
        else:
            sqft_per_pallet = DEFAULT_PALLET_SQFT

        line_inputs.append(
            LineInput(
                sku_id=line.sku.id,
                sku_code=line.sku.sku,
                qty=line.qty,
                total_sqft=space.total_sqft,
                sqft_per_pallet=sqft_per_pallet,
            )
        )

    # 4. Load candidate lots with free sqft
    lot_inputs = await _load_candidate_lots(session)

    # 5. Run the planner
    plan = plan_assignment(line_inputs, lot_inputs)

    # 6. Persist
    rows = [
        LotAssignment(
            container_id=container_id,
            sku_id=p.sku_id,
            lot_id=p.lot_id,
            assignment_order=p.assignment_order,
            planned_sqft=p.planned_sqft,
            actual_sqft=0.0,
            planned_pallets=p.planned_pallets,
            actual_pallets=0,
            status="planned",
        )
        for p in plan
    ]
    session.add_all(rows)
    await session.flush()
    return rows


async def _load_candidate_lots(session: AsyncSession) -> list[LotInput]:
    """All non-blocked lots with current free sqft capacity."""
    placed_subq = (
        select(Pallet.lot_id, func.coalesce(func.sum(Pallet.sqft), 0.0).label("placed_sqft"))
        .group_by(Pallet.lot_id)
        .subquery()
    )
    reserved_subq = (
        select(
            LotAssignment.lot_id,
            func.coalesce(
                func.sum(LotAssignment.planned_sqft - LotAssignment.actual_sqft),
                0.0,
            ).label("reserved_sqft"),
        )
        .where(LotAssignment.status.in_(["planned", "active"]))
        .group_by(LotAssignment.lot_id)
        .subquery()
    )

    q = (
        select(
            Lot.id,
            Lot.lot_code,
            Lot.sqft_capacity,
            func.coalesce(placed_subq.c.placed_sqft, 0.0).label("placed"),
            func.coalesce(reserved_subq.c.reserved_sqft, 0.0).label("reserved"),
        )
        .outerjoin(placed_subq, placed_subq.c.lot_id == Lot.id)
        .outerjoin(reserved_subq, reserved_subq.c.lot_id == Lot.id)
        .where(Lot.blocked.is_(False))
        .order_by(Lot.lot_code)
    )

    result = await session.execute(q)
    out: list[LotInput] = []
    for row in result:
        free = row.sqft_capacity - float(row.placed) - float(row.reserved)
        if free > 0:
            out.append(
                LotInput(
                    lot_id=row.id,
                    lot_code=row.lot_code,
                    free_sqft=round(free, 2),
                )
            )
    return out
