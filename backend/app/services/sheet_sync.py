"""OneDrive Excel sync. Supports two configurations; auto-detects which:

  1. WEBHOOK mode (default for now) — POST rows to an Azure Logic Apps / Power
     Automate flow URL that has its own OneDrive Excel connector wired up.
     No app registration needed. Set INBOUND_WEBHOOK_URL.

  2. GRAPH mode (optional) — Direct Microsoft Graph API call with an Entra ID
     app-only token (client credentials flow). Faster, no middle-man, but
     requires Entra ID app-registration permissions (most student tenants
     don't have this). Set MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET /
     ONEDRIVE_USER_UPN / ONEDRIVE_FILE_PATH / ONEDRIVE_TABLE_NAME.

Either way, vendor submissions never fail if the sync is misconfigured or
the upstream is unreachable — calls are best-effort.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

HEADERS = [
    "container_no",
    "whpo_number",
    "expected_arrival_date",
    "expected_arrival_time",
    "qty",
    "product_type",
    "sku",
    "customer",
    "do_number",
    "submitter_name",
    "submitter_email",
    "submitted_at",
    "driver_name",
    "driver_license",
    "driver_phone",
    "truck_license_plate",
    "insurance",
    "carrier",
    "last_updated_at",
    # New (column 20) — appended at the end so the existing 19 positions
    # stay locked. The Logic App row mapping just needs the new column
    # mapped to items('For_each')[19].
    "bol_number",
]


# ─── Configuration detection ───────────────────────────────────────────


def _webhook_urls() -> list[str]:
    """Return every configured downstream webhook URL."""
    return [u for u in (settings.inbound_webhook_url, settings.onedrive_webhook_url) if u]


def _webhook_configured() -> bool:
    return bool(_webhook_urls())


def _graph_configured() -> bool:
    return all(
        [
            settings.ms_tenant_id,
            settings.ms_client_id,
            settings.ms_client_secret,
            settings.onedrive_user_upn,
            settings.onedrive_file_path,
            settings.onedrive_table_name,
        ]
    )


def is_configured() -> bool:
    return _webhook_configured() or _graph_configured()


def mode() -> str:
    if _webhook_configured():
        return "webhook"
    if _graph_configured():
        return "graph"
    return "disabled"


# ─── Shared helpers ────────────────────────────────────────────────────


def _serialize(row: dict[str, Any]) -> list[Any]:
    return [row.get(h) if row.get(h) is not None else "" for h in HEADERS]


# ─── Webhook mode (Logic Apps / Power Automate) ────────────────────────


async def _append_via_webhook(rows: list[dict[str, Any]]) -> int:
    """Fan out to every configured webhook. Each downstream gets the same
    payload. Returns the count of rows for the first successful destination
    (best-effort — used just for the manager sync status).
    """
    # Include `headers` so the Office Script can map values to columns
    # by NAME instead of position. Lets ops add extra columns to the
    # InboundTable (populated from elsewhere — manual entry, formulas,
    # other integrations) without breaking the append flow. Without
    # headers, addRow blows up the moment the workbook's column count
    # diverges from len(HEADERS).
    payload = {
        "headers": HEADERS,
        "rows": [_serialize(r) for r in rows],
    }
    headers = {"Content-Type": "application/json"}
    if settings.inbound_webhook_secret:
        headers["X-CN-Secret"] = settings.inbound_webhook_secret

    success_count = 0
    logger.warning("DIAG: append_rows called with %d rows. URLs configured: %d",
                   len(rows), len(_webhook_urls()))
    async with httpx.AsyncClient(timeout=20.0) as client:
        for url in _webhook_urls():
            host = url.split("?")[0]
            try:
                logger.warning("DIAG → POST %s (%d rows)", host, len(rows))
                r = await client.post(url, json=payload, headers=headers)
                logger.warning("DIAG ← %s status=%s body=%s",
                               host, r.status_code, r.text[:200])
                if r.is_success:
                    success_count = len(rows)
                else:
                    logger.warning(
                        "Webhook %s returned %s: %s",
                        host,
                        r.status_code,
                        r.text[:300],
                    )
            except Exception as e:
                logger.warning("Webhook %s errored: %s", host, e)
    return success_count


# ─── Graph mode (Entra ID app-only) ────────────────────────────────────

_token_cache: dict[str, Any] = {"access_token": None, "expires_at": 0.0}
_token_lock = asyncio.Lock()


async def _get_token() -> str | None:
    async with _token_lock:
        if (
            _token_cache["access_token"]
            and _token_cache["expires_at"] > time.time() + 300
        ):
            return _token_cache["access_token"]

        token_url = (
            f"https://login.microsoftonline.com/{settings.ms_tenant_id}"
            "/oauth2/v2.0/token"
        )
        data = {
            "client_id": settings.ms_client_id,
            "client_secret": settings.ms_client_secret,
            "scope": "https://graph.microsoft.com/.default",
            "grant_type": "client_credentials",
        }
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await client.post(token_url, data=data)
                r.raise_for_status()
                result = r.json()
        except Exception as e:
            logger.warning("Failed to acquire MS Graph token: %s", e)
            return None

        _token_cache["access_token"] = result["access_token"]
        _token_cache["expires_at"] = time.time() + result.get("expires_in", 3600)
        return _token_cache["access_token"]


def _graph_add_row_url() -> str:
    path = settings.onedrive_file_path
    if not path.startswith("/"):
        path = "/" + path
    return (
        f"https://graph.microsoft.com/v1.0/users/{settings.onedrive_user_upn}"
        f"/drive/root:{path}:/workbook/tables/"
        f"{settings.onedrive_table_name}/rows/add"
    )


async def _append_via_graph(rows: list[dict[str, Any]]) -> int:
    token = await _get_token()
    if token is None:
        return 0
    values = [_serialize(r) for r in rows]
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(
                _graph_add_row_url(),
                json={"values": values},
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
            )
            if r.is_success:
                return len(values)
            logger.warning(
                "Graph append rows failed %s: %s", r.status_code, r.text[:300]
            )
            return 0
    except Exception as e:
        logger.warning("Graph append rows errored: %s", e)
        return 0


# ─── Public surface ────────────────────────────────────────────────────


async def append_rows(rows: list[dict[str, Any]]) -> int:
    """Append rows to the configured Excel sink. Returns rows pushed (0 on
    no-op / failure). Never raises."""
    if not rows or not is_configured():
        return 0
    if _webhook_configured():
        return await _append_via_webhook(rows)
    return await _append_via_graph(rows)


async def replace_all(rows: list[dict[str, Any]]) -> int:
    """Backfill / manual re-sync. Both modes currently APPEND rather than
    truncate-and-write — wipe the Excel table manually first if you want
    to avoid duplicate rows."""
    return await append_rows(rows)


# ─── Driver-info update flow (in-place row updates in OneDrive Excel) ──


def is_update_configured() -> bool:
    """Driver-info updates now go through the unified vendors-ops Logic App
    (action=update_driver). The dead ONEDRIVE_UPDATE_WEBHOOK_URL is kept in
    config for backwards-compat but no longer used."""
    return bool(settings.onedrive_vendors_ops_url)


async def update_driver_for_container(
    *,
    container_no: str,
    driver_name: str,
    driver_license: str,
    driver_phone: str,
    truck_license_plate: str,
    insurance: str,
    carrier: str,
) -> int:
    """POST driver info to the unified vendors-ops Logic App. The Office
    Script (VendorUsersOps) routes by `action`; for `update_driver` it finds
    rows in InboundTable matching container_no and updates the driver
    columns in place. Returns 1 on success (1+ rows updated), 0 otherwise.
    """
    if not is_update_configured():
        return 0

    import json as _json

    body = {
        "action": "update_driver",
        "payload": _json.dumps(
            {
                "container_no": container_no,
                "driver_name": driver_name,
                "driver_license": driver_license,
                "driver_phone": driver_phone,
                "truck_license_plate": truck_license_plate,
                "insurance": insurance,
                "carrier": carrier,
            }
        ),
    }
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(settings.onedrive_vendors_ops_url, json=body)
    except Exception as e:
        logger.warning("Driver update via vendors-ops errored: %s", e)
        return 0

    if not r.is_success:
        logger.warning(
            "Driver update via vendors-ops returned %s: %s",
            r.status_code,
            r.text[:300],
        )
        return 0

    # Parse the script result. Office Script returns
    # {updated: N, matched_container: ...} on success.
    try:
        data = r.json()
        if isinstance(data, str):
            data = _json.loads(data)
        if isinstance(data, dict) and isinstance(data.get("updated"), int):
            return 1 if data["updated"] > 0 else 0
    except Exception:
        pass
    return 0


async def clear_inbound_table() -> int:
    """Delete EVERY row from the InboundTable in OneDrive Excel (preserves
    the header row). Used by the full-resync endpoint to rebuild the sheet
    from Postgres. Returns the deleted count, or 0 on failure."""
    if not is_update_configured():
        return 0

    import json as _json

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(
                settings.onedrive_vendors_ops_url,
                json={"action": "clear_inbound_table"},
            )
    except Exception as e:
        logger.warning("clear_inbound_table errored: %s", e)
        return 0
    if not r.is_success:
        logger.warning(
            "clear_inbound_table returned %s: %s", r.status_code, r.text[:300]
        )
        return 0
    try:
        data = r.json()
        if isinstance(data, str):
            data = _json.loads(data)
        if isinstance(data, dict) and isinstance(data.get("deleted"), int):
            return data["deleted"]
    except Exception:
        pass
    return 0


async def delete_inbound_rows_for_whpo(whpo_number: str) -> int:
    """Removes every InboundTable row matching the given whpo_number.
    Used by the WHPO update flow before re-appending the fresh row set.
    Returns the deleted count, or 0 on failure / not configured."""
    if not is_update_configured():
        return 0

    import json as _json

    body = {
        "action": "delete_whpo_rows",
        "payload": _json.dumps({"whpo_number": whpo_number}),
    }
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(settings.onedrive_vendors_ops_url, json=body)
    except Exception as e:
        logger.warning("delete_inbound_rows_for_whpo errored: %s", e)
        return 0
    if not r.is_success:
        logger.warning(
            "delete_inbound_rows_for_whpo returned %s: %s",
            r.status_code,
            r.text[:300],
        )
        return 0
    try:
        data = r.json()
        if isinstance(data, str):
            data = _json.loads(data)
        if isinstance(data, dict) and isinstance(data.get("deleted"), int):
            return data["deleted"]
    except Exception:
        pass
    return 0
