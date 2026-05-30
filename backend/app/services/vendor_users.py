"""Postgres-backed vendor portal user store.

Source of truth for vendor accounts. Replaces the old Excel-only store
(`vendor_excel`), which made every login depend on the Excel Online
connector's daily quota. The Excel store is now only a lazy fallback for
accounts created before this migration — see `app.routers.vendor_auth`.

All functions take an AsyncSession and DO NOT commit; the caller owns the
transaction boundary. The one exception is `bump_last_login_bg`, a
fire-and-forget helper that opens its own session so login can return
before the write lands.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import VendorUser

logger = logging.getLogger(__name__)


def _norm(email: str) -> str:
    return (email or "").strip().lower()


async def find_by_email(session: AsyncSession, email: str) -> VendorUser | None:
    needle = _norm(email)
    if not needle:
        return None
    return await session.scalar(
        select(VendorUser).where(func.lower(VendorUser.email) == needle)
    )


async def list_users(session: AsyncSession) -> list[VendorUser]:
    rows = await session.scalars(select(VendorUser).order_by(VendorUser.email))
    return list(rows.all())


async def create_user(
    session: AsyncSession,
    *,
    email: str,
    full_name: str,
    company: str,
    password_hash: str,
    registered_at: datetime | None = None,
    last_login_at: datetime | None = None,
    migrated_from_excel: bool = False,
) -> VendorUser:
    """Insert a new vendor account. Caller must commit. Email is normalized.

    registered_at defaults to now() (via server_default) when omitted."""
    user = VendorUser(
        email=_norm(email),
        full_name=(full_name or "").strip(),
        company=(company or "").strip(),
        password_hash=password_hash,
        last_login_at=last_login_at,
        migrated_from_excel=migrated_from_excel,
    )
    if registered_at is not None:
        user.registered_at = registered_at
    session.add(user)
    await session.flush()
    return user


async def update_password(
    session: AsyncSession, email: str, password_hash: str
) -> int:
    """Overwrite password_hash for an existing account. Caller must commit.
    Returns rows updated (1 on success, 0 if the email doesn't exist)."""
    result = await session.execute(
        update(VendorUser)
        .where(func.lower(VendorUser.email) == _norm(email))
        .values(password_hash=password_hash)
    )
    return result.rowcount or 0


async def update_last_login(
    session: AsyncSession, email: str, when: datetime
) -> None:
    """Stamp last_login_at. Caller must commit."""
    await session.execute(
        update(VendorUser)
        .where(func.lower(VendorUser.email) == _norm(email))
        .values(last_login_at=when)
    )


async def bump_last_login_bg(email: str) -> None:
    """Fire-and-forget last-login stamp with its own session + commit.

    Used from the login handler via asyncio.create_task so the response
    isn't blocked on the write. Never raises — failures are logged."""
    from app.db import SessionLocal

    try:
        async with SessionLocal() as session:
            await update_last_login(session, email, datetime.now(timezone.utc))
            await session.commit()
    except Exception as e:  # noqa: BLE001
        logger.warning("vendor last_login bump failed for %s: %s", email, e)
