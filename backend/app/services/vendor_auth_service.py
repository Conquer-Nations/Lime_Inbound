"""Vendor-user authentication primitives.

bcrypt for password hashing, PyJWT for stateless sessions. No DB writes —
the user record lives in Excel (see `vendor_excel`).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import bcrypt
import jwt
from fastapi import Depends, Header, HTTPException, status

from app.config import settings


# ─── Password hashing ──────────────────────────────────────────────────


def hash_password(plain: str) -> str:
    if not plain:
        raise ValueError("password must not be empty")
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    if not plain or not hashed:
        return False
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


# ─── JWT ───────────────────────────────────────────────────────────────


def create_access_token(*, email: str, full_name: str, company: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": email.strip().lower(),
        "name": full_name,
        "company": company,
        "iat": now,
        "exp": now + timedelta(hours=settings.jwt_expiry_hours),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def decode_access_token(token: str) -> dict[str, Any] | None:
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        return None


# ─── FastAPI dependency ────────────────────────────────────────────────


def _extract_bearer(authorization: str | None) -> str | None:
    if not authorization:
        return None
    parts = authorization.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip() or None


def current_vendor_optional(
    authorization: str | None = Header(default=None),
) -> dict[str, Any] | None:
    """Returns claims if a valid JWT is present, else None. Use for routes
    that accept either authenticated vendors (TQL-style) or legacy
    customer-name submissions (Lime / Boviet)."""
    token = _extract_bearer(authorization)
    if not token:
        return None
    return decode_access_token(token)


def current_vendor_required(
    claims: dict[str, Any] | None = Depends(current_vendor_optional),
) -> dict[str, Any]:
    if not claims:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sign in to continue",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return claims
