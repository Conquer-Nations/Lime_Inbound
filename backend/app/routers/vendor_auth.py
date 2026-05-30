"""Vendor self-service auth — register, login, who-am-I.

Postgres (`vendor_users` table) is the source of truth for vendor accounts.
Historically accounts lived only in an OneDrive Excel workbook, which made
every login depend on the Excel Online connector's daily call-volume quota —
when it ran out, the portal locked everyone out. Auth now reads/writes
Postgres; the Excel store (`vendor_excel`) is consulted only as a lazy
fallback for accounts created before this migration, and each such account
is copied into Postgres on its next successful login or password reset.
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
from app.services import vendor_auth_service, vendor_excel, vendor_users


def _parse_iso(value: str | None) -> datetime | None:
    """Best-effort parse of the legacy Excel `registered_at` ISO string into a
    datetime for migration. Returns None on anything unparseable so the new
    row falls back to its server_default (now())."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.strip())
    except (ValueError, AttributeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt

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
    email_norm = body.email.strip().lower()

    # Postgres is authoritative — reject if the account already exists here.
    existing = await vendor_users.find_by_email(session, email_norm)
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"You already have an account ({email_norm}) registered to "
                f"{existing.company or 'your company'}. Sign in instead."
            ),
        )

    # Also reject if the email exists in the legacy Excel store but hasn't been
    # migrated yet — otherwise we'd create a duplicate. Best-effort: if Excel is
    # unreachable we proceed, since Postgres is the source of truth now.
    if vendor_excel.is_configured():
        try:
            excel_existing = await vendor_excel.find_by_email(email_norm)
        except vendor_excel.VendorExcelError as e:
            logger.warning(
                "register: legacy Excel dup-check failed for %s (proceeding): %s",
                email_norm, e,
            )
            excel_existing = None
        if excel_existing:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"You already have an account ({email_norm}) registered to "
                    f"{excel_existing.get('company', 'your company')}. "
                    "Sign in instead."
                ),
            )

    pwd_hash = vendor_auth_service.hash_password(body.password)

    await vendor_users.create_user(
        session,
        email=email_norm,
        full_name=body.full_name,
        company=body.company,
        password_hash=pwd_hash,
        registered_at=datetime.now(timezone.utc),
    )
    await session.commit()

    # Auto-create the Postgres customer record so the vendor can immediately
    # submit shipments under this company without a manager pre-seeding it.
    try:
        await _ensure_customer(session, body.company)
        await session.commit()
    except Exception as e:
        # Don't fail registration on this — the user is already saved above.
        logger.warning("Auto-create customer failed for '%s': %s", body.company, e)
        await session.rollback()

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
async def login(
    body: LoginRequest,
    session: AsyncSession = Depends(get_session),
):
    email_norm = body.email.strip().lower()

    # 1) Postgres first (authoritative, quota-free).
    user = await vendor_users.find_by_email(session, email_norm)

    resolved_hash: str | None = None
    full_name = ""
    company = ""
    excel_user: dict | None = None

    if user is not None:
        resolved_hash = user.password_hash
        full_name = user.full_name
        company = user.company
    elif vendor_excel.is_configured():
        # 2) Lazy fallback: account may predate the Postgres migration.
        try:
            excel_user = await vendor_excel.find_by_email(email_norm)
        except vendor_excel.VendorExcelError as e:
            raise HTTPException(status_code=502, detail=str(e))
        if excel_user is not None:
            resolved_hash = excel_user.get("password_hash", "")
            full_name = excel_user.get("full_name", "")
            company = excel_user.get("company", "")

    if not resolved_hash or not vendor_auth_service.verify_password(
        body.password, resolved_hash
    ):
        # Same error whether the email is unknown or the password is wrong →
        # don't reveal whether the account exists.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Wrong email or password.",
        )

    # Password checked out. If this was an un-migrated Excel account, copy it
    # into Postgres now so future logins never touch Excel again.
    if user is None and excel_user is not None:
        try:
            await vendor_users.create_user(
                session,
                email=email_norm,
                full_name=full_name,
                company=company,
                password_hash=resolved_hash,
                registered_at=_parse_iso(excel_user.get("registered_at")),
                migrated_from_excel=True,
            )
            await session.commit()
            logger.info("Lazily migrated vendor account %s from Excel", email_norm)
        except Exception as e:  # noqa: BLE001 — never block login on migration
            logger.warning("lazy-migrate of %s failed: %s", email_norm, e)
            await session.rollback()

    # Fire-and-forget the last_login_at write so login returns immediately.
    # (No-ops harmlessly if the lazy migration above didn't land.)
    asyncio.create_task(vendor_users.bump_last_login_bg(email_norm))

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
async def reset_password(
    body: ResetPasswordRequest,
    session: AsyncSession = Depends(get_session),
):
    """Self-service password reset. Vendor provides their email + a new
    password; backend overwrites the bcrypt hash in Postgres and issues a
    fresh JWT (auto-login). If the account only exists in the legacy Excel
    store, it's migrated into Postgres with the new password.

    NOTE: there's no email-verification step — anyone who knows a vendor's
    email can reset their password. This is acceptable for a small internal
    portal but should be upgraded to email-link verification before going
    production. Tracked as a known limitation.
    """
    email_norm = body.email.strip().lower()
    new_hash = vendor_auth_service.hash_password(body.new_password)

    # 1) Postgres first.
    user = await vendor_users.find_by_email(session, email_norm)
    if user is not None:
        updated = await vendor_users.update_password(session, email_norm, new_hash)
        await session.commit()
        if updated < 1:
            raise HTTPException(
                status_code=500,
                detail="Password reset reported 0 rows updated.",
            )
        full_name = user.full_name
        company = user.company
    else:
        # 2) Legacy Excel account — migrate it into Postgres with the new hash.
        excel_user: dict | None = None
        if vendor_excel.is_configured():
            try:
                excel_user = await vendor_excel.find_by_email(email_norm)
            except vendor_excel.VendorExcelError as e:
                raise HTTPException(status_code=502, detail=str(e))
        if not excel_user:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"No account found for {email_norm}. Register first or "
                    "check the email you typed."
                ),
            )
        full_name = excel_user.get("full_name", "")
        company = excel_user.get("company", "")
        await vendor_users.create_user(
            session,
            email=email_norm,
            full_name=full_name,
            company=company,
            password_hash=new_hash,
            registered_at=_parse_iso(excel_user.get("registered_at")),
            migrated_from_excel=True,
        )
        await session.commit()

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
