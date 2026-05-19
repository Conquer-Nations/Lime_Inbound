"""Vendor self-service auth — register, login, who-am-I.

Excel is the user store. Backend keeps no Postgres mirror — every register
appends a row to the OneDrive workbook, every login reads & verifies.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_session
from app.models import Customer
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
    Lets vendor self-registration auto-create the customer record so we don't
    have to seed it by hand every time a new company onboards."""
    clean = name.strip()
    if not clean:
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
    """Public — returns customer names for the register-page dropdown.
    Names only; no contact info or other internals."""
    rows = await session.scalars(select(Customer.name).order_by(Customer.name))
    return list(rows)


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
