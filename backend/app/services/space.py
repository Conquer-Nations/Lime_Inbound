"""Footprint / lot-space calculations.

Pure functions — given dimensions and quantities, compute how much warehouse
floor space (sqft) a shipment needs and how it maps onto fixed-size lots.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

# Vernon facility lot footprint (17 ft × 23 ft = 391 sqft per lot).
DEFAULT_LOT_SQFT = 391.0
DEFAULT_LOT_LENGTH_FT = 17.0
DEFAULT_LOT_WIDTH_FT = 23.0

# Reasonable default if a SKU has neither vendor-declared nor master dimensions.
# 48"×40" GMA pallet = 1920 sq in = 13.33 sqft. Add aisle margin → 16.
DEFAULT_PALLET_SQFT = 16.0


@dataclass
class LineSpace:
    """Result of computing space for one container line."""

    sqft_per_unit: float
    total_sqft: float
    lots_equivalent: float
    basis: str
    # Whole-pallet roll-up — set when SKU master gives both items_per_pallet
    # and pallet_sqft, so we can report the warehouse-floor math:
    #   pallets = ceil(qty / items_per_pallet); total_sqft = pallets × pallet_sqft
    pallets_needed: int | None = None


def sqft_from_inches(length_in: float, width_in: float) -> float:
    """Convert L×W in inches to sqft."""
    return (length_in * width_in) / 144.0


def compute_pallet_rollup(
    qty: int,
    items_per_pallet: float | None,
    pallet_sqft: float | None,
    lot_sqft: float = DEFAULT_LOT_SQFT,
) -> dict:
    """Standalone pallet → sqft → lots calculator. Used both by
    compute_line_space and by the SKU admin UI calculator preview.

    Returns 0s for any field that can't be computed (missing inputs).

    Epsilon-aware ceil — items_per_pallet is often a rounded conversion
    factor (1.9655 ≈ 1.96551724…); 114/1.9655 = 58.0005 which would
    otherwise ceil to 59. We subtract a tiny epsilon before ceil so
    values within ~0.001 of a whole number snap down. Real overflows
    (e.g. 58.4 pallets) still ceil up correctly.
    """
    if not items_per_pallet or items_per_pallet <= 0:
        return {"pallets": 0, "total_sqft": 0.0, "lots": 0.0}
    raw = qty / items_per_pallet
    pallets = math.ceil(raw - 1e-3)
    if pallets < 0:
        pallets = 0
    total_sqft = pallets * (pallet_sqft or 0.0)
    lots = total_sqft / lot_sqft if lot_sqft > 0 else 0.0
    return {
        "pallets": int(pallets),
        "total_sqft": round(float(total_sqft), 2),
        "lots": round(float(lots), 3),
    }


def compute_line_space(
    *,
    qty: int,
    on_pallet: bool | None,
    pallet_length_in: float | None,
    pallet_width_in: float | None,
    item_length_in: float | None,
    item_width_in: float | None,
    items_per_pallet: float | None,
    sku_sqft_per_unit: float | None,
    stackable: bool,
    max_stack_height: int | None,
    sku_pallet_sqft: float | None = None,
    lot_sqft: float = DEFAULT_LOT_SQFT,
) -> LineSpace:
    """Derive the sqft footprint for `qty` units of an SKU.

    Priority order for footprint source (highest wins):
      1. SKU master pallet_sqft + items_per_pallet → whole-pallet rollup
         (matches actual warehouse-floor math; can't have half a pallet)
      2. Vendor-declared pallet dims + items_per_pallet → exact per-unit sqft
      3. Vendor-declared item dims → per-unit sqft directly
      4. SKU master sqft_per_unit → fallback
      5. Vendor pallet dims, no items_per_pallet → 1 unit = 1 pallet
      6. DEFAULT_PALLET_SQFT → last-resort default
    """
    sqft_per_unit = 0.0
    basis = "default"
    pallets_needed: int | None = None

    # 1. Best case: SKU master tells us both items/pallet and pallet_sqft.
    if (
        sku_pallet_sqft
        and sku_pallet_sqft > 0
        and items_per_pallet
        and items_per_pallet > 0
    ):
        rollup = compute_pallet_rollup(qty, items_per_pallet, sku_pallet_sqft, lot_sqft)
        pallets_needed = rollup["pallets"]
        total_sqft_pre_stack = rollup["total_sqft"]
        # Apply stackable discount across the rolled-up total
        if stackable and max_stack_height and max_stack_height > 1:
            total_sqft_pre_stack = total_sqft_pre_stack / max_stack_height
        sqft_per_unit = total_sqft_pre_stack / qty if qty > 0 else 0.0
        lots_equivalent = (
            total_sqft_pre_stack / lot_sqft if lot_sqft > 0 else 0.0
        )
        return LineSpace(
            sqft_per_unit=round(sqft_per_unit, 3),
            total_sqft=round(total_sqft_pre_stack, 2),
            lots_equivalent=round(lots_equivalent, 3),
            basis="sku_pallet_rollup",
            pallets_needed=pallets_needed,
        )

    # 2-6: existing precedence chain (vendor-declared dims, sqft_per_unit, …)
    if (
        on_pallet
        and pallet_length_in
        and pallet_width_in
        and items_per_pallet
        and items_per_pallet > 0
    ):
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
        sqft_per_pallet = sqft_from_inches(pallet_length_in, pallet_width_in)
        sqft_per_unit = sqft_per_pallet
        basis = "vendor_pallet_no_ipp"
    else:
        sqft_per_unit = DEFAULT_PALLET_SQFT
        basis = "default"

    if stackable and max_stack_height and max_stack_height > 1:
        sqft_per_unit = sqft_per_unit / max_stack_height

    total_sqft = qty * sqft_per_unit
    lots_equivalent = total_sqft / lot_sqft if lot_sqft > 0 else 0.0

    return LineSpace(
        sqft_per_unit=round(sqft_per_unit, 3),
        total_sqft=round(total_sqft, 2),
        lots_equivalent=round(lots_equivalent, 3),
        basis=basis,
        pallets_needed=pallets_needed,
    )


def pallets_needed(total_sqft: float, sqft_per_pallet: float = DEFAULT_PALLET_SQFT) -> int:
    """Round-up estimate of pallet count for a given footprint."""
    if sqft_per_pallet <= 0:
        return 0
    return math.ceil(total_sqft / sqft_per_pallet)
