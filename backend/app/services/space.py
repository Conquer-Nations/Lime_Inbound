"""Footprint / lot-space calculations.

Pure functions — given dimensions and quantities, compute how much warehouse
floor space (sqft) a shipment needs and how it maps onto fixed-size lots.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

# Conquer Nation standard lot footprint (23 ft × 70 ft).
DEFAULT_LOT_SQFT = 1610.0

# Reasonable default if a SKU has neither vendor-declared nor master dimensions.
# 48"×40" GMA pallet = 1920 sq in = 13.33 sqft. Add aisle margin → 16.
DEFAULT_PALLET_SQFT = 16.0


@dataclass
class LineSpace:
    """Result of computing space for one container line."""

    sqft_per_unit: float
    total_sqft: float
    lots_equivalent: float
    basis: str  # "vendor_pallet" | "vendor_item" | "sku_master" | "default"


def sqft_from_inches(length_in: float, width_in: float) -> float:
    """Convert L×W in inches to sqft."""
    return (length_in * width_in) / 144.0


def compute_line_space(
    *,
    qty: int,
    on_pallet: bool | None,
    pallet_length_in: float | None,
    pallet_width_in: float | None,
    item_length_in: float | None,
    item_width_in: float | None,
    items_per_pallet: int | None,
    sku_sqft_per_unit: float | None,
    stackable: bool,
    max_stack_height: int | None,
    lot_sqft: float = DEFAULT_LOT_SQFT,
) -> LineSpace:
    """Derive the sqft footprint for `qty` units of an SKU.

    Priority order for footprint source (highest wins):
      1. Vendor-declared pallet dims + items_per_pallet → exact per-unit sqft
      2. Vendor-declared item dims → per-unit sqft directly
      3. SKU master sqft_per_unit → fallback
      4. DEFAULT_PALLET_SQFT (very rough) → last-resort default
    """
    sqft_per_unit = 0.0
    basis = "default"

    if (
        on_pallet
        and pallet_length_in
        and pallet_width_in
        and items_per_pallet
        and items_per_pallet > 0
    ):
        # Compute sqft for the whole pallet, divide across items_per_pallet
        sqft_per_pallet = sqft_from_inches(pallet_length_in, pallet_width_in)
        sqft_per_unit = sqft_per_pallet / items_per_pallet
        basis = "vendor_pallet"
    elif on_pallet is False and item_length_in and item_width_in:
        sqft_per_unit = sqft_from_inches(item_length_in, item_width_in)
        basis = "vendor_item"
    elif sku_sqft_per_unit and sku_sqft_per_unit > 0:
        sqft_per_unit = sku_sqft_per_unit
        basis = "sku_master"
    elif on_pallet and pallet_length_in and pallet_width_in:
        # Pallet dims given but no items_per_pallet → treat each pallet as 1 unit
        sqft_per_pallet = sqft_from_inches(pallet_length_in, pallet_width_in)
        # Conservative: assume 1 item = 1 pallet of space
        sqft_per_unit = sqft_per_pallet
        basis = "vendor_pallet_no_ipp"
    else:
        # Truly nothing — use the default pallet footprint estimate
        sqft_per_unit = DEFAULT_PALLET_SQFT
        basis = "default"

    # Apply vertical stacking discount if the SKU supports it
    if stackable and max_stack_height and max_stack_height > 1:
        sqft_per_unit = sqft_per_unit / max_stack_height

    total_sqft = qty * sqft_per_unit
    lots_equivalent = total_sqft / lot_sqft if lot_sqft > 0 else 0.0

    return LineSpace(
        sqft_per_unit=round(sqft_per_unit, 3),
        total_sqft=round(total_sqft, 2),
        lots_equivalent=round(lots_equivalent, 3),
        basis=basis,
    )


def pallets_needed(total_sqft: float, sqft_per_pallet: float = DEFAULT_PALLET_SQFT) -> int:
    """Round-up estimate of pallet count for a given footprint."""
    if sqft_per_pallet <= 0:
        return 0
    return math.ceil(total_sqft / sqft_per_pallet)
