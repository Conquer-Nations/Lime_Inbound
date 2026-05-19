"""Upload vendor documents directly to OneDrive via Microsoft Graph.

Cloud-only path: no OneDrive desktop client required. Uses an OAuth public
client app + delegated `Files.ReadWrite` scope. A refresh token is acquired
via device code flow once and persisted to disk; from then on the backend
silently renews access tokens as needed.

One-time setup:
    cd backend
    python -m app.scripts.onedrive_login

The script prints a code; visit https://microsoft.com/devicelogin in any
browser, paste the code, sign in as the OneDrive account that owns the
target tree. After that the backend can upload / delete files without
further user interaction.

Tree layout (matches the local-sync variant exactly):
    /{root}/{Company}/{YYYY}/{MM - Month}/WHPO {whpo}/{container}/{kind}.{ext}

Graph's PUT to `/me/drive/root:/path:/content` auto-creates intermediate
folders, so no separate folder-creation calls are needed.

Best-effort: every helper logs and swallows failures; vendor uploads never
fail because Graph is unreachable.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import date
from pathlib import Path
from typing import Final
from urllib.parse import quote

import httpx
import msal

from app.config import settings
from app.services import vendor_uploads

logger = logging.getLogger(__name__)

SCOPES: Final = ["https://graph.microsoft.com/Files.ReadWrite"]
GRAPH_BASE: Final = "https://graph.microsoft.com/v1.0"
# 4 MB inline limit. Anything bigger needs an upload session.
INLINE_PUT_LIMIT: Final = 4 * 1024 * 1024

_ILLEGAL = re.compile(r'[\\/:*?"<>|]+')


# ─── Token cache management ────────────────────────────────────────────


def _cache_path() -> Path:
    raw = settings.onedrive_graph_cache_path or "./.onedrive_token_cache.json"
    return Path(raw).expanduser().resolve()


def _load_cache() -> msal.SerializableTokenCache:
    cache = msal.SerializableTokenCache()
    p = _cache_path()
    if p.is_file():
        try:
            cache.deserialize(p.read_text())
        except (OSError, json.JSONDecodeError) as e:
            logger.warning("onedrive_graph: token cache unreadable %r", e)
    return cache


def _save_cache(cache: msal.SerializableTokenCache) -> None:
    if not cache.has_state_changed:
        return
    p = _cache_path()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(cache.serialize())
        # Make the cache file owner-readable only.
        try:
            p.chmod(0o600)
        except OSError:
            pass
    except OSError as e:
        logger.warning("onedrive_graph: cache save failed %r", e)


def _msal_app(cache: msal.SerializableTokenCache) -> msal.PublicClientApplication:
    authority = (
        f"https://login.microsoftonline.com/{settings.onedrive_graph_tenant or 'common'}"
    )
    return msal.PublicClientApplication(
        settings.onedrive_graph_client_id,
        authority=authority,
        token_cache=cache,
    )


# ─── Public API ────────────────────────────────────────────────────────


def is_configured() -> bool:
    """True iff Graph upload is enabled AND a refresh token has been saved
    via a successful device-code login."""
    if not settings.onedrive_graph_enabled:
        return False
    cache = _load_cache()
    app = _msal_app(cache)
    return bool(app.get_accounts())


def signed_in_account() -> str | None:
    """Return the upn / email of the signed-in account, or None."""
    cache = _load_cache()
    app = _msal_app(cache)
    accounts = app.get_accounts()
    if not accounts:
        return None
    return accounts[0].get("username") or None


def device_code_login() -> dict:
    """Run the device-code flow. Prints the user code + verification URL,
    then blocks until the user signs in. Persists refresh token on success.

    Returns the MSAL token response dict (has `access_token`,
    `id_token_claims`, etc.).
    """
    cache = _load_cache()
    app = _msal_app(cache)
    flow = app.initiate_device_flow(scopes=SCOPES)
    if "user_code" not in flow:
        raise RuntimeError(
            f"OneDrive device flow could not start. Response: {flow}"
        )
    print("\n" + "=" * 70)
    print(flow["message"])
    print("=" * 70 + "\n", flush=True)
    result = app.acquire_token_by_device_flow(flow)
    _save_cache(cache)
    if "access_token" not in result:
        raise RuntimeError(
            f"Device-code login failed: {result.get('error_description') or result}"
        )
    return result


def sign_out() -> None:
    """Forget the saved refresh token (next upload will fail until you
    re-run `python -m app.scripts.onedrive_login`)."""
    p = _cache_path()
    if p.is_file():
        try:
            p.unlink()
        except OSError as e:
            logger.warning("onedrive_graph: sign-out unlink failed %r", e)


def _get_token() -> str | None:
    """Acquire an access token silently using the saved refresh token.
    Returns None on failure (which makes uploads no-op rather than crash)."""
    if not settings.onedrive_graph_enabled:
        return None
    cache = _load_cache()
    app = _msal_app(cache)
    accounts = app.get_accounts()
    if not accounts:
        logger.warning(
            "onedrive_graph: no signed-in account — run "
            "`python -m app.scripts.onedrive_login`."
        )
        return None
    result = app.acquire_token_silent(SCOPES, account=accounts[0])
    _save_cache(cache)
    if not result or "access_token" not in result:
        logger.warning(
            "onedrive_graph: silent token acquisition failed. "
            "Refresh token may have expired. Re-run device login."
        )
        return None
    return result["access_token"]


# ─── Path computation (mirrors onedrive_local_sync.compute_path) ───────


def _sanitize(s: str) -> str:
    cleaned = _ILLEGAL.sub(" ", s).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned or "untitled"


def graph_path(
    *,
    company: str,
    arrival_date: date,
    whpo_number: str,
    container_no: str,
    kind: str,
    original_filename: str,
    content_type: str,
) -> str:
    """Build the OneDrive path string (no leading slash) for a given doc."""
    year = f"{arrival_date.year:04d}"
    month = f"{arrival_date.month:02d} - {arrival_date.strftime('%B')}"
    whpo = f"WHPO {whpo_number.strip()}"
    container = container_no.strip().upper()
    ext = vendor_uploads.pick_extension(original_filename, content_type)
    filename = f"{kind}{ext}"
    parts = [
        _sanitize(settings.onedrive_graph_root),
        _sanitize(company.strip()),
        _sanitize(year),
        _sanitize(month),
        _sanitize(whpo),
        _sanitize(container),
        _sanitize(filename),
    ]
    return "/".join(parts)


# ─── Upload / delete ───────────────────────────────────────────────────


async def upload_document(
    *,
    company: str,
    arrival_date: date | None,
    whpo_number: str,
    container_no: str,
    kind: str,
    storage_path: str,
    original_filename: str,
    content_type: str,
) -> None:
    if not is_configured():
        return
    token = _get_token()
    if token is None:
        return

    effective_date = arrival_date or date.today()
    path = graph_path(
        company=company,
        arrival_date=effective_date,
        whpo_number=whpo_number,
        container_no=container_no,
        kind=kind,
        original_filename=original_filename,
        content_type=content_type,
    )

    try:
        src = vendor_uploads.absolute_path(storage_path)
    except vendor_uploads.UploadError:
        logger.warning("onedrive_graph: bad storage path %s", storage_path)
        return
    if not src.is_file():
        logger.warning("onedrive_graph: source missing %s", src)
        return

    try:
        data = src.read_bytes()
    except OSError as e:
        logger.warning("onedrive_graph: read failed %r", e)
        return

    if len(data) <= INLINE_PUT_LIMIT:
        await _put_inline(token, path, data, content_type)
    else:
        await _put_via_session(token, path, data, content_type)


async def _put_inline(
    token: str, path: str, data: bytes, content_type: str
) -> None:
    encoded = quote(path, safe="/")
    url = (
        f"{GRAPH_BASE}/me/drive/root:/{encoded}:/content"
        "?@microsoft.graph.conflictBehavior=replace"
    )
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": content_type or "application/octet-stream",
    }
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            res = await client.put(url, content=data, headers=headers)
            if res.status_code >= 400:
                logger.warning(
                    "onedrive_graph: PUT %s → %s %s",
                    path,
                    res.status_code,
                    res.text[:300],
                )
                return
        logger.info("onedrive_graph: uploaded %s (%d bytes)", path, len(data))
    except Exception as e:  # noqa: BLE001
        logger.warning("onedrive_graph: PUT failed path=%s err=%r", path, e)


async def _put_via_session(
    token: str, path: str, data: bytes, content_type: str
) -> None:
    """Larger-file path: create an upload session, then PUT the bytes to
    the returned signed URL with a Content-Range header."""
    encoded = quote(path, safe="/")
    session_url = (
        f"{GRAPH_BASE}/me/drive/root:/{encoded}:/createUploadSession"
    )
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    body = {
        "item": {
            "@microsoft.graph.conflictBehavior": "replace",
        }
    }
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            res = await client.post(session_url, json=body, headers=headers)
            if res.status_code >= 400:
                logger.warning(
                    "onedrive_graph: createUploadSession %s → %s %s",
                    path,
                    res.status_code,
                    res.text[:300],
                )
                return
            upload_url = res.json().get("uploadUrl")
            if not upload_url:
                logger.warning("onedrive_graph: no uploadUrl in response")
                return

            size = len(data)
            put_headers = {
                "Content-Length": str(size),
                "Content-Range": f"bytes 0-{size - 1}/{size}",
            }
            # NB: do NOT include Authorization on the uploadUrl PUT — the
            # URL is pre-signed.
            res2 = await client.put(
                upload_url, content=data, headers=put_headers
            )
            if res2.status_code >= 400:
                logger.warning(
                    "onedrive_graph: upload session PUT %s → %s %s",
                    path,
                    res2.status_code,
                    res2.text[:300],
                )
                return
        logger.info("onedrive_graph: uploaded %s (%d bytes via session)", path, size)
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "onedrive_graph: upload session failed path=%s err=%r", path, e
        )


async def delete_document(
    *,
    company: str,
    arrival_date: date | None,
    whpo_number: str,
    container_no: str,
    kind: str,
    original_filename: str,
    content_type: str,
) -> None:
    if not is_configured():
        return
    token = _get_token()
    if token is None:
        return

    effective_date = arrival_date or date.today()
    path = graph_path(
        company=company,
        arrival_date=effective_date,
        whpo_number=whpo_number,
        container_no=container_no,
        kind=kind,
        original_filename=original_filename,
        content_type=content_type,
    )
    encoded = quote(path, safe="/")
    url = f"{GRAPH_BASE}/me/drive/root:/{encoded}"
    headers = {"Authorization": f"Bearer {token}"}
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            res = await client.delete(url, headers=headers)
            # 204 = deleted, 404 = wasn't there (both fine).
            if res.status_code not in (204, 404):
                logger.warning(
                    "onedrive_graph: DELETE %s → %s %s",
                    path,
                    res.status_code,
                    res.text[:300],
                )
                return
        logger.info("onedrive_graph: deleted %s", path)
    except Exception as e:  # noqa: BLE001
        logger.warning("onedrive_graph: DELETE failed path=%s err=%r", path, e)
