"""Vendor self-service auth — register, login, who-am-I.

Excel is the user store. Backend keeps no Postgres mirror — every register
appends a row to the OneDrive workbook, every login reads & verifies.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_session
from app.models import Account, Customer
from app.schemas.vendor_auth import (
    LoginRequest,
    RegisterRequest,
    ResetPasswordRequest,
    TokenResponse,
    VendorUserResponse,
)
from app.services import vendor_auth_service, vendor_excel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/vendor/auth", tags=["vendor-auth"])


async def _ensure_customer(session: AsyncSession, name: str) -> None:
    """Insert a customer row if no exact-name match exists. Idempotent.
    Lets vendor self-registration auto-create the customer record so we
    don't have to seed it by hand every time a new company onboards.

    Skips creation when the name matches an existing Account — registering
    as an account (e.g. "TQL") shouldn't accidentally spawn a Customer row
    with the same name; the account hierarchy already covers it."""
    clean = name.strip()
    if not clean:
        return
    # Don't create a Customer named after an existing Account.
    acc = await session.scalar(
        select(Account).where(func.lower(Account.name) == clean.lower())
    )
    if acc is not None:
        return
    existing = await session.scalar(select(Customer).where(Customer.name == clean))
    if existing is None:
        session.add(Customer(name=clean))
        await session.flush()
        logger.info("Auto-created customer record for '%s' on vendor register", clean)


@router.post("/register", response_model=TokenResponse, status_code=201)
async def register(
    body: RegisterRequest,
    session: AsyncSession = Depends(get_session),
):
    if not vendor_excel.is_configured():
        raise HTTPException(
            status_code=503,
            detail=(
                "Vendor user storage isn't configured yet — backend admin "
                "needs to wire ONEDRIVE_VENDORS_OPS_URL."
            ),
        )

    email_norm = body.email.strip().lower()

    try:
        existing = await vendor_excel.find_by_email(email_norm)
    except vendor_excel.VendorExcelError as e:
        raise HTTPException(status_code=502, detail=str(e))

    if existing:
        raise HTTPException(
            status_code=409,
            detail=(
                f"You already have an account ({email_norm}) registered to "
                f"{existing.get('company', 'your company')}. Sign in instead."
            ),
        )

    pwd_hash = vendor_auth_service.hash_password(body.password)
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")

    try:
        await vendor_excel.append_user(
            email=email_norm,
            full_name=body.full_name,
            company=body.company,
            password_hash=pwd_hash,
            registered_at=now_iso,
        )
    except vendor_excel.VendorExcelError as e:
        raise HTTPException(status_code=502, detail=str(e))

    # Auto-create the Postgres customer record so the vendor can immediately
    # submit shipments under this company without a manager pre-seeding it.
    try:
        await _ensure_customer(session, body.company)
        await session.commit()
    except Exception as e:
        # Don't fail registration on this — the user is already in Excel.
        logger.warning("Auto-create customer failed for '%s': %s", body.company, e)

    token = vendor_auth_service.create_access_token(
        email=email_norm, full_name=body.full_name, company=body.company
    )
    return TokenResponse(
        access_token=token,
        expires_in=settings.jwt_expiry_hours * 3600,
        user=VendorUserResponse(
            email=email_norm, full_name=body.full_name, company=body.company
        ),
    )


@router.get("/customers", response_model=list[str])
async def list_customer_names(session: AsyncSession = Depends(get_session)):
    """Public — names for the register-page dropdown. Includes both
    Customer (brand) names AND Account names — registering as an
    Account lets the user later submit shipments for ANY brand under it
    (e.g. TQL → Lime / Boviet / Pan Am / NP). Brand-only registration
    constrains the user to that single brand."""
    cust_names = (await session.scalars(select(Customer.name))).all()
    acct_names = (await session.scalars(select(Account.name))).all()
    # De-duplicate (an Account and Customer can share a name in legacy
    # data) and sort. Names only; no contact info or other internals.
    return sorted({*cust_names, *acct_names})


@router.get("/my-brands", response_model=list[str])
async def my_brands(
    claims: dict = Depends(vendor_auth_service.current_vendor_required),
    session: AsyncSession = Depends(get_session),
) -> list[str]:
    """Return the brand names the logged-in vendor is allowed to submit
    shipments for. Resolution, in order:

      1. If vendor.company matches an Account → all Customers under that
         Account (e.g. TQL → Lime, Boviet, Pan Am, NP). Frontend renders
         these as the "Submitting on behalf of" picker.
      2. If vendor.company matches a single Customer (brand) → return
         just that brand. Frontend skips the picker, customer is set
         automatically.
      3. Legacy fallback (vendor.company is free-text, doesn't match any
         Account/Customer) → return the company string as-is so the
         submission still goes through. Manager can later link them.

    Case-insensitive matching; whitespace trimmed."""
    company = (claims.get("company") or "").strip()
    if not company:
        return []

    # 1) Account?
    acc = await session.scalar(
        select(Account).where(func.lower(Account.name) == company.lower())
    )
    if acc is not None:
        brand_rows = (
            await session.scalars(
                select(Customer.name)
                .where(Customer.account_id == acc.id)
                .order_by(Customer.name)
            )
        ).all()
        if brand_rows:
            return list(brand_rows)
        # Account exists but no brands attached — fall through to brand lookup
        # in case someone registered with the same name as a brand AND an account.

    # 2) Customer (brand)?
    cust = await session.scalar(
        select(Customer).where(func.lower(Customer.name) == company.lower())
    )
    if cust is not None:
        return [cust.name]

    # 3) Legacy fallback
    return [company]


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest):
    if not vendor_excel.is_configured():
        raise HTTPException(
            status_code=503,
            detail="Vendor user storage isn't configured yet.",
        )

    email_norm = body.email.strip().lower()

    try:
        user = await vendor_excel.find_by_email(email_norm)
    except vendor_excel.VendorExcelError as e:
        raise HTTPException(status_code=502, detail=str(e))

    if not user or not vendor_auth_service.verify_password(
        body.password, user.get("password_hash", "")
    ):
        # Same error for both → don't reveal whether the email exists.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Wrong email or password.",
        )

    full_name = user.get("full_name", "")
    company = user.get("company", "")

    # Fire-and-forget the last_login_at write so login returns immediately.
    # The Logic App round-trip used to add 1-3 seconds to every login — we don't
    # need to block the response on it. Failures are logged, not surfaced.
    async def _bump_last_login() -> None:
        try:
            await vendor_excel.update_last_login(
                email_norm, datetime.now(timezone.utc).isoformat(timespec="seconds")
            )
        except vendor_excel.VendorExcelError as e:
            logger.warning("update_last_login failed for %s: %s", email_norm, e)
        except Exception as e:  # noqa: BLE001
            logger.warning("update_last_login crashed for %s: %s", email_norm, e)

    asyncio.create_task(_bump_last_login())

    token = vendor_auth_service.create_access_token(
        email=email_norm, full_name=full_name, company=company
    )
    return TokenResponse(
        access_token=token,
        expires_in=settings.jwt_expiry_hours * 3600,
        user=VendorUserResponse(
            email=email_norm, full_name=full_name, company=company
        ),
    )


@router.get("/me", response_model=VendorUserResponse)
async def me(
    claims: dict = Depends(vendor_auth_service.current_vendor_required),
):
    return VendorUserResponse(
        email=claims.get("sub", ""),
        full_name=claims.get("name", ""),
        company=claims.get("company", ""),
    )


@router.post("/reset-password", response_model=TokenResponse)
async def reset_password(body: ResetPasswordRequest):
    """Self-service password reset. Vendor provides their email + a new
    password; backend overwrites the bcrypt hash in the VendorUsers table and
    issues a fresh JWT (auto-login).

    NOTE: there's no email-verification step — anyone who knows a vendor's
    email can reset their password. This is acceptable for a small internal
    portal but should be upgraded to email-link verification before going
    production. Tracked as a known limitation.
    """
    if not vendor_excel.is_configured():
        raise HTTPException(
            status_code=503,
            detail="Vendor user storage isn't configured yet.",
        )

    email_norm = body.email.strip().lower()

    try:
        existing = await vendor_excel.find_by_email(email_norm)
    except vendor_excel.VendorExcelError as e:
        raise HTTPException(status_code=502, detail=str(e))

    if not existing:
        raise HTTPException(
            status_code=404,
            detail=(
                f"No account found for {email_norm}. Register first or check "
                "the email you typed."
            ),
        )

    new_hash = vendor_auth_service.hash_password(body.new_password)
    try:
        updated = await vendor_excel.update_password(email_norm, new_hash)
    except vendor_excel.VendorExcelError as e:
        raise HTTPException(status_code=502, detail=str(e))

    if updated < 1:
        raise HTTPException(
            status_code=502,
            detail="Password reset reported 0 rows updated — Excel sync issue.",
        )

    full_name = existing.get("full_name", "")
    company = existing.get("company", "")
    token = vendor_auth_service.create_access_token(
        email=email_norm, full_name=full_name, company=company
    )
    return TokenResponse(
        access_token=token,
        expires_in=settings.jwt_expiry_hours * 3600,
        user=VendorUserResponse(
            email=email_norm, full_name=full_name, company=company
        ),
    )
