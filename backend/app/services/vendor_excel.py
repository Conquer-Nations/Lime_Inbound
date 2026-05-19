"""Vendor-user storage in OneDrive Excel.

Excel is the source of truth — no Postgres table for vendor accounts. A single
Logic App fronts the workbook; it runs an Office Script (`VendorUsersOps`)
that performs list/append/update-last-login on the `VendorUsers` table.

Setup the Tiana side needs:
  • In the OneDrive workbook: add a `VendorUsers` sheet with a table named
    `VendorUsers` having columns (in order):
        email | full_name | company | password_hash | registered_at | last_login_at
  • Add an Office Script named `VendorUsersOps` to the workbook (script body
    documented in the project README).
  • Create a Logic App that on HTTP trigger runs `VendorUsersOps` with the
    incoming `action` and `payload` properties, then returns the script's
    result object.
  • Put the trigger URL in backend `.env` as `ONEDRIVE_VENDORS_OPS_URL`.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


class VendorExcelError(Exception):
    pass


def is_configured() -> bool:
    return bool(settings.onedrive_vendors_ops_url)


async def _call_ops(action: str, payload: dict[str, Any] | None = None) -> Any:
    if not is_configured():
        raise VendorExcelError(
            "Vendor users Excel ops URL not configured "
            "(set ONEDRIVE_VENDORS_OPS_URL in backend .env)"
        )

    body: dict[str, Any] = {"action": action}
    if payload is not None:
        # Office Script `main(workbook, action, payload?)` takes payload as a
        # JSON string. Logic App passes the body fields through verbatim.
        body["payload"] = json.dumps(payload)

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(settings.onedrive_vendors_ops_url, json=body)
    except Exception as e:
        logger.warning("Vendor Excel ops call errored: %s", e)
        raise VendorExcelError(f"Excel ops upstream errored: {e}") from e

    if not r.is_success:
        logger.warning(
            "Vendor Excel ops returned %s: %s", r.status_code, r.text[:300]
        )
        raise VendorExcelError(
            f"Excel ops upstream returned {r.status_code}: {r.text[:200]}"
        )

    # Logic App returns the Office Script's result. Depending on response
    # configuration that's either the raw object, or a JSON string we need
    # to decode again. Handle both.
    try:
        data = r.json()
    except Exception:
        raise VendorExcelError(f"Excel ops returned non-JSON: {r.text[:200]}")

    if isinstance(data, str):
        try:
            data = json.loads(data)
        except Exception:
            raise VendorExcelError(
                f"Excel ops returned string that wasn't JSON: {data[:200]}"
            )

    if isinstance(data, dict) and data.get("error"):
        raise VendorExcelError(f"Excel ops script error: {data['error']}")

    return data


async def list_users() -> list[dict[str, Any]]:
    """Returns every vendor user row from Excel. Empty list if table is empty
    or sheet was just created."""
    data = await _call_ops("list")
    users = data.get("users") if isinstance(data, dict) else None
    if not isinstance(users, list):
        return []
    # Strings only — Excel can hand us numbers or dates; coerce defensively.
    return [{k: ("" if v is None else str(v)) for k, v in u.items()} for u in users]


async def find_by_email(email: str) -> dict[str, Any] | None:
    needle = email.strip().lower()
    if not needle:
        return None
    for u in await list_users():
        if str(u.get("email", "")).strip().lower() == needle:
            return u
    return None


async def append_user(
    *,
    email: str,
    full_name: str,
    company: str,
    password_hash: str,
    registered_at: str,
) -> None:
    await _call_ops(
        "append",
        {
            "email": email.strip().lower(),
            "full_name": full_name.strip(),
            "company": company.strip(),
            "password_hash": password_hash,
            "registered_at": registered_at,
            "last_login_at": "",
        },
    )


async def update_last_login(email: str, when_iso: str) -> None:
    await _call_ops(
        "update_last_login",
        {"email": email.strip().lower(), "last_login_at": when_iso},
    )


async def update_password(email: str, password_hash: str) -> int:
    """Overwrite the password_hash for an existing user. Returns the number of
    rows updated (1 on success, 0 if the email doesn't exist)."""
    data = await _call_ops(
        "update_password",
        {"email": email.strip().lower(), "password_hash": password_hash},
    )
    if isinstance(data, dict):
        u = data.get("updated")
        if isinstance(u, int):
            return u
    return 0


async def list_inbound_rows() -> list[dict[str, Any]]:
    """Reads every row from the InboundTable in Excel — used by the
    Pull-from-Excel sync to detect manual edits and push them back to
    Postgres. Returns dicts keyed by column header."""
    data = await _call_ops("list_inbound")
    rows = data.get("rows") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        return []
    return [
        {k: ("" if v is None else str(v)) for k, v in r.items()} for r in rows
    ]
