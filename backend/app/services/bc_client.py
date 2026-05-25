"""Dynamics 365 Business Central API client — Phase 1 (Customers).

Pattern: dual-write. Every Account create/update in the in-house app
also calls `bc_client.upsert_customer(account)` to mirror the row into
BC. cn-warehouse-backend stays the source of truth for operational
state; BC accumulates the same data and becomes the system of record
for financials. Eventually phases 2-4 will add Items, Posted Receipts,
Sales Invoices, Posted Shipments.

Auth: Azure AD service-to-service (OAuth client_credentials grant).
Tokens are cached in-process until 60s before expiry; auto-refreshed.

Best-effort: a BC failure NEVER blocks the in-house write. The
caller's commit happens first; this service is fire-and-log on top.
The Account row records the last sync result so the Manager Portal
can surface failures.

Required App Service settings (all five must be set or the service
no-ops):

  BC_TENANT_ID       Azure AD directory (tenant) ID
  BC_CLIENT_ID       Azure AD app client ID
  BC_CLIENT_SECRET   Azure AD app secret (paste in App Service, never commit)
  BC_ENVIRONMENT     "Sandbox" or your sandbox name
  BC_COMPANY_NAME    Exact BC company name (case-sensitive)
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import Account

logger = logging.getLogger(__name__)


# ─── Module state (token cache) ─────────────────────────────────────────


_token: str | None = None
_token_expires_at: float = 0.0  # unix epoch seconds
_company_id: str | None = None  # BC's GUID for the configured company
_lock = asyncio.Lock()


# ─── Configuration helpers ──────────────────────────────────────────────


def is_configured() -> bool:
    """True iff all five required env vars are set. Service no-ops when
    False — every callable just logs and returns a degraded result."""
    return all([
        settings.bc_tenant_id,
        settings.bc_client_id,
        settings.bc_client_secret,
        settings.bc_environment,
        settings.bc_company_name,
    ])


def _api_root() -> str:
    """Root URL for the BC REST API (per-tenant + per-environment)."""
    return (
        f"{settings.bc_api_base.rstrip('/')}/v2.0/{settings.bc_tenant_id}"
        f"/{settings.bc_environment}/api/v2.0"
    )


# ─── Auth ──────────────────────────────────────────────────────────────


async def _fetch_token() -> str:
    """OAuth client_credentials. Cached for the token lifetime minus
    60s safety margin. Re-fetches on demand."""
    global _token, _token_expires_at
    async with _lock:
        # Re-check inside the lock in case a concurrent caller just refreshed.
        if _token and time.time() < _token_expires_at - 60:
            return _token

        token_url = (
            f"https://login.microsoftonline.com/{settings.bc_tenant_id}"
            f"/oauth2/v2.0/token"
        )
        body = {
            "grant_type": "client_credentials",
            "client_id": settings.bc_client_id,
            "client_secret": settings.bc_client_secret,
            "scope": "https://api.businesscentral.dynamics.com/.default",
        }
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.post(token_url, data=body)
        if not r.is_success:
            raise RuntimeError(
                f"BC OAuth failed [{r.status_code}]: {r.text[:300]}"
            )
        data = r.json()
        _token = data["access_token"]
        _token_expires_at = time.time() + int(data.get("expires_in", 3600))
        logger.info(
            "BC OAuth token refreshed; expires in %ss",
            int(data.get("expires_in", 3600)),
        )
        return _token


async def _company_guid(client: httpx.AsyncClient) -> str:
    """BC's REST API addresses Customer rows via company GUID, not the
    display name. Resolve it once + cache.

    BC stores companies with both `name` (internal — often 'My Company'
    or 'CRONUS USA, Inc.') and `displayName` (user-facing — e.g.
    'Conquer Nation Inc'). We match BC_COMPANY_NAME against either
    (case-insensitive) so configurers can use whichever they see in
    the BC UI."""
    global _company_id
    if _company_id:
        return _company_id
    token = await _fetch_token()
    r = await client.get(
        f"{_api_root()}/companies",
        headers={"Authorization": f"Bearer {token}"},
    )
    if not r.is_success:
        raise RuntimeError(
            f"BC list-companies failed [{r.status_code}]: {r.text[:300]}"
        )
    companies = r.json().get("value", [])
    target = settings.bc_company_name.strip().casefold()
    for c in companies:
        name = c.get("name", "").strip().casefold()
        display = c.get("displayName", "").strip().casefold()
        if target in (name, display):
            _company_id = c["id"]
            return _company_id  # type: ignore[return-value]
    available = ", ".join(
        f"{c.get('name', '?')!r} (display: {c.get('displayName', '?')!r})"
        for c in companies
    )
    raise RuntimeError(
        f"BC company {settings.bc_company_name!r} not found in tenant. "
        f"Available: {available}"
    )


# ─── Public API: Customer upsert ────────────────────────────────────────


async def upsert_customer(session: AsyncSession, account: Account) -> bool:
    """Mirror an Account row to BC as a Customer. Updates account.
    bc_customer_no on first success; subsequent calls PATCH the same
    BC row. Records last-error to account.bc_sync_error on failure.

    Returns True on success, False on any failure (logged + recorded).
    Never raises — caller's commit doesn't depend on this."""
    if not is_configured():
        logger.info("BC sync: not configured, skipping upsert for account %s", account.id)
        return False

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            token = await _fetch_token()
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            }
            company_id = await _company_guid(client)
            base = f"{_api_root()}/companies({company_id})/customers"

            # Minimal payload — BC Customers have many fields but only
            # displayName is required. Address fields are best-effort.
            payload = _account_to_bc_customer(account)

            if account.bc_customer_no:
                # PATCH the existing row via BC Customer.No. → filter.
                # BC's API supports PATCH by id (GUID) or by Number filter.
                # We persisted `bc_customer_no` (the No., not the GUID),
                # so we need to resolve to GUID first via $filter.
                lookup = await client.get(
                    f"{base}?$filter=number eq '{account.bc_customer_no}'&$select=id",
                    headers=headers,
                )
                if not lookup.is_success:
                    raise RuntimeError(
                        f"BC customer lookup failed [{lookup.status_code}]: "
                        f"{lookup.text[:200]}"
                    )
                items = lookup.json().get("value", [])
                if items:
                    cust_id = items[0]["id"]
                    # PATCH needs If-Match etag — fetch the full row to get it.
                    etag_resp = await client.get(
                        f"{base}({cust_id})",
                        headers=headers,
                    )
                    etag = (
                        etag_resp.json().get("@odata.etag", "*")
                        if etag_resp.is_success
                        else "*"
                    )
                    patch = await client.patch(
                        f"{base}({cust_id})",
                        headers={**headers, "If-Match": etag},
                        json=payload,
                    )
                    if not patch.is_success:
                        raise RuntimeError(
                            f"BC customer PATCH failed [{patch.status_code}]: "
                            f"{patch.text[:300]}"
                        )
                    _mark_synced(account, account.bc_customer_no)
                    await session.commit()
                    return True
                # No row found despite having a number — fall through to POST.
                logger.warning(
                    "BC sync: stored bc_customer_no=%s not found in BC, recreating",
                    account.bc_customer_no,
                )

            # First-time create.
            create = await client.post(base, headers=headers, json=payload)
            if not create.is_success:
                raise RuntimeError(
                    f"BC customer POST failed [{create.status_code}]: "
                    f"{create.text[:300]}"
                )
            new_no = create.json().get("number")
            if not new_no:
                raise RuntimeError(
                    f"BC customer POST returned no `number` field: "
                    f"{create.text[:200]}"
                )
            _mark_synced(account, new_no)
            await session.commit()
            return True

    except Exception as e:
        logger.warning(
            "BC sync: upsert_customer for account %s failed: %s", account.id, e
        )
        account.bc_sync_error = f"{type(e).__name__}: {e}"[:500]
        try:
            await session.commit()
        except Exception:
            pass
        return False


def _mark_synced(account: Account, bc_no: str) -> None:
    account.bc_customer_no = bc_no
    account.bc_synced_at = datetime.now(timezone.utc)
    account.bc_sync_error = None


def _account_to_bc_customer(account: Account) -> dict[str, Any]:
    """Project an Account → BC Customer payload. Conservative for
    now — just displayName + email + address. Expandable later as
    needed (taxRegistrationNumber, customerPostingGroup, etc.)."""
    out: dict[str, Any] = {"displayName": account.name}
    if account.billing_email:
        out["email"] = account.billing_email
    if account.billing_address:
        # BC wants discrete address fields; we have a free-text
        # billing_address. Stash the whole thing in addressLine1 — the
        # manager can correct splitting via the BC UI if needed.
        out["addressLine1"] = account.billing_address[:100]
    return out
