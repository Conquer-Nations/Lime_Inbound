"""Invoice pricing utilities. Port of CN-BILLING/src/pricing.js.

Behavior matches the JS source verbatim so existing invoices generated
in the standalone CN-BILLING app would total identically here.

Core operations:
  * recompute_minimums  — auto-apply picking floor (PIK-MIN $10)
  * invoice_totals       — bundle line items into subtotal/fuel/
                           advancing/tax/total. Fuel surcharge is
                           DRY-FSC; advancing = ACC-060 + DRY-PPF +
                           DRY-ADV (vendor pass-throughs with markup).
  * compute_due_date     — invoice_date + Net N days
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Iterable

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import InvoiceLine


# Picking codes that count toward the PIK-MIN floor.
PICK_CODES: tuple[str, ...] = (
    "PIK-001", "PIK-002", "PIK-003", "PIK-004", "PIK-005", "PIK-006",
)

# Charges that flow into the "Advancing" line on the invoice
# (vendor pass-throughs, all with built-in markup).
ADVANCE_CODES: tuple[str, ...] = ("ACC-060", "DRY-PPF", "DRY-ADV")


def round2(n: float | int | None) -> float:
    """Round to cents to avoid float drift."""
    if n is None:
        return 0.0
    return round(float(n) * 100) / 100


async def recompute_picking_minimum(
    session: AsyncSession,
    invoice_id: int,
) -> float:
    """Picking-floor auto-apply. Sums all PICK_CODES lines on the
    invoice; if the subtotal is > 0 but < $10, inserts a PIK-MIN
    line for the shortfall (marked auto_applied=True).

    Removes any prior auto PIK-MIN lines first so re-running is
    idempotent. Returns the shortfall added (0 if none)."""
    # Drop existing auto-applied PIK-MIN
    await session.execute(
        delete(InvoiceLine).where(
            InvoiceLine.invoice_id == invoice_id,
            InvoiceLine.code == "PIK-MIN",
            InvoiceLine.auto_applied.is_(True),
        )
    )

    pick_lines = (
        await session.scalars(
            select(InvoiceLine.line_total).where(
                InvoiceLine.invoice_id == invoice_id,
                InvoiceLine.code.in_(PICK_CODES),
            )
        )
    ).all()
    pick_total = sum(pick_lines or [])
    if pick_total <= 0 or pick_total >= 10.0:
        return 0.0
    shortfall = round2(10.0 - pick_total)
    session.add(
        InvoiceLine(
            invoice_id=invoice_id,
            code="PIK-MIN",
            category="PICKING",
            description="Picking minimum applied (auto)",
            unit="per order",
            quantity=1,
            unit_rate=shortfall,
            line_total=shortfall,
            taxable=False,
            auto_applied=True,
        )
    )
    await session.flush()
    return shortfall


def invoice_totals_from_lines(
    lines: Iterable,
    tax_rate: float,
    adjustment: float = 0.0,
    operational_charge: float = 0.0,
) -> dict[str, float]:
    """Compute subtotal / fuel / advancing / taxable base / tax / total
    from a collection of invoice_line-shaped rows (or ORM objects).

    Mirrors `invoiceTotals` in CN-BILLING/src/pricing.js:
      - lineSubtotal = SUM(line_total)
      - fuel = SUM(line_total where code='DRY-FSC')
      - advancing = SUM(line_total where code in ADVANCE_CODES)
      - taxable_base = SUM(line_total where taxable=true)
      - subtotal = lineSubtotal + operational_charge
      - tax = taxable_base * tax_rate
      - total = subtotal + adjustment + tax
    """
    line_subtotal = 0.0
    fuel = 0.0
    advancing = 0.0
    taxable_base = 0.0

    for line in lines:
        # Support both dict-shaped rows and ORM objects.
        code = getattr(line, "code", None) or (line.get("code") if isinstance(line, dict) else None)
        line_total = float(
            getattr(line, "line_total", None)
            if hasattr(line, "line_total")
            else line.get("line_total", 0)
        )
        taxable = bool(
            getattr(line, "taxable", None)
            if hasattr(line, "taxable")
            else line.get("taxable", False)
        )
        line_subtotal = round2(line_subtotal + line_total)
        if code == "DRY-FSC":
            fuel = round2(fuel + line_total)
        if code in ADVANCE_CODES:
            advancing = round2(advancing + line_total)
        if taxable:
            taxable_base = round2(taxable_base + line_total)

    op = round2(operational_charge or 0)
    subtotal = round2(line_subtotal + op)
    tax = round2(taxable_base * (tax_rate or 0))
    total = round2(subtotal + (adjustment or 0) + tax)
    return {
        "subtotal": subtotal,
        "line_subtotal": line_subtotal,
        "operational_charge": op,
        "fuel": fuel,
        "advancing": advancing,
        "taxable_base": taxable_base,
        "tax": tax,
        "adjustment": round2(adjustment),
        "total": total,
    }


def compute_due_date(invoice_date: date, terms: str) -> date:
    """invoice_date + Net N. Defaults to Net 30 if terms aren't a
    known value. COD / Prepaid → same day as invoice."""
    days_map = {
        "Net 15": 15,
        "Net 30": 30,
        "Net 45": 45,
        "Net 60": 60,
        "COD": 0,
        "Prepaid": 0,
    }
    return invoice_date + timedelta(days=days_map.get(terms, 30))
