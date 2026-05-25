"""Vendor-portal access scoping.

A vendor's JWT carries `company` (set at registration). Every WHPO /
Transfer Order is tied to a `Customer` row. The rule:

  * Direct-brand login (vendor.company == customer.name) → allowed.
  * Account-level login (vendor.company == account.name AND customer
    rolls up to that account via account_id) → allowed. Lets one TQL
    employee submit + view shipments for any brand under TQL.
  * Anything else → 403.

Comparison is case-fold + whitespace-trimmed so "TQL Trading Inc."
matches regardless of how the vendor typed it during registration.
"""
from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Account, Customer


def normalize_company(s: str | None) -> str:
    return (s or "").strip().casefold()


async def enforce_company_match(
    session: AsyncSession,
    claims: dict,
    customer_name: str,
) -> None:
    """Raise 401 if no company claim, 403 if the vendor's company can't
    access the customer. Direct match short-circuits without a DB call;
    the Account→brand lookup only fires on mismatch."""
    vendor_co = normalize_company(claims.get("company"))
    if not vendor_co:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Your session is missing a company. Sign out and back in.",
        )
    target = normalize_company(customer_name)
    if vendor_co == target:
        return  # Direct brand-login match.

    # Account-level fallback: vendor's company might be the ACCOUNT name,
    # and customer_name a BRAND under that account.
    acc = await session.scalar(
        select(Account).where(func.lower(Account.name) == vendor_co)
    )
    if acc is not None:
        is_under_account = await session.scalar(
            select(Customer.id).where(
                Customer.account_id == acc.id,
                func.lower(Customer.name) == target,
            )
        )
        if is_under_account is not None:
            return

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=(
            f"This shipment belongs to '{customer_name}'. Only that "
            "company's vendor accounts can view or modify it."
        ),
    )


async def vendor_customer_ids(
    session: AsyncSession, claims: dict
) -> list[int]:
    """Return Customer.id rows the vendor can access. Used by list
    endpoints that filter many rows by vendor scope; single-row endpoints
    should call `enforce_company_match` instead.

    Includes:
      * The Customer whose name matches the vendor's company directly.
      * All Customers under an Account whose name matches the vendor's
        company (account-level login like TQL).
    Returns [] if neither resolves — list endpoints then return empty
    instead of leaking other tenants' data."""
    vendor_co = normalize_company(claims.get("company"))
    if not vendor_co:
        return []
    ids: set[int] = set()

    # Direct brand match
    direct = (
        await session.scalars(
            select(Customer.id).where(func.lower(Customer.name) == vendor_co)
        )
    ).all()
    ids.update(direct)

    # Account-level: customers under an account whose name matches.
    acc = await session.scalar(
        select(Account).where(func.lower(Account.name) == vendor_co)
    )
    if acc is not None:
        under_account = (
            await session.scalars(
                select(Customer.id).where(Customer.account_id == acc.id)
            )
        ).all()
        ids.update(under_account)

    return list(ids)
